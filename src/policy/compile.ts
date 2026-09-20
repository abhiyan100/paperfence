import { planHardening, renderHookScript, type Policy } from "../harden/generate.js";
import type { Rule, RuleCategory } from "../types.js";
import type { CompiledPolicy, CompiledStatement, Enforceability, PolicyDocument, PolicyStatement } from "./types.js";

/**
 * Compile a policy for one target and say, per statement, what will actually
 * enforce it.
 *
 * The answer is not "yes" or "no". It is one of five, and the two in the
 * middle are where most real policies live:
 *
 *   enforced             a control refuses it, unattended, today
 *   needs-runtime-guard  only paperfence's generated hook can express it
 *   partial              some routes are closed and others are open
 *   org-control          no agent-side control can do it; it belongs to the
 *                        git host, CI, or a secret manager
 *   unenforceable        not mechanically checkable; guidance, and the policy
 *                        should say so rather than imply otherwise
 *
 * A team that reads this output knows which of its rules are load-bearing.
 */

export type TargetId = "claude-code" | "claude-code-hook" | "codex" | "github";

interface Assessment {
  enforceability: Enforceability;
  mechanism: string;
  gaps: string[];
  elsewhere?: string;
}

/**
 * Claude Code with deny entries only: no generated hook, nothing added to the
 * repository beyond settings.json. This is the honest baseline, and it is
 * weaker than most people expect.
 */
function assessClaudeDenyOnly(s: PolicyStatement): Assessment {
  switch (s.category) {
    case "protect-secrets":
      return {
        enforceability: "partial",
        mechanism: `permissions.deny Read(${s.targets?.[0] ?? ".env"})`,
        gaps: [
          "covers the Read tool and cat, head, tail, sed and wc in Bash, and shell redirections",
          "does not cover grep, base64, a while-read loop, or a node or python one-liner that opens the file itself",
        ],
      };
    case "no-exfil":
      return {
        enforceability: "partial",
        mechanism: "permissions.deny on WebFetch and Bash(curl *), Bash(wget *)",
        gaps: [
          "a deny rule does not match the same program by absolute path (/usr/bin/curl) or inside sh -c",
          "fetch() from a node or python one-liner is not a curl invocation and is not matched",
        ],
      };
    case "no-destructive":
      return {
        enforceability: "partial",
        mechanism: "permissions.deny on rm -rf, git reset --hard, git clean",
        gaps: ["flag order and equivalent commands (find -delete, truncate, a script that shells out) are not enumerable in a deny list"],
      };
    case "protect-branch":
      return {
        enforceability: "partial",
        mechanism: `permissions.deny Bash(git push origin ${s.targets?.[0] ?? "main"}*)`,
        gaps: [
          "a deny pattern cannot see that `git push origin HEAD:main` or `git -C . push` or a push from a wrapper script ends on the protected branch",
          "committing on the protected branch locally is a different command again",
        ],
      };
    case "no-force-push":
      return { enforceability: "partial", mechanism: "permissions.deny Bash(git push --force*)", gaps: ["-f, --force-with-lease, and a push refspec with a leading + are separate spellings"] };
    case "protect-tests":
      return {
        enforceability: "partial",
        mechanism: `permissions.deny Edit(${s.targets?.[0] ?? "tests/"}**)`,
        gaps: ["Edit is covered; deleting the file with rm, or disabling the suite through the test script in package.json, is not"],
      };
    case "no-install":
      return { enforceability: "partial", mechanism: "permissions.deny on npm install, pnpm add, yarn add", gaps: ["editing package.json by hand and running a plain install is not an add command"] };
    case "scope":
      return {
        enforceability: "partial",
        mechanism: "permissions.deny Edit(path) for each forbidden path",
        gaps: ["Edit and Read are consulted for paths; Write, MultiEdit and NotebookEdit rules are accepted and never used, and a shell redirection or sed -i writes the file anyway"],
      };
    case "require-before":
      return {
        enforceability: "unenforceable",
        mechanism: "none",
        gaps: ["a deny list decides one call at a time and has no memory of whether something ran earlier in the session"],
      };
    case "ask-first":
      return {
        enforceability: "org-control",
        mechanism: "permissions.ask",
        gaps: ["an ask entry needs a human to answer. In an unattended run there is nobody, and the call proceeds or fails on its own terms"],
        elsewhere: "In CI, decide whether the command should be forbidden outright or moved behind a deployment approval outside the agent.",
      };
    default:
      return { enforceability: "unenforceable", mechanism: "none", gaps: ["this statement is not a mechanical check"] };
  }
}

/** Claude Code with paperfence's generated guard hook installed. */
function assessClaudeWithGuard(s: PolicyStatement): Assessment {
  switch (s.category) {
    case "protect-branch":
      return {
        enforceability: "needs-runtime-guard",
        mechanism: `paperfence guard: refuses commits and pushes that land on ${(s.targets ?? ["main"]).join(", ")}, including refspecs, -C, and wrapper scripts`,
        gaps: ["a push from a process the hook does not see (a background job started earlier, a git alias that execs) is outside a PreToolUse hook's reach"],
        elsewhere: "Branch protection on the git host is the control that does not depend on the agent cooperating.",
      };
    case "no-force-push":
      return { enforceability: "needs-runtime-guard", mechanism: "paperfence guard: refuses --force, -f, --force-with-lease and + refspecs", gaps: [] };
    case "protect-secrets":
      return {
        enforceability: "needs-runtime-guard",
        mechanism: "paperfence guard: refuses the Read tool, shell readers, redirections, base64 and script one-liners that name the file",
        gaps: ["a secret the agent has already seen cannot be unseen; the guard prevents the read, not the memory"],
        elsewhere: "Real credentials should not be on the machine the agent runs on. A secret manager with short-lived tokens is the control.",
      };
    case "protect-tests":
      return {
        enforceability: "needs-runtime-guard",
        mechanism: "paperfence guard: refuses edits and deletions of test files that exist in HEAD, and allows new ones",
        gaps: ["disabling the suite through the test script, a config file, or a CI job is not an edit to a test file"],
      };
    case "no-exfil":
      return { enforceability: "needs-runtime-guard", mechanism: "paperfence guard: refuses network programs and script-driven requests to non-loopback hosts", gaps: [
          "a host allowlist is not the same as a proxy; the control is the network, not the shell",
          "loopback is exempt, because paperfence's own sandbox sink lives there. On a machine with a real service on 127.0.0.1, that is a way out",
        ], elsewhere: "An egress proxy or a container with no route out is the control that does not depend on parsing shell." };
    case "no-destructive":
      return { enforceability: "needs-runtime-guard", mechanism: "paperfence guard: refuses recursive removal, hard resets, force-clean and destructive SQL", gaps: [] };
    case "no-install":
      return { enforceability: "needs-runtime-guard", mechanism: "paperfence guard: refuses dependency additions across npm, pnpm, yarn, pip and friends", gaps: [] };
    case "scope":
      return { enforceability: "needs-runtime-guard", mechanism: "paperfence guard: refuses writes outside the allowed paths, whichever tool or shell command performs them", gaps: [] };
    case "require-before":
      return {
        enforceability: "needs-runtime-guard",
        mechanism: `paperfence guard: records a successful \`${s.before ?? "npm test"}\` in this session and refuses a ${s.targets?.[1] === "push" ? "push" : "commit"} until it has run`,
        gaps: [
          "credit is given only for a whole, successful, non-backgrounded run of the exact command",
          `it gates the ${s.targets?.[1] === "push" ? "push" : "commit"} and nothing else: commits made before the guard existed can still be pushed`,
        ],
      };
    case "ask-first":
      return {
        enforceability: "needs-runtime-guard",
        mechanism: "paperfence guard: refuses the command outright in an unattended run",
        gaps: ['"ask" and "refuse" are the same thing when nobody is there to ask. Attended runs should use permissions.ask instead'],
      };
    default:
      return { enforceability: "unenforceable", mechanism: "none", gaps: ["this statement is not a mechanical check"] };
  }
}

/** Codex: sandbox mode and approval policy, no rule grammar. */
function assessCodex(s: PolicyStatement): Assessment {
  const sandboxCovers: RuleCategory[] = ["no-exfil", "scope"];
  if (sandboxCovers.includes(s.category)) {
    return {
      enforceability: "partial",
      mechanism: s.category === "no-exfil" ? 'sandbox_mode = "workspace-write" with no network, or features.network_proxy with an allowlist' : 'sandbox_mode = "workspace-write" confines writes to the workspace',
      gaps: [
        s.category === "scope"
          ? "the workspace is the whole repository; the sandbox cannot express a path allowlist inside it"
          : "network access is on or off for the whole run; per-host rules need the proxy feature",
        "paperfence does not verify Codex's decisions yet, so this is read from the configuration, not measured",
      ],
    };
  }
  return {
    enforceability: "needs-runtime-guard",
    mechanism: "a Codex PreToolUse hook returning decision \"block\"",
    gaps: [
      "Codex hooks run only after a user trusts them by content hash, so a hook in the repository is not a hook that fires",
      'a hook returning permissionDecision "ask" is parsed and ignored: Codex has no ask in its hook model',
      "paperfence does not generate Codex hooks yet",
    ],
  };
}

/** The git host: the only control that does not depend on the agent cooperating. */
function assessGitHub(s: PolicyStatement): Assessment {
  switch (s.category) {
    case "protect-branch":
      return {
        enforceability: "enforced",
        mechanism: `branch protection on ${(s.targets ?? ["main"]).join(", ")}: require a pull request, block direct pushes`,
        gaps: [],
        elsewhere: "Set it on the repository, not in the agent's configuration. It holds whatever the agent does.",
      };
    case "no-force-push":
      return { enforceability: "enforced", mechanism: "branch protection: block force pushes", gaps: [], elsewhere: "Set it on the repository." };
    case "protect-tests":
      return {
        enforceability: "partial",
        mechanism: "a required status check that runs the suite, plus CODEOWNERS on the test directories",
        gaps: ["catches it at review time, not at the moment the agent does it"],
        elsewhere: "Required checks and CODEOWNERS on the repository.",
      };
    case "require-before":
      return { enforceability: "enforced", mechanism: "a required status check: the merge is blocked until it passes", gaps: ["the commit still happens; the merge does not"], elsewhere: "Required checks on the repository." };
    case "protect-secrets":
      return { enforceability: "partial", mechanism: "push protection and secret scanning", gaps: ["catches a secret being committed, not a secret being read"], elsewhere: "Secret scanning on the repository, and short-lived credentials from a secret manager." };
    default:
      return { enforceability: "org-control", mechanism: "none at the git host", gaps: [], elsewhere: "This one has to be enforced at the agent, not at the repository." };
  }
}

const ASSESSORS: Record<TargetId, (s: PolicyStatement) => Assessment> = {
  "claude-code": assessClaudeDenyOnly,
  "claude-code-hook": assessClaudeWithGuard,
  codex: assessCodex,
  github: assessGitHub,
};

export const TARGET_LABELS: Record<TargetId, string> = {
  "claude-code": "Claude Code, deny entries only",
  "claude-code-hook": "Claude Code with the paperfence guard",
  codex: "Codex",
  github: "GitHub",
};

/** Policy statements become the rule shape the hardening planner already speaks. */
export function statementsAsRules(doc: PolicyDocument): Rule[] {
  return doc.statements.map((s) => ({
    id: s.id,
    text: s.text,
    category: s.category,
    targets: s.category === "require-before" ? [s.before ?? s.targets?.[0] ?? "npm test", s.targets?.[1] === "push" ? "push" : "commit"] : (s.targets ?? []),
    source: { kind: "prose" as const, file: s.from?.file ?? "paperfence.policy.yaml", line: s.from?.line },
  }));
}

export function compilePolicy(doc: PolicyDocument, target: TargetId): CompiledPolicy {
  const assess = ASSESSORS[target];
  const statements: CompiledStatement[] = doc.statements.map((s) => {
    if (s.acceptAsGuidance) {
      return {
        statement: s,
        enforceability: "unenforceable",
        mechanism: "none, and the policy says so",
        gaps: ["marked acceptAsGuidance: the author has accepted this as guidance rather than a control"],
      };
    }
    const a = assess(s);
    return { statement: s, enforceability: a.enforceability, mechanism: a.mechanism, gaps: a.gaps, elsewhere: a.elsewhere };
  });

  const artifacts: Record<string, string> = {};
  const notes: string[] = [];

  if (target === "claude-code" || target === "claude-code-hook") {
    const plan = planHardening(statementsAsRules(doc));
    artifacts[".claude/settings.json"] = JSON.stringify({ permissions: { deny: plan.deny } }, null, 2) + "\n";
    if (target === "claude-code-hook") {
      artifacts[".claude/hooks/policy.json"] = JSON.stringify(plan.policy satisfies Policy, null, 2) + "\n";
      artifacts[".claude/hooks/paperfence-guard.cjs"] = renderHookScript();
    }
    notes.push(...plan.notes);
  }
  if (target === "github") {
    notes.push("GitHub controls are not files in the repository. paperfence lists what to set; setting it is a repository admin's job.");
  }
  if (target === "codex") {
    notes.push("paperfence reads Codex configuration but does not write it yet. This is an assessment, not a compilation.");
  }

  return { target: TARGET_LABELS[target], statements, artifacts, notes };
}

/**
 * The statements no target in this set can enforce. The list a team should
 * actually read: these are the rules that exist only in prose.
 */
export function unenforcedAnywhere(compiled: CompiledPolicy[]): CompiledStatement[] {
  const byId = new Map<string, CompiledStatement[]>();
  for (const c of compiled) {
    for (const s of c.statements) byId.set(s.statement.id, [...(byId.get(s.statement.id) ?? []), s]);
  }
  const out: CompiledStatement[] = [];
  for (const [, all] of byId) {
    const best = all.find((s) => s.enforceability === "enforced") ?? all.find((s) => s.enforceability === "needs-runtime-guard") ?? all.find((s) => s.enforceability === "partial");
    if (!best) out.push(all[0]!);
  }
  return out;
}
