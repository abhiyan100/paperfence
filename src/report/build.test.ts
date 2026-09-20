import { describe, expect, it } from "vitest";
import { buildReport } from "./build.js";
import type { Rule, StaticProbeResult } from "../types.js";

function rule(id: string, over: Partial<Rule>): Rule {
  return { id, text: id, category: "protect-secrets", targets: [".env"], source: { kind: "prose", file: "CLAUDE.md" }, ...over };
}

function probe(ruleId: string, blocked: boolean): StaticProbeResult {
  const p = { tool: "Read" as const, input: { file_path: ".env" }, describe: "Read .env" };
  return { ruleId, outcomes: [{ probe: p, blockedBy: blocked ? "permission-deny" : "none", evidence: "x" }], probe: p, blockedBy: blocked ? "permission-deny" : "none", evidence: "x" };
}

/**
 * A prose line and the settings entry that backs it are one control. Counting
 * both inflates every percentage in the report.
 */
describe("restatements", () => {
  const prose = rule("prose-1", {});
  const entry = rule("perm-1", { text: "Deny Read(./.env)", targets: ["./.env"], source: { kind: "permission", file: ".claude/settings.json", entry: "Read(./.env)", list: "deny" } });

  it("counts the pair once and keeps both in the report", () => {
    const r = buildReport("/r", [prose, entry], [probe("prose-1", false), probe("perm-1", false)], [], "static");
    expect(r.verdicts).toHaveLength(2);
    expect(r.totals.wish).toBe(1);
  });

  it("marks the settings entry, not the prose", () => {
    const r = buildReport("/r", [prose, entry], [probe("prose-1", false), probe("perm-1", false)], [], "static");
    expect(r.verdicts.find((v) => v.rule.id === "perm-1")!.restates).toMatchObject({ ruleId: "prose-1", where: "CLAUDE.md" });
    expect(r.verdicts.find((v) => v.rule.id === "prose-1")!.restates).toBeUndefined();
  });

  it("marks it whichever order the rules arrive in", () => {
    const r = buildReport("/r", [entry, prose], [probe("perm-1", false), probe("prose-1", false)], [], "static");
    expect(r.verdicts.find((v) => v.rule.id === "perm-1")!.restates).toBeDefined();
    expect(r.totals.wish).toBe(1);
  });

  it("treats `.env` and `./.env` as the same file", () => {
    const r = buildReport("/r", [prose, rule("perm-2", { targets: ["`.env`"], source: { kind: "permission", file: ".claude/settings.json", entry: "x", list: "deny" } })], [probe("prose-1", false), probe("perm-2", false)], [], "static");
    expect(r.totals.wish).toBe(1);
  });

  it("does not merge two rules about different files", () => {
    const other = rule("prose-2", { targets: ["secrets.json"] });
    const r = buildReport("/r", [prose, other], [probe("prose-1", false), probe("prose-2", false)], [], "static");
    expect(r.totals.wish).toBe(2);
    expect(r.verdicts.every((v) => !v.restates)).toBe(true);
  });

  it("does not merge two rules in different categories", () => {
    const other = rule("prose-3", { category: "no-exfil", targets: [] });
    const r = buildReport("/r", [prose, other], [probe("prose-1", false), probe("prose-3", false)], [], "static");
    expect(r.totals.wish).toBe(2);
  });
});

/**
 * A first version of this keyed only on category and targets. A repository
 * with twenty-six prose rules, many in categories that carry no targets,
 * reported one rule and twenty-five restatements. Different sentences are
 * different rules even when paperfence files them the same way.
 */
describe("restatements do not collapse distinct prose", () => {
  const proseRule = (id: string, text: string, over: Partial<Rule> = {}) => rule(id, { text, category: "no-destructive", targets: [], ...over });

  it("keeps two prose rules in the same category with no targets", () => {
    const rules = [proseRule("a", "Never run rm -rf."), proseRule("b", "Never drop a database table.")];
    const r = buildReport("/r", rules, rules.map((x) => probe(x.id, false)), [], "static");
    expect(r.totals.wish).toBe(2);
    expect(r.verdicts.every((v) => !v.restates)).toBe(true);
  });

  it("keeps many unmappable rules apart", () => {
    const rules = Array.from({ length: 8 }, (_, i) => rule(`o${i}`, { text: `style rule ${i}`, category: "other", targets: [] }));
    const r = buildReport("/r", rules, [], [], "static");
    expect(r.totals.untested).toBe(8);
  });

  it("still collapses a settings entry onto the prose it restates", () => {
    const rules = [
      rule("prose-1", { text: "Never read .env", category: "protect-secrets", targets: [".env"] }),
      rule("perm-1", { text: "Deny Read(./.env)", category: "protect-secrets", targets: ["./.env"], source: { kind: "permission", file: ".claude/settings.json", entry: "Read(./.env)", list: "deny" } }),
    ];
    const r = buildReport("/r", rules, rules.map((x) => probe(x.id, false)), [], "static");
    expect(r.totals.wish).toBe(1);
    expect(r.verdicts.find((v) => v.rule.id === "perm-1")!.restates).toBeDefined();
  });

  it("does not collapse a settings entry that has no prose behind it", () => {
    const rules = [
      rule("perm-1", { text: "Deny Read(./.env)", category: "protect-secrets", targets: [".env"], source: { kind: "permission", file: ".claude/settings.json", entry: "Read(./.env)", list: "deny" } }),
      rule("perm-2", { text: "Deny Read(./secrets.json)", category: "protect-secrets", targets: ["secrets.json"], source: { kind: "permission", file: ".claude/settings.json", entry: "x", list: "deny" } }),
    ];
    const r = buildReport("/r", rules, rules.map((x) => probe(x.id, false)), [], "static");
    expect(r.totals.wish).toBe(2);
  });

  it("does not collapse a settings entry onto prose in a different category", () => {
    const rules = [
      rule("prose-1", { text: "Never read .env", category: "protect-secrets", targets: [".env"] }),
      rule("perm-1", { text: "Deny Edit(./.env)", category: "scope", targets: [".env"], source: { kind: "permission", file: ".claude/settings.json", entry: "x", list: "deny" } }),
    ];
    const r = buildReport("/r", rules, rules.map((x) => probe(x.id, false)), [], "static");
    expect(r.totals.wish + r.totals.untested).toBe(2);
  });
});
