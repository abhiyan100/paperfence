import type { RuleCategory } from "../types.js";

/**
 * The policy document: what a team says its agents may and may not do,
 * written once, in a form a machine can compile and a human can review.
 *
 * It is deliberately not a rule DSL. Every statement is one of a small set of
 * shapes, because the value here is not expressiveness, it is being able to
 * answer "can this actually be enforced, and by what?" for every line.
 *
 * Lives at paperfence.policy.yaml.
 */

export type PolicyEffect = "forbid" | "require" | "restrict";

export interface PolicyStatement {
  /** Stable id, used in receipts and compiler output. */
  id: string;
  /** The statement in the team's own words. Shown in reports instead of the machine form. */
  text: string;
  category: RuleCategory;
  effect: PolicyEffect;
  /** Branches, paths, commands, hosts. Meaning depends on the category. */
  targets?: string[];
  /** Paths or commands explicitly exempted. */
  except?: string[];
  /** For require: the step that must have run first. */
  before?: string;
  /** Where the statement came from, when it was inferred rather than written. */
  from?: { file: string; line?: number };
  /** Set by the author to accept an unenforceable statement as guidance only. */
  acceptAsGuidance?: boolean;
}

export interface PolicyDocument {
  version: 1;
  /** Runtimes this policy is meant to govern. */
  runtimes: string[];
  statements: PolicyStatement[];
  /** Free-text notes carried through to compiled output. */
  notes?: string[];
}

/**
 * How well a target can enforce a statement. The whole point of the policy
 * layer: a team should find out at compile time, not after an incident, that
 * a line in their policy is decoration.
 */
export type Enforceability =
  /** A control in the target refuses it outright, with no human present. */
  | "enforced"
  /** Some routes to the violation are refused and others are not. */
  | "partial"
  /** Only paperfence's generated guard can express it; the runtime alone cannot. */
  | "needs-runtime-guard"
  /** No agent-side control can enforce it. It belongs to the git host, CI, or a secret manager. */
  | "org-control"
  /** Not mechanically checkable at all. Guidance, and the policy should say so. */
  | "unenforceable";

export const ENFORCEABILITY_ORDER: Enforceability[] = ["enforced", "needs-runtime-guard", "partial", "org-control", "unenforceable"];

export interface CompiledStatement {
  statement: PolicyStatement;
  enforceability: Enforceability;
  /** What will enforce it, in the target's own vocabulary. */
  mechanism: string;
  /** What will not be caught. Always populated for partial, often for enforced. */
  gaps: string[];
  /** What a human has to do outside the agent, for org-control. */
  elsewhere?: string;
}

export interface CompiledPolicy {
  target: string;
  statements: CompiledStatement[];
  /** Files the compiler would write, as path -> contents. */
  artifacts: Record<string, string>;
  notes: string[];
}

export function summarize(c: CompiledPolicy): Record<Enforceability, number> {
  const out = { enforced: 0, partial: 0, "needs-runtime-guard": 0, "org-control": 0, unenforceable: 0 } as Record<Enforceability, number>;
  for (const s of c.statements) out[s.enforceability]++;
  return out;
}
