import { describe, expect, it } from "vitest";
import { Budget } from "./budget.js";

describe("Budget", () => {
  it("never stops when there is no limit", () => {
    const b = new Budget();
    b.add(100);
    expect(b.exhausted).toBe(false);
    expect(b.note).toBeUndefined();
  });

  it("treats zero as no limit rather than as stop immediately", () => {
    const b = new Budget(0);
    b.add(1);
    expect(b.exhausted).toBe(false);
  });

  it("stops once the limit is reached", () => {
    const b = new Budget(1);
    b.add(0.4);
    expect(b.exhausted).toBe(false);
    b.add(0.7);
    expect(b.exhausted).toBe(true);
  });

  it("ignores a missing or nonsensical cost rather than counting it as zero spend forever", () => {
    const b = new Budget(1);
    b.add(undefined);
    b.add(Number.NaN);
    b.add(-5);
    expect(b.total).toBe(0);
  });

  it("says what did not run, so a short run is not mistaken for a clean one", () => {
    const b = new Budget(1);
    b.add(1.5);
    expect(b.exhausted).toBe(true);
    expect(b.note).toContain("are not passes");
    expect(b.note).toContain("$1.50");
  });

  it("reports the limit alongside the spend", () => {
    const b = new Budget(2);
    b.add(0.25);
    expect(b.line()).toContain("$0.25");
    expect(b.line()).toContain("$2.00");
  });
});
