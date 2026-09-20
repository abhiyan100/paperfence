import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolEvent } from "../types.js";

/**
 * Drive Codex non-interactively and turn its event stream into tool events.
 *
 * `codex exec --json` emits JSONL. The items that matter:
 *
 *   {"type":"item.completed","item":{"type":"command_execution",
 *     "command":"/bin/zsh -lc 'cat a.txt'","aggregated_output":"hello\n",
 *     "exit_code":0,"status":"completed"}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * Two things about Codex differ from Claude Code and shape everything here.
 *
 * Commands arrive wrapped: `/bin/zsh -lc '<the real command>'`. The wrapper is
 * unwrapped so the matcher sees what actually ran, which is the same unwrapping
 * that `bash -lc` needed.
 *
 * And Codex's sandbox does not refuse a call. It runs the command confined, and
 * the operation inside it fails: a write under `read-only` comes back as
 * `zsh:1: operation not permitted`. So a blocked action looks like a command
 * that ran and failed, not like a denial, and the evidence is the effect not
 * happening rather than a refusal being recorded.
 */

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexRunOptions {
  cwd: string;
  sandbox: CodexSandbox;
  model?: string;
  /** Extra `-c key=value` overrides. */
  config?: Record<string, string>;
  /** Load only the repository's configuration, not the user's. */
  ignoreUserConfig?: boolean;
  /** Run repository hooks without a persisted trust entry. Only for a harness. */
  bypassHookTrust?: boolean;
  timeoutMs?: number;
  onProgress?: (m: string) => void;
}

export interface CodexRun {
  events: ToolEvent[];
  finalText: string;
  /** Codex reports token usage rather than a dollar figure. */
  usage?: { inputTokens: number; outputTokens: number };
  turns: number;
  error?: string;
  /** Raw JSONL, kept so a surprising result can be read back. */
  raw: string[];
}

/**
 * `/bin/zsh -lc 'cat a.txt'` is a wrapper around `cat a.txt`.
 *
 * Stripping the outer quotes is not enough. A single-quoted argument escapes a
 * literal quote as a four-character sequence, so a command naming a path with
 * a space was recorded with the escaping still in it and the matcher then saw
 * a different command from the one that ran. Undo the escaping too.
 */
export function unwrapShell(command: string): string {
  const m = /^\s*(?:\/\S+\/)?(?:sh|bash|zsh|dash|ksh)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*c\s+(.*)$/s.exec(command);
  if (!m) return command;
  const rest = m[1]!.trim();
  const q = rest[0];
  if (q === "'" && rest.endsWith("'") && rest.length > 1) {
    const inner = rest.slice(1, -1);
    // Inside single quotes the only possible escape is quote, backslash,
    // quote, quote, which stands for one literal quote.
    return inner.split("'\\''").join("'");
  }
  if (q === '"' && rest.endsWith('"') && rest.length > 1) {
    return rest.slice(1, -1).replace(/\\(["$`\\])/g, "$1");
  }
  return rest;
}

interface CodexItem {
  id?: string;
  type: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  text?: string;
  message?: string;
  path?: string;
  changes?: unknown;
}

export async function runCodex(prompt: string, opts: CodexRunOptions): Promise<CodexRun> {
  const args = ["exec", "--json", "--sandbox", opts.sandbox, "--skip-git-repo-check", "--ephemeral", "--color", "never"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.ignoreUserConfig !== false) args.push("--ignore-user-config");
  if (opts.bypassHookTrust) args.push("--enable", "hooks", "--dangerously-bypass-hook-trust");
  for (const [k, v] of Object.entries(opts.config ?? {})) args.push("-c", `${k}=${v}`);
  args.push(prompt);

  const events: ToolEvent[] = [];
  const raw: string[] = [];
  let finalText = "";
  let usage: CodexRun["usage"];
  let turns = 0;
  let error: string | undefined;

  await new Promise<void>((resolve) => {
    const child = spawn("codex", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Codex reads its credential from CODEX_HOME. Everything else is dropped:
      // the agent should not inherit this machine's other tokens.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        CODEX_HOME: process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "/tmp", ".codex"),
        LANG: process.env.LANG ?? "C.UTF-8",
        TERM: "dumb",
        NO_COLOR: "1",
        GIT_TERMINAL_PROMPT: "0",
        PAPERFENCE: "1",
      },
    });
    const timer = setTimeout(
      () => {
        error = `codex exec exceeded ${Math.round((opts.timeoutMs ?? 5 * 60_000) / 1000)}s`;
        child.kill("SIGKILL");
      },
      opts.timeoutMs ?? 5 * 60_000,
    );

    let buf = "";
    child.stdout.on("data", (d) => {
      buf += String(d);
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        raw.push(line);
        let msg: { type?: string; item?: CodexItem; usage?: { input_tokens?: number; output_tokens?: number } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "turn.completed") {
          usage = { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 };
          continue;
        }
        const item = msg.item;
        if (!item || msg.type !== "item.completed") continue;
        if (item.type === "agent_message" && item.text) {
          turns++;
          finalText = item.text;
          opts.onProgress?.(item.text.slice(0, 120));
          continue;
        }
        if (item.type === "error" && item.message) {
          // Codex reports configuration problems as items, not as a failed run.
          if (!/deprecated/i.test(item.message)) error = item.message;
          continue;
        }
        if (item.type === "command_execution" && typeof item.command === "string") {
          const command = unwrapShell(item.command);
          const failed = typeof item.exit_code === "number" && item.exit_code !== 0;
          events.push({
            ts: Date.now(),
            tool: "Bash",
            input: { command },
            result: (item.aggregated_output ?? "").slice(0, 20_000),
            // Codex confines rather than refusing, so nothing here is "denied".
            // A refused operation shows up as a command that ran and failed.
            outcome: failed ? "failed" : "ran",
          });
          opts.onProgress?.(`Bash ${command.slice(0, 100)}`);
          continue;
        }
        if (item.type === "file_change" || item.type === "patch") {
          // A file change names its paths in `changes`, not in `path`. Requiring
          // `path` dropped every edit, so a run that rewrote files produced an
          // empty event list and looked like a run that did nothing.
          const paths: string[] = [];
          if (typeof item.path === "string") paths.push(item.path);
          if (Array.isArray(item.changes)) {
            for (const c of item.changes as { path?: unknown }[]) {
              if (c && typeof c.path === "string") paths.push(c.path);
            }
          }
          for (const file_path of paths.length ? paths : ["(unknown path)"]) {
            events.push({ ts: Date.now(), tool: "Edit", input: { file_path }, outcome: item.status === "failed" ? "failed" : "ran" });
            opts.onProgress?.(`Edit ${file_path}`);
          }
          continue;
        }
      }
    });
    child.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) opts.onProgress?.(s.split("\n").slice(-1)[0]!.slice(0, 160));
    });
    child.on("error", (e) => {
      error = e.message.includes("ENOENT") ? "the codex CLI is not on PATH" : e.message;
      clearTimeout(timer);
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !error) error = `codex exec exited ${code}`;
      resolve();
    });
  });

  return { events, finalText: finalText.trim().slice(0, 4000), usage, turns, error, raw };
}

/** Is the codex CLI available, and what version? */
export async function codexVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.trim() || null));
  });
}

/** Does this machine have a Codex credential? Checked without reading it. */
export async function codexAuthPresent(): Promise<boolean> {
  const home = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex");
  return fs.stat(path.join(home, "auth.json")).then(() => true).catch(() => false);
}
