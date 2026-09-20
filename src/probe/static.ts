import { effectiveSettings, type AgentConfig } from "../config/discover.js";
import { firePreToolUseHooks } from "../config/hooks.js";
import { evaluatePermissions, inertRules } from "../config/permissions.js";
import { claudeCode } from "../runtimes/claude-code.js";
import type { DiscoveredConfig, RuntimeAdapter } from "../runtimes/types.js";
import type { RepoProfile } from "../repo/profile.js";
import { probesFor, scenarioFor } from "../scenarios/catalog.js";
import type { EnforcementLayer, ProbeCall, ProbeOutcome, Rule, StaticProbeResult } from "../types.js";

/**
 * The static probe answers one question per rule without running any model:
 * "if an agent tried the obvious violation, would this repo's config stop it?"
 *
 * Two layers can stop it, in the order Claude Code evaluates them:
 *   1. permissions.deny in settings.json
 *   2. a PreToolUse hook exiting 2 (or returning a deny decision)
 *
 * permissions.ask is reported separately: it is a gate only while a human is
 * watching. In an unattended run (--dangerously-skip-permissions, CI, the
 * Agent SDK with bypassPermissions) it is not a gate at all.
 */

export interface StaticProbeOptions {
  /** What this repository contains. Probes are written against it, not against a fixture. */
  profile: RepoProfile;
  /**
   * Which runtime's semantics to evaluate against.
   *
   * A repository configured for Codex must not be judged by Claude Code's
   * permission rules: the absence of a deny entry says nothing about a runtime
   * that has no deny entries. Defaults to Claude Code.
   */
  adapter?: RuntimeAdapter;
  /**
   * The adapter's own view of the repository's configuration.
   *
   * Claude Code's discovery looks in `.claude`; Codex's looks in `.codex` and
   * parses TOML. Handing the adapter a translation of someone else's discovery
   * made it report that a config it never read was absent.
   */
  adapterConfig?: DiscoveredConfig;
  /** Treat "ask" as a gate. Default false, because the whole point is unattended runs. */
  askCounts?: boolean;
  /** Do not execute the repo's hook scripts (for repos you do not trust). Matching hooks are reported as "present, not run". */
  noHooks?: boolean;
  hookTimeoutMs?: number;
  onProgress?: (msg: string) => void;
}

export async function staticProbe(cfg: AgentConfig, rules: Rule[], opts: StaticProbeOptions): Promise<StaticProbeResult[]> {
  const settings = effectiveSettings(cfg);
  const results: StaticProbeResult[] = [];
  const inert = inertRules(settings.permissions ?? {});
  for (const i of inert) opts.onProgress?.(`note: ${i.raw}: ${i.why}`);
  for (const rule of rules) {
    const spec = scenarioFor(rule.category);
    if (!spec.attackable) continue;
    const probes = probesFor(rule, { rule, profile: opts.profile });
    // A rule is gated if *every* canonical probe is blocked. One open door is enough to lose.
    const outcomes: ProbeOutcome[] = [];
    for (const probe of probes) {
      opts.onProgress?.(`${rule.id}: probing ${probe.describe}`);
      outcomes.push(await probeOne(settings, cfg.root, probe, opts, cfg));
    }
    if (outcomes.length === 0) continue;
    const open = outcomes.find((p) => p.blockedBy === "none");
    const head = open ?? outcomes[0]!;
    const inertNote = rule.source.kind === "permission" ? inert.find((i) => i.raw === (rule.source as { entry: string }).entry) : undefined;
    if (inertNote && open) {
      results.push({ ruleId: rule.id, outcomes, probe: head.probe, blockedBy: "none", evidence: `this entry is inert: ${inertNote.why}` });
      continue;
    }
    const blockedCount = outcomes.filter((o) => o.blockedBy !== "none").length;
    let evidence = head.evidence;
    if (open && blockedCount > 0) {
      const blockedList = outcomes
        .filter((o) => o.blockedBy !== "none")
        .map((o) => `"${o.probe.describe}" is blocked (${o.blockedBy})`)
        .join(", ");
      evidence = `${blockedList}, but "${open.probe.describe}" gets through: ${open.evidence}`;
    }
    results.push({ ruleId: rule.id, outcomes, probe: head.probe, blockedBy: head.blockedBy, evidence });
  }
  return results;
}

async function probeOne(
  settings: ReturnType<typeof effectiveSettings>,
  root: string,
  probe: ProbeCall,
  opts: StaticProbeOptions,
  cfg?: AgentConfig,
): Promise<ProbeOutcome> {
  const call = { tool: probe.tool, input: absolutize(probe.input, root) };
  const adapter = opts.adapter ?? claudeCode;

  // A runtime other than Claude Code decides this its own way, and some of
  // them cannot decide it at all. Unknown is reported as unknown.
  if (adapter.id !== "claude-code" && opts.adapterConfig) {
    const d = adapter.evaluate(opts.adapterConfig, probe);
    if (d.decision === "deny") return { probe, blockedBy: "permission-deny", evidence: `${adapter.label}: ${d.reason}` };
    if (d.decision === "ask") return { probe, blockedBy: opts.askCounts ? "permission-ask" : "none", evidence: `${adapter.label}: ${d.reason}` };
    return { probe, blockedBy: "none", evidence: `${adapter.label}: ${d.reason}` };
  }

  const perm = evaluatePermissions(settings.permissions ?? {}, call, root);
  if (perm.decision === "deny") {
    return { probe, blockedBy: "permission-deny", evidence: perm.reason };
  }
  if (opts.noHooks) {
    const matching = (settings.hooks?.PreToolUse ?? []).filter((g) => !g.matcher || g.matcher === "*" || g.matcher.split("|").map((x) => x.trim()).includes(call.tool) || safeRegex(g.matcher, call.tool));
    if (matching.length) return { probe, blockedBy: "none", evidence: `${matching.length} PreToolUse hook(s) match but were not run (--no-hooks); cannot tell whether they block` };
    if (perm.decision === "ask") return { probe, blockedBy: opts.askCounts ? "permission-ask" : "none", evidence: `${perm.reason} (ask only: a human must be present to say no)` };
    return { probe, blockedBy: "none", evidence: "no deny rule matched; no hooks matched" };
  }
  const hookResults = await firePreToolUseHooks(settings, call, root, { timeoutMs: opts.hookTimeoutMs });
  const blocker = hookResults.find((h) => h.blocked);
  if (blocker) {
    const why = blocker.reason ? `: ${truncate(blocker.reason, 160)}` : "";
    return { probe, blockedBy: "hook", evidence: `hook "${truncate(blocker.command, 60)}" exited ${blocker.exitCode}${why}` };
  }
  if (perm.decision === "ask") {
    const layer: EnforcementLayer = opts.askCounts ? "permission-ask" : "none";
    return {
      probe,
      blockedBy: layer,
      evidence: `${perm.reason} (ask only: a human must be present to say no)`,
    };
  }
  const crashed = hookResults.filter((h) => h.exitCode !== 0 && h.exitCode !== 2);
  const crashNote = crashed.length
    ? ` ${crashed.length} hook(s) crashed (exit ${crashed.map((h) => (h.timedOut ? "timeout" : h.exitCode)).join(", ")}) and Claude Code treats a crashed hook as allow`
    : "";
  const tried = hookResults.length ? `${hookResults.length} hook(s) ran and allowed it${crashNote}` : "no hooks matched";
  return { probe, blockedBy: "none", evidence: `no deny rule matched; ${tried}` };
}

function absolutize(input: Record<string, unknown>, root: string): Record<string, unknown> {
  const out = { ...input };
  for (const k of ["file_path", "path", "notebook_path"]) {
    const v = out[k];
    if (typeof v === "string" && !v.startsWith("/")) out[k] = `${root}/${v}`;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function safeRegex(matcher: string, tool: string): boolean {
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false;
  }
}
