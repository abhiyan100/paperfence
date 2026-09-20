import { describe, expect, it } from "vitest";
import { compareMarkdown, scanMarkdown } from "./markdown.js";
import type { CompareReport, Fingerprint, Rule, RuleVerdict, ScanReport } from "../types.js";

const fingerprint: Fingerprint = { paperfence: "0.1.0", os: "linux", sandbox: "none", approvalMode: "n/a", at: "2026-09-20T00:00:00.000Z" };
const rule = (text: string): Rule => ({ id: text.slice(0, 4), text, category: "protect-branch", targets: ["main"], source: { kind: "prose", file: "CLAUDE.md" } });

function report(verdicts: RuleVerdict[], over: Partial<ScanReport> = {}): ScanReport {
  const totals = { gate: 0, wish: 0, broken: 0, untested: 0, error: 0, notApplicable: 0 };
  for (const v of verdicts) {
    if (v.grade === "GATE") totals.gate++;
    else if (v.grade === "WISH") totals.wish++;
    else if (v.grade === "BROKEN") totals.broken++;
    else if (v.grade === "ERROR") totals.error++;
    else if (v.grade === "NOT_APPLICABLE") totals.notApplicable++;
    else totals.untested++;
  }
  return { version: "0.1.0", repo: "/r", scannedAt: "2026-09-20T00:00:00.000Z", mode: "static", rules: verdicts.map((v) => v.rule), verdicts, totals, fingerprint, ...over };
}

describe("scanMarkdown", () => {
  it("leads with the answer, not with a table", () => {
    const md = scanMarkdown(report([{ rule: rule("Never push to main."), grade: "BROKEN", runs: [], summary: "it was pushed" }]));
    const firstLine = md.split("\n").find((l) => l.startsWith("**"))!;
    expect(firstLine).toContain("broken in a live run");
  });

  it("says plainly when everything is behind a control", () => {
    const md = scanMarkdown(report([{ rule: rule("Never push to main."), grade: "GATE", runs: [], summary: "a hook blocks it" }]));
    expect(md).toContain("has a control behind it");
  });

  it("counts wishes when nothing was broken", () => {
    const md = scanMarkdown(report([
      { rule: rule("a"), grade: "WISH", runs: [], summary: "nothing stops it" },
      { rule: rule("b"), grade: "GATE", runs: [], summary: "a hook blocks it" },
    ]));
    expect(md).toContain("1 of 2 rules has nothing mechanical behind it");
  });

  it("keeps not-applicable rules out of the headline and says they are not a pass", () => {
    const md = scanMarkdown(report([
      { rule: rule("a"), grade: "GATE", runs: [], summary: "a hook blocks it" },
      { rule: rule("b"), grade: "NOT_APPLICABLE", runs: [], summary: "no test suite", notApplicable: { reason: "this repository has no test suite" } },
    ]));
    expect(md).toContain("All 1 testable rule");
    expect(md).toContain("Not a statement that these hold");
  });

  it("warns when the repository runs a runtime the report does not cover", () => {
    const md = scanMarkdown(
      report([{ rule: rule("a"), grade: "WISH", runs: [], summary: "nothing stops it" }], {
        runtimes: [{ id: "codex", label: "Codex", markers: ["AGENTS.md"], support: { discover: true, evaluate: false, probeHooks: false, drive: false, harden: false }, covered: false, notes: "Codex enforces differently.", outOfScope: [] }],
      }),
    );
    expect(md).toContain("does not cover Codex");
  });

  it("escapes pipes so a rule with a pipe in it does not break the table", () => {
    const md = scanMarkdown(report([{ rule: rule("Never run `a | b`."), grade: "WISH", runs: [], summary: "x" }]));
    expect(md).toContain("`a \\| b`");
  });

  it("does not list every rule when there are many", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ rule: rule(`rule ${i}`), grade: "WISH" as const, runs: [], summary: "nothing stops it" }));
    const md = scanMarkdown(report(many));
    expect(md).toContain("and 15 more");
  });
});

function compareReport(over: Partial<CompareReport> = {}): CompareReport {
  const v = (name: string) => ({ name, dir: "/d", model: "m", describe: name });
  return {
    version: "0.1.0", repo: "/r", at: "2026-09-20T00:00:00.000Z",
    suite: { bad: [], good: [] },
    variants: [v("base"), v("head")],
    runs: [],
    summaries: [
      { variant: v("base"), badBlocked: 2, badTotal: 2, goodCompleted: 2, goodTotal: 2, askedHuman: 0, denied: 0, costUsd: 1, errors: 0, inconclusive: 0, notApplicable: 0 },
      { variant: v("head"), badBlocked: 2, badTotal: 2, goodCompleted: 2, goodTotal: 2, askedHuman: 0, denied: 0, costUsd: 1, errors: 0, inconclusive: 0, notApplicable: 0 },
    ],
    reps: 1,
    fingerprint,
    ...over,
  };
}

describe("compareMarkdown", () => {
  it("says there is no regression when both arms match", () => {
    expect(compareMarkdown(compareReport())).toContain("No regression");
  });

  it("names a safety regression", () => {
    const r = compareReport();
    r.summaries[1]!.badBlocked = 0;
    expect(compareMarkdown(r)).toContain("lets more forbidden things through");
  });

  it("names a usefulness regression, which most tools do not check at all", () => {
    const r = compareReport();
    r.summaries[1]!.goodCompleted = 0;
    expect(compareMarkdown(r)).toContain("blocks ordinary work");
  });

  it("names both when both happen", () => {
    const r = compareReport();
    r.summaries[1]!.badBlocked = 0;
    r.summaries[1]!.goodCompleted = 0;
    expect(compareMarkdown(r)).toContain("and breaks ordinary work");
  });

  it("says whether the run can tell the arms apart at all", () => {
    const r = compareReport();
    r.summaries[1]!.badBlocked = 0;
    const md = compareMarkdown(r);
    expect(md).toContain("Can this run tell the two apart?");
    expect(md).toContain("the intervals overlap");
  });

  it("puts trials with no verdict in their own column, never in blocked", () => {
    const r = compareReport();
    r.summaries[1]!.errors = 2;
    r.summaries[1]!.inconclusive = 1;
    expect(compareMarkdown(r)).toContain("| 3 |");
    expect(compareMarkdown(r)).toContain("no verdict");
  });
});
