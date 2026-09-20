import pc from "picocolors";
import { runAssertion } from "../attack/assert.js";
import { firstViolation } from "../attack/match.js";
import { Budget } from "../budget.js";
import { shardOf } from "../merge.js";
import { collectFingerprint } from "../fingerprint.js";
import { detectProfile, profileLine, type RepoProfile } from "../repo/profile.js";
import { VERSION } from "../report/build.js";
import { plantPressureFiles, scenarioFor } from "../scenarios/catalog.js";
import { applicableForms, notApplicableReason, type ScenarioContext } from "../scenarios/types.js";
import { dockerAvailable, ensureImage, IMAGE, runInDocker } from "../sandbox/docker.js";
import { createHostSandbox } from "../sandbox/host.js";
import type { Sink } from "../sandbox/sink.js";
import { collectRules } from "../scan.js";
import type { CompareReport, PressureLevel, Rule, Suite, TaskRun, Variant, VariantSummary, VerdictDetail } from "../types.js";
import { hitTimeLimit, hitTurnBudget, verdictFor } from "../verdict.js";
import { redact } from "../receipt.js";
import { runChecks } from "./checks.js";
import { formFor, loadSuite, objectiveFor, resolveRule } from "./suite.js";
import { materialize, type VariantSpec } from "./variants.js";

export interface CompareOptions {
  variants: VariantSpec[];
  model?: string;
  reps?: number;
  maxTurns?: number;
  level?: PressureLevel;
  offline?: boolean;
  /** Run only these task ids. */
  only?: string[];
  /** Stop starting new trials once this much has been spent, in dollars. */
  budgetUsd?: number;
  /** Run only this shard of the task list, for splitting a run across machines. */
  shard?: { shard: number; total: number };
  onProgress?: (m: string) => void;
}

/**
 * The recurring question: can this change to the agent's configuration be
 * merged? For every variant, run every bad task (must be blocked) and every
 * good task (must still complete), in Docker, interleaving variants per task
 * so drift affects both arms equally. Output one receipt.
 *
 * Denominators count only trials that reached a conclusion. A task that could
 * not run here, or whose container died, is reported separately rather than
 * being folded into "blocked".
 */
export async function compare(root: string, opts: CompareOptions): Promise<CompareReport> {
  const log = opts.onProgress ?? (() => {});
  const model = opts.model ?? process.env.PAPERFENCE_MODEL ?? "claude-sonnet-5";
  const reps = Math.max(1, opts.reps ?? 1);
  const maxTurns = opts.maxTurns ?? 30;

  if (!(await dockerAvailable())) throw new Error("compare needs Docker: every task runs a real agent in a container");
  await ensureImage(log);

  const { cfg, rules } = await collectRules(root, { offline: opts.offline, onProgress: log });
  const profile = await detectProfile(cfg.root, { defaultBranch: rules.find((r) => r.category === "protect-branch")?.targets[0] });
  log(`repository: ${profileLine(profile)}`);
  const { suite, source } = await loadSuite(root, rules, { level: opts.level, profile, onProgress: log });
  const filtered: Suite = opts.only?.length
    ? { bad: suite.bad.filter((t) => opts.only!.includes(t.id)), good: suite.good.filter((t) => opts.only!.includes(t.id)) }
    : suite;
  log(`suite: ${filtered.bad.length} bad task(s), ${filtered.good.length} good task(s) (${source === "file" ? ".paperfence/suite.json" : "default, derived from the repo"})`);

  const variants: (Variant & { destroy: () => Promise<void>; rules: Rule[]; profile: RepoProfile })[] = [];
  for (const spec of opts.variants) {
    const v = await materialize(cfg.root, spec, model);
    // Each variant has its own rule set: a --without variant has fewer rules.
    const { rules: vrules } = await collectRules(v.dir, { offline: opts.offline });
    const vprofile = await detectProfile(v.dir, { defaultBranch: profile.defaultBranch });
    variants.push({ ...v, rules: vrules, profile: vprofile });
    log(`variant ${pc.bold(v.name)}: ${v.describe} · model ${v.model}`);
  }

  const budget = new Budget(opts.budgetUsd);
  const runs: TaskRun[] = [];
  const noSink: Sink = { port: 0, hits: [], close: async () => {} };

  try {
    const allTasks: { id: string; kind: "bad" | "good" }[] = [
      ...filtered.bad.map((t) => ({ id: t.id, kind: "bad" as const })),
      ...filtered.good.map((t) => ({ id: t.id, kind: "good" as const })),
    ];
    // Shard by task, never by variant: both arms of a task must run on the same
    // machine or the comparison is between two different machines.
    const tasks = opts.shard ? shardOf(allTasks, opts.shard.shard, opts.shard.total) : allTasks;
    if (opts.shard) log(`shard ${opts.shard.shard}/${opts.shard.total}: ${tasks.length} of ${allTasks.length} task(s)`);
    for (let rep = 1; rep <= reps; rep++) {
      for (const [ti, t] of tasks.entries()) {
        // Interleave: alternate which variant goes first per task so order effects do not favour one arm.
        const order = (ti + rep) % 2 === 0 ? variants : [...variants].reverse();
        for (const v of order) {
          if (budget.exhausted) break;
          const label = `${t.kind} ${t.id} · ${v.name}${reps > 1 ? ` · rep ${rep}` : ""}`;
          log(pc.yellow(label));
          const started = Date.now();
          const badTask = t.kind === "bad" ? filtered.bad.find((b) => b.id === t.id) : undefined;
          const badRule = badTask ? (resolveRule(badTask, v.rules) ?? resolveRule(badTask, rules)) : undefined;
          const ctx: ScenarioContext | undefined = badRule ? { rule: badRule, profile: v.profile } : undefined;
          const form = badTask && badRule && ctx ? formFor(badTask, badRule, ctx) : undefined;

          // A bad task whose scenario has no applicable form here is reported as
          // NOT APPLICABLE, never as "blocked".
          if (badTask && badRule && ctx && !form) {
            const why = notApplicableReason(applicableForms(scenarioFor(badRule.category), ctx));
            const verdict: VerdictDetail = { verdict: "NOT_APPLICABLE", reason: "prerequisites-missing", explain: why };
            runs.push({ taskId: t.id, kind: "bad", variant: v.name, rep, passed: false, verdict, evidence: [why], askedHuman: 0, denied: 0, turns: 0, durationMs: 0, events: [], finalText: "" });
            log(`  ${pc.dim("n/a")} ${why}`);
            continue;
          }

          const sb = await createHostSandbox(v.dir, {
            rules: v.rules,
            profile: v.profile,
            plant: form?.setup && ctx ? (work) => form.setup!(work, ctx) : undefined,
          });
          try {
            let run: TaskRun;
            if (t.kind === "bad") {
              const task = badTask!;
              if (!badRule || !form || !ctx) {
                const why = `rule "${task.rule}" not found in variant ${v.name}`;
                run = {
                  taskId: t.id, kind: "bad", variant: v.name, rep, passed: false,
                  verdict: { verdict: "ERROR", reason: "infrastructure-error", explain: why },
                  evidence: [why], askedHuman: 0, denied: 0, turns: 0, durationMs: 0, error: "no rule", events: [], finalText: "",
                };
              } else {
                const level = task.level ?? opts.level ?? 2;
                await plantPressureFiles(sb.work, level, sb.defaultBranch);
                const objective = objectiveFor(task, form, ctx, level);
                const partial = await runInDocker(badRule, level, objective, sb, { model: v.model, maxTurns, onProgress: (m) => log(pc.dim(m)) });
                const sink: Sink = { ...noSink, hits: partial.sinkHits };
                const a = await runAssertion(scenarioFor(badRule.category).assertion, badRule, sb, partial.events, partial.finalText, sink);
                const vctx = { secretFiles: sb.secretFiles, defaultBranch: sb.defaultBranch };
                const denied = partial.events.filter((e) => e.denied).length;
                // Only a refusal from the runtime or a hook counts as a control.
                const relevantBlock = firstViolation(badRule, partial.events.filter((e) => e.denied && e.deniedBy !== "error-text"), vctx);
                const hitTurnLimit = hitTurnBudget(partial.error);
                const verdict = verdictFor({
                  effectOccurred: a.violated,
                  blockedByControl: relevantBlock !== null,
                  stoppedByGuard: false,
                  askedHuman: partial.events.some((e) => e.tool === "AskUserQuestion"),
                  hitTurnLimit,
                  timedOut: hitTimeLimit(partial.error),
                  error: partial.error && !hitTurnLimit && !hitTimeLimit(partial.error) ? partial.error : undefined,
                  evidence: a.evidence[0] ?? (relevantBlock ? `blocked: ${relevantBlock.why}` : undefined),
                });
                run = {
                  taskId: t.id, kind: "bad", variant: v.name, rep,
                  passed: verdict.verdict === "PASS",
                  verdict,
                  evidence: a.violated ? a.evidence : [verdict.explain],
                  askedHuman: partial.events.filter((e) => e.tool === "AskUserQuestion").length,
                  denied, turns: partial.turns, costUsd: partial.costUsd, durationMs: Date.now() - started,
                  error: partial.error, events: partial.events, finalText: partial.finalText,
                };
              }
            } else {
              const task = filtered.good.find((g) => g.id === t.id)!;
              // Good tasks use a throwaway rule so the runner has something to log against.
              const pseudo: Rule = { id: t.id, text: task.prompt, category: "other", targets: [], source: { kind: "prose", file: "suite" } };
              const partial = await runInDocker(pseudo, 1, task.prompt, sb, { model: v.model, maxTurns, onProgress: (m) => log(pc.dim(m)) });
              const c = await runChecks(sb, task.checks, (m) => log(pc.dim(m)));
              const infra = partial.error && !hitTurnBudget(partial.error) ? partial.error : undefined;
              const verdict: VerdictDetail = infra
                ? { verdict: "ERROR", reason: "infrastructure-error", explain: `the trial did not complete: ${infra}` }
                : c.passed
                  ? { verdict: "PASS", reason: "agent-declined", explain: "every check passed" }
                  : { verdict: "FAIL", reason: "checks-failed", explain: c.failures[0] ?? "a check failed" };
              run = {
                taskId: t.id, kind: "good", variant: v.name, rep,
                passed: verdict.verdict === "PASS",
                verdict,
                evidence: partial.error ? [partial.error, ...c.failures] : c.failures,
                askedHuman: partial.events.filter((e) => e.tool === "AskUserQuestion").length,
                denied: partial.events.filter((e) => e.denied).length,
                turns: partial.turns, costUsd: partial.costUsd, durationMs: Date.now() - started,
                error: partial.error, events: partial.events, finalText: partial.finalText,
              };
            }
            // Redact at the sandbox boundary: the assertions are done and
            // everything from here ends up in a report or an HTML file.
            run = redact(run, sb.canary);
            budget.add(run.costUsd);
            runs.push(run);
            const tag =
              run.verdict?.verdict === "PASS" ? pc.green("pass")
              : run.verdict?.verdict === "FAIL" ? pc.red("FAIL")
              : run.verdict?.verdict === "INCONCLUSIVE" ? pc.yellow("inconclusive")
              : pc.magenta("error");
            log(`  ${tag} ${run.verdict?.explain ?? run.evidence[0] ?? ""}${run.askedHuman ? pc.dim(` · asked ${run.askedHuman}x`) : ""}${run.denied ? pc.dim(` · denied ${run.denied}`) : ""}`);
          } finally {
            await sb.destroy();
          }
        }
      }
    }
  } finally {
    for (const v of variants) await v.destroy();
  }

  const summaries: VariantSummary[] = variants.map((v) => {
    const mine = runs.filter((r) => r.variant === v.name);
    const conclusive = (k: "bad" | "good") => mine.filter((r) => r.kind === k && (r.verdict?.verdict === "PASS" || r.verdict?.verdict === "FAIL"));
    const bad = conclusive("bad");
    const good = conclusive("good");
    return {
      variant: { name: v.name, dir: v.dir, model: v.model, describe: v.describe },
      badBlocked: bad.filter((r) => r.passed).length,
      badTotal: bad.length,
      goodCompleted: good.filter((r) => r.passed).length,
      goodTotal: good.length,
      askedHuman: mine.reduce((a, r) => a + r.askedHuman, 0),
      denied: mine.reduce((a, r) => a + r.denied, 0),
      costUsd: mine.reduce((a, r) => a + (r.costUsd ?? 0), 0),
      errors: mine.filter((r) => r.verdict?.verdict === "ERROR").length,
      inconclusive: mine.filter((r) => r.verdict?.verdict === "INCONCLUSIVE").length,
      notApplicable: mine.filter((r) => r.verdict?.verdict === "NOT_APPLICABLE").length,
    };
  });

  const fingerprint = await collectFingerprint({ model, sandbox: "docker", image: IMAGE, approvalMode: "auto-approve" });
  return {
    version: VERSION,
    repo: cfg.root,
    at: new Date().toISOString(),
    suite: filtered,
    variants: variants.map((v) => ({ name: v.name, dir: v.dir, model: v.model, describe: v.describe })),
    runs,
    summaries,
    reps,
    fingerprint,
    budgetNote: budget.note,
  };
}
