import { discoverConfig } from "./config/discover.js";
import { staticProbe } from "./probe/static.js";
import { buildReport } from "./report/build.js";
import { extractRulesFromProse, fellBack } from "./rules/extract.js";
import { rulesFromSettings } from "./rules/from-settings.js";
import { normalizeRule } from "./rules/normalize.js";
import { applyOverrides, loadOverrides, OVERRIDES_PATH } from "./rules/overrides.js";
import type { Rule, ScanReport } from "./types.js";
import { dockerAvailable, ensureImage, IMAGE, probeInDocker } from "./sandbox/docker.js";
import { createHostSandbox } from "./sandbox/host.js";
import { collectFingerprint } from "./fingerprint.js";
import { detectProfile, profileLine } from "./repo/profile.js";
import { adapterFor, detectRuntimes } from "./runtimes/index.js";
import { claudeCode } from "./runtimes/claude-code.js";
import type { RuntimeCoverage } from "./types.js";

export interface ScanOptions {
  offline?: boolean;
  model?: string;
  askCounts?: boolean;
  /** Never execute hook scripts anywhere; report matching hooks as unknown. */
  noHooks?: boolean;
  /** Execute hook scripts on this machine instead of in a container. Only for repos you trust. */
  unsafeRunHooks?: boolean;
  onProgress?: (msg: string) => void;
}

export async function collectRules(root: string, opts: ScanOptions = {}): Promise<{ cfg: Awaited<ReturnType<typeof discoverConfig>>; rules: Rule[] }> {
  const cfg = await discoverConfig(root);
  const prose = await extractRulesFromProse(cfg, { offline: opts.offline, model: opts.model, onProgress: opts.onProgress });
  const perms = rulesFromSettings(cfg);
  // Which reader produced these rules, in the run's own log. The two fail in
  // opposite directions, and a model call that failed and fell back used to
  // leave no trace: the report described keyword output while the command line
  // had asked for the model.
  if (prose.length || cfg.proseFiles.length) opts.onProgress?.(extractionLine(prose, opts.offline === true));
  for (const f of fellBack) opts.onProgress?.(`  ${f.file}: the model could not be used (${f.why}), so these rules are the keyword reader's`);
  const { rules: corrected, applied } = applyOverrides([...prose, ...perms].map(normalizeRule), await loadOverrides(cfg.root));
  for (const a of applied) opts.onProgress?.(`  ${OVERRIDES_PATH}: ${a.ruleId} read as ${a.from}, corrected to ${a.to}`);
  return { cfg, rules: corrected };
}

/**
 * One line saying who read the rule files, and how well that reader does.
 *
 * The numbers are from `scripts/corpus-accuracy.ts` against the frozen corpus
 * in `fixtures/corpus`, not a guess. They belong next to the rules because a
 * reader that finds a little over half the checkable rules is a different
 * thing to be handed than a list that looks complete.
 */
export function extractionLine(prose: Rule[], askedOffline: boolean): string {
  const byReader = new Set(prose.map((r) => (r.source.kind === "prose" ? (r.source.reader ?? "keyword") : "keyword")));
  const who = byReader.size > 1 ? "a mix of the model and the keyword reader" : byReader.has("model") ? "a model" : "the offline keyword reader";
  const accuracy = byReader.has("model")
    ? "on six real rule files it finds about 3 in 5 of the mechanically checkable rules, and files roughly a fifth of the judgement ones under a category that has a probe behind it"
    : "on six real rule files it finds about 2 in 5 of the mechanically checkable rules and gets almost no targets right";
  return `rules read by ${who}${askedOffline ? " (--offline)" : ""}: ${accuracy}. Anything missed here is missing from everything below.`;
}

export async function scan(root: string, opts: ScanOptions = {}): Promise<ScanReport> {
  const { cfg, rules } = await collectRules(root, opts);
  const log = opts.onProgress ?? (() => {});
  const profile = await detectProfile(cfg.root, { defaultBranch: rules.find((r) => r.category === "protect-branch")?.targets[0] });
  log(`repository: ${profileLine(profile)}`);
  const runtimes = await collectRuntimeCoverage(cfg.root, log);
  // Judge the repository by the runtime it is configured for. A repository
  // with AGENTS.md and no .claude directory is a Codex repository, and the
  // absence of a Claude Code deny entry says nothing about it.
  const primary = runtimes.find((r) => r.id !== "claude-code" && !runtimes.some((x) => x.id === "claude-code"));
  const adapter = primary ? adapterFor(primary.id as Parameters<typeof adapterFor>[0]) : claudeCode;
  const adapterConfig = primary ? await adapter.discover(cfg.root) : undefined;
  if (primary) log(`evaluating against ${adapter.label}, which is what this repository is configured for`);
  const hasHooks = cfg.settings.some((s) => Object.keys(s.json.hooks ?? {}).length > 0);
  let statics;
  let sandbox: "docker" | "host" | "none" = "none";
  if (opts.noHooks || !hasHooks) {
    statics = await staticProbe(cfg, rules, { profile, adapter, adapterConfig, askCounts: opts.askCounts, noHooks: true, onProgress: log });
  } else if (opts.unsafeRunHooks) {
    sandbox = "host";
    log("running the repo's hook scripts on this machine (--unsafe-run-hooks)");
    statics = await staticProbe(cfg, rules, { profile, adapter, adapterConfig, askCounts: opts.askCounts, onProgress: log });
  } else if (await dockerAvailable()) {
    sandbox = "docker";
    await ensureImage(log);
    const sb = await createHostSandbox(cfg.root, { rules, profile });
    try {
      log("probing hooks in a container (repo hook scripts do not run on this machine)");
      statics = await probeInDocker(sb, rules, profile, (m) => log(m));
    } finally {
      await sb.destroy();
    }
  } else {
    log("docker not available: hook scripts were not executed; rules they might cover are reported as unknown. Pass --unsafe-run-hooks to run them here.");
    statics = await staticProbe(cfg, rules, { profile, adapter, adapterConfig, askCounts: opts.askCounts, noHooks: true, onProgress: log });
  }
  const fingerprint = await collectFingerprint({ sandbox, image: sandbox === "docker" ? IMAGE : undefined, approvalMode: "n/a" });
  return buildReport(cfg.root, rules, statics, [], "static", fingerprint, { profile, runtimes });
}

/**
 * Which runtimes this repository is set up for, and how much of each this
 * scan actually covers. A repository configured for a runtime paperfence can
 * only read is a repository whose verdicts do not describe it, and the report
 * has to say that rather than let an absence of findings read as safety.
 */
export async function collectRuntimeCoverage(root: string, log: (m: string) => void = () => {}): Promise<RuntimeCoverage[]> {
  const found = await detectRuntimes(root);
  return found.map(({ adapter, markers }) => {
    const covered = adapter.support.evaluate && adapter.support.drive;
    if (!covered) log(`note: this repository is configured for ${adapter.label}, which paperfence can read but not verify. Its verdicts below describe Claude Code only.`);
    return {
      id: adapter.id,
      label: adapter.label,
      markers,
      support: adapter.support,
      covered,
      notes: adapter.notes,
      outOfScope: [],
    };
  });
}
