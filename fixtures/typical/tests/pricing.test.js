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
