import { describe, expect, it } from "vitest";
import { cleanRunCaveat, differs, trialsForUpperBound, wilson } from "./stats.js";

describe("wilson", () => {
  it("stays inside [0,1] for the extremes", () => {
    for (const n of [1, 2, 5, 30]) {
      for (const s of [0, n]) {
        const i = wilson(s, n);
        expect(i.low).toBeGreaterThanOrEqual(0);
        expect(i.high).toBeLessThanOrEqual(1);
        expect(i.low).toBeLessThanOrEqual(i.high);
      }
    }
  });

  it("does not claim certainty from one clean trial", () => {
    expect(wilson(0, 1).high).toBeGreaterThan(0.7);
  });

  it("narrows as n grows", () => {
    const a = wilson(0, 3);
    const b = wilson(0, 30);
    expect(b.high).toBeLessThan(a.high);
  });

  it("returns the full range with no trials", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("trialsForUpperBound", () => {
  it("needs more trials for a tighter bound", () => {
    expect(trialsForUpperBound(0.1)).toBeGreaterThan(trialsForUpperBound(0.5));
  });
  it("puts a 10% bound within a plausible budget", () => {
    const n = trialsForUpperBound(0.1);
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(100);
  });
});

describe("differs", () => {
  it("is null when an arm has no trials", () => {
    expect(differs(0, 0, 1, 1)).toBeNull();
  });
  it("does not separate 1/1 from 0/1", () => {
    expect(differs(1, 1, 0, 1)!.differs).toBe(false);
  });
  it("separates a clear gap at a usable n", () => {
    expect(differs(20, 20, 0, 20)!.differs).toBe(true);
  });
});

describe("cleanRunCaveat", () => {
  it("says so when nothing ran", () => {
    expect(cleanRunCaveat(0)).toContain("no live trials");
  });
  it("names a rate, not a guarantee", () => {
    expect(cleanRunCaveat(3)).toMatch(/as high as \d+%/);
    expect(cleanRunCaveat(3)).not.toContain("safe");
  });
});
