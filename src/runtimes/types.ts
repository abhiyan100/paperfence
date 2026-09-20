import type { ProbeCall, Rule } from "../types.js";

/**
 * A runtime is a coding agent with its own configuration files, its own
 * permission semantics and its own hook model: Claude Code, Codex, Cursor,
 * Copilot, Gemini.
 *
 * The point of this boundary is honesty. paperfence can do four separate
 * things to a runtime, and it can do different subsets of them for each:
 *
 *   discover   find the files that instruct the agent
 *   evaluate   decide, statically, whether a configured control blocks a call
 *   probe      execute the repository's own hooks against a synthetic call
 *   drive      run the agent unattended against an objective
 *
 * An adapter declares which of those it supports, and reports must say so.
 * Claiming a scan covers a runtime we can only half-read is exactly the kind
 * of paper fence this tool exists to find.
 */

export type RuntimeId = "claude-code" | "codex" | "cursor" | "copilot" | "gemini";

export interface RuntimeSupport {
  /** We can find and read this runtime's configuration. */
  discover: boolean;
  /** We implement this runtime's permission matching, so a static verdict means something. */
  evaluate: boolean;
  /** We can execute the repository's own hook scripts with this runtime's payload shape. */
  probeHooks: boolean;
  /** We can run the agent unattended and observe its tool calls. */
  drive: boolean;
  /** We can write controls for this runtime. */
  harden: boolean;
}

/** What the runtime's own enforcement can express. Used by the policy compiler. */
export interface RuntimeControls {
  /** Deny-list entries that refuse a call outright. */
  deny: boolean;
  /** Entries that require a human to approve. Worth nothing in an unattended run. */
  ask: boolean;
  /** A pre-tool hook that can block. */
  preToolHook: boolean;
  /** A post-tool hook, which can observe but not prevent. */
  postToolHook: boolean;
  /** Path-scoped read/write rules. */
  pathScoping: boolean;
  /** A sandbox or network policy the runtime enforces itself. */
  sandbox: boolean;
  /** Anything the runtime accepts in config but never consults. */
  inertSurfaces: string[];
}

export interface DiscoveredConfig {
  root: string;
  runtime: RuntimeId;
  /** Files whose prose instructs the agent. */
  proseFiles: { file: string; content: string }[];
  /** Machine-readable configuration, as parsed. */
  settingsFiles: { file: string; json: unknown }[];
  /** Hook scripts that live in the repository. */
  hookScripts: { file: string; content: string }[];
  /** Config this runtime reads from outside the repository, which we did not look at. */
  outOfScope: string[];
}

export type StaticDecision =
  | { decision: "deny"; layer: "permission-deny"; reason: string }
  | { decision: "ask"; layer: "permission-ask"; reason: string }
  | { decision: "allow"; layer: "none"; reason: string }
  | { decision: "unknown"; layer: "none"; reason: string };

export interface RuntimeAdapter {
  id: RuntimeId;
  label: string;
  support: RuntimeSupport;
  controls: RuntimeControls;
  /** One or two sentences: what this runtime's controls mean and where they stop. */
  notes: string;
  /** Files that mark a repository as configured for this runtime. */
  markers: string[];

  discover(root: string): Promise<DiscoveredConfig>;

  /**
   * Static evaluation of one synthetic call against the discovered config.
   * Adapters that cannot evaluate return "unknown" with a reason; callers must
   * render that as unknown, never as allowed.
   */
  evaluate(cfg: DiscoveredConfig, call: ProbeCall): StaticDecision;

  /** Config entries this runtime accepts but never enforces. */
  inert(cfg: DiscoveredConfig): { raw: string; why: string }[];

  /** How this runtime would be told about a rule, for the harden plan. */
  describeEnforcement?(rule: Rule): string;
}

/** A short line for reports: what we could and could not do with this runtime. */
export function supportLine(a: RuntimeAdapter): string {
  const yes: string[] = [];
  const no: string[] = [];
  const add = (ok: boolean, label: string) => (ok ? yes : no).push(label);
  add(a.support.discover, "read its config");
  add(a.support.evaluate, "evaluate its permission rules");
  add(a.support.probeHooks, "run its hooks");
  add(a.support.drive, "drive the agent");
  add(a.support.harden, "write controls for it");
  const parts = [`${a.label}: paperfence can ${yes.join(", ") || "do nothing with it"}`];
  if (no.length) parts.push(`cannot ${no.join(", ")}`);
  return parts.join("; ");
}
