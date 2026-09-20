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
 *   --network none                              egress network
 *   ┌────────────────────────┐              ┌──────────────┐
 *   │ agent                  │              │ proxy        │
 *   │ Claude Code via SDK    │  shared      │ POST         │
 *   │ 127.0.0.1:8080 ────────┼── volume ───►│ /v1/messages │──► api.anthropic.com
 *   │   forwarder in runner  │  api.sock    │ only; swaps  │
 *   │ repo + origin mounted  │              │ in the cred  │
 *   └────────────────────────┘              └──────────────┘
 *
 * The agent container has no network namespace routes at all: no gateway, no
 * DNS, no other containers, only loopback. Its single path to the model API
 * is a unix socket on a volume it shares with the proxy, reached through a
 * loopback forwarder the runner starts. The proxy requires the per-run token,
 * forwards only POST /v1/messages, and holds the only credential.
 *
 * The job goes in through an environment variable and the result comes out on
 * stdout, so nothing the agent can write is trusted.
 *
 * See docs/decisions/0003-sandbox-network.md for what this replaced and why.
 */

export const IMAGE = "paperfence-sandbox:0.4";

/** Where the proxy's unix socket lives inside both containers. */
export const SOCK_DIR = "/paperfence/sock";
export const PROXY_SOCKET = `${SOCK_DIR}/api.sock`;

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
 && mkdir -p /paperfence/sock \\
 && chown -R node:node /paperfence
# /paperfence/sock is where the proxy's unix socket volume mounts. Docker seeds
# a new named volume with the ownership of the image directory, so it has to
# exist here and belong to node, or neither container can use it.
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
  const netEgress = `paperfence-egress-${sb.id}`;
  const proxyName = `paperfence-proxy-${sb.id}`;
  const agentName = `paperfence-agent-${sb.id}`;
  // A named volume, not a bind mount: unix sockets do not work across the
  // macOS filesystem bridge, but do work on a volume inside the Linux VM.
  const sockVol = `paperfence-sock-${sb.id}`;
  const job = Buffer.from(
    JSON.stringify({ rule, level, objective, model: opts.model, maxTurns: opts.maxTurns, work: "/sandbox/repo", dir: "/sandbox", proxySocket: PROXY_SOCKET, proxyPort: 8080 }),
  ).toString("base64");

  const startedAt = Date.now();
  let error: string | undefined;
  let stdout = "";
  const cleanup = async () => {
    for (const args of [["rm", "-f", agentName], ["rm", "-f", proxyName], ["network", "rm", netEgress], ["volume", "rm", "-f", sockVol]]) {
      await run("docker", args).catch(() => {});
    }
  };
  // Never let the credential appear in argv or in an error message.
  const scrub = (m: string) => m.replaceAll(cred.value, "<credential>");

  try {
    await cleanup();
    await run("docker", ["network", "create", netEgress]);
    await run("docker", ["volume", "create", sockVol]);

    // Proxy sidecar: egress only. It never shares a network with the agent.
    // Credential passed through the environment.
    const credName = cred.kind === "api-key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN";
    await run(
      "docker",
      [
        "run", "-d", "--rm", "--name", proxyName,
        "--network", netEgress,
        "-v", `${proxyJs}:/paperfence/proxy.mjs:ro`,
        "-v", `${sockVol}:${SOCK_DIR}`,
        "-e", credName,
        "-e", "PAPERFENCE_PROXY_TOKEN",
        "--memory", "256m", "--pids-limit", "64", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        IMAGE, "node", "/paperfence/proxy.mjs", "--socket", PROXY_SOCKET,
      ],
      { env: { ...process.env, [credName]: cred.value, PAPERFENCE_PROXY_TOKEN: token } },
    );
    opts.onProgress?.(`proxy up (${cred.source}); agent container has no credential, no network and no route to this machine`);

    // Agent container: no network at all. Only the repo, the bare origin and
    // the proxy's socket volume are mounted.
    const args = [
      "run", "--rm", "--name", agentName,
      "--network", "none",
      "-v", `${sockVol}:${SOCK_DIR}`,
      "-v", `${sb.work}:/sandbox/repo`,
      "-v", `${sb.remote}:/sandbox/origin.git`,
      "-w", "/sandbox/repo",
      "--memory", "2g", "--pids-limit", "512", "--cpus", "2", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", "ANTHROPIC_BASE_URL=http://127.0.0.1:8080",
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

  // The agent shares stdout with the runner. One envelope is the runner's; more
  // than one means something else wrote to the stream, and a trial whose
  // evidence channel is ambiguous is not evidence. Take the last, and say so.
  let result: Partial | null = null;
  const envelopes = countEnvelopes(stdout);
  if (envelopes > 1) {
    error = `the container emitted ${envelopes} result envelopes; exactly one is expected, so this trial's evidence cannot be trusted`;
  } else if (envelopes === 1) {
    const start = stdout.lastIndexOf(RESULT_START);
    const end = stdout.lastIndexOf(RESULT_END);
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(stdout.slice(start + RESULT_START.length, end).trim());
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.events) && typeof parsed.ruleId === "string") result = parsed as Partial;
      } catch {
        // malformed result
      }
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

/** How many complete result envelopes are in this stream. More than one means the stream was written to by something other than the runner. */
export function countEnvelopes(stdout: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const a = stdout.indexOf(RESULT_START, i);
    if (a === -1) break;
    const b = stdout.indexOf(RESULT_END, a);
    if (b === -1) break;
    n++;
    i = b + RESULT_END.length;
  }
  return n;
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

export interface IsolationCheck {
  name: string;
  /** True when the sandbox behaved as the threat model says it should. */
  ok: boolean;
  detail: string;
}

/**
 * Check the boundary rather than assert it.
 *
 * paperfence's whole claim is that what it observed happened inside a box.
 * These checks run the agent container with exactly the flags a trial uses
 * and confirm, from inside it, that there is no default route, no DNS, no
 * path to this machine, and no path to the proxy's network. Run by
 * `paperfence doctor`.
 */
export async function verifyIsolation(onProgress?: (m: string) => void): Promise<IsolationCheck[]> {
  await ensureImage(onProgress);
  const netEgress = `paperfence-doctor-egress-${Date.now().toString(36)}`;
  const probeName = `paperfence-doctor-${Date.now().toString(36)}`;
  const checks: IsolationCheck[] = [];

  const inAgent = async (script: string): Promise<{ code: number | null; out: string }> => {
    try {
      const { stdout, stderr } = await run(
        "docker",
        ["run", "--rm", "--name", `${probeName}-${Math.random().toString(36).slice(2, 8)}`, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", IMAGE, "sh", "-c", script],
        { timeout: 60_000 },
      );
      return { code: 0, out: (stdout + stderr).trim() };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? null, out: ((err.stdout ?? "") + (err.stderr ?? "")).trim() };
    }
  };

  onProgress?.("checking the agent container has no routes");
  const routes = await inAgent("ip route show 2>/dev/null || cat /proc/net/route");
  const hasDefault = /\bdefault\b/.test(routes.out) || /\n00000000/.test(routes.out);
  checks.push({
    name: "no default route",
    ok: !hasDefault,
    detail: hasDefault ? `the container has a default route: ${routes.out.split("\n")[0]}` : "the routing table has no gateway, so nothing outside loopback is addressable",
  });

  onProgress?.("checking DNS does not resolve");
  const dns = await inAgent("getent hosts api.anthropic.com >/dev/null 2>&1 && echo RESOLVED || echo NO_DNS");
  checks.push({
    name: "no DNS",
    ok: dns.out.includes("NO_DNS"),
    detail: dns.out.includes("NO_DNS") ? "name resolution fails inside the container" : "names resolve, so the container can address hosts by name",
  });

  onProgress?.("checking this machine is unreachable from the container");
  // 192.168.65.254 is Docker Desktop's gateway to the host; 172.17.0.1 is the
  // default bridge gateway on Linux. Under --network none neither is routable.
  const host = await inAgent("for h in 192.168.65.254 172.17.0.1 host.docker.internal; do timeout 3 curl -s -o /dev/null --connect-timeout 2 http://$h/ && echo REACHED_$h; done; echo DONE");
  const reached = host.out.match(/REACHED_\S+/g) ?? [];
  checks.push({
    name: "this machine is unreachable",
    ok: reached.length === 0,
    detail: reached.length ? `the container reached ${reached.join(", ")}` : "no route to the host gateway or to host.docker.internal",
  });

  onProgress?.("checking a container on the proxy's network is unreachable");
  try {
    await run("docker", ["network", "create", netEgress]);
    await run("docker", ["run", "-d", "--rm", "--name", probeName, "--network", netEgress, IMAGE, "node", "-e", "require('http').createServer((q,s)=>s.end('here')).listen(8080,'0.0.0.0')"]);
    const peer = await inAgent(`timeout 3 curl -s --connect-timeout 2 http://${probeName}:8080/ && echo REACHED || echo NO_ROUTE`);
    checks.push({
      name: "the proxy's network is unreachable",
      ok: !peer.out.includes("REACHED"),
      detail: peer.out.includes("REACHED") ? "the agent container reached a container on the proxy network" : "a service on the proxy's network is not addressable from the agent container",
    });
  } catch (e) {
    checks.push({ name: "the proxy's network is unreachable", ok: false, detail: `check did not run: ${(e as Error).message.split("\n")[0]}` });
  } finally {
    await run("docker", ["rm", "-f", probeName]).catch(() => {});
    await run("docker", ["network", "rm", netEgress]).catch(() => {});
  }

  onProgress?.("checking the container cannot raise its own privileges");
  const priv = await inAgent("id -u; (sudo -n true 2>/dev/null && echo SUDO_OK) || echo NO_SUDO");
  checks.push({
    name: "runs unprivileged",
    ok: !priv.out.includes("SUDO_OK") && !/^0$/m.test(priv.out),
    detail: priv.out.includes("SUDO_OK") ? "sudo works inside the container" : `runs as uid ${priv.out.split("\n")[0]} with no sudo`,
  });

  return checks;
}
