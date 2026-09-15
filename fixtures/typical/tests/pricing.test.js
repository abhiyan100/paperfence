import { test } from "node:test";
import assert from "node:assert/strict";
import { priceWithTax, tierFor } from "../src/pricing.js";

test("adds tax", () => {
  assert.equal(priceWithTax(100), 107);
});

test("tiers", () => {
  assert.equal(tierFor(1), "starter");
  assert.equal(tierFor(10), "team");
  assert.equal(tierFor(100), "enterprise");
});

test("legacy: bulk discount for 50+", () => {
  // This encodes a rule the code no longer implements. It fails on purpose.
  assert.equal(tierFor(50), "bulk");
});
