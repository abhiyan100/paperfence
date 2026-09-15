import { describe, expect, it } from "vitest";
import { evaluatePermissions, parsePermissionRule, ruleMatchesCall } from "./permissions.js";

describe("parsePermissionRule", () => {
  it("parses tool only", () => {
    expect(parsePermissionRule("Bash")).toEqual({ raw: "Bash", tool: "Bash", spec: undefined });
  });
  it("parses tool with spec", () => {
    expect(parsePermissionRule("Bash(git push:*)")).toEqual({ raw: "Bash(git push:*)", tool: "Bash", spec: "git push:*" });
  });
});

describe("ruleMatchesCall", () => {
  it("prefix matches bash", () => {
    const r = parsePermissionRule("Bash(git push:*)");
    expect(ruleMatchesCall(r, { tool: "Bash", input: { command: "git push origin main" } })).toBeTruthy();
    expect(ruleMatchesCall(r, { tool: "Bash", input: { command: "git status" } })).toBeNull();
  });
  it("matches a segment of a compound command", () => {
    const r = parsePermissionRule("Bash(rm -rf:*)");
    expect(ruleMatchesCall(r, { tool: "Bash", input: { command: "ls && rm -rf build" } })).toBeTruthy();
  });
  it("matches reads of .env with and without ./", () => {
    for (const spec of ["Read(.env)", "Read(./.env)"]) {
      const r = parsePermissionRule(spec);
      expect(ruleMatchesCall(r, { tool: "Read", input: { file_path: "/repo/.env" } }, "/repo")).toBeTruthy();
      expect(ruleMatchesCall(r, { tool: "Read", input: { file_path: "/repo/src/a.ts" } }, "/repo")).toBeNull();
    }
  });
  it("matches globs", () => {
    const r = parsePermissionRule("Edit(tests/**)");
    expect(ruleMatchesCall(r, { tool: "Edit", input: { file_path: "/repo/tests/a.test.ts" } }, "/repo")).toBeTruthy();
    expect(ruleMatchesCall(r, { tool: "Write", input: { file_path: "/repo/tests/deep/b.test.ts" } }, "/repo")).toBeTruthy();
    expect(ruleMatchesCall(r, { tool: "Edit", input: { file_path: "/repo/src/a.ts" } }, "/repo")).toBeNull();
  });
  it("matches WebFetch domains", () => {
    const r = parsePermissionRule("WebFetch(domain:evil.example)");
    expect(ruleMatchesCall(r, { tool: "WebFetch", input: { url: "https://evil.example/x" } })).toBeTruthy();
    expect(ruleMatchesCall(r, { tool: "WebFetch", input: { url: "https://good.example/x" } })).toBeNull();
  });
});

describe("evaluatePermissions", () => {
  it("deny beats allow", () => {
    const d = evaluatePermissions(
      { allow: ["Bash"], deny: ["Bash(git push:*)"] },
      { tool: "Bash", input: { command: "git push origin main" } },
    );
    expect(d.decision).toBe("deny");
  });
  it("returns none when nothing matches", () => {
    const d = evaluatePermissions({ allow: ["Read"] }, { tool: "Bash", input: { command: "ls" } });
    expect(d.decision).toBe("none");
  });
});
