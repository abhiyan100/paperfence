import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadCredential } from "../proxy.js";
import type { AttackRun, PressureLevel, Rule } from "../types.js";
import type { Sandbox } from "./host.js";
import type { SinkHit } from "./sink.js";

const run = promisify(execFile);

/**
 * Docker mode: the boundary is the container, not a regex.
 *
 *   ┌──────────────── internal network (no route out) ────────────────┐
 *   │  agent container                     proxy container            │
 *   │  /sandbox (repo + bare origin)  ───► only forwards /v1/* to     │──► api.anthropic.com
 *   │  ANTHROPIC_API_KEY=placeholder       api.anthropic.com, swaps   │
 *   │  no credential, no other route       in the real credential    │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The agent can only reach the proxy. The proxy only reaches Anthropic.
 * The credential lives in the proxy container's environment, never the agent's.
 */

export const IMAGE = "paperfence-sandbox:0.1";

function here(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

async function distFile(name: string): Promise<string> {
  const candidates = [path.join(here(), name), path.join(here(), "..", name), path.join(here(), "..", "..", "dist", name)];
  for (const c of candidates) if (await fs.stat(c).then(() => true).catch(() => false)) return c;
  throw new Error(`dist/${name} not found; run \`pnpm build\` first`);
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function ensureImage(onProgress?: (m: string) => void): Promise<void> {
  try {
    await run("docker", ["image", "inspect", IMAGE]);
    return;
  } catch {
    // build it
  }
  onProgress?.(`building ${IMAGE} (first run only, a minute or two)`);
  const ctx = await fs.mkdtemp(path.join(os.tmpdir(), "pf-img-"));
  await fs.writeFile(path.join(ctx, "Dockerfile"), DOCKERFILE);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", ["build", "-t", IMAGE, ctx], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (d) => onProgress?.(String(d).trim().split("\n").slice(-1)[0] ?? ""));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited ${code}`))));
  });
  await fs.rm(ctx, { recursive: true, force: true });
}

export const DOCKERFILE = `FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /paperfence
RUN npm init -y >/dev/null && npm install --omit=dev @anthropic-ai/claude-agent-sdk@0.3.272 >/dev/null 2>&1
RUN useradd -m -u 1000 -s /bin/bash agent || true
ENV GIT_AUTHOR_NAME=agent GIT_AUTHOR_EMAIL=agent@sandbox GIT_COMMITTER_NAME=agent GIT_COMMITTER_EMAIL=agent@sandbox GIT_TERMINAL_PROMPT=0
ENV HOME=/home/agent
`;

export interface DockerRunOptions {
  model: string;
  maxTurns: number;
  onProgress?: (m: string) => void;
}

type Partial = Omit<AttackRun, "violated" | "violationEvidence"> & { sinkHits: SinkHit[] };

export async function runInDocker(rule: Rule, level: PressureLevel, objective: string, sb: Sandbox, opts: DockerRunOptions): Promise<Partial> {
  const runner = await distFile("runner.js");
  const proxyJs = await distFile("proxy.js");
  const cred = await loadCredential();
  const net = `paperfence-net-${sb.id}`;
  const proxyName = `paperfence-proxy-${sb.id}`;
  const agentName = `paperfence-agent-${sb.id}`;

  const jobPath = path.join(sb.dir, "job.json");
  const resultPath = path.join(sb.dir, "result.json");
  await fs.writeFile(
    jobPath,
    JSON.stringify({ rule, level, objective, model: opts.model, maxTurns: opts.maxTurns, work: "/sandbox/repo", dir: "/sandbox", resultPath: "/sandbox/result.json" }),
  );
  await fs.rm(resultPath, { force: true });

  const startedAt = Date.now();
  let error: string | undefined;
  const cleanup = async () => {
    await run("docker", ["rm", "-f", agentName]).catch(() => {});
    await run("docker", ["rm", "-f", proxyName]).catch(() => {});
    await run("docker", ["network", "rm", net]).catch(() => {});
  };

  try {
    await cleanup();
    // Internal network: containers on it can talk to each other and nothing else.
    await run("docker", ["network", "create", "--internal", net]);

    // Proxy sidecar: on the internal network AND the default bridge, so it can reach Anthropic.
    const credEnv = cred.kind === "api-key" ? `ANTHROPIC_API_KEY=${cred.value}` : `CLAUDE_CODE_OAUTH_TOKEN=${cred.value}`;
    await run("docker", [
      "run", "-d", "--rm", "--name", proxyName,
      "--network", net,
      "-v", `${proxyJs}:/paperfence/proxy.mjs:ro`,
      "-e", credEnv,
      "--memory", "256m", "--pids-limit", "64", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      IMAGE, "node", "/paperfence/proxy.mjs", "8080", "0.0.0.0",
    ]);
    await run("docker", ["network", "connect", "bridge", proxyName]);
    opts.onProgress?.(`proxy up (${cred.source}); agent container has no credential and no route out`);

    // Agent container: internal network only. Placeholder key, base URL pointing at the proxy.
    const args = [
      "run", "--rm", "--name", agentName,
      "--network", net,
      "-v", `${sb.dir}:/sandbox`,
      "-v", `${runner}:/paperfence/runner.mjs:ro`,
      "-w", "/sandbox/repo",
      "--user", "1000:1000",
      "--memory", "2g", "--pids-limit", "512", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", `ANTHROPIC_BASE_URL=http://${proxyName}:8080`,
      "-e", "ANTHROPIC_API_KEY=paperfence-placeholder",
      "-e", "PAPERFENCE_SANDBOX=/sandbox/repo",
      "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      IMAGE, "node", "/paperfence/runner.mjs", "/sandbox/job.json",
    ];
    await new Promise<void>((resolve) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stderr.on("data", (d) => {
        for (const line of String(d).split("\n")) if (line.trim()) opts.onProgress?.(line.trimEnd());
      });
      child.on("close", (code) => {
        if (code !== 0) error = `container exited ${code}`;
        resolve();
      });
    });
  } catch (e) {
    error = (e as Error).message.split("\n")[0];
  } finally {
    await cleanup();
  }

  let result: Partial | null = null;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch {
    // runner did not get far enough to write a result
  }
  if (!result) {
    return {
      ruleId: rule.id, level, model: opts.model, startedAt, endedAt: Date.now(), events: [], finalText: "",
      mechanicallyBlocked: false, blockEvidence: [], turns: 0, error: error ?? "no result from container", sinkHits: [],
    };
  }
  if (error && !result.error) result.error = error;
  return result;
}
