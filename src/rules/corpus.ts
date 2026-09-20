import { promises as fs } from "node:fs";
import path from "node:path";
import type { Rule, RuleCategory } from "../types.js";

/**
 * Scoring extraction against whole documents instead of single sentences.
 *
 * The sentence set in `extraction-cases.ts` says so itself: it is easier than
 * reality and a perfect score on it is not a claim about real repositories.
 * Both readers score every clear-cut sentence there, and the first run against
 * three real repositories still produced rules called untestable that are not,
 * style rules filed under categories with probes behind them, and one line
 * extracted twice. None of that was visible at the sentence level, because
 * what changes the reading is the surrounding document.
 *
 * So this scores against six real rule files, frozen at a commit, annotated by
 * hand with what a careful reader should conclude about every statement in
 * them. The corpus is evidence, not a training set: when paperfence scores
 * badly the number is the finding.
 */

export type Testable = "mechanical" | "guidance";

export interface ExpectedPolicy {
  id: string;
  /** Verbatim from the document, so matching is exact rather than approximate. */
  quote: string;
  category: RuleCategory;
  targets: string[];
  testable: Testable;
  /** Stated ordering, when the rule has one. */
  ordering?: { action: string; relation: "before" | "after"; of: string };
  /** The id of the policy this one restates. */
  duplicateOf?: string;
  /** A reasonable reader could pick another category. Scored separately. */
  ambiguous?: boolean;
  /**
   * An agent can mechanically violate this and paperfence has no category for
   * it. Filing it as `other` is the right answer today; counting it as a
   * reading error would blame extraction for a coverage gap.
   */
  gap?: boolean;
  note?: string;
}

export interface ExpectedTrap {
  quote: string;
  why: string;
}

export interface ExpectedDoc {
  doc: string;
  summary: string;
  policies: ExpectedPolicy[];
  traps: ExpectedTrap[];
}

export interface CorpusDoc {
  slug: string;
  repo: string;
  path: string;
  commit: string;
  body: string;
  expected: ExpectedDoc;
}

export async function loadCorpus(root: string): Promise<CorpusDoc[]> {
  const base = path.join(root, "fixtures", "corpus");
  const out: CorpusDoc[] = [];
  for (const slug of (await fs.readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const dir = path.join(base, slug);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    out.push({
      slug,
      repo: meta.repo,
      path: meta.path,
      commit: meta.commit,
      body: await fs.readFile(path.join(dir, "doc.md"), "utf8"),
      expected: JSON.parse(await fs.readFile(path.join(dir, "expected.json"), "utf8")),
    });
  }
  return out;
}

/** Words that carry no identity, so overlap is measured on the rest. */
const STOP = new Set("a an the and or of to in on for with that this it is are be as by if not no never always do does don't you your we our their its at from into than then them they".split(" "));

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/`+/g, " ")
    .replace(/\*\*?/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^a-z0-9_./:<>-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * Does this extracted rule say the same thing as this annotated policy?
 *
 * Not string equality: extraction paraphrases, trims and re-punctuates. The
 * test is how much of the annotation's distinctive vocabulary the extracted
 * text reproduces. Anchored on the annotation rather than symmetrically,
 * because a rule that quotes a whole paragraph containing the policy has still
 * found the policy.
 */
export function overlap(expectedQuote: string, extractedText: string): number {
  const want = new Set(tokens(expectedQuote));
  const got = new Set(tokens(extractedText));
  if (want.size === 0 || got.size === 0) return 0;
  let hit = 0;
  for (const w of want) if (got.has(w)) hit++;
  const anchoredOnExpected = hit / want.size;
  // The other direction too. An annotated sentence often carries a long
  // parenthetical the extractor drops, and a faithful extraction of the clause
  // that matters then scores as a miss. Requiring nearly all of the
  // extraction's own vocabulary to come from the annotation keeps this from
  // matching a short rule to an unrelated long one.
  const backwards = got.size >= 4 && hit / got.size >= 0.8 ? hit / got.size : 0;
  return Math.max(anchoredOnExpected, backwards);
}

export const MATCH_THRESHOLD = 0.6;

export interface DocScore {
  slug: string;
  extracted: number;
  /** Annotated policies, by kind. */
  policies: number;
  mechanical: number;
  /** Found at all, regardless of category. */
  foundMechanical: number;
  foundAll: number;
  /** Of the matched policies, how many got the annotated category. */
  categoryScored: number;
  categoryRight: number;
  /** Same, for the ones a reasonable reader could argue about. */
  arguableScored: number;
  arguableRight: number;
  /** Of matched policies with targets annotated: exact set, partial, missed. */
  targetsScored: number;
  targetsExact: number;
  targetsPartial: number;
  /** Extracted rules matching an annotated policy already claimed by another extracted rule. */
  duplicates: number;
  /** Extracted rules matching no annotated policy at all. */
  falsePolicies: { text: string; category: RuleCategory; trap?: string }[];
  /** Annotated mechanical policies that were found but filed as `other`. */
  testableCalledUntestable: { quote: string; want: RuleCategory }[];
  /** Annotated guidance filed under a category with a probe behind it. */
  guidanceMadeMechanical: { quote: string; got: RuleCategory }[];
  /** Mechanical policies never extracted at all. */
  missed: { quote: string; want: RuleCategory }[];
}

const MECHANICAL_CATEGORIES = new Set<RuleCategory>([
  "protect-branch", "protect-tests", "protect-secrets", "no-destructive",
  "no-force-push", "no-install", "scope", "ask-first", "no-exfil", "require-before",
]);

function targetMatch(want: string[], got: string[]): "exact" | "partial" | "none" {
  const norm = (s: string) => s.toLowerCase().replace(/^[`'"]|[`'"]$/g, "").replace(/\/$/, "").trim();
  const w = want.map(norm).filter(Boolean);
  const g = got.map(norm).filter(Boolean);
  if (w.length === 0) return "exact";
  const hit = w.filter((x) => g.some((y) => y === x || y.includes(x) || x.includes(y)));
  if (hit.length === w.length && g.length <= w.length) return "exact";
  if (hit.length > 0) return "partial";
  return "none";
}

export function scoreDoc(doc: CorpusDoc, rules: Rule[]): DocScore {
  const s: DocScore = {
    slug: doc.slug, extracted: rules.length,
    policies: doc.expected.policies.length,
    mechanical: doc.expected.policies.filter((p) => p.testable === "mechanical").length,
    foundMechanical: 0, foundAll: 0,
    categoryScored: 0, categoryRight: 0, arguableScored: 0, arguableRight: 0,
    targetsScored: 0, targetsExact: 0, targetsPartial: 0,
    duplicates: 0, falsePolicies: [], testableCalledUntestable: [], guidanceMadeMechanical: [], missed: [],
  };

  // Best extracted rule per annotated policy, and which policies each rule hit.
  const claimedBy = new Map<string, Rule[]>();
  for (const r of rules) {
    let best: { p: ExpectedPolicy; score: number } | null = null;
    for (const p of doc.expected.policies) {
      const o = overlap(p.quote, r.text);
      if (o >= MATCH_THRESHOLD && (!best || o > best.score)) best = { p, score: o };
    }
    if (!best) {
      const trap = doc.expected.traps.find((t) => overlap(t.quote, r.text) >= MATCH_THRESHOLD);
      s.falsePolicies.push({ text: r.text.slice(0, 120), category: r.category, ...(trap ? { trap: trap.why } : {}) });
      continue;
    }
    const key = best.p.duplicateOf ?? best.p.id;
    claimedBy.set(key, [...(claimedBy.get(key) ?? []), r]);
  }

  for (const p of doc.expected.policies) {
    const key = p.duplicateOf ?? p.id;
    const hits = claimedBy.get(key) ?? [];
    if (hits.length === 0) {
      if (p.testable === "mechanical" && !p.duplicateOf) s.missed.push({ quote: p.quote.slice(0, 100), want: p.category });
      continue;
    }
    if (p.duplicateOf) continue; // scored on the policy it restates
    s.foundAll++;
    if (p.testable === "mechanical") s.foundMechanical++;
    // Several extracted rules landing on one annotated policy is a duplicate.
    s.duplicates += hits.length - 1;

    const got = hits[0]!;
    if (p.ambiguous) {
      s.arguableScored++;
      if (got.category === p.category) s.arguableRight++;
    } else {
      s.categoryScored++;
      if (got.category === p.category) s.categoryRight++;
    }
    // A gap rule filed as `other` is right; paperfence has no category for it.
    if (p.testable === "mechanical" && !p.gap && got.category === "other") {
      s.testableCalledUntestable.push({ quote: p.quote.slice(0, 100), want: p.category });
    }
    if (p.testable === "guidance" && MECHANICAL_CATEGORIES.has(got.category) && p.category === "other") {
      s.guidanceMadeMechanical.push({ quote: p.quote.slice(0, 100), got: got.category });
    }
    if (p.targets.length > 0) {
      s.targetsScored++;
      const m = targetMatch(p.targets, got.targets);
      if (m === "exact") s.targetsExact++;
      else if (m === "partial") s.targetsPartial++;
    }
  }
  return s;
}

export function renderCorpus(scores: DocScore[], label: string): string {
  const sum = (f: (s: DocScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
  const L: string[] = [];
  L.push(`${label}`);
  L.push(`  documents                    ${scores.length}`);
  L.push(`  rules extracted              ${sum((s) => s.extracted)}`);
  L.push(`  mechanical policies found    ${sum((s) => s.foundMechanical)}/${sum((s) => s.mechanical)}  ${pct(sum((s) => s.foundMechanical), sum((s) => s.mechanical))}`);
  L.push(`  all policies found           ${sum((s) => s.foundAll)}/${sum((s) => s.policies)}  ${pct(sum((s) => s.foundAll), sum((s) => s.policies))}`);
  L.push(`  category, clear-cut          ${sum((s) => s.categoryRight)}/${sum((s) => s.categoryScored)}  ${pct(sum((s) => s.categoryRight), sum((s) => s.categoryScored))}`);
  L.push(`  category, arguable           ${sum((s) => s.arguableRight)}/${sum((s) => s.arguableScored)}  ${pct(sum((s) => s.arguableRight), sum((s) => s.arguableScored))}`);
  L.push(`  targets exact                ${sum((s) => s.targetsExact)}/${sum((s) => s.targetsScored)}  ${pct(sum((s) => s.targetsExact), sum((s) => s.targetsScored))}   partial ${sum((s) => s.targetsPartial)}`);
  L.push(`  duplicate extractions        ${sum((s) => s.duplicates)}`);
  L.push(`  rules matching no policy     ${sum((s) => s.falsePolicies.length)}  (of them, known traps: ${sum((s) => s.falsePolicies.filter((f) => f.trap).length)})`);
  L.push(`  checkable called untestable  ${sum((s) => s.testableCalledUntestable.length)}`);
  L.push(`  guidance made mechanical     ${sum((s) => s.guidanceMadeMechanical.length)}`);
  L.push(`  mechanical policies missed   ${sum((s) => s.missed.length)}`);
  return L.join("\n");
}
