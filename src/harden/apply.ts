import { promises as fs } from "node:fs";
import path from "node:path";
import type { SettingsJson } from "../config/discover.js";
import type { HardenPlan } from "./generate.js";
import { renderHookScript } from "./generate.js";

/**
 * Write the plan into the repo:
 *   .claude/hooks/paperfence-guard.cjs  the hook (.cjs so it works in "type": "module" repos too)
 *   .claude/hooks/policy.json           what it enforces
 *   .claude/settings.json               deny entries + hook registration (merged, never clobbered)
 *
 * Returns what changed so the CLI can show a diff-ish summary.
 */
export interface ApplyResult {
  wrote: string[];
  addedDeny: string[];
  hookRegistered: boolean;
}

const HOOK_CMD = "node .claude/hooks/paperfence-guard.cjs";

export async function applyHardening(root: string, plan: HardenPlan, opts: { dryRun?: boolean } = {}): Promise<ApplyResult> {
  const hooksDir = path.join(root, ".claude", "hooks");
  const settingsPath = path.join(root, ".claude", "settings.json");
  const wrote: string[] = [];

  let settings: SettingsJson = {};
  const raw = await fs.readFile(settingsPath, "utf8").catch(() => null);
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${settingsPath} is not valid JSON (${(e as Error).message}); fix it before hardening so nothing gets overwritten`);
    }
  }
  settings.permissions ??= {};
  settings.permissions.deny ??= [];
  const addedDeny = plan.deny.filter((d) => !settings.permissions!.deny!.includes(d));
  settings.permissions.deny.push(...addedDeny);

  settings.hooks ??= {};
  let hookRegistered = false;
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    settings.hooks[event] ??= [];
    const already = settings.hooks[event]!.some((g) => g.hooks?.some((h) => h.command === HOOK_CMD));
    if (!already) {
      settings.hooks[event]!.push({
        matcher: event === "PreToolUse" ? "Bash|Read|Edit|Write|MultiEdit|NotebookEdit|WebFetch" : "Bash",
        hooks: [{ type: "command", command: HOOK_CMD, timeout: 10 }],
      });
      hookRegistered = true;
    }
  }
  // The hook and its policy must not be editable by the agent it constrains.
  for (const d of ["Edit(.claude/hooks/**)", "Edit(.claude/settings.json)", "Edit(.claude/settings.local.json)"]) {
    if (!settings.permissions.deny.includes(d)) {
      settings.permissions.deny.push(d);
      addedDeny.push(d);
    }
  }

  if (!opts.dryRun) {
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, "paperfence-guard.cjs"), renderHookScript(), { mode: 0o755 });
    wrote.push(".claude/hooks/paperfence-guard.cjs");
    await fs.writeFile(path.join(hooksDir, "policy.json"), JSON.stringify(plan.policy, null, 2) + "\n");
    wrote.push(".claude/hooks/policy.json");
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    wrote.push(".claude/settings.json");
    // Session state file the hook uses for "tests before commit". Keep it out of git.
    const gi = path.join(root, ".gitignore");
    const existing = await fs.readFile(gi, "utf8").catch(() => "");
    if (!existing.split("\n").some((l) => l.trim() === ".claude/.paperfence-session.json")) {
      await fs.writeFile(gi, existing.trimEnd() + "\n.claude/.paperfence-session.json\n");
      wrote.push(".gitignore");
    }
  }
  return { wrote, addedDeny, hookRegistered };
}
