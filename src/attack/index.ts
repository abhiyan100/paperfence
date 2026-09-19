import pc from "picocolors";
import { discoverConfig } from "../config/discover.js";
import { staticProbe } from "../probe/static.js";
import { buildReport } from "../report/build.js";
import { specFor } from "../rules/catalog.js";
import { createHostSandbox, plantPressureFiles } from "../sandbox/host.js";
import { startSink, type Sink } from "../sandbox/sink.js";
import { dockerAvailable, ensureImage, IMAGE, probeInDocker, runInDocker } from "../sandbox/docker.js";
import { collectFingerprint } from "../fingerprint.js";
import { collectRules } from "../scan.js";
import type { AttackRun, PressureLevel, Rule, ScanReport } from "../types.js";
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
  /** Skip live runs for rules the static probe already shows as gated. Default false: a live agent may find a form the probes missed. */
  skipStaticGates?: boolean;
  /** "docker" (default) runs the agent in a container with no credential and no route out; "host" runs it here behind a best-effort guard. */
  sandbox?: "docker" | "host";
  onProgress?: (msg: string) => void;
  onRun?: (run: AttackRun, rule: Rule) => void;
}

/**
 * For every attackable rule: static probe first (free), then live runs at
 * rising pressure until the rule breaks, is mechanically blocked, or we run
 * out of levels. Each run gets a fresh sandbox.
 */
export async function attack(root: string, opts: AttackOptions = {}): Promise<ScanReport> {
  const model = opts.model ?? process.env.PAPERFENCE_MODEL ?? "claude-sonnet-5";
  const maxLevel = opts.maxLevel ?? 3;
  const maxTurns = opts.maxTurns ?? 30;
  const log = opts.onProgress ?? (() => {});

  const cfg = await discoverConfig(root);
  const { rules } = await collectRules(root, { offline: opts.offline, onProgress: log });

  const selected = rules.filter((r) => {
    if (!specFor(r.category).attackable) return false;
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
    const psb = await createHostSandbox(root, { rules });
    try {
      log("static probe in a container (repo hooks run there, not on this machine)");
      statics = await probeInDocker(psb, rules, (m) => log(pc.dim(m)));
    } finally {
      await psb.destroy();
    }
  } else {
    statics = await staticProbe(cfg, rules, { onProgress: log });
  }
  const staticById = new Map(statics.map((s) => [s.ruleId, s]));
  // In docker mode the sink runs inside the container; here it only exists in host mode.
  const sink: Sink = useDocker ? { port: 0, hits: [], close: async () => {} } : await startSink();
  const runs: AttackRun[] = [];
  try {
    for (const rule of selected) {
      const spec = specFor(rule.category);
      const sp = staticById.get(rule.id);
      if (opts.skipStaticGates && sp && sp.blockedBy !== "none") {
        log(`${pc.green("gate")} ${rule.id}: static probe already shows a block (${sp.blockedBy}); skipping live runs`);
        continue;
      }
      for (let level = 1 as PressureLevel; level <= maxLevel; level = (level + 1) as PressureLevel) {
        sink.hits.length = 0;
        const sb = await createHostSandbox(root, { rules, keepOnExit: opts.keepSandbox, plant: spec.setup });
        await plantPressureFiles(sb, level);
        const objective = spec.objective(rule, level);
        log(`${pc.yellow("attack")} ${rule.id} level ${level}: ${spec.violation}`);
        let partial: Awaited<ReturnType<typeof runAdversary>>;
        if (useDocker) {
          const r = await runInDocker(rule, level, objective, sb, { model, maxTurns, onProgress: (m) => log(pc.dim(m)) });
          sink.hits.push(...r.sinkHits);
          partial = r;
        } else {
          partial = await runAdversary(rule, level, objective, sb, {
            model,
            maxTurns,
            guard: true,
            onEvent: (e) => log(pc.dim(`    ${e.tool} ${summarizeInput(e.input)}`)),
          });
        }
        const a = await runAssertion(spec.assertion, rule, sb, partial.events, partial.finalText, sink);
        const ctx = { secretFiles: sb.secretFiles, defaultBranch: sb.defaultBranch };
        // A denied call only counts as a gate for THIS rule if the call would have violated THIS rule.
        const relevantBlock = firstViolation(rule, partial.events.filter((e) => e.denied && !(e.deniedReason ?? "").includes("paperfence-guard")), ctx);
        // A call our own guard stopped counts as an attempted violation only if it was one.
        const relevantGuard = firstViolation(rule, partial.events.filter((e) => e.denied && (e.deniedReason ?? "").includes("paperfence-guard")), ctx);
        const run: AttackRun = {
          ...partial,
          violated: a.violated || relevantGuard !== null,
          violationEvidence: [...a.evidence, ...(relevantGuard ? [`attempted (stopped by paperfence guard, not by the repo): ${relevantGuard.why}`] : [])],
          mechanicallyBlocked: relevantBlock !== null,
          blockEvidence: relevantBlock ? [`${relevantBlock.event.tool} was blocked: ${relevantBlock.why}: ${(relevantBlock.event.deniedReason ?? "").split("\n")[0]?.slice(0, 200)}`] : [],
        };
        runs.push(run);
        opts.onRun?.(run, rule);
        if (!opts.keepSandbox) await sb.destroy();
        else log(pc.dim(`    sandbox kept at ${sb.dir}`));

        if (run.error) log(pc.red(`    ${run.error}`));
        if (run.violated) {
          log(`${pc.red("broken")} ${rule.id} at level ${level}: ${run.violationEvidence[0] ?? ""}`);
          break;
        }
        if (run.mechanicallyBlocked) {
          log(`${pc.green("gate")} ${rule.id}: ${run.blockEvidence[0] ?? ""}`);
          break;
        }
        log(pc.dim(`    held at level ${level} (agent declined)`));
      }
    }
  } finally {
    await sink.close();
  }

  const fingerprint = await collectFingerprint({ model, sandbox: useDocker ? "docker" : "host", image: useDocker ? IMAGE : undefined, approvalMode: "auto-approve" });
  return buildReport(cfg.root, rules, statics, runs, "attack", fingerprint);
}

function summarizeInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.url ?? i.path ?? i.pattern ?? "";
  return String(v).slice(0, 100);
}
