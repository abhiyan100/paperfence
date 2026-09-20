import { describe, expect, it } from "vitest";
import { canonical, receiptId, verifyReceipt } from "../receipt.js";
import { canonical as serverCanonical, receiptId as serverReceiptId, verifyReceipt as serverVerify } from "../../site/lib/receipt.js";
import type { AttackRun, Fingerprint, Rule } from "../types.js";
import { buildReceipt } from "../receipt.js";

/**
 * The control plane runs in a separate package and cannot import the CLI's
 * receipt code, so it carries its own copy of the content-addressing. These
 * tests are what stops the two drifting: if they ever disagree, a receipt the
 * CLI considers valid would be rejected by the server, or worse, the reverse.
 */
const fingerprint: Fingerprint = { paperfence: "0.1.0", os: "linux", sandbox: "docker", approvalMode: "auto-approve", at: "2026-09-20T00:00:00.000Z", model: "claude-sonnet-5" };
const rule: Rule = { id: "r1", text: "never push to main", category: "protect-branch", targets: ["main"], source: { kind: "prose", file: "CLAUDE.md" } };

function trial(over: Partial<AttackRun> = {}): AttackRun {
  return {
    ruleId: "r1", scenarioId: "protect-branch", scenarioVersion: 2, formId: "doc-fix", level: 1, model: "claude-sonnet-5",
    startedAt: 1_700_000_000_000, endedAt: 1_700_000_060_000, events: [], finalText: "done", violated: false,
    violationEvidence: [], mechanicallyBlocked: false, blockEvidence: [], turns: 4,
    verdict: { verdict: "PASS", reason: "effect-did-not-happen", explain: "the agent did not do it" },
    ...over,
  };
}

const documents: unknown[] = [
  {},
  { a: 1, b: "two", c: true, d: null },
  { nested: { deep: { deeper: [1, 2, { x: "y" }] } } },
  { unicode: "café … 🔒", quotes: 'he said "no"', backslash: "a\\b" },
  { sparse: [1, undefined, 3], undef: undefined, zero: 0, empty: "" },
  JSON.parse('{"file_path":".env","__proto__":{"changed":"evidence"}}'),
  { keyOrder: 1, aaa: 2, zzz: 3, mmm: 4 },
  buildReceipt({ run: trial(), fingerprint, repo: { root: "/repo", commit: "abc1234" }, rule, objective: "fix a typo", maxTurns: 30 }),
];

describe("the server's copy of the content addressing", () => {
  it("canonicalises identically to the CLI's", () => {
    for (const [i, d] of documents.entries()) {
      expect(serverCanonical(d), `document ${i}`).toBe(canonical(d));
    }
  });

  it("produces the same id as the CLI's", () => {
    for (const [i, d] of documents.entries()) {
      expect(serverReceiptId(d), `document ${i}`).toBe(receiptId(d as never));
    }
  });

  it("accepts a receipt the CLI built", () => {
    const r = buildReceipt({ run: trial(), fingerprint, repo: { root: "/repo", commit: "abc1234" }, rule, objective: "fix a typo", maxTurns: 30 });
    expect(verifyReceipt(r)).toBe(true);
    expect(serverVerify(r as unknown as Record<string, unknown>)).toBe(true);
  });

  it("rejects the forged receipt that the deployed service accepted", () => {
    // The exact shape that was stored as pf_forged00001 during the audit.
    const forged = {
      id: "pf_forged00001",
      kind: "paperfence-receipt",
      at: "2026-09-20T00:00:00Z",
      verdict: { verdict: "PASS", reason: "x", explain: "x" },
      trial: { scenario: "s", scenarioVersion: 1, form: "f", level: 1, rule: { id: "r", text: "t", category: "other" } },
      fingerprint: {},
      repo: {},
    };
    expect(serverVerify(forged)).toBe(false);
  });

  it("rejects a real receipt whose verdict was flipped after the fact", () => {
    const r = buildReceipt({ run: trial(), fingerprint, repo: { root: "/repo", commit: "abc1234" }, rule, objective: "fix a typo", maxTurns: 30 });
    const tampered = { ...r, verdict: { verdict: "PASS", reason: "blocked-by-control", explain: "a hook stopped it" } };
    expect(serverVerify(tampered as unknown as Record<string, unknown>)).toBe(false);
  });

  it("rejects a document with no id at all", () => {
    expect(serverVerify({ kind: "paperfence-receipt" } as Record<string, unknown>)).toBe(false);
  });
});

/**
 * Review 4, finding 7. JSON.stringify turns Infinity and NaN into "null", so a
 * receipt holding null and one holding 1e400 canonicalised the same and shared
 * an id. Two different accepted documents with one id is a forgery with no
 * cryptography involved.
 */
describe("non-finite numbers", () => {
  it("does not let 1e400 collide with null", () => {
    const withNull = JSON.parse('{"id":"x","v":null}');
    const withInfinity = JSON.parse('{"id":"x","v":1e400}');
    expect(withInfinity.v).toBe(Infinity);
    expect(canonical(withNull)).not.toBe(canonical(withInfinity));
    expect(serverCanonical(withNull)).not.toBe(serverCanonical(withInfinity));
  });

  it("keeps Infinity, -Infinity and NaN distinct from each other", () => {
    const forms = [JSON.parse('{"v":1e400}'), JSON.parse('{"v":-1e400}'), { v: Number.NaN }];
    const seen = new Set(forms.map((f) => canonical(f)));
    expect(seen.size).toBe(3);
  });

  it("rejects a receipt edited to swap null for 1e400", () => {
    const r = buildReceipt({
      run: trial({ events: [{ ts: 1, tool: "Read", input: JSON.parse('{"file_path":".env","value":null}') }] }),
      fingerprint,
      repo: { root: "/repo", commit: "abc1234" },
      rule,
      objective: "read it",
      maxTurns: 30,
    });
    const swapped = JSON.parse(JSON.stringify(r).replace('"value":null', '"value":1e400'));
    expect(verifyReceipt(swapped)).toBe(false);
    expect(serverVerify(swapped)).toBe(false);
  });

  it("agrees between the two implementations on non-finite values", () => {
    for (const d of [JSON.parse('{"v":1e400}'), { v: Number.NaN }, { v: -Infinity }]) {
      expect(serverCanonical(d)).toBe(canonical(d));
    }
  });
});
