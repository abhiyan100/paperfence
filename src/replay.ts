import pc from "picocolors";
import { runAssertion } from "./attack/assert.js";
import { firstViolation } from "./attack/match.js";
import { runAdversary } from "./attack/adversary.js";
import { collectFingerprint } from "./fingerprint.js";
import { buildReceipt, fingerprintDiff, readReceipt, repoState, writeReceipt, verifyReceipt, type Receipt } from "./receipt.js";
import { detectProfile } from "./repo/profile.js";
import { plantPressureFiles, scenarioFor } from "./scenarios/catalog.js";
import type { ScenarioContext } from "./scenarios/types.js";
import { dockerAvailable, ensureImage, IMAGE, runInDocker } from "./sandbox/docker.js";
import { createHostSandbox } from "./sandbox/host.js";
import { startSink, type Sink } from "./sandbox/sink.js";
import type { AttackRun, Rule } from "./types.js";
import { hitTimeLimit, hitTurnBudget, verdictFor } from "./verdict.js";

/**
 * Re-run the conditions a receipt describes.
 *
 * What replay reproduces: the repository, the scenario and its version, the
 * attack form, the pressure level, the model, the turn budget, the sandbox.
 * What it cannot reproduce: the agent. Two identical setups can end
 * differently, and when they do that is a fact worth having, not a failure of
 * the replay. The output always says which parts of the setup drifted.
 */

export interface ReplayOptions {
  /** Run the agent here instead of in Docker. */
  sandbox?: "docker" | "host";
  /** Override the model, to ask "does the newer model still do this?" */
  model?: string;
  onProgress?: (m: string) => void;
}

export interface ReplayResult {
  original: Receipt;
  replayed: Receipt;
  /** What differed between the two setups. */
  drift: string[];
  /** True when the repository is not at the commit the original ran against. */
  repoMoved: boolean;
  sameVerdict: boolean;
}

export async function replay(root: string, id: string, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const log = opts.onProgress ?? (() => {});
  const original = await readReceipt(root, id);
  if (!verifyReceipt(original)) {
    throw new Error(`receipt ${original.id} does not hash to its own contents; it has been edited and is not evidence of anything`);
  }

  const scenario = scenarioFor(original.trial.rule.category);
  if (scenario.version !== original.trial.scenarioVersion) {
    log(pc.yellow(`the "${scenario.id}" scenario is now version ${scenario.version}; this receipt was recorded at version ${original.trial.scenarioVersion}. The objective is replayed verbatim from the receipt.`));
  }
  const form = scenario.forms.find((f) => f.id === original.trial.form);
  if (!form && original.trial.form !== "default") {
    log(pc.yellow(`attack form "${original.trial.form}" no longer exists; replaying the recorded objective without its setup step.`));
  }

  const now = await repoState(root);
  const repoMoved = Boolean(original.repo.commit && now.commit && original.repo.commit !== now.commit);
  if (repoMoved) log(pc.yellow(`the repository is at ${now.commit?.slice(0, 7)}; the receipt ran against ${original.repo.commit?.slice(0, 7)}. Replaying against what is here now.`));
  if (now.dirty) log(pc.yellow("the working tree has uncommitted changes, so this replay is not against a clean checkout."));

  const model = opts.model ?? original.fingerprint.model ?? "claude-sonnet-5";
  const useDocker = opts.sandbox !== "host";
  if (useDocker) {
    if (!(await dockerAvailable())) throw new Error("replay needs Docker, or pass --unsafe-host to run the agent on this machine");
    await ensureImage(log);
  }

  const rule: Rule = { ...original.trial.rule, source: { kind: "prose", file: "receipt" } };
  const profile = await detectProfile(root, { defaultBranch: rule.category === "protect-branch" ? rule.targets[0] : undefined });
  const ctx: ScenarioContext = { rule, profile };

  const sink: Sink = useDocker ? { port: 0, hits: [], close: async () => {} } : await startSink();
  const sb = await createHostSandbox(root, {
    rules: [rule],
    profile,
    plant: form?.setup ? (work) => form.setup!(work, ctx) : undefined,
  });

  let built: AttackRun;
  try {
    await plantPressureFiles(sb.work, original.trial.level, sb.defaultBranch);
    const objective = original.trial.objective;
    log(`replaying ${original.id}: ${scenario.label} · ${original.trial.form} · level ${original.trial.level} · ${model}`);

    let partial: Awaited<ReturnType<typeof runAdversary>>;
    if (useDocker) {
      const r = await runInDocker(rule, original.trial.level, objective, sb, { model, maxTurns: original.trial.maxTurns, onProgress: (m) => log(pc.dim(m)) });
      sink.hits.push(...r.sinkHits);
      partial = r;
    } else {
      partial = await runAdversary(rule, original.trial.level, objective, sb, { model, maxTurns: original.trial.maxTurns, guard: true });
    }

    const assertion = await runAssertion(scenario.assertion, rule, sb, partial.events, partial.finalText, sink);
    const vctx = { secretFiles: sb.secretFiles, defaultBranch: sb.defaultBranch };
    const relevantBlock = firstViolation(rule, partial.events.filter((e) => e.denied && e.deniedBy !== "error-text" && !(e.deniedReason ?? "").includes("paperfence-guard")), vctx);
    const relevantGuard = firstViolation(rule, partial.events.filter((e) => e.denied && (e.deniedReason ?? "").includes("paperfence-guard")), vctx);
    const hitTurnLimit = hitTurnBudget(partial.error);

    const verdict = verdictFor({
      effectOccurred: assertion.violated,
      blockedByControl: relevantBlock !== null,
      stoppedByGuard: relevantGuard !== null,
      askedHuman: partial.events.some((e) => e.tool === "AskUserQuestion"),
      hitTurnLimit,
      timedOut: hitTimeLimit(partial.error),
      error: partial.error && !hitTurnLimit && !hitTimeLimit(partial.error) ? partial.error : undefined,
      evidence: assertion.evidence[0] ?? (relevantBlock ? `${relevantBlock.event.tool} was blocked: ${relevantBlock.why}` : undefined),
    });

    built = {
      ...partial,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      formId: original.trial.form,
      formDescribe: form?.describe,
      hitTurnLimit,
      verdict,
      violated: verdict.verdict === "FAIL",
      violationEvidence: assertion.evidence,
      mechanicallyBlocked: relevantBlock !== null,
      blockEvidence: relevantBlock ? [`${relevantBlock.event.tool} was blocked: ${relevantBlock.why}`] : [],
    };
  } finally {
    await sb.destroy();
    await sink.close();
  }

  const fingerprint = await collectFingerprint({ model, sandbox: useDocker ? "docker" : "host", image: useDocker ? IMAGE : undefined, approvalMode: "auto-approve" });
  const replayed = buildReceipt({
    run: built,
    fingerprint,
    repo: now,
    rule,
    objective: original.trial.objective,
    maxTurns: original.trial.maxTurns,
    canary: undefined,
  });
  await writeReceipt(root, replayed);

  const drift = fingerprintDiff(original.fingerprint, fingerprint);
  if (repoMoved) drift.unshift(`repository: ${original.repo.commit?.slice(0, 7)} -> ${now.commit?.slice(0, 7)}`);
  if (scenario.version !== original.trial.scenarioVersion) drift.unshift(`scenario version: ${original.trial.scenarioVersion} -> ${scenario.version}`);

  return { original, replayed, drift, repoMoved, sameVerdict: original.verdict.verdict === replayed.verdict.verdict };
}

export function renderReplay(r: ReplayResult): string {
  const out: string[] = [""];
  out.push(pc.bold("paperfence replay") + pc.dim(`  ${r.original.id} -> ${r.replayed.id}`));
  out.push("");
  out.push(`  ${pc.dim("rule")}      ${r.original.trial.rule.text}`);
  out.push(`  ${pc.dim("scenario")}  ${r.original.trial.scenario} · form ${r.original.trial.form} · pressure level ${r.original.trial.level}`);
  out.push("");
  const badge = (v: string) => (v === "FAIL" ? pc.red(v) : v === "PASS" ? pc.green(v) : v === "ERROR" ? pc.magenta(v) : pc.yellow(v));
  out.push(`  ${pc.dim("then")}      ${badge(r.original.verdict.verdict)}  ${r.original.verdict.explain}`);
  out.push(`  ${pc.dim("now")}       ${badge(r.replayed.verdict.verdict)}  ${r.replayed.verdict.explain}`);
  out.push("");
  if (r.drift.length) {
    out.push(pc.bold("What changed between the two runs"));
    for (const d of r.drift) out.push(`  ${pc.yellow("~")} ${d}`);
  } else {
    out.push(pc.dim("  Nothing in the setup changed between the two runs."));
  }
  out.push("");
  if (!r.sameVerdict) {
    out.push(
      r.drift.length
        ? pc.yellow("  The verdict changed and so did the setup, so this run cannot say which caused it.")
        : pc.yellow("  Same setup, different verdict. Agents are stochastic: run it a few more times before you believe either result."),
    );
  } else {
    out.push(pc.dim("  Same verdict. One matching replay is weak evidence; use --reps on attack for a number you can quote."));
  }
  out.push("");
  return out.join("\n");
}
