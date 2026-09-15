import { spawn } from "node:child_process";
import type { HookMatcherGroup, SettingsJson } from "./discover.js";
import type { ToolCall } from "./permissions.js";

/**
 * Fire the repo's own PreToolUse hooks with a payload shaped exactly like
 * Claude Code's, and see whether any of them would block the call.
 *
 * Exit code 2 blocks. JSON on stdout with permissionDecision "deny" blocks.
 * Anything else lets the call through.
 */

export interface HookFireResult {
  blocked: boolean;
  command: string;
  matcher?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
  timedOut?: boolean;
}

function matcherApplies(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === "*" || matcher === "") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher.split("|").map((s) => s.trim()).includes(tool);
  }
}

function runCommand(command: string, payload: string, cwd: string, timeoutMs: number): Promise<HookFireResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/",
        LANG: process.env.LANG ?? "C.UTF-8",
        CLAUDE_PROJECT_DIR: cwd,
        PAPERFENCE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      // A timed-out hook never blocks; Claude Code lets the call continue.
      if (timedOut) {
        resolve({ blocked: false, command, exitCode: code, stdout, stderr, reason: "timed out", timedOut });
        return;
      }
      let blocked = code === 2;
      let reason: string | undefined = blocked ? stderr.trim() || "exit code 2" : undefined;
      if (!blocked && stdout.trim().startsWith("{")) {
        // Well-formed JSON on stdout is honoured on any exit code; hookSpecificOutput must name the event.
        try {
          const j = JSON.parse(stdout);
          const hso = j?.hookSpecificOutput;
          if (hso && hso.hookEventName === "PreToolUse" && hso.permissionDecision === "deny") {
            blocked = true;
            reason = hso.permissionDecisionReason ?? "hook returned deny";
          } else if (j?.continue === false) {
            blocked = true;
            reason = j?.stopReason ?? "hook returned continue: false";
          } else if (hso && hso.permissionDecision === "deny" && hso.hookEventName !== "PreToolUse") {
            reason = "hook printed a deny without hookEventName: PreToolUse, which Claude Code ignores";
          }
        } catch {
          // not JSON, fine
        }
      }
      resolve({ blocked, command, exitCode: code, stdout, stderr, reason, timedOut });
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

export async function firePreToolUseHooks(
  settings: SettingsJson,
  call: ToolCall,
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<HookFireResult[]> {
  const groups: HookMatcherGroup[] = settings.hooks?.PreToolUse ?? [];
  const payload = JSON.stringify({
    session_id: "paperfence-probe",
    transcript_path: "/dev/null",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: call.tool,
    tool_input: call.input,
    tool_use_id: "toolu_paperfence",
  });
  const results: HookFireResult[] = [];
  for (const group of groups) {
    if (!matcherApplies(group.matcher, call.tool)) continue;
    for (const h of group.hooks) {
      if (h.type !== "command" || !h.command) continue;
      // Respect the hook's own timeout (seconds; default 600). Cap at what the caller allows so scans stay fast.
      const configured = typeof h.timeout === "number" ? h.timeout * 1000 : 600_000;
      const r = await runCommand(h.command, payload, cwd, Math.min(configured, opts.timeoutMs ?? 30_000));
      results.push({ ...r, matcher: group.matcher });
    }
  }
  return results;
}
