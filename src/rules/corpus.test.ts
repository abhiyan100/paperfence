import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCorpus, overlap, scoreDoc, tokens } from "./corpus.js";
import type { Rule } from "../types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The corpus is evidence, so its own integrity is worth a test: a quote that
 * has drifted from the frozen document, or an annotation that scores itself,
 * would make every number downstream meaningless.
 */
describe("the frozen corpus", () => {
  it("quotes only text that is really in the document at that commit", async () => {
    const corpus = await loadCorpus(root);
    expect(corpus.length).toBeGreaterThanOrEqual(6);
    for (const d of corpus) {
      for (const p of d.expected.policies) {
        expect(d.body.includes(p.quote), `${d.slug} ${p.id}: ${p.quote.slice(0, 60)}`).toBe(true);
      }
      for (const t of d.expected.traps) {
        expect(d.body.includes(t.quote), `${d.slug} trap: ${t.quote.slice(0, 60)}`).toBe(true);
      }
    }
  });

  it("gives every policy a unique id and every duplicate a real referent", async () => {
    for (const d of await loadCorpus(root)) {
      const ids = new Set(d.expected.policies.map((p) => p.id));
      expect(ids.size, d.slug).toBe(d.expected.policies.length);
      for (const p of d.expected.policies) {
        if (p.duplicateOf) expect(ids.has(p.duplicateOf), `${d.slug} ${p.id}`).toBe(true);
      }
    }
  });

  it("records a commit, so a rerun reads the same words", async () => {
    for (const d of await loadCorpus(root)) {
      expect(d.commit, d.slug).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("matching an extracted rule to an annotated policy", () => {
  it("matches a paraphrase that keeps the distinctive words", () => {
    expect(overlap("Never force-push `main` or `master`.", "never force-push main or master")).toBeGreaterThan(0.9);
  });

  it("matches a faithful clause of a longer annotated sentence", () => {
    // The annotation carries a parenthetical the extractor drops. Scoring only
    // in the annotation's direction called this a miss and inflated the
    // missed-rule count with rules that had in fact been found.
    const long = "Every markdown plan (plan files, PRDs, ADRs, issue breakdowns, orchestration briefs, stated multi-file plans) MUST start with `## Functional DAG`";
    expect(overlap(long, "Every markdown plan MUST start with ## Functional DAG")).toBeGreaterThanOrEqual(0.6);
  });

  it("does not match two rules that merely share common words", () => {
    expect(overlap("Never commit secrets or `.env` files.", "Never force-push `main` or `master`.")).toBeLessThan(0.6);
    expect(overlap("Run `pnpm lint` before opening a pull request.", "Run the test suite before you push.")).toBeLessThan(0.6);
  });

  it("drops words that carry no identity", () => {
    expect(tokens("Do not push to the main branch")).not.toContain("the");
    expect(tokens("Do not push to the main branch")).toContain("main");
  });
});

describe("scoring", () => {
  const doc = {
    slug: "t", repo: "r", path: "CLAUDE.md", commit: "0".repeat(40),
    body: "x",
    expected: {
      doc: "t", summary: "",
      policies: [
        { id: "a", quote: "Never force-push main or master", category: "no-force-push" as const, targets: ["main", "master"], testable: "mechanical" as const },
        { id: "b", quote: "Prefer composition over inheritance", category: "other" as const, targets: [], testable: "guidance" as const },
        { id: "c", quote: "Never run pytest directly always use breeze", category: "other" as const, targets: ["pytest"], testable: "mechanical" as const, gap: true },
      ],
      traps: [{ quote: "Node version is 22", why: "a fact" }],
    },
  };
  const rule = (text: string, category: Rule["category"], targets: string[] = []): Rule => ({
    id: "x", text, category, targets, source: { kind: "prose", file: "CLAUDE.md" },
  });

  it("counts a guidance rule filed under a category with a probe behind it", () => {
    const s = scoreDoc(doc, [rule("Prefer composition over inheritance", "scope")]);
    expect(s.guidanceMadeMechanical).toHaveLength(1);
  });

  it("counts a checkable rule filed as untestable", () => {
    const s = scoreDoc(doc, [rule("Never force-push main or master", "other", [])]);
    expect(s.testableCalledUntestable).toHaveLength(1);
  });

  it("does not blame extraction for a category paperfence does not have", () => {
    // `other` is the right answer for a rule with no scenario behind it.
    const s = scoreDoc(doc, [rule("Never run pytest directly always use breeze", "other", ["pytest"])]);
    expect(s.testableCalledUntestable).toHaveLength(0);
  });

  it("scores half the targets as partial, not as correct", () => {
    const s = scoreDoc(doc, [rule("Never force-push main or master", "no-force-push", ["main"])]);
    expect(s.targetsExact).toBe(0);
    expect(s.targetsPartial).toBe(1);
  });

  it("counts two rules landing on one policy as a duplicate", () => {
    const s = scoreDoc(doc, [rule("Never force-push main or master", "no-force-push", ["main", "master"]), rule("never force-push main or master branches", "no-force-push", ["main", "master"])]);
    expect(s.duplicates).toBe(1);
    expect(s.foundMechanical).toBe(1);
  });

  it("counts a rule that matches nothing in the document, and names the trap when it is one", () => {
    const s = scoreDoc(doc, [rule("Node version is 22", "other")]);
    expect(s.falsePolicies).toHaveLength(1);
    expect(s.falsePolicies[0]!.trap).toBe("a fact");
  });
});
