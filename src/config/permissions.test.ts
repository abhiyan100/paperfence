import { describe, expect, it } from "vitest";
import { bashFileTargets, evaluatePermissions, inertRules, parsePermissionRule, pathSpecMatches, ruleMatchesCall, splitSubcommands } from "./permissions.js";

const R = "/repo";
const bash = (command: string) => ({ tool: "Bash", input: { command } });

describe("parsePermissionRule", () => {
  it("parses tool only", () => {
    expect(parsePermissionRule("Bash")).toEqual({ raw: "Bash", tool: "Bash", spec: undefined });
  });
  it("parses tool with spec", () => {
    expect(parsePermissionRule("Bash(git push:*)")).toEqual({ raw: "Bash(git push:*)", tool: "Bash", spec: "git push:*" });
  });
});

describe("Bash rules", () => {
  it(":* and trailing * are prefix matches that also match the bare command", () => {
    for (const spec of ["Bash(git push:*)", "Bash(git push *)"]) {
      const r = parsePermissionRule(spec);
      expect(ruleMatchesCall(r, bash("git push origin main"))).toBeTruthy();
      expect(ruleMatchesCall(r, bash("git push"))).toBeTruthy();
      expect(ruleMatchesCall(r, bash("git pushx"))).toBeNull();
      expect(ruleMatchesCall(r, bash("git status"))).toBeNull();
    }
  });
  it("* matches at any position", () => {
    const r = parsePermissionRule("Bash(git * --force)");
    expect(ruleMatchesCall(r, bash("git push origin main --force"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("git push origin main"))).toBeNull();
  });
  it("exact match without *", () => {
    const r = parsePermissionRule("Bash(npm test)");
    expect(ruleMatchesCall(r, bash("npm test"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("npm test -- --watch"))).toBeNull();
  });
  it("deny applies when any subcommand matches, including subshells", () => {
    const r = parsePermissionRule("Bash(rm -rf *)");
    expect(ruleMatchesCall(r, bash("ls && rm -rf build"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("ls; rm -rf build"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("ls | rm -rf build"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("ls & rm -rf build"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("echo $(rm -rf build)"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("(cd x && rm -rf build)"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("ls\nrm -rf build"))).toBeTruthy();
  });
  it("quoted text is data and wrappers are stripped", () => {
    const r = parsePermissionRule("Bash(git push:*)");
    expect(ruleMatchesCall(r, bash("echo 'safe; git push origin main'"))).toBeNull();
    expect(ruleMatchesCall(r, bash("command git push origin main"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("GIT_TRACE=1 git push origin main"))).toBeTruthy();
  });
  it("leading / anchors at the project, no any-depth", () => {
    expect(pathSpecMatches("/infra/**", "/repo/infra/x.yml", R)).toBe(true);
    expect(pathSpecMatches("/infra/**", "/repo/vendor/infra/x.yml", R)).toBe(false);
    expect(pathSpecMatches("infra/**", "/repo/vendor/infra/x.yml", R)).toBe(true);
  });
  it("does not match the program by path or under sh -c (documented gap)", () => {
    const r = parsePermissionRule("Bash(curl *)");
    expect(ruleMatchesCall(r, bash("curl https://x"))).toBeTruthy();
    expect(ruleMatchesCall(r, bash("/usr/bin/curl https://x"))).toBeNull();
    expect(ruleMatchesCall(r, bash("sh -c 'curl https://x'"))).toBeNull();
  });
});

describe("splitSubcommands / bashFileTargets", () => {
  it("splits and finds file targets", () => {
    expect(splitSubcommands("a && b | c; d")).toEqual(["a", "b", "c", "d"]);
    expect(bashFileTargets("cat .env")).toEqual({ reads: [".env"], writes: [] });
    expect(bashFileTargets("head -n 3 ./.env")).toEqual({ reads: ["./.env"], writes: [] });
    expect(bashFileTargets("echo hi > out.txt")).toEqual({ reads: [], writes: ["out.txt"] });
    expect(bashFileTargets("sort < .env")).toEqual({ reads: [".env"], writes: [] });
    expect(bashFileTargets("grep KEY .env")).toEqual({ reads: [], writes: [] });
  });
});

describe("Read/Edit path rules", () => {
  it("bare filename matches at any depth (gitignore)", () => {
    expect(pathSpecMatches(".env", "/repo/.env", R)).toBe(true);
    expect(pathSpecMatches(".env", "/repo/packages/api/.env", R)).toBe(true);
    expect(pathSpecMatches(".env", "/repo/.env.example", R)).toBe(false);
    expect(pathSpecMatches("*.env", "/repo/prod.env", R)).toBe(true);
    expect(pathSpecMatches(".env", "/elsewhere/.env", R)).toBe(false);
  });
  it("./path and path are relative to the project", () => {
    expect(pathSpecMatches("./.env", "/repo/.env", R)).toBe(true);
    expect(pathSpecMatches("./.env", "/repo/./.env", R)).toBe(true);
    expect(pathSpecMatches("src/**", "/repo/src/a/b.ts", R)).toBe(true);
    expect(pathSpecMatches("src/**", "/repo/lib/src/a.ts", R)).toBe(true); // single-segment dir/** matches at any depth for deny
    expect(pathSpecMatches("src/components/**", "/repo/src/components/x.tsx", R)).toBe(true);
    expect(pathSpecMatches("src/components/**", "/repo/x/src/components/x.tsx", R)).toBe(false);
  });
  it("// is absolute and ~/ is home", () => {
    expect(pathSpecMatches("//etc/**", "/etc/hosts", R)).toBe(true);
    expect(pathSpecMatches("//etc/**", "/repo/etc/hosts", R)).toBe(false);
  });
  it("Read deny covers cat/head/tail/sed and < redirects in Bash, not grep or node", () => {
    const r = parsePermissionRule("Read(./.env)");
    expect(ruleMatchesCall(r, bash("cat .env"), R)).toBeTruthy();
    expect(ruleMatchesCall(r, bash("ls && head -3 .env"), R)).toBeTruthy();
    expect(ruleMatchesCall(r, bash("sort < .env"), R)).toBeTruthy();
    expect(ruleMatchesCall(r, bash("grep KEY .env"), R)).toBeNull();
    expect(ruleMatchesCall(r, bash("node -e 'require(\"fs\").readFileSync(\".env\")'"), R)).toBeNull();
    expect(ruleMatchesCall(r, bash("cat .env.example"), R)).toBeNull();
  });
  it("Edit deny covers Write/MultiEdit/NotebookEdit and > redirects", () => {
    const r = parsePermissionRule("Edit(tests/**)");
    expect(ruleMatchesCall(r, { tool: "Edit", input: { file_path: "/repo/tests/a.test.ts" } }, R)).toBeTruthy();
    expect(ruleMatchesCall(r, { tool: "Write", input: { file_path: "/repo/tests/deep/b.test.ts" } }, R)).toBeTruthy();
    expect(ruleMatchesCall(r, bash("echo x > tests/a.test.ts"), R)).toBeTruthy();
    expect(ruleMatchesCall(r, { tool: "Edit", input: { file_path: "/repo/src/a.ts" } }, R)).toBeNull();
    expect(ruleMatchesCall(r, { tool: "Read", input: { file_path: "/repo/tests/a.test.ts" } }, R)).toBeNull();
  });
  it("Write(path) rules are never consulted", () => {
    const r = parsePermissionRule("Write(tests/**)");
    expect(ruleMatchesCall(r, { tool: "Write", input: { file_path: "/repo/tests/a.test.ts" } }, R)).toBeNull();
    expect(inertRules({ deny: ["Write(tests/**)", "Read(.env)"] })).toHaveLength(1);
  });
  it("bare tool deny removes the tool", () => {
    expect(ruleMatchesCall(parsePermissionRule("WebFetch"), { tool: "WebFetch", input: { url: "https://x" } })).toBeTruthy();
    expect(ruleMatchesCall(parsePermissionRule("Edit"), { tool: "Write", input: { file_path: "/repo/a" } })).toBeNull();
  });
});

describe("WebFetch", () => {
  it("matches domains with wildcards", () => {
    const r = parsePermissionRule("WebFetch(domain:*.example.com)");
    expect(ruleMatchesCall(r, { tool: "WebFetch", input: { url: "https://api.example.com/x" } })).toBeTruthy();
    expect(ruleMatchesCall(r, { tool: "WebFetch", input: { url: "https://example.com/x" } })).toBeNull();
    expect(ruleMatchesCall(parsePermissionRule("WebFetch(domain:example.com)"), { tool: "WebFetch", input: { url: "https://EXAMPLE.com./x" } })).toBeTruthy();
  });
});

describe("evaluatePermissions", () => {
  it("deny beats allow", () => {
    const d = evaluatePermissions({ allow: ["Bash"], deny: ["Bash(git push *)"] }, bash("git push origin main"));
    expect(d.decision).toBe("deny");
  });
  it("returns none when nothing matches", () => {
    expect(evaluatePermissions({ allow: ["Read"] }, bash("ls")).decision).toBe("none");
  });
});
