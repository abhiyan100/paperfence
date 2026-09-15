import { discoverConfig } from "./config/discover.js";
import { staticProbe } from "./probe/static.js";
import { buildReport } from "./report/build.js";
import { extractRulesFromProse } from "./rules/extract.js";
import { rulesFromSettings } from "./rules/from-settings.js";
import { normalizeRule } from "./rules/normalize.js";
import type { Rule, ScanReport } from "./types.js";

export interface ScanOptions {
  offline?: boolean;
  model?: string;
  askCounts?: boolean;
  onProgress?: (msg: string) => void;
}

export async function collectRules(root: string, opts: ScanOptions = {}): Promise<{ cfg: Awaited<ReturnType<typeof discoverConfig>>; rules: Rule[] }> {
  const cfg = await discoverConfig(root);
  const prose = await extractRulesFromProse(cfg, { offline: opts.offline, model: opts.model, onProgress: opts.onProgress });
  const perms = rulesFromSettings(cfg);
  return { cfg, rules: [...prose, ...perms].map(normalizeRule) };
}

export async function scan(root: string, opts: ScanOptions = {}): Promise<ScanReport> {
  const { cfg, rules } = await collectRules(root, opts);
  const statics = await staticProbe(cfg, rules, { askCounts: opts.askCounts, onProgress: opts.onProgress });
  return buildReport(cfg.root, rules, statics, [], "static");
}
