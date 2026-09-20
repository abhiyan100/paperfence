import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Rule, RuleCategory } from "../types.js";
import type { PolicyDocument, PolicyStatement } from "./types.js";

export const POLICY_PATH = "paperfence.policy.yaml";

const CATEGORIES: RuleCategory[] = [
  "protect-branch", "protect-tests", "protect-secrets", "no-exfil", "no-destructive",
  "no-force-push", "no-install", "scope", "require-before", "ask-first", "other",
];

const EFFECT_FOR: Record<RuleCategory, PolicyStatement["effect"]> = {
  "protect-branch": "forbid",
  "protect-tests": "forbid",
  "protect-secrets": "forbid",
  "no-exfil": "forbid",
  "no-destructive": "forbid",
  "no-force-push": "forbid",
  "no-install": "forbid",
  scope: "restrict",
  "require-before": "require",
  "ask-first": "forbid",
  other: "forbid",
};

export async function loadPolicy(root: string): Promise<{ doc: PolicyDocument; file: string } | null> {
  const file = path.join(root, POLICY_PATH);
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`${POLICY_PATH}: ${(e as Error).message}`);
  }
  return { doc: validatePolicy(parsed), file };
}

/**
 * A policy that does not parse enforces nothing, so every problem is an error
 * with a line the author can fix, never a silently dropped statement.
 */
export function validatePolicy(input: unknown): PolicyDocument {
  if (!input || typeof input !== "object") throw new Error(`${POLICY_PATH}: expected a mapping at the top level`);
  const doc = input as Partial<PolicyDocument>;
  if (doc.version !== 1) throw new Error(`${POLICY_PATH}: version must be 1 (got ${JSON.stringify(doc.version)})`);
  if (!Array.isArray(doc.statements)) throw new Error(`${POLICY_PATH}: statements must be a list`);
  const runtimes = Array.isArray(doc.runtimes) && doc.runtimes.length ? doc.runtimes : ["claude-code"];

  const seen = new Set<string>();
  const statements: PolicyStatement[] = doc.statements.map((s, i) => {
    const where = `${POLICY_PATH}: statements[${i}]`;
    if (!s || typeof s !== "object") throw new Error(`${where}: expected a mapping`);
    const st = s as Partial<PolicyStatement>;
    if (!st.id) throw new Error(`${where}: id is required`);
    if (seen.has(st.id)) throw new Error(`${where}: duplicate id "${st.id}"`);
    seen.add(st.id);
    if (!st.text) throw new Error(`${where} (${st.id}): text is required; write the rule the way you would say it to a new hire`);
    if (!st.category || !CATEGORIES.includes(st.category)) {
      throw new Error(`${where} (${st.id}): category must be one of ${CATEGORIES.join(", ")}`);
    }
    const effect = st.effect ?? EFFECT_FOR[st.category];
    if (!["forbid", "require", "restrict"].includes(effect)) throw new Error(`${where} (${st.id}): effect must be forbid, require or restrict`);
    if (effect === "require" && !st.before && !st.targets?.length) {
      throw new Error(`${where} (${st.id}): a require statement needs "before" (the step that must run first) or targets`);
    }
    if (st.category === "scope" && !st.targets?.length) {
      throw new Error(`${where} (${st.id}): a scope statement needs targets: paths the agent may touch, or "!path" for paths it may not`);
    }
    return {
      id: st.id,
      text: st.text,
      category: st.category,
      effect,
      targets: st.targets ?? [],
      except: st.except ?? [],
      before: st.before,
      from: st.from,
      acceptAsGuidance: st.acceptAsGuidance ?? false,
    };
  });

  return { version: 1, runtimes, statements, notes: doc.notes ?? [] };
}

/**
 * Turn what a scan found into a policy document.
 *
 * The output is a draft, not a decision. It keeps the team's own wording as
 * the text of each statement, so review is reading their own words back, not
 * learning a new syntax.
 */
export function inferPolicy(rules: Rule[], runtimes: string[] = ["claude-code"]): PolicyDocument {
  const statements: PolicyStatement[] = [];
  const byKey = new Map<string, PolicyStatement>();
  // A prose rule and the settings entry that backs it are one statement. Prose
  // wins: "never read .env" is what the team meant, `Deny Read(./.env)` is how
  // someone tried to say it.
  const ordered = [...rules].sort((a, b) => Number(a.source.kind !== "prose") - Number(b.source.kind !== "prose"));
  for (const r of ordered) {
    const key = `${r.category}:${normalizeTargets(r.targets).join(",")}`;
    // Two rules with the same category and the same targets are one control
    // stated twice. Counting both would inflate every denominator downstream.
    if (byKey.has(key)) continue;
    const statement: PolicyStatement = {
      id: `${r.category}-${statements.filter((s) => s.category === r.category).length + 1}`,
      text: r.text,
      category: r.category,
      effect: EFFECT_FOR[r.category],
      targets: normalizeTargets(r.targets),
      except: [],
      before: r.category === "require-before" ? (r.targets[0] ?? "npm test") : undefined,
      from: r.source.kind === "prose" ? { file: r.source.file, line: r.source.line } : { file: r.source.file },
      acceptAsGuidance: r.category === "other",
    };
    byKey.set(key, statement);
    statements.push(statement);
  }
  return {
    version: 1,
    runtimes,
    statements,
    notes: [
      "Drafted by `paperfence policy init` from the rules already in this repository.",
      "Edit it: the wording is yours, the categories and targets are our guess.",
      "`paperfence policy check` says what each statement can and cannot be enforced by.",
    ],
  };
}

/** `./.env` and `.env` are the same file; `tests/` and `tests` the same directory. */
function normalizeTargets(targets: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of targets) {
    const bang = t.startsWith("!");
    const body = (bang ? t.slice(1) : t).replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/\/+$/, "");
    const clean = (bang ? "!" : "") + body;
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.sort();
}

export function renderPolicy(doc: PolicyDocument): string {
  const clean = {
    version: doc.version,
    runtimes: doc.runtimes,
    statements: doc.statements.map((s) => {
      const out: Record<string, unknown> = { id: s.id, text: s.text, category: s.category, effect: s.effect };
      if (s.targets?.length) out.targets = s.targets;
      if (s.except?.length) out.except = s.except;
      if (s.before) out.before = s.before;
      if (s.acceptAsGuidance) out.acceptAsGuidance = true;
      if (s.from) out.from = s.from;
      return out;
    }),
  };
  const header = (doc.notes ?? []).map((n) => `# ${n}`).join("\n");
  return `${header}\n\n${stringifyYaml(clean, { lineWidth: 100 })}`;
}
