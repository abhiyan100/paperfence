import pc from "picocolors";
import { discoverConfig } from "../config/discover.js";
import { staticProbe } from "../probe/static.js";
import { buildReport } from "../report/build.js";
import { detectProfile, profileLine, type RepoProfile } from "../repo/profile.js";
import { plantPressureFiles, scenarioFor } from "../scenarios/catalog.js";
import { applicableForms, notApplicableReason, type AttackForm, type ScenarioContext } from "../scenarios/types.js";
import { createHostSandbox } from "../sandbox/host.js";
import { startSink, type Sink } from "../sandbox/sink.js";
import { dockerAvailable, ensureImage, IMAGE, probeInDocker, runInDocker } from "../sandbox/docker.js";
import { Budget } from "../budget.js";
import { shardOf } from "../merge.js";
import { collectFingerprint } from "../fingerprint.js";
import { buildReceipt, redact, repoState, writeReceipt, type ReceiptRepo } from "../receipt.js";
import { collectRules, collectRuntimeCoverage } from "../scan.js";
import type { AttackRun, Fingerprint, PressureLevel, Rule, ScanReport } from "../types.js";
import { hitTimeLimit, hitTurnBudget, verdictFor } from "../verdict.js";
import { runAdversary } from "./adversary.js";
import { runAssertion } from "./assert.js";
import { firstViolation } from "./match.js";

export interface AttackOptions {
  model?: string;
  maxLevel?: PressureLevel;
  maxTurns?: number;
  ruleIds?: string[];
  categories?: string[];
  offline?: boolean;
  keepSandbox?: boolean;
  /** Trials per (form, level). More trials narrow the interval; agent behaviour is stochastic. */
  reps?: number;
  /** Try only this attack form. */
  formIds?: string[];
  /** Skip live runs for rules the static probe already shows as gated. Default false: a live agent may find a form the probes missed. */
  skipStaticGates?: boolean;
  /** "docker" (default) runs the agent in a container with no credential and no route out; "host" runs it here behind a best-effort guard. */
  sandbox?: "docker" | "host";
  /** Write a receipt per trial into .paperfence/receipts. Default true. */
  receipts?: boolean;
  /** Stop starting new trials once this much has been spent, in dollars. */
  budgetUsd?: number;
  /** Run only this shard of the trial list, for splitting a run across machines. */
  shard?: { shard: number; total: number };
  onProgress?: (msg: string) => void;
  onRun?: (run: AttackRun, rule: Rule) => void;
}

/**
 * For every attackable rule: static probe first (free), then live trials.
 *
 * A rule is attacked through several *forms*: different tasks that all end in
 * the same forbidden effect. A form whose prerequisites this repository does
 * not meet is not run and is reported as such; it never counts as the rule
 * holding. Within a form, pressure rises until the rule breaks or the levels
 * run out. Each trial gets a fresh sandbox.
 */
export async function attack(root: string, opts: AttackOptions = {}): Promise<ScanReport> {
  const model = opts.model ?? process.env.PAPERFENCE_MODEL ?? "claude-sonnet-5";
  const maxLevel = opts.maxLevel ?? 3;
  const maxTurns = opts.maxTurns ?? 30;
  const reps = Math.max(1, opts.reps ?? 1);
  const log = opts.onProgress ?? (() => {});

  const cfg = await discoverConfig(root);
  const { rules } = await collectRules(root, { offline: opts.offline, onProgress: log });
  const profile = await detectProfile(cfg.root, { defaultBranch: rules.find((r) => r.category === "protect-branch")?.targets[0] });
  log(`repository: ${profileLine(profile)}`);
  const runtimes = await collectRuntimeCoverage(cfg.root, log);

  const selected = rules.filter((r) => {
    if (!scenarioFor(r.category).attackable) return false;
    if (opts.ruleIds?.length && !opts.ruleIds.includes(r.id)) return false;
    if (opts.categories?.length && !opts.categories.includes(r.category)) return false;
    return true;
  });

  const useDocker = opts.sandbox !== "host";
  if (useDocker) {
    if (!(await dockerAvailable())) {
      throw new Error("docker is not available. Install Docker, or pass --unsafe-host to run the agent on this machine behind a best-effort guard.");
    }
    await ensureImage(log);
  } else {
    log(pc.yellow("host mode: the agent runs on this machine. paperfence's guard hook is a best-effort filter, not a boundary."));
  }

  // Static probe. In docker mode the repo's hook scripts run inside a container, never here.
  let statics;
  if (useDocker) {
    const psb = await createHostSandbox(root, { rules, profile });
    try {
      log("static probe in a container (repo hooks run there, not on this machine)");
      statics = await probeInDocker(psb, rules, profile, (m) => log(pc.dim(m)));
    } finally {
      await psb.destroy();
    }
  } else {
    statics = await staticProbe(cfg, rules, { profile, onProgress: log });
  }
  const staticById = new Map(statics.map((s) => [s.ruleId, s]));

  // Conditions are fixed before the first trial, so every receipt in this run describes the same setup.
  const fingerprint = await collectFingerprint({ model, sandbox: useDocker ? "docker" : "host", image: useDocker ? IMAGE : undefined, approvalMode: "auto-approve" });
  const repo = await repoState(cfg.root);

  // In docker mode the sink runs inside the container; here it only exists in host mode.
  const sink: Sink = useDocker ? { port: 0, hits: [], close: async () => {} } : await startSink();
  const budget = new Budget(opts.budgetUsd);
  const runs: AttackRun[] = [];
  const notApplicable = new Map<string, string>();
  const skippedForms = new Map<string, { form: string; missing: string[] }[]>();

  try {
    for (const rule of selected) {
      const scenario = scenarioFor(rule.category);
      const ctx: ScenarioContext = { rule, profile };
      const applicability = applicableForms(scenario, ctx);
      skippedForms.set(rule.id, applicability.skipped);

      if (applicability.forms.length === 0) {
        const why = notApplicableReason(applicability);
        notApplicable.set(rule.id, why);
        log(`${pc.dim("n/a")} ${rule.id}: ${why}`);
        continue;
      }
      for (const s of applicability.skipped) log(pc.dim(`    form "${s.form}" not applicable: needs ${s.missing.join("; or ")}`));

      const sp = staticById.get(rule.id);
      if (opts.skipStaticGates && sp && sp.blockedBy !== "none") {
        log(`${pc.green("gate")} ${rule.id}: static probe already shows a block (${sp.blockedBy}); skipping live trials`);
        continue;
      }

      const forms = opts.formIds?.length ? applicability.forms.filter((f) => opts.formIds!.includes(f.id)) : applicability.forms;
      // Shard by form: a form is the unit that escalates through pressure
      // levels, so splitting inside one would have each machine deciding
      // "settled" without seeing the others' results.
      const mine = opts.shard ? shardOf(forms, opts.shard.shard, opts.shard.total) : forms;
      if (opts.shard && mine.length !== forms.length) {
        log(pc.dim(`    shard ${opts.shard.shard}/${opts.shard.total}: ${mine.length} of ${forms.length} form(s) for this rule`));
      }
      for (const form of mine) {
        let settled = false;
        for (let level = 1 as PressureLevel; level <= maxLevel && !settled; level = (level + 1) as PressureLevel) {
          for (let rep = 0; rep < reps && !settled; rep++) {
            if (budget.exhausted) {
              log(pc.yellow(`    ${budget.note}`));
              settled = true;
              break;
            }
            const run = await oneTrial({ rule, form, ctx, level, profile, model, maxTurns, useDocker, sink, keepSandbox: opts.keepSandbox, log, fingerprint, repo, writeReceipts: opts.receipts !== false });
            budget.add(run.costUsd);
            runs.push(run);
            opts.onRun?.(run, rule);
            const v = run.verdict!;
            const label = `${rule.id} · ${form.id} · level ${level}${reps > 1 ? ` · rep ${rep + 1}` : ""}`;
            if (v.verdict === "FAIL") {
              log(`${pc.red("broken")} ${label}: ${v.explain}`);
              settled = true;
            } else if (v.verdict === "PASS" && v.reason === "blocked-by-control") {
              log(`${pc.green("gate")} ${label}: ${v.explain}`);
              settled = true;
            } else if (v.verdict === "ERROR") {
              log(pc.magenta(`    error ${label}: ${v.explain}`));
            } else if (v.verdict === "INCONCLUSIVE") {
              log(pc.yellow(`    inconclusive ${label}: ${v.explain}`));
            } else {
              log(pc.dim(`    held ${label}: ${v.explain}`));
            }
          }
        }
      }
    }
  } finally {
    await sink.close();
  }

  if (budget.note) log(pc.yellow(budget.note));
  return buildReport(cfg.root, rules, statics, runs, "attack", fingerprint, { profile, runtimes, notApplicable, skippedForms, budgetNote: budget.note });
}

interface TrialArgs {
  rule: Rule;
  form: AttackForm;
  ctx: ScenarioContext;
  level: PressureLevel;
  profile: RepoProfile;
  model: string;
  maxTurns: number;
  useDocker: boolean;
  sink: Sink;
  keepSandbox?: boolean;
  log: (m: string) => void;
  fingerprint: Fingerprint;
  repo: ReceiptRepo;
  writeReceipts: boolean;
}

async function oneTrial(a: TrialArgs): Promise<AttackRun> {
  const scenario = scenarioFor(a.rule.category);
  a.sink.hits.length = 0;
  const sb = await createHostSandbox(a.ctx.profile.root, {
    rules: [a.rule],
    profile: a.profile,
    keepOnExit: a.keepSandbox,
    plant: a.form.setup ? (work) => a.form.setup!(work, a.ctx) : undefined,
  });
  try {
    await plantPressureFiles(sb.work, a.level, sb.defaultBranch);
    const objective = a.form.objective(a.ctx, a.level);
    a.log(`${pc.yellow("attack")} ${a.rule.id} · ${a.form.id} · level ${a.level}: ${a.form.describe}`);

    let partial: Awaited<ReturnType<typeof runAdversary>>;
    if (a.useDocker) {
      const r = await runInDocker(a.rule, a.level, objective, sb, { model: a.model, maxTurns: a.maxTurns, onProgress: (m) => a.log(pc.dim(m)) });
      a.sink.hits.push(...r.sinkHits);
      partial = r;
    } else {
      partial = await runAdversary(a.rule, a.level, objective, sb, {
        model: a.model,
        maxTurns: a.maxTurns,
        guard: true,
        onEvent: (e) => a.log(pc.dim(`    ${e.tool} ${summarizeInput(e.input)}`)),
      });
    }

    const assertion = await runAssertion(scenario.assertion, a.rule, sb, partial.events, partial.finalText, a.sink);
    const vctx = { secretFiles: sb.secretFiles, defaultBranch: sb.defaultBranch };
    // A denied call counts as a gate for THIS rule only if the call would have
    // violated THIS rule AND the refusal came from the runtime or a hook. A
    // command that printed "permission denied" itself is not a control, and
    // `cat .env; echo "permission denied" >&2; exit 1` had already read the file.
    const enforced = partial.events.filter((e) => e.denied && e.deniedBy !== "error-text" && !(e.deniedReason ?? "").includes("paperfence-guard"));
    const relevantBlock = firstViolation(a.rule, enforced, vctx);
    // A call our own guard stopped counts as an attempted violation only if it was one.
    const relevantGuard = firstViolation(a.rule, partial.events.filter((e) => e.denied && (e.deniedReason ?? "").includes("paperfence-guard")), vctx);

    const hitTurnLimit = hitTurnBudget(partial.error);
    const infraError = partial.error && !hitTurnLimit && !hitTimeLimit(partial.error) ? partial.error : undefined;

    const verdict = verdictFor({
      effectOccurred: assertion.violated,
      blockedByControl: relevantBlock !== null,
      stoppedByGuard: relevantGuard !== null,
      askedHuman: partial.events.some((e) => e.tool === "AskUserQuestion"),
      hitTurnLimit,
      timedOut: hitTimeLimit(partial.error),
      error: infraError,
      evidence:
        assertion.evidence[0] ??
        (relevantGuard ? `the agent attempted it (${relevantGuard.why}); only paperfence's sandbox guard stopped it, not this repo` : undefined) ??
        (relevantBlock ? `${relevantBlock.event.tool} was blocked: ${relevantBlock.why}` : undefined),
    });

    const built: AttackRun = {
      ...partial,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      formId: a.form.id,
      formDescribe: a.form.describe,
      hitTurnLimit,
      verdict,
      violated: verdict.verdict === "FAIL",
      violationEvidence: [...assertion.evidence, ...(relevantGuard ? [`attempted (stopped by paperfence guard, not by the repo): ${relevantGuard.why}`] : [])],
      mechanicallyBlocked: relevantBlock !== null,
      blockEvidence: relevantBlock ? [`${relevantBlock.event.tool} was blocked: ${relevantBlock.why}: ${(relevantBlock.event.deniedReason ?? "").split("\n")[0]?.slice(0, 200)}`] : [],
    };

    // Redact once, here, at the boundary of the sandbox. The assertions above
    // needed the canary to detect a leak; nothing after this point does, and
    // everything after this point ends up in a report, an HTML file or a
    // receipt. Redacting only the receipt left the canary in the other two.
    const clean = redact(built, sb.canary);
    Object.assign(built, clean);

    if (a.writeReceipts) {
      const receipt = buildReceipt({ run: built, fingerprint: a.fingerprint, repo: a.repo, rule: a.rule, objective, maxTurns: a.maxTurns, canary: sb.canary });
      await writeReceipt(a.repo.root, receipt);
      built.receipt = receipt.id;
      a.log(pc.dim(`    receipt ${receipt.id}`));
    }
    return built;
  } finally {
    if (!a.keepSandbox) await sb.destroy();
    else a.log(pc.dim(`    sandbox kept at ${sb.dir}`));
  }
}

function summarizeInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.url ?? i.path ?? i.pattern ?? "";
  return String(v).slice(0, 100);
}
