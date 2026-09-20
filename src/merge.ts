import { profileLine } from "./repo/profile.js";
import { buildReport } from "./report/build.js";
import { listReceipts, readReceipt, verifyReceipt, type Receipt } from "./receipt.js";
import { scenarioFor } from "./scenarios/catalog.js";
import type { AttackRun, Fingerprint, Rule, ScanReport } from "./types.js";

/**
 * Combine receipts from several runs into one report.
 *
 * This is what makes sharding possible without a server. A receipt already
 * carries everything a verdict needs: the rule, the scenario and its version,
 * the form, the pressure level, the events, the verdict itself, and the
 * fingerprint of the conditions. Five machines running a fifth of the trials
 * each produce five sets of receipts, and this turns them back into the report
 * one machine would have produced, minus the wall-clock.
 *
 * Two things it refuses to do quietly. It will not merge receipts whose
 * conditions differ, because trials run against different runtimes or models
 * are not the same experiment; the differing fields are named and the merge
 * fails unless the caller says to proceed. And it will not accept a receipt
 * that does not hash to its own contents.
 */

export interface MergeOptions {
  /** Merge even when the fingerprints differ. The report records what differed. */
  allowMixed?: boolean;
  onProgress?: (m: string) => void;
}

export interface MergeResult {
  report: ScanReport;
  receipts: Receipt[];
  /** Fingerprint fields that were not the same across every receipt. */
  mixed: { field: string; values: string[] }[];
  /** Receipts rejected, and why. */
  rejected: { id: string; why: string }[];
}

/** Fields that must match for two trials to belong to the same experiment. */
const MUST_MATCH: (keyof Fingerprint)[] = ["paperfence", "claudeCode", "agentSdk", "model", "sandbox", "image", "approvalMode"];

export async function mergeReceipts(paths: string[], root: string, opts: MergeOptions = {}): Promise<MergeResult> {
  const log = opts.onProgress ?? (() => {});
  const receipts: Receipt[] = [];
  const rejected: { id: string; why: string }[] = [];

  for (const p of paths) {
    let r: Receipt;
    try {
      r = await readReceipt(root, p);
    } catch (e) {
      rejected.push({ id: p, why: (e as Error).message });
      continue;
    }
    if (!verifyReceipt(r)) {
      rejected.push({ id: r.id, why: "does not hash to its own contents; it has been edited and is not evidence" });
      continue;
    }
    if (receipts.some((x) => x.id === r.id)) continue; // the same receipt twice is one trial
    receipts.push(r);
  }

  if (!receipts.length) throw new Error(`no usable receipts${rejected.length ? `; ${rejected.length} rejected` : ""}`);

  const mixed: { field: string; values: string[] }[] = [];
  for (const field of MUST_MATCH) {
    const values = [...new Set(receipts.map((r) => String(r.fingerprint[field] ?? "unset")))];
    if (values.length > 1) mixed.push({ field, values });
  }
  if (mixed.length && !opts.allowMixed) {
    throw new Error(
      `these receipts did not come from the same setup, so merging them would report one experiment where there were several: ${mixed
        .map((m) => `${m.field} is ${m.values.join(" and ")}`)
        .join("; ")}. Pass --allow-mixed to merge anyway; the report will say what differed.`,
    );
  }
  for (const m of mixed) log(`mixed ${m.field}: ${m.values.join(", ")}`);

  // Rebuild the runs the report wants from the evidence the receipts hold.
  const rules = new Map<string, Rule>();
  const runs: AttackRun[] = [];
  for (const r of receipts) {
    const rule: Rule = {
      id: r.trial.rule.id,
      text: r.trial.rule.text,
      category: r.trial.rule.category,
      targets: r.trial.rule.targets,
      source: { kind: "prose", file: "receipt" },
    };
    rules.set(rule.id, rule);
    runs.push({
      ruleId: rule.id,
      scenarioId: r.trial.scenario,
      scenarioVersion: r.trial.scenarioVersion,
      formId: r.trial.form,
      formDescribe: r.trial.formDescribe,
      level: r.trial.level,
      model: r.fingerprint.model ?? "unknown",
      startedAt: Date.parse(r.at),
      endedAt: Date.parse(r.at) + r.durationMs,
      events: r.events,
      finalText: r.finalText,
      violated: r.verdict.verdict === "FAIL",
      violationEvidence: r.verdict.verdict === "FAIL" ? [r.verdict.explain] : [],
      mechanicallyBlocked: r.verdict.reason === "blocked-by-control",
      blockEvidence: r.verdict.reason === "blocked-by-control" ? [r.verdict.explain] : [],
      costUsd: r.costUsd,
      turns: r.turns,
      error: r.error,
      verdict: r.verdict,
      receipt: r.id,
    });
  }

  // Forms this repository could not support are not in any receipt, so a merged
  // report cannot claim to know about them. It says so rather than implying
  // the scenario was fully covered.
  const skippedForms = new Map<string, { form: string; missing: string[] }[]>();
  for (const [id, rule] of rules) {
    const tried = new Set(runs.filter((r) => r.ruleId === id).map((r) => r.formId));
    const all = scenarioFor(rule.category).forms;
    const missing = all.filter((f) => !tried.has(f.id)).map((f) => ({ form: f.id, missing: ["no receipt for this form in the merged set"] }));
    if (missing.length) skippedForms.set(id, missing);
  }

  const first = receipts[0]!;
  const fingerprint: Fingerprint = { ...first.fingerprint, at: new Date().toISOString() };
  const report = buildReport(first.repo.root, [...rules.values()], [], runs, "attack", fingerprint, { skippedForms });
  log(`merged ${receipts.length} receipt(s) into ${report.verdicts.length} verdict(s)`);
  return { report, receipts, mixed, rejected };
}

/** Every receipt in the repository, for `merge --all`. */
export async function allReceiptIds(root: string): Promise<string[]> {
  return (await listReceipts(root)).map((r) => r.id);
}

/**
 * Which trials belong to this shard.
 *
 * Deterministic and stateless: shard k of n takes every nth item. No
 * coordinator, no queue, and a shard that dies takes only its own slice with
 * it. Round-robin rather than contiguous blocks, so a long-running scenario
 * does not land entirely on one machine.
 */
export function shardOf<T>(items: T[], shard: number, total: number): T[] {
  if (total <= 1) return items;
  if (shard < 1 || shard > total) throw new Error(`--shard ${shard}/${total}: the shard number must be between 1 and ${total}`);
  return items.filter((_, i) => i % total === shard - 1);
}

/** Parse "2/5" into its parts. */
export function parseShard(spec: string): { shard: number; total: number } {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`--shard expects "k/n", for example "2/5"; got ${JSON.stringify(spec)}`);
  const shard = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || shard < 1 || shard > total) throw new Error(`--shard ${spec}: k must be between 1 and n`);
  return { shard, total };
}

export function mergeSummary(r: MergeResult): string {
  const lines: string[] = [];
  lines.push(`${r.receipts.length} receipt(s) from ${new Set(r.receipts.map((x) => x.fingerprint.at.slice(0, 10))).size} run date(s)`);
  if (r.mixed.length) {
    lines.push("These did not all come from the same setup:");
    for (const m of r.mixed) lines.push(`  ${m.field}: ${m.values.join(", ")}`);
  }
  if (r.rejected.length) {
    lines.push(`${r.rejected.length} rejected:`);
    for (const x of r.rejected.slice(0, 5)) lines.push(`  ${x.id}: ${x.why}`);
  }
  return lines.join("\n");
}

export { profileLine };
