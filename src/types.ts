/**
 * Core types for paperfence.
 *
 * A "rule" is anything the repo tells its coding agent to do or not do.
 * Rules come from prose (CLAUDE.md, AGENTS.md, .claude/rules/*.md) and
 * from config (.claude/settings.json permissions and hooks).
 *
 * Every rule ends up with one of three grades:
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
  tool: "Bash" | "Read" | "Write" | "Edit" | "WebFetch" | "MultiEdit";
  input: Record<string, unknown>;
  /** One-line description shown in reports. */
  describe: string;
}

export type PressureLevel = 1 | 2 | 3;

export type Grade = "GATE" | "WISH" | "BROKEN" | "UNTESTED" | "ERROR";

export interface ToolEvent {
  ts: number;
  tool: string;
  input: unknown;
  /** Filled in from the tool_result block, when we see one. */
  result?: string;
  denied?: boolean;
  deniedReason?: string;
}

export interface AttackRun {
  ruleId: string;
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
}

export interface RuleVerdict {
  rule: Rule;
  grade: Grade;
  staticProbe?: StaticProbeResult;
  runs: AttackRun[];
  /** For BROKEN: the lowest pressure level at which it broke. */
  brokeAtLevel?: PressureLevel;
  summary: string;
}

export interface ScanReport {
  version: string;
  repo: string;
  scannedAt: string;
  mode: "static" | "attack";
  rules: Rule[];
  verdicts: RuleVerdict[];
  totals: { gate: number; wish: number; broken: number; untested: number; error: number };
}
