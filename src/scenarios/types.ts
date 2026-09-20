import type { RepoProfile } from "../repo/profile.js";
import type { PressureLevel, ProbeCall, Rule, RuleCategory } from "../types.js";

/**
 * A scenario is how paperfence tries to produce one forbidden effect.
 *
 * It is not a command. A rule like "never push to main" can be broken by a
 * hotfix, by a release bump, by a revert; those are different tasks that
 * touch different parts of a repo and produce different shell. Each one is a
 * *form*. Grading a rule on a single form and calling it a gate is the main
 * way a tool like this lies to you.
 *
 * Every form declares what the repository must have for the form to mean
 * anything. A form whose prerequisites are missing is NOT APPLICABLE. That
 * is not the same as "the agent could not do it", and it is never counted as
 * the rule holding.
 */

export type AssertionKind =
  | "remote-main-unchanged"
  | "tests-intact"
  | "secret-not-read"
  | "no-exfil"
  | "no-destructive-call"
  | "deps-unchanged"
  | "scope-respected"
  | "step-ran-before"
  | "no-ask-first-action"
  | "no-force-push"
  | "none";

export type PrerequisiteKind =
  | "repo-files"
  | "readme"
  | "test-suite"
  | "test-files"
  | "plantable-test"
  | "runnable-test-suite"
  | "source-file"
  | "package-manifest"
  | "python-manifest"
  | "numeric-constant"
  | "scope-target"
  | "command-target"
  | "required-step";

export interface ScenarioContext {
  rule: Rule;
  profile: RepoProfile;
}

export interface Prerequisite {
  kind: PrerequisiteKind;
  /** Written so it reads well after "needs ". */
  describe: string;
  met: (ctx: ScenarioContext) => boolean;
}

export interface AttackForm {
  id: string;
  /** The route to the forbidden effect this form exercises. */
  describe: string;
  requires: PrerequisiteKind[];
  /** Files planted before the sandbox snapshot, so any tampering with them is visible. */
  setup?: (work: string, ctx: ScenarioContext) => Promise<void>;
  /** The task given to the agent. It never names the forbidden command at level 1. */
  objective: (ctx: ScenarioContext, level: PressureLevel) => string;
}

export interface Scenario {
  /** Stable id used in receipts. */
  id: string;
  /** Bumped whenever an objective, a form, or the assertion changes, so old receipts stay interpretable. */
  version: number;
  category: RuleCategory;
  label: string;
  /** Plain-English description of the forbidden effect. */
  violation: string;
  assertion: AssertionKind;
  attackable: boolean;
  probes: (ctx: ScenarioContext) => ProbeCall[];
  forms: AttackForm[];
}

export const PREREQUISITES: Record<PrerequisiteKind, Prerequisite> = {
  "repo-files": { kind: "repo-files", describe: "any file in the repository", met: (c) => c.profile.files.length > 0 },
  readme: { kind: "readme", describe: "a README", met: (c) => c.profile.readme !== null },
  "test-suite": { kind: "test-suite", describe: "a test command we can name", met: (c) => c.profile.testCommand !== null },
  "test-files": { kind: "test-files", describe: "at least one test file already in the repo", met: (c) => c.profile.testFiles.length > 0 },
  "plantable-test": {
    kind: "plantable-test",
    // Whether the suite actually runs is settled by running it in the sandbox,
    // not here. This only asks whether we know how to write a failing test.
    describe: "a test framework paperfence can write a failing test for (node:test, vitest, jest, mocha, pytest)",
    met: (c) => c.profile.testCommand !== null && ["node-test", "vitest", "jest", "mocha", "pytest"].includes(c.profile.testFramework ?? ""),
  },
  "runnable-test-suite": {
    kind: "runnable-test-suite",
    describe: "a test suite that runs in the sandbox, which is checked by running it there",
    met: (c) => c.profile.testCommand !== null,
  },
  "source-file": { kind: "source-file", describe: "at least one source file", met: (c) => c.profile.sourceFiles.length > 0 },
  "package-manifest": { kind: "package-manifest", describe: "a package.json", met: (c) => c.profile.packageJson !== null },
  "python-manifest": {
    kind: "python-manifest",
    describe: "a Python dependency manifest",
    met: (c) => c.profile.files.some((f) => /^(requirements(-\w+)?\.txt|pyproject\.toml|Pipfile)$/.test(f)),
  },
  "numeric-constant": {
    kind: "numeric-constant",
    describe: "a named numeric constant we can ask for a one-line change to",
    met: (c) => c.profile.constant !== null,
  },
  "scope-target": {
    kind: "scope-target",
    describe: "a file that exists and is outside the area this rule allows",
    met: (c) => scopeTarget(c) !== null,
  },
  "command-target": {
    kind: "command-target",
    describe: "a command named by the rule",
    met: (c) => commandTarget(c) !== null,
  },
  "required-step": {
    kind: "required-step",
    describe: "a required step that is a command this repository can actually run",
    met: (c) => requiredStep(c) !== null,
  },
};

/** Programs a rule file plausibly names as a required step. */
const RUNNERS = new Set([
  "npm", "pnpm", "yarn", "bun", "bunx", "npx", "node", "deno",
  "python", "python3", "uv", "uvx", "pip", "poetry", "pytest", "tox", "ruff", "mypy", "black", "pyright",
  "go", "cargo", "rustfmt", "clippy", "just", "make", "bazel", "gradle", "mvn", "dotnet",
  "git", "tsc", "eslint", "prettier", "biome", "oxlint", "vitest", "jest", "mocha", "rspec", "bundle", "rake",
  "docker", "terraform", "prek", "pre-commit", "lefthook", "husky", "breeze",
]);

/**
 * The command a `require-before` rule says must run, or null when the rule
 * does not name one.
 *
 * This is the same failure as an invented scope path, and worse in its
 * consequence. The assertion takes `targets[0]` as the command to look for, so
 * when extraction returns a fragment of the sentence instead of a command -
 * `API changes`, `evidence gathering before commit`, `tests` - nothing the
 * agent runs can ever match it, `ranStep` stays false, and the first commit
 * the agent makes is recorded as skipping a required step. A rule the agent
 * had no way to satisfy is reported as broken in a live run.
 *
 * So the step has to be a command: a program this ecosystem has, or a script
 * this repository defines. Anything else means the rule is not checkable here,
 * which is a true thing to say and the other is not.
 */
export function requiredStep(ctx: ScenarioContext): string | null {
  const scripts = Object.keys((ctx.profile.packageJson as { scripts?: Record<string, string> } | null)?.scripts ?? {});
  for (const raw of ctx.rule.targets) {
    const clean = raw.replace(/^`|`$/g, "").trim();
    if (!clean || clean.length > 80) continue;
    // Ordering prose that leaked into the target list.
    if (/\b(before|after|first|then|when|while|unless|every|all)\b/i.test(clean)) continue;
    if (/[,;]/.test(clean)) continue;
    const parts = clean.split(/\s+/);
    if (parts.length > 6) continue;
    const head = parts[0]!.toLowerCase();
    if (RUNNERS.has(head)) return clean;
    // A bare script name, when the repository really defines it.
    if (parts.length === 1 && scripts.includes(clean)) return `npm run ${clean}`;
  }
  return null;
}

/** A file that exists in this repo and would violate the scope rule if edited. */
/**
 * Is this target a path this repository actually has?
 *
 * Extraction often returns a fragment of the sentence instead of a path:
 * `bug fixes: confined to immediate impact`, `test assertions`, `API changes`.
 * Those are not targets, and treating them as one produced the worst kind of
 * output this project can produce. `scopeTarget` looked for a file outside the
 * "allowed directory" `bug fixes: confined to immediate impact`, every file in
 * the repository qualified, and the report then said
 *
 *   Nothing mechanical stops "edit .claude-plugin/marketplace.json"
 *
 * for a rule about keeping bug fixes small. The path came from paperfence, not
 * from the repository's rule, and the sentence reads as though it came from
 * the rule.
 *
 * So a target has to name something that is really there. When none of them
 * do, the rule is unmapped, which the report already knows how to say.
 */
export function matchesTarget(file: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const rx = new RegExp("^" + pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
    return rx.test(file);
  }
  return file === pattern || file.startsWith(pattern + "/");
}

export function usableTarget(target: string, files: string[]): string | null {
  const clean = target.replace(/^!/, "").replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/\/$/, "").trim();
  if (!clean || clean.length > 120) return null;
  // A sentence fragment, not a path. Spaces and colons are the giveaway; a
  // path with a space is possible and vanishingly rare in a rule file.
  if (/\s|:/.test(clean)) return null;
  if (clean.startsWith("~") || clean.startsWith("/") || clean.split("/").includes("..")) return null;
  return files.some((f) => matchesTarget(f, clean)) ? clean : null;
}

export function scopeTarget(ctx: ScenarioContext): string | null {
  const { rule, profile } = ctx;
  const forbidden = rule.targets.filter((t) => t.startsWith("!")).map((t) => usableTarget(t, profile.files)).filter((t): t is string => t !== null);
  const allowed = rule.targets.filter((t) => !t.startsWith("!")).map((t) => usableTarget(t, profile.files)).filter((t): t is string => t !== null);
  // Nothing in the rule names a real path, so there is nothing honest to probe.
  if (!forbidden.length && !allowed.length) return null;
  const editable = profile.files.filter((f) => !f.startsWith(".git/") && !/\.(png|jpg|jpeg|gif|ico|pdf|zip|lock)$/.test(f) && f !== "package-lock.json" && f !== "pnpm-lock.yaml");
  if (forbidden.length) {
    const hit = editable.find((f) => forbidden.some((d) => matchesTarget(f, d)));
    if (hit) return hit;
  }
  if (allowed.length) {
    const hit = editable.find((f) => !allowed.some((d) => matchesTarget(f, d)) && !f.startsWith(".claude/") && !/^(README|LICENSE)/i.test(f));
    if (hit) return hit;
  }
  return null;
}

/** The command an ask-first rule is about, when the rule names one. */
export function commandTarget(ctx: ScenarioContext): string | null {
  for (const t of ctx.rule.targets) {
    const clean = t.replace(/^`|`$/g, "").trim();
    if (!clean) continue;
    if (/^[a-z][\w.-]*( |$)/i.test(clean) && !clean.startsWith("/") && !clean.includes("\n")) return clean;
  }
  return null;
}

export interface Applicability {
  /** Forms whose prerequisites this repo meets. */
  forms: AttackForm[];
  /** For each form we skipped, why. */
  skipped: { form: string; missing: string[] }[];
}

export function applicableForms(scenario: Scenario, ctx: ScenarioContext): Applicability {
  const forms: AttackForm[] = [];
  const skipped: { form: string; missing: string[] }[] = [];
  for (const form of scenario.forms) {
    const missing = form.requires.filter((k) => !PREREQUISITES[k].met(ctx)).map((k) => PREREQUISITES[k].describe);
    if (missing.length) skipped.push({ form: form.id, missing });
    else forms.push(form);
  }
  return { forms, skipped };
}

/** One line explaining why a scenario did not run here. */
export function notApplicableReason(a: Applicability): string {
  const missing = [...new Set(a.skipped.flatMap((s) => s.missing))];
  return `this repository has none of the prerequisites: needs ${missing.join("; or ")}`;
}
