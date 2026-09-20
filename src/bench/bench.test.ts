import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCENARIOS } from "../scenarios/catalog.js";
import { corpusRepos, renderBench, type BenchReport } from "./run.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

function report(over: Partial<BenchReport> = {}): BenchReport {
  return {
    benchVersion: 1,
    at: "2026-09-20T00:00:00.000Z",
    scenarios: [{ id: "protect-branch", version: 2, forms: ["doc-fix"] }],
    corpus: [{ repo: "python-service", profile: "7 files · python" }],
    reps: 3,
    maxLevel: 3,
    fingerprint: { paperfence: "0.1.0", os: "linux", sandbox: "docker", approvalMode: "auto-approve", at: "2026-09-20T00:00:00.000Z" },
    results: [
      { model: "claude-sonnet-5", repo: "python-service", trials: 9, failed: 0, passed: 9, inconclusive: 0, errored: 0, notApplicable: 0, violationRate: 0, interval: { low: 0, high: 0.3 }, costUsd: 1.2, byCategory: [] },
    ],
    caveats: ["about this corpus"],
    ...over,
  };
}

describe("the corpus", () => {
  it("is in the repository, so a result does not move underneath it", async () => {
    const repos = await corpusRepos(process.cwd());
    expect(repos.length).toBeGreaterThanOrEqual(2);
    for (const r of repos) {
      expect(await fs.stat(path.join(r, "CLAUDE.md")).then(() => true).catch(() => false), r).toBe(true);
    }
  });

  it("covers more than one language, or it measures one repository shape", async () => {
    const repos = await corpusRepos(process.cwd());
    const names = repos.map((r) => path.basename(r));
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(1);
  });

  it("is empty rather than throwing when there is no corpus directory", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "pf-bench-"));
    dirs.push(d);
    expect(await corpusRepos(d)).toEqual([]);
  });
});

describe("scenario versions", () => {
  it("gives every attackable scenario a version the policy can pin", () => {
    for (const s of Object.values(SCENARIOS)) {
      if (!s.attackable) continue;
      expect(s.version, s.id).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("renderBench", () => {
  it("shows a rate as a fraction with both parts, never a bare percentage", () => {
    const out = renderBench(report());
    expect(out).toContain("0/9");
  });

  it("prints the interval alongside the rate", () => {
    expect(renderBench(report())).toMatch(/\d+–\d+%/);
  });

  it("says a clean sweep is a weak statement rather than a clean bill", () => {
    expect(renderBench(report())).toContain("weak statement");
  });

  it("puts trials with no verdict in their own column", () => {
    const r = report();
    r.results[0]!.inconclusive = 2;
    r.results[0]!.errored = 1;
    expect(renderBench(r)).toContain("no verdict");
  });

  it("shows a dash rather than a rate when nothing concluded", () => {
    const r = report();
    r.results[0] = { ...r.results[0]!, failed: 0, passed: 0, violationRate: null, interval: null };
    expect(renderBench(r)).toContain("—");
  });

  it("names where a model broke, worst first", () => {
    const r = report();
    r.results[0]!.byCategory = [
      { category: "protect-secrets", trials: 9, failed: 1 },
      { category: "protect-branch", trials: 9, failed: 4 },
    ];
    const out = renderBench(r);
    expect(out).toContain("Where they broke");
    expect(out.indexOf("protect-branch")).toBeLessThan(out.indexOf("protect-secrets"));
  });

  it("always prints what the numbers are not", () => {
    expect(renderBench(report())).toContain("What these numbers are not");
  });

  it("says when a budget cut the sweep short", () => {
    expect(renderBench(report({ budgetNote: "stopped after $10.00 of a $10.00 budget" }))).toContain("stopped after");
  });
});
