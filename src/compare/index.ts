import pc from "picocolors";
import { runAssertion } from "../attack/assert.js";
import { firstViolation } from "../attack/match.js";
import { collectFingerprint } from "../fingerprint.js";
import { VERSION } from "../report/build.js";
import { specFor } from "../rules/catalog.js";
import { dockerAvailable, ensureImage, IMAGE, runInDocker } from "../sandbox/docker.js";
import { createHostSandbox, plantPressureFiles } from "../sandbox/host.js";
import type { Sink } from "../sandbox/sink.js";
import { collectRules } from "../scan.js";
import type { CompareReport, PressureLevel, Rule, Suite, TaskRun, Variant, VariantSummary } from "../types.js";
import { runChecks } from "./checks.js";
import { loadSuite, objectiveFor, resolveRule } from "./suite.js";
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
  onProgress?: (m: string) => void;
}

/**
 * The recurring question: can this change to the agent's configuration be
 * merged? For every variant, run every bad task (must be blocked) and every
 * good task (must still complete), in Docker, interleaving variants per task
 * so drift affects both arms equally. Output one receipt.
 */
export async function compare(root: string, opts: CompareOptions): Promise<CompareReport> {
  const log = opts.onProgress ?? (() => {});
  const model = opts.model ?? process.env.PAPERFENCE_MODEL ?? "claude-sonnet-5";
  const reps = Math.max(1, opts.reps ?? 1);
  const maxTurns = opts.maxTurns ?? 30;

  if (!(await dockerAvailable())) throw new Error("compare needs Docker: every task runs a real agent in a container");
  await ensureImage(log);

  const { cfg, rules } = await collectRules(root, { offline: opts.offline, onProgress: log });
  const { suite, source } = await loadSuite(root, rules, { level: opts.level, onProgress: log });
  const filtered: Suite = opts.only?.length
    ? { bad: suite.bad.filter((t) => opts.only!.includes(t.id)), good: suite.good.filter((t) => opts.only!.includes(t.id)) }
    : suite;
  log(`suite: ${filtered.bad.length} bad task(s), ${filtered.good.length} good task(s) (${source === "file" ? ".paperfence/suite.json" : "default, derived from the repo"})`);

  const variants: (Variant & { destroy: () => Promise<void>; rules: Rule[] })[] = [];
  for (const spec of opts.variants) {
    const v = await materialize(cfg.root, spec, model);
    // Each variant has its own rule set: a --without variant has fewer rules.
    const { rules: vrules } = await collectRules(v.dir, { offline: opts.offline });
    variants.push({ ...v, rules: vrules });
    log(`variant ${pc.bold(v.name)}: ${v.describe} · model ${v.model}`);
  }

  const runs: TaskRun[] = [];
  const noSink: Sink = { port: 0, hits: [], close: async () => {} };

  try {
    const tasks: { id: string; kind: "bad" | "good" }[] = [...filtered.bad.map((t) => ({ id: t.id, kind: "bad" as const })), ...filtered.good.map((t) => ({ id: t.id, kind: "good" as const }))];
    for (let rep = 1; rep <= reps; rep++) {
      for (const [ti, t] of tasks.entries()) {
        // Interleave: alternate which variant goes first per task so order effects do not favour one arm.
        const order = (ti + rep) % 2 === 0 ? variants : [...variants].reverse();
        for (const v of order) {
          const label = `${t.kind} ${t.id} · ${v.name}${reps > 1 ? ` · rep ${rep}` : ""}`;
          log(pc.yellow(label));
          const started = Date.now();
          const badTask = t.kind === "bad" ? filtered.bad.find((b) => b.id === t.id) : undefined;
          const badRule = badTask ? (resolveRule(badTask, v.rules) ?? resolveRule(badTask, rules)) : undefined;
          const sb = await createHostSandbox(v.dir, { rules: v.rules, plant: badRule ? specFor(badRule.category).setup : undefined });
          try {
            let run: TaskRun;
            if (t.kind === "bad") {
              const task = badTask!;
              const rule = badRule;
              if (!rule) {
                run = { taskId: t.id, kind: "bad", variant: v.name, rep, passed: false, evidence: [`rule "${task.rule}" not found in variant ${v.name}`], askedHuman: 0, denied: 0, turns: 0, durationMs: 0, error: "no rule", events: [], finalText: "" };
              } else {
                const level = task.level ?? opts.level ?? 2;
                await plantPressureFiles(sb, level);
                const objective = objectiveFor(task, rule);
                const partial = await runInDocker(rule, level, objective, sb, { model: v.model, maxTurns, onProgress: (m) => log(pc.dim(m)) });
                const sink: Sink = { ...noSink, hits: partial.sinkHits };
                const a = await runAssertion(specFor(rule.category).assertion, rule, sb, partial.events, partial.finalText, sink);
                const ctx = { secretFiles: sb.secretFiles, defaultBranch: sb.defaultBranch };
                const denied = partial.events.filter((e) => e.denied).length;
                const relevantBlock = firstViolation(rule, partial.events.filter((e) => e.denied), ctx);
                run = {
                  taskId: t.id, kind: "bad", variant: v.name, rep,
                  passed: !a.violated,
                  evidence: a.violated ? a.evidence : relevantBlock ? [`blocked: ${relevantBlock.why}`] : ["agent declined"],
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
              run = {
                taskId: t.id, kind: "good", variant: v.name, rep,
                passed: c.passed && !partial.error,
                evidence: partial.error ? [partial.error, ...c.failures] : c.failures,
                askedHuman: partial.events.filter((e) => e.tool === "AskUserQuestion").length,
                denied: partial.events.filter((e) => e.denied).length,
                turns: partial.turns, costUsd: partial.costUsd, durationMs: Date.now() - started,
                error: partial.error, events: partial.events, finalText: partial.finalText,
              };
            }
            runs.push(run);
            log(`  ${run.passed ? pc.green("pass") : pc.red("FAIL")} ${run.evidence[0] ?? ""}${run.askedHuman ? pc.dim(` · asked ${run.askedHuman}x`) : ""}${run.denied ? pc.dim(` · denied ${run.denied}`) : ""}`);
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
    const bad = mine.filter((r) => r.kind === "bad");
    const good = mine.filter((r) => r.kind === "good");
    return {
      variant: { name: v.name, dir: v.dir, model: v.model, describe: v.describe },
      badBlocked: bad.filter((r) => r.passed).length,
      badTotal: bad.length,
      goodCompleted: good.filter((r) => r.passed).length,
      goodTotal: good.length,
      askedHuman: mine.reduce((a, r) => a + r.askedHuman, 0),
      denied: mine.reduce((a, r) => a + r.denied, 0),
      costUsd: mine.reduce((a, r) => a + (r.costUsd ?? 0), 0),
      errors: mine.filter((r) => r.error).length,
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
  };
}
