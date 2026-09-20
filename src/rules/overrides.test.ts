import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyOverrides, loadOverrides, OVERRIDES_PATH, renderOverridesTemplate } from "./overrides.js";
import type { Rule } from "../types.js";

const rule = (id: string, category: Rule["category"], text = "some rule"): Rule => ({
  id, text, category, targets: [], source: { kind: "prose", file: "CLAUDE.md", reader: "model" },
});

const withFile = async (body: string): Promise<string> => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-ovr-")));
  await fs.mkdir(path.join(root, path.dirname(OVERRIDES_PATH)), { recursive: true });
  await fs.writeFile(path.join(root, OVERRIDES_PATH), body);
  return root;
};

/**
 * Extraction files roughly one judgement rule in five under a category with a
 * probe behind it. Until this existed the only way to disagree with a reading
 * was to stop using the tool.
 */
describe("correcting how a rule was read", () => {
  it("changes the category and says it did", () => {
    const { rules, applied } = applyOverrides([rule("prose-aaa", "protect-tests"), rule("prose-bbb", "scope")], { "prose-aaa": "other" });
    expect(rules[0]!.category).toBe("other");
    expect(rules[1]!.category).toBe("scope");
    expect(applied).toEqual([{ ruleId: "prose-aaa", from: "protect-tests", to: "other", text: "some rule" }]);
  });

  it("records nothing when the correction agrees with the reading", () => {
    const { applied } = applyOverrides([rule("prose-aaa", "scope")], { "prose-aaa": "scope" });
    expect(applied).toHaveLength(0);
  });

  it("cannot invent a rule, only refile one", () => {
    const { rules } = applyOverrides([rule("prose-aaa", "other")], { "prose-zzz": "protect-secrets" });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.category).toBe("other");
  });

  it("refuses a category paperfence does not have, rather than ignoring it", async () => {
    const root = await withFile('{"prose-aaa":"protect-everything"}');
    await expect(loadOverrides(root)).rejects.toThrow(/not a category/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses a broken file rather than silently applying no corrections", async () => {
    const root = await withFile("{ not json");
    await expect(loadOverrides(root)).rejects.toThrow(/not valid JSON/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("means no corrections when there is no file", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-ovr-")));
    expect(await loadOverrides(root)).toEqual({});
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes a template its own loader accepts", async () => {
    // A template the tool rejects is worse than no template, and the first
    // draft of this one put the rule text in a trailing `//` comment.
    const body = renderOverridesTemplate([rule("prose-aaa", "protect-tests", 'Do not delete tests in `tests/`. "Fix" the code.'), rule("prose-bbb", "scope")]);
    expect(() => JSON.parse(body)).not.toThrow();
    const root = await withFile(body);
    expect(await loadOverrides(root)).toEqual({ "prose-aaa": "protect-tests", "prose-bbb": "scope" });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("leaves judgement rules out of the template, since they are already unprobed", () => {
    const body = renderOverridesTemplate([rule("prose-aaa", "other"), rule("prose-bbb", "scope")]);
    expect(JSON.parse(body)["prose-aaa"]).toBeUndefined();
    expect(JSON.parse(body)["prose-bbb"]).toBe("scope");
  });
});
