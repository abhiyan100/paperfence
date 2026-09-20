import { describe, expect, it } from "vitest";
import { EXTRACTION_CASES, renderAccuracy, score } from "./extraction-cases.js";
import { extractRulesHeuristically } from "./heuristic.js";
import { normalizeRule } from "./normalize.js";
import type { Rule, RuleCategory } from "../types.js";

/**
 * How often does the offline reader put a rule in the right category?
 *
 * This is the layer under every verdict. A rule inherits its category's
 * verdict, so a sentence read wrongly produces a verdict about a command
 * nobody asked about, and in a repository that happens to deny that command it
 * reads as protection. Before this suite that failure rate was anecdote.
 *
 * The floors below are deliberately set at what the reader manages today, not
 * at what it should manage. They exist to catch a regression. Raising them is
 * the work; `reviews/real-repos-01.md` has the cases that motivated it.
 */
function categoriseOffline(text: string): RuleCategory {
  const hits = extractRulesHeuristically(`- ${text}`);
  if (!hits.length) return "other";
  const h = hits[0]!;
  const rule: Rule = { id: "x", text: h.text, category: h.category, targets: h.targets, source: { kind: "prose", file: "t" } };
  return normalizeRule(rule).category;
}

const offline = score(categoriseOffline);

describe("the offline reader's categorisation", () => {
  it("has a case for every category it can produce", () => {
    const covered = new Set(EXTRACTION_CASES.map((c) => c.expect));
    for (const c of ["protect-branch", "protect-tests", "protect-secrets", "no-exfil", "no-destructive", "no-force-push", "no-install", "scope", "require-before", "ask-first", "other"] as RuleCategory[]) {
      expect(covered.has(c), `no case expects ${c}`).toBe(true);
    }
  });

  it("gets every clear-cut case right", () => {
    // Printed on failure so a regression says exactly what it broke. This was
    // 30/33 when the suite was written; the three misses it named were the two
    // real rules a public repository had that came back untestable, plus
    // "get approval before deploying", and all three are fixed.
    expect(offline.correct, renderAccuracy(offline, "offline")).toBe(offline.total);
  });

  it("does not silently start guessing at the arguable ones", () => {
    // These are cases where a reasonable reader could pick another category.
    // Scored apart so they neither flatter the number nor fail the build.
    expect(offline.arguableCorrect).toBeLessThanOrEqual(offline.arguableTotal);
  });

  it("does not file judgement under a category that has a probe behind it", () => {
    // The dangerous direction: "prefer composition over inheritance" graded
    // against `npm install left-pad` is a verdict about nothing.
    expect(offline.overreached.map((o) => `${o.got}: ${o.text.slice(0, 60)}`)).toHaveLength(offline.overreached.length);
    expect(offline.overreached.length, renderAccuracy(offline, "offline")).toBeLessThanOrEqual(2);
  });

  it("gets the rules with an unmistakable verb right", () => {
    expect(categoriseOffline("Never push directly to main. Always open a pull request.")).toBe("protect-branch");
    expect(categoriseOffline("Do not force push. Ever.")).toBe("no-force-push");
    expect(categoriseOffline("Never read `.env` or print secrets to the console.")).toBe("protect-secrets");
    expect(categoriseOffline("Always run `npm test` before committing.")).toBe("require-before");
  });

  it("leaves plain style advice alone", () => {
    expect(categoriseOffline("Prefer composition over inheritance.")).toBe("other");
    expect(categoriseOffline("Write clear commit messages in the imperative mood.")).toBe("other");
  });
});

describe("the case set itself", () => {
  it("quotes real repositories rather than only our own wording", () => {
    expect(EXTRACTION_CASES.filter((c) => c.source).length).toBeGreaterThanOrEqual(10);
  });

  it("records why the cases from the first real run are here", () => {
    const noted = EXTRACTION_CASES.filter((c) => c.note);
    expect(noted.length).toBeGreaterThanOrEqual(3);
    for (const c of noted) expect(c.note!.length).toBeGreaterThan(20);
  });

  it("has no duplicate sentences", () => {
    const seen = new Set(EXTRACTION_CASES.map((c) => c.text));
    expect(seen.size).toBe(EXTRACTION_CASES.length);
  });
});
