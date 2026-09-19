import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Fingerprint } from "./types.js";

const run = promisify(execFile);

/**
 * What produced this report. Two runs with different fingerprints are not
 * comparable, and a report without one is an anecdote.
 */
export async function collectFingerprint(opts: { model?: string; sandbox: Fingerprint["sandbox"]; image?: string; approvalMode?: Fingerprint["approvalMode"]; cwd?: string } ): Promise<Fingerprint> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = [path.join(here, "..", "package.json"), path.join(here, "..", "..", "package.json")].find((p) => existsSync(p));
  let version = "unknown";
  let sdk: string | undefined;
  try {
    if (pkgPath) {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      version = pkg.version ?? version;
      const sdkPkg = path.join(path.dirname(pkgPath), "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
      sdk = JSON.parse(await fs.readFile(sdkPkg, "utf8")).version;
    }
  } catch {
    // fine
  }
  const commit = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: pkgPath ? path.dirname(pkgPath) : process.cwd() }).then((r) => r.stdout.trim()).catch(() => undefined);
  const claude = await run("claude", ["--version"], { timeout: 10_000 }).then((r) => r.stdout.trim().split("\n")[0]).catch(() => undefined);
  return {
    paperfence: version,
    paperfenceCommit: commit,
    claudeCode: claude,
    agentSdk: sdk,
    model: opts.model,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    sandbox: opts.sandbox,
    image: opts.image,
    approvalMode: opts.approvalMode ?? (opts.sandbox === "none" ? "n/a" : "auto-approve"),
    at: new Date().toISOString(),
  };
}

export function fingerprintLine(f: Fingerprint): string {
  const parts = [`paperfence ${f.paperfence}${f.paperfenceCommit ? `@${f.paperfenceCommit}` : ""}`];
  if (f.claudeCode) parts.push(`claude-code ${f.claudeCode.replace(/\s*\(Claude Code\)/, "")}`);
  if (f.agentSdk) parts.push(`sdk ${f.agentSdk}`);
  if (f.model) parts.push(`model ${f.model}`);
  parts.push(f.sandbox === "docker" ? `docker ${f.image ?? ""}`.trim() : f.sandbox === "host" ? "host sandbox (unsafe)" : "no live runs");
  if (f.sandbox !== "none") parts.push(`approvals ${f.approvalMode}`);
  parts.push(f.os);
  return parts.join(" · ");
}
