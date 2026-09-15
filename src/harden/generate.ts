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

export interface Policy {
  protectedBranches: string[];
  protectedTestPaths: string[];
  secretFiles: string[];
  forbiddenPaths: string[];
  allowedPaths: string[];
  requireBeforeCommit: string[];
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
    requireBeforeCommit: [],
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
        deny.add("WebFetch");
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
      case "require-before":
        push(policy.requireBeforeCommit, r.targets[0] ?? "npm test");
        break;
      case "ask-first":
        if (r.targets[0]) push(policy.askFirstCommands, r.targets[0]);
        break;
      default:
        notes.push(`No mechanical fix for: "${r.text}"`);
    }
  }

  // Secrets: a deny on Read is not enough (cat, grep, source all read the file). The hook covers Bash.
  if (policy.secretFiles.length) notes.push("Read() deny entries stop the Read tool; the hook also blocks cat/grep/head/source of those files in Bash.");
  if (policy.askFirstCommands.length) notes.push("Ask-first commands are blocked outright in unattended runs. When a human is present, move them to permissions.ask instead.");

  return { deny: [...deny].sort(), policy, notes };
}

/**
 * The hook script. Plain Node, no dependencies, reads the policy JSON next to it.
 * Exit 2 blocks and the stderr line is what the agent sees.
 */
export function renderHookScript(): string {
  return `#!/usr/bin/env node
// paperfence guard hook. Generated; edit policy.json, not this file.
// Runs on PreToolUse. Exit 2 = block. Anything written to stderr is shown to the agent.
const fs = require("fs");
const path = require("path");

const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "policy.json"), "utf8"));
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const tool = input.tool_name || "";
const ti = input.tool_input || {};
const cwd = input.cwd || process.cwd();
const stateFile = path.join(cwd, ".claude", ".paperfence-session.json");

function block(msg) {
  process.stderr.write("paperfence: " + msg + "\\n");
  process.exit(2);
}
function rel(p) {
  if (!p) return "";
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
  return path.relative(cwd, abs).split(path.sep).join("/");
}
function under(p, dir) {
  return p === dir || p.startsWith(dir + "/");
}
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; }
}
function writeState(s) {
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s)); } catch {}
}
const segments = (cmd) => cmd.split(/\\s*(?:&&|\\|\\||;|\\|)\\s*/).filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");

if (tool === "Read" || tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
  const p = rel(ti.file_path || ti.path || ti.notebook_path || "");
  for (const s of policy.secretFiles) {
    if (p === s || p.endsWith("/" + s)) block("reading " + s + " is not allowed");
  }
  if (tool !== "Read") {
    for (const d of policy.protectedTestPaths) {
      if (under(p, d)) block("editing tests under " + d + "/ is not allowed; fix the code instead");
    }
    if (/\\.(test|spec)\\.[cm]?[jt]sx?$/.test(p) && policy.protectedTestPaths.length) block("editing test files is not allowed; fix the code instead");
    for (const d of policy.forbiddenPaths) {
      if (under(p, d)) block("editing " + d + "/ is not allowed");
    }
    if (policy.allowedPaths.length && !policy.allowedPaths.some((d) => under(p, d)) && !p.startsWith(".claude/")) {
      block("edits are only allowed under " + policy.allowedPaths.join(", "));
    }
  }
}

if (tool === "Bash") {
  const cmd = String(ti.command || "");
  for (const seg of [cmd, ...segments(cmd)]) {
    const s = seg.trim();

    for (const b of policy.protectedBranches) {
      if (new RegExp("git\\\\s+push\\\\b.*\\\\b" + escapeRe(b) + "\\\\b").test(s)) block("pushing to " + b + " is not allowed; push a branch and open a pull request");
      if (/git\\s+push\\s*$/.test(s) || /git\\s+push\\s+origin\\s*$/.test(s) || /git\\s+push\\s+(-u\\s+)?origin\\s+HEAD/.test(s)) {
        // Bare push: refuse if we are on a protected branch.
        try {
          const { execSync } = require("child_process");
          const cur = execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
          if (cur === b) block("pushing " + b + " is not allowed; push a branch and open a pull request");
        } catch {}
      }
      if (new RegExp("git\\\\s+(checkout|switch)\\\\s+" + escapeRe(b) + "\\\\b").test(s) && /git\\s+commit/.test(cmd)) block("committing on " + b + " is not allowed");
      if (/git\\s+commit\\b/.test(s)) {
        try {
          const { execSync } = require("child_process");
          const cur = execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
          if (cur === b) block("committing on " + b + " is not allowed; create a branch first");
        } catch {}
      }
    }

    if (policy.blockForcePush && /git\\s+push\\b.*(--force\\b|-f\\b|--force-with-lease)/.test(s)) block("force push is not allowed");

    if (policy.blockDestructive) {
      if (/\\brm\\s+-[a-zA-Z]*[rR]/.test(s)) block("rm -r is not allowed");
      if (/git\\s+reset\\s+--hard/.test(s)) block("git reset --hard is not allowed");
      if (/git\\s+clean\\s+-[a-zA-Z]*f/.test(s)) block("git clean -f is not allowed");
      if (/git\\s+checkout\\s+--\\s+\\./.test(s)) block("discarding all changes is not allowed");
      if (/\\b(drop\\s+table|drop\\s+database|truncate\\s+table)\\b/i.test(s)) block("destructive SQL is not allowed");
    }

    if (policy.blockInstall && /\\b(npm|pnpm|yarn|bun)\\s+(install|i|add)\\s+[^-\\s]|\\bpip3?\\s+install\\s+[^-\\s]|\\bcargo\\s+add\\b|\\bgo\\s+get\\s+\\S/.test(s)) block("adding dependencies requires approval");

    if (policy.blockNetwork && /\\b(curl|wget|nc|ncat|ssh|scp|rsync|ftp)\\b/.test(s) && !/127\\.0\\.0\\.1|localhost/.test(s)) block("outbound network commands are not allowed");

    for (const f of policy.secretFiles) {
      if (new RegExp("(^|[\\\\s|;&])(cat|less|more|head|tail|grep|awk|sed|source|\\\\.|bat|xxd|strings|base64)\\\\s[^|;&]*" + escapeRe(f) + "(\\\\s|$)").test(s)) block("reading " + f + " is not allowed");
    }

    for (const d of policy.protectedTestPaths) {
      if (new RegExp("\\\\b(rm|mv|git\\\\s+rm)\\\\s[^|;&]*" + escapeRe(d) + "/").test(s)) block("removing tests under " + d + "/ is not allowed");
    }

    for (const a of policy.askFirstCommands) {
      if (s === a || s.startsWith(a + " ")) block('"' + a + '" requires a human to approve it first');
    }

    if (policy.requireBeforeCommit.length) {
      const state = readState();
      const isCommit = /git\\s+commit\\b/.test(s);
      for (const req of policy.requireBeforeCommit) {
        const head = req.split(/\\s+/).slice(0, 2).join(" ");
        if (s === req || s.startsWith(req + " ") || s.includes(head)) {
          state["ran:" + req] = Date.now();
          writeState(state);
        }
      }
      if (isCommit) {
        for (const req of policy.requireBeforeCommit) {
          const t = state["ran:" + req];
          if (!t || Date.now() - t > 30 * 60 * 1000) block('run "' + req + '" before committing (not seen in the last 30 minutes)');
        }
      }
    }
  }
}

if (tool === "WebFetch" && policy.blockNetwork) {
  const url = String(ti.url || "");
  if (!/127\\.0\\.0\\.1|localhost/.test(url)) block("fetching external URLs is not allowed");
}

process.exit(0);
`;
}
