import { describe, expect, it } from "vitest";
import { CASES, caseById } from "./cases.js";
import { predict } from "./run.js";

/**
 * These check the case table itself, not the runtime. Running the runtime
 * costs money and needs Docker, so `paperfence conformance` is a command
 * someone chooses to run, not part of the unit suite. What the unit suite can
 * check is that each case says what it means and that our own matcher agrees
 * with the expectation the case was written for.
 */
describe("conformance cases", () => {
  it("has a unique id and a claim for every case", () => {
    const ids = new Set<string>();
    for (const c of CASES) {
      expect(ids.has(c.id), c.id).toBe(false);
      ids.add(c.id);
      expect(c.claim.length, c.id).toBeGreaterThan(20);
      expect(c.claim.endsWith("."), c.id).toBe(true);
    }
  });

  it("predicts what each case says it expects", () => {
    for (const c of CASES) {
      expect(predict(c, "/repo"), `${c.id}: ${c.claim}`).toBe(c.expected);
    }
  });

  it("uses harmless commands, so a model's own judgement does not decide the result", () => {
    const dangerous = /rm\s|--force|reset --hard|\.env\b|curl|wget|npm publish|git push/;
    for (const c of CASES) {
      const text = JSON.stringify(c.call.input);
      expect(dangerous.test(text), `${c.id} uses a command a model may refuse on its own: ${text}`).toBe(false);
    }
  });

  it("allows the tool it exercises, so ask and deny are signals rather than the default prompt", () => {
    for (const c of CASES) {
      // The precedence and tool-wide cases set their own allow list on purpose.
      if (["allow-bare-tool-name", "tool-wide-deny"].includes(c.id)) continue;
      const allow = c.settings.permissions?.allow ?? [];
      expect(allow.length, c.id).toBeGreaterThan(0);
    }
  });

  it("marks a case as a gap only when it expects the runtime not to refuse", () => {
    for (const c of CASES.filter((x) => x.gap)) expect(c.expected, c.id).not.toBe("deny");
  });

  it("marks promptsWhenAttended only on cases we predict allow for", () => {
    for (const c of CASES.filter((x) => x.promptsWhenAttended)) expect(c.expected, c.id).toBe("allow");
  });

  it("covers both directions: rules that match and rules that do not", () => {
    expect(CASES.some((c) => c.expected === "deny")).toBe(true);
    expect(CASES.some((c) => c.expected === "allow")).toBe(true);
    expect(CASES.some((c) => c.expected === "ask")).toBe(true);
  });

  it("pins each precedence pair", () => {
    for (const id of ["deny-beats-allow", "deny-beats-ask", "ask-beats-allow"]) expect(caseById(id), id).toBeDefined();
  });

  it("names the files a case needs", () => {
    for (const c of CASES) {
      const p = (c.call.input as { file_path?: string }).file_path;
      if (!p || c.call.tool === "Write") continue;
      expect(Object.keys(c.files ?? {}), `${c.id} reads ${p} but plants no such file`).toContain(p);
    }
  });
});
