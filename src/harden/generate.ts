import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Rule, RuleCategory } from "../types.js";

/**
 * Turn a wish into a gate.
 *
 * For each category we know the cheapest mechanical enforcement that Claude
 * Code honours without a human present:
 *   - a permissions.deny entry (evaluated before any prompt, cannot be talked around)
 *   - a PreToolUse hook that exits 2 (same, but can express things deny rules cannot,
 *     like "no commit unless tests ran this session" or "no edits under infra/")
 *
 * We generate one hook script that handles every category, driven by a small
 * JSON policy, so the user has one file to read instead of ten.
 */

export interface HardenPlan {
  deny: string[];
  policy: Policy;
  notes: string[];
}

/**
 * "Run X before Y". Y matters: a rule that says lint before pushing is not a
 * rule about committing, and compiling it as one both blocks work that is
 * allowed and lets through the thing that is not.
 */
export type GatedAction = "commit" | "push" | "pull-request";

/**
 * Which action a "run X before Y" rule gates.
 *
 * Only commit and push existed, so "run `pnpm lint` before opening a pull
 * request" was compiled as a push: it blocked ordinary pushes, which is work
 * the rule allows, and let `gh pr create` through, which is the thing the rule
 * is about.
 */
export function gatedAction(target: string | undefined): GatedAction {
  const t = (target ?? "").toLowerCase().replace(/[`_]/g, " ").trim();
  if (/\b(pr|pull request|pull-request|merge request|review)\b/.test(t)) return "pull-request";
  if (/\bpush\b/.test(t)) return "push";
  return "commit";
}

export interface RequireBefore {
  /** The command that must have run. */
  command: string;
  /** What it must have run before. */
  action: GatedAction;
}

export interface Policy {
  protectedBranches: string[];
  protectedTestPaths: string[];
  secretFiles: string[];
  forbiddenPaths: string[];
  allowedPaths: string[];
  requireBefore: RequireBefore[];
  askFirstCommands: string[];
  blockDestructive: boolean;
  blockForcePush: boolean;
  blockInstall: boolean;
  blockNetwork: boolean;
}

export function planHardening(rules: Rule[], categoriesToFix?: Set<RuleCategory>): HardenPlan {
  const policy: Policy = {
    protectedBranches: [],
    protectedTestPaths: [],
    secretFiles: [],
    forbiddenPaths: [],
    allowedPaths: [],
    requireBefore: [],
    askFirstCommands: [],
    blockDestructive: false,
    blockForcePush: false,
    blockInstall: false,
    blockNetwork: false,
  };
  const deny = new Set<string>();
  const notes: string[] = [];
  const push = (arr: string[], v: string) => {
    if (v && !arr.includes(v)) arr.push(v);
  };

  for (const r of rules) {
    if (categoriesToFix && !categoriesToFix.has(r.category)) continue;
    switch (r.category) {
      case "protect-branch":
        push(policy.protectedBranches, r.targets[0] ?? "main");
        break;
      case "protect-tests":
        push(policy.protectedTestPaths, (r.targets[0] ?? "tests/").replace(/\/$/, ""));
        break;
      case "protect-secrets":
        for (const t of r.targets.length ? r.targets : [".env"]) {
          push(policy.secretFiles, t.replace(/^\.\//, ""));
          deny.add(`Read(./${t.replace(/^\.\//, "")})`);
        }
        break;
      case "no-exfil":
        policy.blockNetwork = true;
        // Not a bare `WebFetch`: measured, a deny entry naming only a tool does
        // not stop the call. The generated hook refuses WebFetch instead.
        deny.add("WebFetch(domain:*)");
        deny.add("Bash(curl *)");
        deny.add("Bash(wget *)");
        deny.add("Bash(*/curl *)");
        deny.add("Bash(*/wget *)");
        break;
      case "no-destructive":
        policy.blockDestructive = true;
        deny.add("Bash(rm -rf *)");
        deny.add("Bash(rm -fr *)");
        deny.add("Bash(rm -r *)");
        deny.add("Bash(git reset --hard *)");
        deny.add("Bash(git clean *)");
        break;
      case "no-force-push":
        policy.blockForcePush = true;
        break;
      case "no-install":
        policy.blockInstall = true;
        break;
      case "scope":
        for (const t of r.targets) {
          if (t.startsWith("!")) push(policy.forbiddenPaths, t.slice(1).replace(/\/$/, ""));
          else push(policy.allowedPaths, t.replace(/\/$/, ""));
        }
        break;
      case "require-before": {
        const command = r.targets[0] ?? "npm test";
        const action: GatedAction = gatedAction(r.targets[1]);
        if (!policy.requireBefore.some((x) => x.command === command && x.action === action)) policy.requireBefore.push({ command, action });
        break;
      }
      case "ask-first":
        if (r.targets[0]) push(policy.askFirstCommands, r.targets[0]);
        break;
      default:
        notes.push(`No mechanical fix for: "${r.text}"`);
    }
  }

  if (policy.blockNetwork) notes.push("WebFetch is refused by the hook. A deny entry naming only a tool does not stop the call, so one is not generated.");
  if (policy.secretFiles.length) notes.push("Read() deny entries cover the Read tool and cat/head/tail/sed; the hook also blocks grep, source, redirects, and node/python one-liners that name the file.");
  if (policy.askFirstCommands.length) notes.push("Ask-first commands are blocked outright in unattended runs. When a human is present, move them to permissions.ask instead.");
  for (const r of policy.requireBefore) notes.push(`"${r.command}" must have run, successfully and in full, before a ${r.action}. Credit lasts 30 minutes and the agent cannot write the record.`);

  return { deny: [...deny].sort(), policy, notes };
}

/**
 * The hook script lives in templates/paperfence-guard.cjs as a real file so it
 * can be read, linted and tested without escaping. Resolved relative to this
 * module whether we run from src/ (tsx) or dist/.
 */
export function renderHookScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "templates", "paperfence-guard.cjs"), // src/harden -> templates
    path.join(here, "..", "templates", "paperfence-guard.cjs"), // dist -> templates
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  }
  throw new Error("templates/paperfence-guard.cjs not found");
}
