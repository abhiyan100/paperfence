import { createHash } from "node:crypto";
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
  /** Every file this would write, as path -> exact contents. Populated on a dry run so the diff is reviewable before anything lands. */
  patch: { path: string; before: string | null; after: string }[];
}

const HOOK_CMD = "node .claude/hooks/paperfence-guard.cjs";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

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

  // Everything this call would write, computed the same way whether or not we
  // write it, so a dry run shows the bytes that would land rather than a
  // summary of them.
  const guardBody = renderHookScript();
  const policyBody = JSON.stringify(plan.policy, null, 2) + "\n";
  const settingsBody = JSON.stringify(settings, null, 2) + "\n";
  const gi = path.join(root, ".gitignore");
  const gitignoreBefore = await fs.readFile(gi, "utf8").catch(() => null);
  const needsGitignore = !(gitignoreBefore ?? "").split("\n").some((l) => l.trim() === ".claude/.paperfence-session-*.json");
  const gitignoreBody = ((gitignoreBefore ?? "").trimEnd() + "\n.claude/.paperfence-session-*.json\n").replace(/^\n/, "");

  const patch: ApplyResult["patch"] = [
    { path: ".claude/hooks/paperfence-guard.cjs", before: await fs.readFile(path.join(hooksDir, "paperfence-guard.cjs"), "utf8").catch(() => null), after: guardBody },
    { path: ".claude/hooks/policy.json", before: await fs.readFile(path.join(hooksDir, "policy.json"), "utf8").catch(() => null), after: policyBody },
    { path: ".claude/settings.json", before: raw, after: settingsBody },
    ...(needsGitignore ? [{ path: ".gitignore", before: gitignoreBefore, after: gitignoreBody }] : []),
  ].filter((f) => f.before !== f.after);

  if (!opts.dryRun) {
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, "paperfence-guard.cjs"), guardBody, { mode: 0o755 });
    wrote.push(".claude/hooks/paperfence-guard.cjs");
    // policy.json is generated wholesale, so a team that hand-edited it lost
    // the edit on the next harden with nothing said. A copy is kept whenever
    // the file on disk is not one paperfence itself last wrote. The stamp is a
    // sibling file rather than a field, so the policy the guard reads keeps
    // exactly the shape it had.
    const policyPath = path.join(hooksDir, "policy.json");
    const existing = await fs.readFile(policyPath, "utf8").catch(() => null);
    if (existing !== null && existing !== policyBody) {
      const stamp = await fs.readFile(path.join(hooksDir, ".policy.generated"), "utf8").catch(() => "");
      const ours = stamp.trim() === sha256(existing);
      if (!ours) {
        await fs.writeFile(policyPath + ".bak", existing);
        wrote.push(".claude/hooks/policy.json.bak");
      }
    }
    await fs.writeFile(policyPath, policyBody);
    await fs.writeFile(path.join(hooksDir, ".policy.generated"), sha256(policyBody) + "\n");
    wrote.push(".claude/hooks/policy.json");
    await fs.writeFile(settingsPath, settingsBody);
    wrote.push(".claude/settings.json");
    // Session state file the hook uses for "tests before commit". Keep it out of git.
    if (needsGitignore) {
      await fs.writeFile(gi, gitignoreBody);
      wrote.push(".gitignore");
    }
  }
  return { wrote, addedDeny, hookRegistered, patch };
}
