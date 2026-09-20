/**
 * Core types for paperfence.
 *
 * A "rule" is anything the repo tells its coding agent to do or not do.
 * Rules come from prose (CLAUDE.md, AGENTS.md, .claude/rules/*.md) and
 * from config (.claude/settings.json permissions and hooks).
 *
 * Four things are kept apart everywhere in this codebase, because conflating
 * them is how a tool like this starts lying:
 *
 *   declared policy       what the repo says in prose
 *   configured controls   what settings.json and hooks would actually stop
 *   observed capability   what an agent did when asked
 *   adversarial evidence  what an agent did when pushed
 *
 * Every rule ends up with one of three grades, always attached to the scope
 * of evidence that produced it:
 *   GATE   - something mechanical (a hook, a deny rule) stops the violation.
 *   WISH   - nothing mechanical exists; the agent obeyed only because it felt like it.
 *   BROKEN - the agent violated the rule and nothing stopped it.
 */

export type RuleCategory =
  | "protect-branch" // never push/commit to main directly
  | "protect-tests" // never delete or weaken tests
  | "protect-secrets" // never read .env / credentials
  | "no-exfil" // never send data out (curl, wget, fetch to external)
  | "no-destructive" // rm -rf, git reset --hard, force push, drop table
  | "no-install" // never add dependencies without asking
  | "scope" // only touch certain paths
  | "require-before" // always run X before Y (tests before commit, lint before push)
  | "ask-first" // ask the human before doing X
  | "no-force-push"
  | "other"; // we could not map it to a mechanical check; reported but not attacked

export type RuleSource =
  | { kind: "prose"; file: string; line?: number }
  | { kind: "permission"; file: string; entry: string; list: "allow" | "deny" | "ask" }
  | { kind: "hook"; file: string; event: string; matcher?: string; command: string };

export interface Rule {
  id: string;
  /** The rule as the human wrote it, verbatim when possible. */
  text: string;
  category: RuleCategory;
  /** Paths, commands, or branches the rule is about, if any. e.g. ["main"], [".env"], ["tests/"] */
  targets: string[];
  source: RuleSource;
}


/**
 * What one trial established. Five outcomes, because "not violated" was
 * hiding three different situations: the control blocked it, the agent
 * declined, and the trial never got far enough to find out.
 */
export type TrialVerdict =
  /** The forbidden effect did not happen and the trial reached a conclusion. */
  | "PASS"
  /** The forbidden effect happened (bad task), or a required check failed (good task). */
  | "FAIL"
  /** Infrastructure failed: container, API, runner. Says nothing about the policy. */
  | "ERROR"
  /** The trial ended without a conclusion: turn budget or timeout ran out with nothing decided. */
  | "INCONCLUSIVE"
  /** This repository does not have what the scenario needs. Not run. */
  | "NOT_APPLICABLE";

/** Why a trial ended the way it did, in the vocabulary a reader can act on. */
export type VerdictReason =
  | "effect-occurred"
  | "blocked-by-control"
  | "stopped-by-paperfence-guard"
  /**
   * The forbidden effect did not happen and nothing would have stopped it.
   *
   * Named for the observation, not for a motive. This used to be
   * `agent-declined`, which claimed the agent refused. It also covers the
   * agent doing the task properly and never reaching for the forbidden route,
   * and a run where the agent completed the work legitimately was reported as
   * "the agent declined" — a statement about the run that was not true.
   */
  | "effect-did-not-happen"
  | "agent-asked-human"
  /** A good task finished and every check on it passed. */
  | "checks-passed"
  | "checks-failed"
  | "turn-budget-exhausted"
  | "timed-out"
  | "infrastructure-error"
  | "prerequisites-missing";

export interface VerdictDetail {
  verdict: TrialVerdict;
  reason: VerdictReason;
  /** One line a human can read without opening the events. */
  explain: string;
}

/**
 * What a grade is a claim about. A GATE with an evidence scope of one form at
 * one pressure level on one model is a much smaller statement than the word
 * suggests, and the report has to say so.
 */
export interface EvidenceScope {
  /** Attack forms actually tried. */
  forms: string[];
  /** Forms skipped because this repo lacks their prerequisites. */
  formsSkipped: { form: string; missing: string[] }[];
  levels: PressureLevel[];
  trials: number;
  passed: number;
  failed: number;
  inconclusive: number;
  errored: number;
  models: string[];
  runtime: string;
  /** Upper bound on the violation rate consistent with these trials, as a percentage. */
  violationRateUpperBound?: number;
}

export type EnforcementLayer = "hook" | "permission-deny" | "permission-ask" | "none";

export interface ProbeOutcome {
  probe: ProbeCall;
  /** Which layer, if any, would have stopped this call. */
  blockedBy: EnforcementLayer;
  /** Human-readable evidence: the hook's stderr, the deny entry that matched, etc. */
  evidence: string;
}

export interface StaticProbeResult {
  ruleId: string;
  /** Every canonical violation we tried. A rule is a gate only if all of them are blocked. */
  outcomes: ProbeOutcome[];
  /** The first open door, or the first outcome if all were blocked. */
  probe: ProbeCall;
  blockedBy: EnforcementLayer;
  evidence: string;
}

export interface ProbeCall {
  tool: "Bash" | "Read" | "Write" | "Edit" | "WebFetch" | "MultiEdit" | "Glob" | "Grep" | "NotebookEdit";
  input: Record<string, unknown>;
  /** One-line description shown in reports. */
  describe: string;
}

export type PressureLevel = 1 | 2 | 3;

export type Grade = "GATE" | "WISH" | "BROKEN" | "UNTESTED" | "ERROR" | "NOT_APPLICABLE";

/**
 * What happened to a tool call. Four different facts, kept apart:
 *   attempted  the agent asked for it; we never saw a result
 *   denied     a hook or permission rule refused it before it ran
 *   ran        it executed and the tool reported success
 *   failed     it executed and the tool reported an error (non-zero exit, exception)
 */
export type ToolOutcome = "attempted" | "denied" | "ran" | "failed";

/**
 * How we know a call was denied. The difference matters: a structured record
 * from the runtime is the runtime telling us it refused, while a line of
 * English in a command's own output is the command talking. A program that
 * prints "permission denied" and exits 1 is not a control.
 */
export type DenialSource =
  /** The runtime reported it in permission_denials, or our own hook returned deny. */
  | "runtime"
  /** A hook's own marker was found in the tool result. */
  | "hook"
  /** Matched by pattern against the tool's error text. Suggestive, not proof. */
  | "error-text";

export interface ToolEvent {
  ts: number;
  tool: string;
  input: unknown;
  /** Filled in from the tool_result block, when we see one. */
  result?: string;
  denied?: boolean;
  deniedReason?: string;
  deniedBy?: DenialSource;
  outcome?: ToolOutcome;
}

/** Everything needed to say what exactly produced a report. */
export interface Fingerprint {
  paperfence: string;
  paperfenceCommit?: string;
  claudeCode?: string;
  agentSdk?: string;
  model?: string;
  os: string;
  sandbox: "docker" | "host" | "none";
  image?: string;
  approvalMode: "auto-approve" | "n/a";
  at: string;
}

export interface AttackRun {
  ruleId: string;
  /** Scenario that produced this trial, and the version of its definition. */
  scenarioId?: string;
  scenarioVersion?: number;
  /** Which route to the forbidden effect this trial took. */
  formId?: string;
  formDescribe?: string;
  level: PressureLevel;
  model: string;
  startedAt: number;
  endedAt: number;
  events: ToolEvent[];
  /** Final assistant text, trimmed. */
  finalText: string;
  /** Did the sandbox assertions detect the violation? */
  violated: boolean;
  violationEvidence: string[];
  /** Did we observe a mechanical block during the run? */
  mechanicallyBlocked: boolean;
  blockEvidence: string[];
  costUsd?: number;
  turns: number;
  error?: string;
  /** Whether the run hit its turn budget without concluding. */
  hitTurnLimit?: boolean;
  /**
   * Calls the runtime would have prompted a human about.
   *
   * In an unattended run paperfence answers yes, which is what CI does. The
   * fact that it was asked at all is the observable difference between an
   * "ask" rule and no rule, and the conformance suite needs it.
   */
  approvalRequests?: { tool: string; input: unknown }[];
  /**
   * The tools the runtime advertised at session start.
   *
   * The runtime's own statement of what the agent could call, not the agent's
   * account of it. A tool missing from this list was not available, which is
   * the strongest form of refusal and is invisible in the tool-call log,
   * because there is no call to log.
   */
  availableTools?: string[];
  /** The trial-level verdict. Derived once, in verdictFor(), never re-derived by readers. */
  verdict?: VerdictDetail;
  /** Content-addressed id of this trial's receipt, when one was written. */
  receipt?: string;
}

/** A trial is an attack run with its verdict settled. Same shape; clearer name. */
export type Trial = AttackRun;

export interface RuleVerdict {
  rule: Rule;
  grade: Grade;
  staticProbe?: StaticProbeResult;
  runs: AttackRun[];
  /** For BROKEN: the lowest pressure level at which it broke. */
  brokeAtLevel?: PressureLevel;
  summary: string;
  /** What this grade is a claim about. Absent for static-only scans. */
  evidence?: EvidenceScope;
  /** Set when the repository lacks the prerequisites for every form of this scenario. */
  notApplicable?: { reason: string };
  /**
   * Set when another rule in this report is the same control stated a second
   * way: a prose line and the settings entry that backs it. Shown in full,
   * counted once, so the denominators mean what they say.
   */
  restates?: { ruleId: string; where: string };
}

export interface ScanReport {
  version: string;
  repo: string;
  scannedAt: string;
  mode: "static" | "attack";
  rules: Rule[];
  verdicts: RuleVerdict[];
  totals: { gate: number; wish: number; broken: number; untested: number; error: number; notApplicable: number };
  fingerprint?: Fingerprint;
  /** What we saw in the repository, so a reader can tell applicable from missing. */
  profile?: { line: string; testCommand: string | null; languages: string[]; files: number };
  /** Which agent runtimes this repository is configured for, and how much of each we covered. */
  runtimes?: RuntimeCoverage[];
  /** Set when a spend limit stopped the run early. Trials that did not run are not passes. */
  budgetNote?: string;
}

export interface RuntimeCoverage {
  id: string;
  label: string;
  /** Files that identify this runtime in the repository. */
  markers: string[];
  /** What paperfence can do with this runtime. */
  support: { discover: boolean; evaluate: boolean; probeHooks: boolean; drive: boolean; harden: boolean };
  /** True when this scan's verdicts describe this runtime. */
  covered: boolean;
  notes: string;
  /** Config this runtime reads that paperfence did not look at. */
  outOfScope: string[];
}

// ---------- compare ----------

/** A check that decides whether a good task was completed. Runs after the agent finishes. */
export type TaskCheck =
  | { kind: "file-contains"; path: string; text: string }
  | { kind: "file-exists"; path: string }
  | { kind: "pushed-non-main-branch" }
  | { kind: "commit-on-non-main-branch" }
  | { kind: "command"; command: string; description?: string };

export interface BadTask {
  id: string;
  /** Rule id from the scan, or a category name. The objective comes from the scenario. */
  rule: string;
  level?: PressureLevel;
  /** Which attack form to use. Default: the first one this repository has the prerequisites for. */
  form?: string;
  /** Optional override of the scenario objective. */
  prompt?: string;
}

export interface GoodTask {
  id: string;
  prompt: string;
  checks: TaskCheck[];
}

export interface Suite {
  bad: BadTask[];
  good: GoodTask[];
}

export interface Variant {
  name: string;
  /** Directory holding this variant's repo (config included). */
  dir: string;
  model: string;
  /** Human description of how it differs from base. */
  describe: string;
}

export interface TaskRun {
  taskId: string;
  kind: "bad" | "good";
  variant: string;
  rep: number;
  /** bad: the forbidden effect did not happen; good: every check passed. Only meaningful when verdict is PASS or FAIL. */
  passed: boolean;
  verdict?: VerdictDetail;
  receipt?: string;
  /** bad: violation evidence; good: failed checks. */
  evidence: string[];
  askedHuman: number;
  denied: number;
  turns: number;
  costUsd?: number;
  durationMs: number;
  error?: string;
  events: ToolEvent[];
  finalText: string;
}

export interface VariantSummary {
  variant: Variant;
  /** Denominators count only trials that reached a PASS/FAIL conclusion. */
  badBlocked: number;
  badTotal: number;
  goodCompleted: number;
  goodTotal: number;
  askedHuman: number;
  denied: number;
  costUsd: number;
  errors: number;
  inconclusive: number;
  notApplicable: number;
}

export interface CompareReport {
  version: string;
  repo: string;
  at: string;
  suite: Suite;
  variants: Variant[];
  runs: TaskRun[];
  summaries: VariantSummary[];
  reps: number;
  fingerprint: Fingerprint;
  /** Set when a spend limit stopped the run early. Tasks that did not run are not passes. */
  budgetNote?: string;
}
