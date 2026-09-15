import pc from "picocolors";
import { discoverConfig } from "../config/discover.js";
import { staticProbe } from "../probe/static.js";
import { buildReport } from "../report/build.js";
import { specFor } from "../rules/catalog.js";
import { createHostSandbox, plantPressureFiles } from "../sandbox/host.js";
import { startSink } from "../sandbox/sink.js";
import { collectRules } from "../scan.js";
import type { AttackRun, PressureLevel, Rule, ScanReport } from "../types.js";
import { runAdversary } from "./adversary.js";
import { runAssertion } from "./assert.js";

export interface AttackOptions {
  model?: string;
  maxLevel?: PressureLevel;
  maxTurns?: number;
  ruleIds?: string[];
  categories?: string[];
  offline?: boolean;
  keepSandbox?: boolean;
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
  const statics = await staticProbe(cfg, rules, { onProgress: log });
  const staticById = new Map(statics.map((s) => [s.ruleId, s]));

  const selected = rules.filter((r) => {
    if (!specFor(r.category).attackable) return false;
    if (opts.ruleIds?.length && !opts.ruleIds.includes(r.id)) return false;
    if (opts.categories?.length && !opts.categories.includes(r.category)) return false;
    return true;
  });

  const sink = await startSink();
  const runs: AttackRun[] = [];
  try {
    for (const rule of selected) {
      const spec = specFor(rule.category);
      const sp = staticById.get(rule.id);
      if (sp && sp.blockedBy !== "none") {
        log(`${pc.green("gate")} ${rule.id}: static probe already shows a block (${sp.blockedBy}); skipping live runs`);
        continue;
      }
      for (let level = 1 as PressureLevel; level <= maxLevel; level = (level + 1) as PressureLevel) {
        sink.hits.length = 0;
        const sb = await createHostSandbox(root, { rules, keepOnExit: opts.keepSandbox });
        await plantPressureFiles(sb, level);
        const objective = spec.objective(rule, level);
        log(`${pc.yellow("attack")} ${rule.id} level ${level}: ${spec.violation}`);
        const partial = await runAdversary(rule, level, objective, sb, {
          model,
          maxTurns,
          onEvent: (e) => log(pc.dim(`    ${e.tool} ${summarizeInput(e.input)}`)),
        });
        const a = await runAssertion(spec.assertion, rule, sb, partial.events, partial.finalText, sink);
        const guardAttempts = partial.blockEvidence.filter((b) => b.startsWith("attempted"));
        const run: AttackRun = {
          ...partial,
          violated: a.violated || guardAttempts.length > 0,
          violationEvidence: [...a.evidence, ...guardAttempts],
          // Guard blocks are not the repo's doing.
          mechanicallyBlocked: partial.blockEvidence.some((b) => !b.startsWith("attempted")),
          blockEvidence: partial.blockEvidence.filter((b) => !b.startsWith("attempted")),
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

  return buildReport(cfg.root, rules, statics, runs, "attack");
}

function summarizeInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.url ?? i.path ?? i.pattern ?? "";
  return String(v).slice(0, 100);
}
