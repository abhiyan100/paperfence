/**
 * Credential broker for docker mode.
 *
 * The agent container never sees a real credential. It is told
 * ANTHROPIC_BASE_URL=http://<this proxy> and given a placeholder API key.
 * This process, which runs outside the adversary's reach, forwards only
 * POST /v1/messages (and count_tokens) to api.anthropic.com and swaps the
 * placeholder for the real credential:
 *   - ANTHROPIC_API_KEY from the environment, or
 *   - the Claude Code OAuth token from the local login (macOS keychain or
 *     ~/.claude/.credentials.json), the same one the claude CLI uses.
 *
 * A per-run token (PAPERFENCE_PROXY_TOKEN) must arrive in the
 * x-paperfence-token header; the agent sends it through
 * ANTHROPIC_CUSTOM_HEADERS. That keeps anything else that can reach the
 * proxy from using it.
 *
 * In docker mode the proxy listens on a unix socket on a volume shared with
 * the agent container, and the agent container has no network at all. See
 * docs/decisions/0003-sandbox-network.md.
 *
 * Usage (used by docker.ts; can also run standalone for debugging):
 *   node dist/proxy.js <port> [bindHost]
 *   node dist/proxy.js --socket /sock/api.sock
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const UPSTREAM = "api.anthropic.com";
const ALLOWED = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const MAX_BODY = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const HOP_BY_HOP = new Set(["host", "x-api-key", "authorization", "connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "x-paperfence-token"]);

export interface Credential {
  kind: "api-key" | "oauth";
  value: string;
  source: string;
}

export async function loadCredential(): Promise<Credential> {
  if (process.env.ANTHROPIC_API_KEY) return { kind: "api-key", value: process.env.ANTHROPIC_API_KEY, source: "ANTHROPIC_API_KEY" };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: "oauth", value: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: "CLAUDE_CODE_OAUTH_TOKEN" };
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
      const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      if (tok) return { kind: "oauth", value: tok, source: "macOS keychain (claude login)" };
    } catch {
      // not logged in via keychain
    }
  }
  try {
    const raw = await fs.readFile(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
    const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    if (tok) return { kind: "oauth", value: tok, source: "~/.claude/.credentials.json (claude login)" };
  } catch {
    // none
  }
  throw new Error("no Claude credential found: set ANTHROPIC_API_KEY, or run `claude login` on this machine");
}

export interface Proxy {
  port: number;
  host: string;
  /** Set when listening on a unix socket instead of a TCP port. */
  socketPath?: string;
  readonly requests: number;
  readonly refused: number;
  close: () => Promise<void>;
}

export async function startProxy(opts: { port?: number; host?: string; socketPath?: string; credential?: Credential; token?: string } = {}): Promise<Proxy> {
  const cred = opts.credential ?? (await loadCredential());
  const token = opts.token ?? process.env.PAPERFENCE_PROXY_TOKEN ?? "";
  const state = { requests: 0, refused: 0 };

  const refuse = (res: http.ServerResponse, code: number, msg: string) => {
    state.refused++;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "paperfence_proxy", message: msg } }));
  };

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (token && req.headers["x-paperfence-token"] !== token) return refuse(res, 401, "missing or wrong x-paperfence-token");
    if (req.method !== "POST" || !ALLOWED.has(url)) return refuse(res, 403, "only POST /v1/messages is forwarded");

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k.toLowerCase()] = v;
    }
    if (cred.kind === "api-key") headers["x-api-key"] = cred.value;
    else {
      headers["authorization"] = `Bearer ${cred.value}`;
      const beta = String(headers["anthropic-beta"] ?? "");
      if (!beta.includes("oauth-2025-04-20")) headers["anthropic-beta"] = beta ? `${beta},oauth-2025-04-20` : "oauth-2025-04-20";
    }
    headers["host"] = UPSTREAM;

    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("close", () => {
      if (tooBig) refuse(res, 413, "request body too large");
    });
    req.on("end", () => {
      if (tooBig) return;
      state.requests++;
      const body = Buffer.concat(chunks);
      headers["content-length"] = String(body.length);
      const up = https.request({ host: UPSTREAM, port: 443, method: "POST", path: req.url ?? url, headers, timeout: UPSTREAM_TIMEOUT_MS }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on("timeout", () => up.destroy(new Error("upstream timeout")));
      up.on("error", (e) => {
        if (!res.headersSent) refuse(res, 502, `upstream: ${e.message}`);
        else res.destroy();
      });
      res.on("close", () => {
        if (!up.destroyed) up.destroy();
      });
      up.end(body);
    });
  });
  server.requestTimeout = UPSTREAM_TIMEOUT_MS + 5000;
  server.headersTimeout = 30_000;

  const host = opts.host ?? "127.0.0.1";
  let port = 0;
  if (opts.socketPath) {
    // Stale socket from a killed run would block bind().
    await fs.rm(opts.socketPath, { force: true }).catch(() => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.socketPath!, () => resolve());
    });
    // The agent container runs as the same uid, but be explicit rather than lucky.
    await fs.chmod(opts.socketPath, 0o660).catch(() => {});
  } else {
    port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, host, () => resolve((server.address() as { port: number }).port));
    });
  }
  return {
    port,
    host,
    socketPath: opts.socketPath,
    get requests() {
      return state.requests;
    },
    get refused() {
      return state.refused;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * Forward a loopback TCP port to a unix socket.
 *
 * Runs inside the agent container, which has no network namespace routes at
 * all: no gateway, no DNS, nothing but loopback. The SDK wants an
 * ANTHROPIC_BASE_URL it can dial over TCP, so this gives it one, and the
 * bytes leave the container through a socket file on a shared volume.
 */
export async function forwardToSocket(opts: { port: number; socketPath: string; waitMs?: number }): Promise<{ close: () => Promise<void> }> {
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  // The proxy container may still be starting.
  for (;;) {
    const there = await fs.stat(opts.socketPath).then((s) => s.isSocket()).catch(() => false);
    if (there) break;
    if (Date.now() > deadline) throw new Error(`no proxy socket at ${opts.socketPath} after ${Math.round((opts.waitMs ?? 30_000) / 1000)}s`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const server = net.createServer((client) => {
    const upstream = net.connect(opts.socketPath);
    const bail = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", bail);
    upstream.on("error", bail);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  return { close: () => new Promise((r) => server.close(() => r())) };
}

// Standalone entry: node dist/proxy.js <port> [host] | node dist/proxy.js --socket <path>
if (process.argv[1] && /proxy\.[cm]?js$/.test(process.argv[1]) && process.argv[2]) {
  if (process.argv[2] === "--socket" && process.argv[3]) {
    const p = await startProxy({ socketPath: process.argv[3] });
    process.stderr.write(`paperfence proxy listening on ${p.socketPath}${process.env.PAPERFENCE_PROXY_TOKEN ? " (token required)" : ""}\n`);
  } else {
    const p = await startProxy({ port: Number(process.argv[2]), host: process.argv[3] ?? "0.0.0.0" });
    process.stderr.write(`paperfence proxy listening on ${p.host}:${p.port}${process.env.PAPERFENCE_PROXY_TOKEN ? " (token required)" : ""}\n`);
  }
}
