import { promises as fs } from "node:fs";
import path from "node:path";
import type { Rule, RuleCategory } from "../types.js";

/**
 * A human's correction of how a rule was read.
 *
 * Extraction is a model reading prose, and measured against six real rule
 * files it files roughly a fifth of the judgement statements under a category
 * that has a probe behind it. `Do not add tests for values that are statically
 * defined` came back as `protect-tests`; `Target Rust modules under 500 LoC`
 * came back as `scope`. Until now the only way to disagree was to stop using
 * the tool, and in a repository with deny entries a miscategorised rule is
 * reported as protected by a control that has nothing to do with it.
 *
 * So the reading is correctable, in one small file, keyed by the rule id the
 * report already prints. Setting a rule to `other` means "this is judgement,
 * do not probe it", which is the correction most often needed.
 *
 * Deliberately not a policy language. It changes how an existing rule is
 * filed; it cannot invent a rule, and it cannot claim a control exists.
 */

export const OVERRIDES_PATH = ".paperfence/categories.json";

const CATEGORIES = new Set<RuleCategory>([
  "protect-branch", "protect-tests", "protect-secrets", "no-destructive", "no-force-push",
  "no-install", "scope", "ask-first", "no-exfil", "require-before", "other",
]);

export interface AppliedOverride {
  ruleId: string;
  from: RuleCategory;
  to: RuleCategory;
  text: string;
}

export async function loadOverrides(root: string): Promise<Record<string, RuleCategory>> {
  const raw = await fs.readFile(path.join(root, OVERRIDES_PATH), "utf8").catch(() => null);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A broken override file must not silently mean "no corrections".
    throw new Error(`${OVERRIDES_PATH} is not valid JSON, so the corrections in it were not applied`);
  }
  const out: Record<string, RuleCategory> = {};
  for (const [id, cat] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
    if (id.startsWith("//") || id === "$schema") continue; // comment keys
    if (typeof cat !== "string" || !CATEGORIES.has(cat as RuleCategory)) {
      throw new Error(`${OVERRIDES_PATH}: "${id}" is set to ${JSON.stringify(cat)}, which is not a category paperfence has`);
    }
    out[id] = cat as RuleCategory;
  }
  return out;
}

export function applyOverrides(rules: Rule[], overrides: Record<string, RuleCategory>): { rules: Rule[]; applied: AppliedOverride[] } {
  const applied: AppliedOverride[] = [];
  const out = rules.map((r) => {
    const to = overrides[r.id];
    if (!to || to === r.category) return r;
    applied.push({ ruleId: r.id, from: r.category, to, text: r.text });
    return { ...r, category: to };
  });
  return { rules: out, applied };
}

/** The file a reader can start from, with the rules this run actually found in it. */
export function renderOverridesTemplate(rules: Rule[]): string {
  const lines = [
    "{",
    '  "//": "How paperfence read each rule. Change a category and run scan again.",',
    '  "//categories": "protect-branch protect-tests protect-secrets no-destructive no-force-push no-install scope ask-first no-exfil require-before other",',
    '  "//other": "\\"other\\" means judgement: paperfence will report it but never probe it.",',
  ];
  // Valid JSON, because `loadOverrides` parses it. The rule text goes in a
  // sibling key rather than a trailing comment: a template its own loader
  // rejects is worse than no template.
  const mapped = rules.filter((r) => r.category !== "other" && r.source.kind === "prose");
  const esc = (t: string) => JSON.stringify(t.replace(/\s+/g, " ").slice(0, 120));
  for (const [i, r] of mapped.entries()) {
    lines.push(`  "//${r.id}": ${esc(r.text)},`);
    lines.push(`  "${r.id}": "${r.category}"${i === mapped.length - 1 ? "" : ","}`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}
