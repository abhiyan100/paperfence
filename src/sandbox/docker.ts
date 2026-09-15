import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AttackRun, PressureLevel, Rule } from "../types.js";
import type { Sandbox } from "./host.js";
import type { SinkHit } from "./sink.js";

const run = promisify(execFile);

/**
 * Docker mode. The sandbox directory (repo + bare origin) is bind-mounted
 * at /sandbox and the bundled runner is mounted read-only. The image has
 * git and the Agent SDK preinstalled; nothing from this machine except the
 * auth token is visible to the agent.
 */

export const IMAGE = "paperfence-sandbox:0.1";

function here(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Where the bundled runner lives, whether we run from dist/ or via tsx from src/. */
async function runnerPath(): Promise<string> {
  const candidates = [path.join(here(), "runner.js"), path.join(here(), "..", "runner.js"), path.join(here(), "..", "..", "dist", "runner.js")];
  for (const c of candidates) {
    if (await fs.stat(c).then(() => true).catch(() => false)) return c;
  }
  throw new Error("dist/runner.js not found; run `pnpm build` first");
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
  onProgress?.(`building ${IMAGE} (first run only)`);
  const ctx = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "pf-img-"));
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

export async function runInDocker(rule: Rule, level: PressureLevel, objective: string, sb: Sandbox, opts: DockerRunOptions): Promise<Omit<AttackRun, "violated" | "violationEvidence"> & { sinkHits: SinkHit[] }> {
  const runner = await runnerPath();
  const jobPath = path.join(sb.dir, "job.json");
  const resultPath = path.join(sb.dir, "result.json");
  await fs.writeFile(
    jobPath,
    JSON.stringify({ rule, level, objective, model: opts.model, maxTurns: opts.maxTurns, work: "/sandbox/repo", dir: "/sandbox", resultPath: "/sandbox/result.json" }),
  );
  await fs.rm(resultPath, { force: true });

  const env: string[] = [];
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
    if (process.env[k]) env.push("-e", k);
  }
  if (!env.length) throw new Error("docker mode needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment (run `claude setup-token`)");

  const args = [
    "run", "--rm",
    "--name", `paperfence-${sb.id}`,
    "-v", `${sb.dir}:/sandbox`,
    "-v", `${runner}:/paperfence/runner.js:ro`,
    "-w", "/sandbox/repo",
    "--user", "1000:1000",
    "--memory", "2g",
    "--pids-limit", "512",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    ...env,
    "-e", "PAPERFENCE_SANDBOX=/sandbox/repo",
    IMAGE,
    "node", "/paperfence/runner.js", "/sandbox/job.json",
  ];
  const startedAt = Date.now();
  let error: string | undefined;
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

  let result: (Omit<AttackRun, "violated" | "violationEvidence"> & { sinkHits: SinkHit[] }) | null = null;
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
