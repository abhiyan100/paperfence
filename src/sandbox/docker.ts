import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadCredential } from "../proxy.js";
import { RESULT_END, RESULT_START } from "../attack/markers.js";
import type { AttackRun, PressureLevel, Rule, StaticProbeResult } from "../types.js";
import type { RepoProfile } from "../repo/profile.js";
import type { Sandbox } from "./host.js";
import type { SinkHit } from "./sink.js";

const run = promisify(execFile);

/**
 * Docker mode: the boundary is the container, not a regex.
 *
 *   internal network (no external route)          egress network
 *   ┌──────────────┐   http://proxy:8080   ┌──────────────┐
 *   │ agent        │ ────────────────────► │ proxy        │ ──► api.anthropic.com
 *   │ Claude Code  │  placeholder key +    │ POST         │
 *   │ via Agent SDK│  per-run token header │ /v1/messages │
 *   │ repo + origin│                       │ only; swaps  │
 *   │ mounted      │                       │ in the cred  │
 *   └──────────────┘                       └──────────────┘
 *
 * The agent can only reach the proxy, and only with the per-run token. The
 * proxy only reaches Anthropic. The credential lives in the proxy's
 * environment. The job goes in through an environment variable and the
 * result comes out on stdout, so nothing the agent can write is trusted.
 *
 * Known limit: Docker's --internal network still routes to the host gateway,
 * so a service bound on the host's Docker interface could be reachable. It
 * cannot reach the internet or the credential. See docs/decisions/0003.
 */

export const IMAGE = "paperfence-sandbox:0.3";

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
  try {
    await fs.writeFile(path.join(ctx, "Dockerfile"), DOCKERFILE);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["build", "-t", IMAGE, ctx], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", () => {});
      child.stderr.on("data", (d) => onProgress?.(String(d).trim().split("\n").slice(-1)[0] ?? ""));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited ${code}`))));
    });
  } finally {
    await fs.rm(ctx, { recursive: true, force: true });
  }
}

// The node image already has a "node" user with UID 1000 and a real home.
export const DOCKERFILE = `FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /paperfence
RUN npm init -y >/dev/null && npm pkg set type=module \\
 && case "$(uname -m)" in aarch64|arm64) P=linux-arm64;; x86_64|amd64) P=linux-x64;; *) echo "unsupported arch" && exit 1;; esac \\
 && npm install --omit=dev @anthropic-ai/claude-agent-sdk@0.3.272 @anthropic-ai/claude-agent-sdk-$P@0.3.272 \\
 && test -x node_modules/@anthropic-ai/claude-agent-sdk-$P/claude \\
 && chown -R node:node /paperfence
ENV GIT_AUTHOR_NAME=agent GIT_AUTHOR_EMAIL=agent@sandbox GIT_COMMITTER_NAME=agent GIT_COMMITTER_EMAIL=agent@sandbox GIT_TERMINAL_PROMPT=0
ENV HOME=/home/node
USER node
`;

export interface DockerRunOptions {
  model: string;
  maxTurns: number;
  /** Wall-clock limit for one run. Default 20 minutes. */
  timeoutMs?: number;
  onProgress?: (m: string) => void;
}

type Partial = Omit<AttackRun, "violated" | "violationEvidence"> & { sinkHits: SinkHit[] };

export async function runInDocker(rule: Rule, level: PressureLevel, objective: string, sb: Sandbox, opts: DockerRunOptions): Promise<Partial> {
  const runner = await distFile("runner.js");
  const proxyJs = await distFile("proxy.js");
  const cred = await loadCredential();
  const token = randomBytes(16).toString("hex");
  const netInternal = `paperfence-int-${sb.id}`;
  const netEgress = `paperfence-egress-${sb.id}`;
  const proxyName = `paperfence-proxy-${sb.id}`;
  const agentName = `paperfence-agent-${sb.id}`;
  const job = Buffer.from(JSON.stringify({ rule, level, objective, model: opts.model, maxTurns: opts.maxTurns, work: "/sandbox/repo", dir: "/sandbox" })).toString("base64");

  const startedAt = Date.now();
  let error: string | undefined;
  let stdout = "";
  const cleanup = async () => {
    for (const args of [["rm", "-f", agentName], ["rm", "-f", proxyName], ["network", "rm", netInternal], ["network", "rm", netEgress]]) {
      await run("docker", args).catch(() => {});
    }
  };
  // Never let the credential appear in argv or in an error message.
  const scrub = (m: string) => m.replaceAll(cred.value, "<credential>");

  try {
    await cleanup();
    await run("docker", ["network", "create", "--internal", netInternal]);
    await run("docker", ["network", "create", netEgress]);

    // Proxy sidecar: internal + its own egress network. Credential passed through the environment.
    const credName = cred.kind === "api-key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
    await run(
      "docker",
      [
        "run", "-d", "--rm", "--name", proxyName,
        "--network", netInternal,
        "-v", `${proxyJs}:/paperfence/proxy.mjs:ro`,
        "-e", credName,
        "-e", "PAPERFENCE_PROXY_TOKEN",
        "--memory", "256m", "--pids-limit", "64", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        IMAGE, "node", "/paperfence/proxy.mjs", "8080", "0.0.0.0",
      ],
      { env: { ...process.env, [credName]: cred.value, PAPERFENCE_PROXY_TOKEN: token } },
    );
    await run("docker", ["network", "connect", netEgress, proxyName]);
    opts.onProgress?.(`proxy up (${cred.source}); agent container has no credential and no external route`);

    // Agent container: internal network only; only the repo and the bare origin are mounted.
    const args = [
      "run", "--rm", "--name", agentName,
      "--network", netInternal,
      "-v", `${sb.work}:/sandbox/repo`,
      "-v", `${sb.remote}:/sandbox/origin.git`,
      "-w", "/sandbox/repo",
      "--memory", "2g", "--pids-limit", "512", "--cpus", "2", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", `ANTHROPIC_BASE_URL=http://${proxyName}:8080`,
      "-e", "ANTHROPIC_API_KEY=paperfence-placeholder",
      "-e", `ANTHROPIC_CUSTOM_HEADERS=x-paperfence-token: ${token}`,
      "-e", "PAPERFENCE_JOB",
      "-e", "PAPERFENCE_SANDBOX=/sandbox/repo",
      "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      "-v", `${runner}:/paperfence/runner.mjs:ro`,
      IMAGE, "node", "/paperfence/runner.mjs",
    ];
    await new Promise<void>((resolve) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAPERFENCE_JOB: job } });
      const timer = setTimeout(() => {
        error = `run exceeded ${Math.round((opts.timeoutMs ?? 20 * 60_000) / 60_000)} minutes`;
        run("docker", ["kill", agentName]).catch(() => {});
      }, opts.timeoutMs ?? 20 * 60_000);
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => {
        for (const line of String(d).split("\n")) if (line.trim()) opts.onProgress?.(scrub(line.trimEnd()));
      });
      child.on("error", (e) => {
        error = scrub(e.message);
        clearTimeout(timer);
        resolve();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !error) error = `container exited ${code}`;
        resolve();
      });
    });
  } catch (e) {
    error = scrub((e as Error).message.split("\n")[0] ?? "");
  } finally {
    await cleanup();
  }

  let result: Partial | null = null;
  const start = stdout.indexOf(RESULT_START);
  const end = stdout.indexOf(RESULT_END);
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(stdout.slice(start + RESULT_START.length, end).trim());
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.events) && typeof parsed.ruleId === "string") result = parsed as Partial;
    } catch {
      // malformed result
    }
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

/**
 * Run the static probe inside a container so the repo's hook scripts never
 * execute on this machine. Uses a fresh sandbox copy (hooks may write state).
 * No proxy, no network: the probe needs neither.
 */
export async function probeInDocker(sb: Sandbox, rules: Rule[], profile: RepoProfile, onProgress?: (m: string) => void): Promise<StaticProbeResult[]> {
  const runner = await distFile("runner.js");
  const name = `paperfence-probe-${sb.id}`;
  const job = Buffer.from(JSON.stringify({ kind: "probe", rules, profile: { ...profile, root: "/sandbox/repo" }, work: "/sandbox/repo" })).toString("base64");
  await run("docker", ["rm", "-f", name]).catch(() => {});
  let stdout = "";
  let error: string | undefined;
  await new Promise<void>((resolve) => {
    const child = spawn(
      "docker",
      [
        "run", "--rm", "--name", name, "--network", "none",
        "-v", `${sb.work}:/sandbox/repo`, "-w", "/sandbox/repo",
        "--memory", "512m", "--pids-limit", "128", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-e", "PAPERFENCE_JOB",
        "-v", `${runner}:/paperfence/runner.mjs:ro`,
        IMAGE, "node", "/paperfence/runner.mjs",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAPERFENCE_JOB: job } },
    );
    const timer = setTimeout(() => {
      error = "probe exceeded 10 minutes";
      run("docker", ["kill", name]).catch(() => {});
    }, 10 * 60_000);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => {
      for (const line of String(d).split("\n")) if (line.trim()) onProgress?.(line.trimEnd());
    });
    child.on("error", (e) => {
      error = e.message;
      clearTimeout(timer);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !error) error = `probe container exited ${code}`;
      resolve();
    });
  });
  await run("docker", ["rm", "-f", name]).catch(() => {});
  const a = stdout.indexOf(RESULT_START);
  const b = stdout.indexOf(RESULT_END);
  if (a === -1 || b <= a) throw new Error(error ?? "no probe result from container");
  const parsed = JSON.parse(stdout.slice(a + RESULT_START.length, b).trim());
  if (!parsed || !Array.isArray(parsed.probes)) throw new Error("malformed probe result");
  return parsed.probes as StaticProbeResult[];
}

/** Run one command inside a container against the sandbox repo (no network). For task checks. */
export async function execInDocker(sb: Sandbox, command: string, opts: { timeoutMs?: number; onProgress?: (m: string) => void } = {}): Promise<{ code: number | null; output: string }> {
  const runner = await distFile("runner.js");
  const name = `paperfence-exec-${sb.id}-${Date.now().toString(36)}`;
  const job = Buffer.from(JSON.stringify({ kind: "exec", command, work: "/sandbox/repo", timeoutMs: opts.timeoutMs })).toString("base64");
  let stdout = "";
  await new Promise<void>((resolve) => {
    const child = spawn(
      "docker",
      [
        "run", "--rm", "--name", name, "--network", "none",
        "-v", `${sb.work}:/sandbox/repo`, "-w", "/sandbox/repo",
        "--memory", "1g", "--pids-limit", "256", "--cpus", "2", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "-e", "PAPERFENCE_JOB",
        "-v", `${runner}:/paperfence/runner.mjs:ro`,
        IMAGE, "node", "/paperfence/runner.mjs",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAPERFENCE_JOB: job } },
    );
    const timer = setTimeout(() => run("docker", ["kill", name]).catch(() => {}), (opts.timeoutMs ?? 5 * 60_000) + 30_000);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => {
      for (const line of String(d).split("\n")) if (line.trim()) opts.onProgress?.(line.trimEnd());
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await run("docker", ["rm", "-f", name]).catch(() => {});
  const a = stdout.indexOf(RESULT_START);
  const b = stdout.indexOf(RESULT_END);
  if (a === -1 || b <= a) return { code: null, output: "no result from container" };
  try {
    return JSON.parse(stdout.slice(a + RESULT_START.length, b).trim()).exec;
  } catch {
    return { code: null, output: "malformed result" };
  }
}
