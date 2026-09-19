import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { collectRules } from "../scan.js";
import type { Rule } from "../types.js";
import { defaultSuite, loadSuite } from "./suite.js";
import { materialize } from "./variants.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "..", "..", "fixtures", "typical");
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

describe("suite", () => {
  it("derives a default suite from the fixture", async () => {
    const { rules } = await collectRules(fixture, { offline: true });
    const suite = await defaultSuite(fixture, rules, 2);
    expect(suite.bad.length).toBeGreaterThanOrEqual(8);
    expect(suite.bad.map((b) => b.id)).toContain("bad-protect-branch");
    expect(suite.good.map((g) => g.id)).toEqual(["good-readme-branch", "good-add-helper", "good-run-tests-report"]);
  });
  it("rejects a suite that references an unknown rule", async () => {
    const { rules } = await collectRules(fixture, { offline: true });
    const tmp = await fs.mkdtemp("/tmp/pf-suite-");
    cleanups.push(() => fs.rm(tmp, { recursive: true, force: true }));
    await fs.mkdir(path.join(tmp, ".paperfence"));
    await fs.writeFile(path.join(tmp, ".paperfence", "suite.json"), JSON.stringify({ bad: [{ id: "x", rule: "nope" }], good: [] }));
    await expect(loadSuite(tmp, rules)).rejects.toThrow(/neither a rule id nor a category/);
  });
});

describe("variants", () => {
  it("--without removes matching rule lines and nothing else", async () => {
    const v = await materialize(fixture, { name: "t", without: ["push directly to main"] }, "m");
    cleanups.push(v.destroy);
    const md = await fs.readFile(path.join(v.dir, "CLAUDE.md"), "utf8");
    expect(md).not.toMatch(/push directly to main/);
    expect(md).toMatch(/Never read `\.env`/);
    expect(v.describe).toMatch(/1 line removed/);
    const { rules } = await collectRules(v.dir, { offline: true });
    expect(rules.some((r: Rule) => r.category === "protect-branch")).toBe(false);
  });
  it("--hook replaces PreToolUse hooks; --deny appends", async () => {
    const v = await materialize(fixture, { name: "t2", hook: "node guard.js", deny: ["Bash(git push *)"] }, "m");
    cleanups.push(v.destroy);
    const s = JSON.parse(await fs.readFile(path.join(v.dir, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("node guard.js");
    expect(s.permissions.deny).toContain("Bash(git push *)");
    expect(s.permissions.deny).toContain("Read(./.env)"); // original kept
  });
  it("--hardened applies harden on the copy, not the fixture", async () => {
    const v = await materialize(fixture, { name: "t3", hardened: true, offline: true }, "m");
    cleanups.push(v.destroy);
    expect(await fs.stat(path.join(v.dir, ".claude", "hooks", "paperfence-guard.cjs")).then(() => true)).toBe(true);
    expect(await fs.stat(path.join(fixture, ".claude", "hooks", "paperfence-guard.cjs")).then(() => true).catch(() => false)).toBe(false);
    expect(v.describe).toMatch(/hardened/);
  });
  it("does not copy node_modules or .git", async () => {
    const v = await materialize(fixture, { name: "t4" }, "m");
    cleanups.push(v.destroy);
    expect(await fs.stat(path.join(v.dir, ".git")).then(() => true).catch(() => false)).toBe(false);
    expect(v.model).toBe("m");
    expect(v.describe).toBe("as is");
  });
});
