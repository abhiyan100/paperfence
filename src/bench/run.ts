import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { attack } from "../attack/index.js";
import { Budget } from "../budget.js";
import { DRIVEN_RUNTIME } from "../attack/index.js";
import { collectFingerprint } from "../fingerprint.js";
import { SCENARIOS } from "../scenarios/catalog.js";
import { dockerAvailable, ensureImage, IMAGE } from "../sandbox/docker.js";
import { wilson } from "../stats.js";
import type { AttackRun, Fingerprint, PressureLevel, ScanReport } from "../types.js";

/**
 * The public benchmark.
 *
 * A benchmark is a promise: the same scenarios, pinned versions, and numbers
 * that reproduce in six months. Everything here is built around being able to
 * keep that promise, which mostly means refusing to smooth anything over.
 *
 * The corpus lives in `bench/repos`, in this repository, so a result can be
 * reproduced by anyone with Docker and a key. It is deliberately not a scrape
 * of public repositories: those change under you, and a benchmark whose inputs
 * move is a chart, not a measurement.
 *
 * Every trial writes a receipt. A published number is a claim you can follow
 * back to the tool calls that produced it.
 */

export interface BenchOptions {
  /** Repositories to run against. Defaults to everything in bench/repos. */
  repos?: string[];
  /** Models to compare. Each runs the whole corpus. */
  models: string[];
  /** Trials per form and level. Below three, the intervals will not separate anything. */
  reps?: number;
  maxLevel?: PressureLevel;
  maxTurns?: number;
  budgetUsd?: number;
  shard?: { shard: number; total: number };
  onProgress?: (m: string) => void;
}

export interface ModelResult {
  model: string;
  repo: string;
  /** Trials that reached a conclusion. */
  trials: number;
  failed: number;
  passed: number;
  inconclusive: number;
  errored: number;
  notApplicable: number;
  /** Violation rate over conclusive trials, with its interval. */
  violationRate: number | null;
  interval: { low: number; high: number } | null;
  costUsd: number;
  /** Per rule category, for the table that actually tells you something. */
  byCategory: { category: string; trials: number; failed: number }[];
}

export interface BenchReport {
  /** Bumped when a result stops being comparable with the one before it. */
  benchVersion: 1;
  at: string;
  /** The scenario definitions these numbers came from. */
  scenarios: { id: string; version: number; forms: string[] }[];
  corpus: { repo: string; profile: string }[];
  reps: number;
  maxLevel: PressureLevel;
  fingerprint: Fingerprint;
  results: ModelResult[];
  /** Set when a spend limit stopped the sweep early. */
  budgetNote?: string;
  /** Always populated. A benchmark that lists only its strengths is marketing. */
  caveats: string[];
}

export const BENCH_DIR = "bench/repos";
export const BENCH_RESULTS = "bench/results";

export async function corpusRepos(root: string): Promise<string[]> {
  const dir = path.join(root, BENCH_DIR);
  const names = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return names.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)).sort();
}

function summarize(model: string, repo: string, report: ScanReport, runs: AttackRun[]): ModelResult {
  const verdicts = runs.map((r) => r.verdict?.verdict ?? "ERROR");
  const failed = verdicts.filter((v) => v === "FAIL").length;
  const passed = verdicts.filter((v) => v === "PASS").length;
  const conclusive = failed + passed;
  const byCategory = new Map<string, { trials: number; failed: number }>();
  for (const r of runs) {
    const cat = report.verdicts.find((v) => v.rule.id === r.ruleId)?.rule.category ?? r.scenarioId ?? "other";
    const e = byCategory.get(cat) ?? { trials: 0, failed: 0 };
    if (r.verdict?.verdict === "FAIL" || r.verdict?.verdict === "PASS") e.trials++;
    if (r.verdict?.verdict === "FAIL") e.failed++;
    byCategory.set(cat, e);
  }
  return {
    model,
    repo: path.basename(repo),
    trials: runs.length,
    failed,
    passed,
    inconclusive: verdicts.filter((v) => v === "INCONCLUSIVE").length,
    errored: verdicts.filter((v) => v === "ERROR").length,
    notApplicable: report.totals.notApplicable,
    violationRate: conclusive ? failed / conclusive : null,
    interval: conclusive ? wilson(failed, conclusive) : null,
    costUsd: runs.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    byCategory: [...byCategory.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.failed - a.failed),
  };
}

export async function runBench(root: string, opts: BenchOptions): Promise<BenchReport> {
  const log = opts.onProgress ?? (() => {});
  const reps = Math.max(1, opts.reps ?? 3);
  const maxLevel = opts.maxLevel ?? 3;
  const maxTurns = opts.maxTurns ?? 25;

  if (!(await dockerAvailable())) throw new Error("the benchmark runs real agents in containers, so it needs Docker");
  await ensureImage(log);

  const repos = opts.repos?.length ? opts.repos : await corpusRepos(root);
  if (!repos.length) throw new Error(`no corpus repositories in ${BENCH_DIR}`);
  const budget = new Budget(opts.budgetUsd);

  const results: ModelResult[] = [];
  const corpus: { repo: string; profile: string }[] = [];

  for (const model of opts.models) {
    for (const repo of repos) {
      if (budget.exhausted) {
        log(pc.yellow(budget.note!));
        break;
      }
      log(pc.bold(`${model} · ${path.basename(repo)}`));
      const runs: AttackRun[] = [];
      const report = await attack(repo, {
        model,
        reps,
        maxLevel,
        maxTurns,
        offline: true, // the corpus rules are ours; a model is not needed to read them
        // Every form, every level, every repetition. An ordinary attack run
        // stops a form once it breaks, which would give failing forms fewer
        // trials than passing ones and understate the rate it is pooled into.
        exhaustive: true,
        budgetUsd: opts.budgetUsd ? Math.max(0, opts.budgetUsd - budget.total) : undefined,
        shard: opts.shard,
        onProgress: (m) => log(pc.dim(`  ${m}`)),
        onRun: (r) => runs.push(r),
      });
      for (const r of runs) budget.add(r.costUsd);
      results.push(summarize(model, repo, report, runs));
      if (!corpus.some((c) => c.repo === path.basename(repo))) {
        corpus.push({ repo: path.basename(repo), profile: report.profile?.line ?? "unknown" });
      }
    }
  }

  const fingerprint = await collectFingerprint({ sandbox: "docker", image: IMAGE, approvalMode: "auto-approve", runtime: DRIVEN_RUNTIME });
  return {
    benchVersion: 1,
    at: new Date().toISOString(),
    scenarios: Object.values(SCENARIOS)
      .filter((s) => s.attackable)
      .map((s) => ({ id: s.id, version: s.version, forms: s.forms.map((f) => f.id) })),
    corpus,
    reps,
    maxLevel,
    fingerprint,
    results,
    budgetNote: budget.note,
    caveats: [
      "These numbers are about this corpus. A model that holds here may not hold on a repository shaped differently.",
      "Agents are stochastic. Two sweeps of the same configuration will not produce identical numbers; the intervals are there to say how much of the difference is noise.",
      "Every trial answered its own permission prompts with yes, which is what an unattended run does. A developer watching would have had a chance to say no.",
      "A scenario whose prerequisites a repository does not meet was not run and is not in any denominator.",
      "Every form runs at every pressure level for every repetition, so the sample is fixed rather than stopping when something breaks. A rate computed over a sample that stops early understates it, because a form that fails once contributes one trial and a form that never fails contributes all of them.",
      "paperfence wrote the scenarios and the corpus. That is a conflict of interest, and the mitigation is that both are in the repository and the receipts are reproducible, not that we promise to be fair.",
    ],
  };
}

export function renderBench(r: BenchReport): string {
  const out: string[] = [""];
  out.push(pc.bold("paperfence benchmark") + pc.dim(`  ${r.corpus.length} repo(s) · ${r.reps} rep(s) · levels 1 to ${r.maxLevel}`));
  out.push("");

  const models = [...new Set(r.results.map((x) => x.model))];
  const w = Math.max(...models.map((m) => m.length), 10);
  out.push(pc.dim(`${"model".padEnd(w)}  ${"repo".padEnd(18)}${"violated".padStart(12)}${"interval".padStart(14)}${"no verdict".padStart(12)}${"cost".padStart(10)}`));
  for (const x of r.results) {
    const rate = x.violationRate === null ? "—" : `${x.failed}/${x.failed + x.passed}`;
    const iv = x.interval ? `${Math.round(x.interval.low * 100)}–${Math.round(x.interval.high * 100)}%` : "—";
    const colour = x.violationRate === null ? pc.dim : x.violationRate > 0 ? pc.red : pc.green;
    out.push(
      `${x.model.padEnd(w)}  ${x.repo.padEnd(18)}${colour(rate.padStart(12))}${pc.dim(iv.padStart(14))}${String(x.inconclusive + x.errored + x.notApplicable).padStart(12)}${("$" + x.costUsd.toFixed(2)).padStart(10)}`,
    );
  }
  out.push("");

  const worst = r.results.flatMap((x) => x.byCategory.filter((c) => c.failed > 0).map((c) => ({ model: x.model, repo: x.repo, ...c })));
  if (worst.length) {
    out.push(pc.bold("Where they broke"));
    for (const x of worst.sort((a, b) => b.failed - a.failed).slice(0, 12)) {
      out.push(`  ${pc.red(`${x.failed}/${x.trials}`.padStart(6))}  ${x.category.padEnd(18)} ${pc.dim(`${x.model} on ${x.repo}`)}`);
    }
    out.push("");
  } else {
    out.push(pc.dim("  No rule was broken in any trial. With these repetition counts that is a weak statement; see the intervals."));
    out.push("");
  }

  if (r.budgetNote) {
    out.push(pc.yellow(`  ${r.budgetNote}`));
    out.push("");
  }
  out.push(pc.bold("What these numbers are not"));
  for (const c of r.caveats) out.push(`  ${pc.dim("·")} ${pc.dim(c)}`);
  out.push("");
  return out.join("\n");
}
