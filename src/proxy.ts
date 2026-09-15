/**
 * Credential broker for docker mode.
 *
 * The agent container never sees a real credential. It is told
 * ANTHROPIC_BASE_URL=http://<this proxy> and given a placeholder API key.
 * This process, which runs outside the adversary's reach, forwards only to
 * api.anthropic.com and swaps the placeholder for the real credential:
 *   - ANTHROPIC_API_KEY from the environment, or
 *   - the Claude Code OAuth token from the local login (macOS keychain or
 *     ~/.claude/.credentials.json), the same one the claude CLI uses.
 *
 * Anything that is not an Anthropic API path is refused, so the proxy is
 * also the only network egress the container has.
 *
 * Usage (used by docker.ts; can also run standalone for debugging):
 *   node dist/proxy.js <port> [bindHost]
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const UPSTREAM = "api.anthropic.com";
const ALLOWED_PATH = /^\/v1\/(messages|complete|models|organizations|count_tokens)/;

export interface Credential {
  kind: "api-key" | "oauth";
  value: string;
  source: string;
}

export async function loadCredential(): Promise<Credential> {
  if (process.env.ANTHROPIC_API_KEY) return { kind: "api-key", value: process.env.ANTHROPIC_API_KEY, source: "ANTHROPIC_API_KEY" };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: "oauth", value: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: "CLAUDE_CODE_OAUTH_TOKEN" };
  // Claude Code login on macOS: keychain item "Claude Code-credentials".
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
      const j = JSON.parse(raw);
      const tok = j?.claudeAiOauth?.accessToken;
      if (tok) return { kind: "oauth", value: tok, source: "macOS keychain (claude login)" };
    } catch {
      // not logged in via keychain
    }
  }
  // Linux / fallback: ~/.claude/.credentials.json
  try {
    const raw = await fs.readFile(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
    const j = JSON.parse(raw);
    const tok = j?.claudeAiOauth?.accessToken;
    if (tok) return { kind: "oauth", value: tok, source: "~/.claude/.credentials.json (claude login)" };
  } catch {
    // none
  }
  throw new Error("no Claude credential found: set ANTHROPIC_API_KEY, or run `claude login` on this machine");
}

export interface Proxy {
  port: number;
  host: string;
  requests: number;
  refused: number;
  close: () => Promise<void>;
}

export async function startProxy(opts: { port?: number; host?: string; credential?: Credential } = {}): Promise<Proxy> {
  const cred = opts.credential ?? (await loadCredential());
  const state = { requests: 0, refused: 0 };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (!ALLOWED_PATH.test(url)) {
      state.refused++;
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "paperfence proxy: only Anthropic API paths are forwarded" }));
      return;
    }
    state.requests++;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lk = k.toLowerCase();
      if (["host", "x-api-key", "authorization", "connection", "content-length"].includes(lk)) continue;
      headers[lk] = v;
    }
    if (cred.kind === "api-key") {
      headers["x-api-key"] = cred.value;
    } else {
      headers["authorization"] = `Bearer ${cred.value}`;
      // OAuth tokens need this beta flag; the CLI sends it when it knows it is on OAuth.
      const beta = String(headers["anthropic-beta"] ?? "");
      if (!beta.includes("oauth-2025-04-20")) headers["anthropic-beta"] = beta ? `${beta},oauth-2025-04-20` : "oauth-2025-04-20";
    }
    headers["host"] = UPSTREAM;

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length) headers["content-length"] = String(body.length);
      const up = https.request({ host: UPSTREAM, port: 443, method: req.method, path: url, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on("error", (e) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `upstream: ${e.message}` }));
      });
      up.end(body);
    });
  });

  const host = opts.host ?? "127.0.0.1";
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve((server.address() as { port: number }).port));
  });
  return {
    port,
    host,
    get requests() {
      return state.requests;
    },
    get refused() {
      return state.refused;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// Standalone entry: node dist/proxy.js <port> [host]
if (process.argv[1] && /proxy\.[cm]?js$/.test(process.argv[1]) && process.argv[2]) {
  const p = await startProxy({ port: Number(process.argv[2]), host: process.argv[3] ?? "0.0.0.0" });
  process.stderr.write(`paperfence proxy listening on ${p.host}:${p.port}\n`);
}
