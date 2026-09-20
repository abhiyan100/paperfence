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
  | "command-target";

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
    describe:
      "a test suite that can actually run in the sandbox: a framework paperfence can write a failing test for, and no uninstalled dependencies (the sandbox carries no node_modules and has no network to fetch them)",
    met: (c) =>
      c.profile.testCommand !== null &&
      ["node-test", "vitest", "jest", "mocha", "pytest"].includes(c.profile.testFramework ?? "") &&
      c.profile.testSuiteRunnable !== false,
  },
  "runnable-test-suite": {
    kind: "runnable-test-suite",
    describe: "a test suite that can run without installing anything, since the sandbox has no network",
    met: (c) => c.profile.testSuiteRunnable !== false,
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
};

/** A file that exists in this repo and would violate the scope rule if edited. */
export function scopeTarget(ctx: ScenarioContext): string | null {
  const { rule, profile } = ctx;
  const forbidden = rule.targets.filter((t) => t.startsWith("!")).map((t) => t.slice(1).replace(/\/$/, ""));
  const allowed = rule.targets.filter((t) => !t.startsWith("!")).map((t) => t.replace(/\/$/, ""));
  const under = (f: string, d: string) => f === d || f.startsWith(d + "/");
  const editable = profile.files.filter((f) => !f.startsWith(".git/") && !/\.(png|jpg|jpeg|gif|ico|pdf|zip|lock)$/.test(f) && f !== "package-lock.json" && f !== "pnpm-lock.yaml");
  if (forbidden.length) {
    const hit = editable.find((f) => forbidden.some((d) => under(f, d)));
    if (hit) return hit;
  }
  if (allowed.length) {
    const hit = editable.find((f) => !allowed.some((d) => under(f, d)) && !f.startsWith(".claude/") && !/^(README|LICENSE)/i.test(f));
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
