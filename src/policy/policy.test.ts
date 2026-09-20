import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Rule } from "../types.js";
import { compilePolicy, statementsAsRules, unenforcedAnywhere, TARGET_LABELS, type TargetId } from "./compile.js";
import { inferPolicy, loadPolicy, POLICY_PATH, renderPolicy, validatePolicy } from "./document.js";
import type { PolicyDocument } from "./types.js";

const dirs: string[] = [];
async function tmpRepo(files: Record<string, string>): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-policy-")));
  dirs.push(d);
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(d, rel)), { recursive: true });
    await fs.writeFile(path.join(d, rel), body);
  }
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

function rule(over: Partial<Rule>): Rule {
  return { id: "r", text: "t", category: "protect-branch", targets: [], source: { kind: "prose", file: "CLAUDE.md" }, ...over };
}

describe("validatePolicy", () => {
  it("rejects a document that is not version 1", () => {
    expect(() => validatePolicy({ version: 2, statements: [] })).toThrow(/version must be 1/);
  });

  it("names the statement and the problem, so the author can fix it", () => {
    expect(() => validatePolicy({ version: 1, statements: [{ id: "a", category: "protect-branch" }] })).toThrow(/statements\[0\] \(a\): text is required/);
    expect(() => validatePolicy({ version: 1, statements: [{ id: "a", text: "x", category: "nonsense" }] })).toThrow(/category must be one of/);
  });

  it("rejects duplicate ids, which would make receipts ambiguous", () => {
    const doc = { version: 1, statements: [{ id: "a", text: "x", category: "no-destructive" }, { id: "a", text: "y", category: "no-install" }] };
    expect(() => validatePolicy(doc)).toThrow(/duplicate id "a"/);
  });

  it("insists a require statement says what must run first", () => {
    expect(() => validatePolicy({ version: 1, statements: [{ id: "a", text: "x", category: "require-before" }] })).toThrow(/needs "before"/);
  });

  it("insists a scope statement says which paths", () => {
    expect(() => validatePolicy({ version: 1, statements: [{ id: "a", text: "x", category: "scope" }] })).toThrow(/needs targets/);
  });

  it("defaults the effect from the category and the runtimes to claude-code", () => {
    const doc = validatePolicy({ version: 1, statements: [{ id: "a", text: "x", category: "scope", targets: ["src/"] }] });
    expect(doc.statements[0]!.effect).toBe("restrict");
    expect(doc.runtimes).toEqual(["claude-code"]);
  });
});

describe("inferPolicy", () => {
  it("keeps the team's own wording and drops the settings entry that restates it", () => {
    const doc = inferPolicy([
      rule({ id: "p1", text: "Never read `.env`.", category: "protect-secrets", targets: [".env"] }),
      rule({ id: "s1", text: "Deny Read(./.env)", category: "protect-secrets", targets: ["./.env"], source: { kind: "permission", file: ".claude/settings.json", entry: "Read(./.env)", list: "deny" } }),
    ]);
    expect(doc.statements).toHaveLength(1);
    expect(doc.statements[0]!.text).toBe("Never read `.env`.");
  });

  it("keeps two prose rules that say different things about the same category", () => {
    const doc = inferPolicy([
      rule({ id: "a", text: "Never touch infra/.", category: "scope", targets: ["!infra/"] }),
      rule({ id: "b", text: "Only edit src/.", category: "scope", targets: ["src/"] }),
    ]);
    expect(doc.statements).toHaveLength(2);
  });

  it("normalises targets so the same path written two ways is one statement", () => {
    const doc = inferPolicy([
      rule({ id: "a", text: "one", category: "protect-tests", targets: ["tests/"] }),
      rule({ id: "b", text: "two", category: "protect-tests", targets: ["./tests"] }),
    ]);
    expect(doc.statements).toHaveLength(1);
    expect(doc.statements[0]!.targets).toEqual(["tests"]);
  });

  it("marks a rule we cannot check as guidance rather than leaving it to look like a control", () => {
    const doc = inferPolicy([rule({ id: "a", text: "Write clear commit messages.", category: "other" })]);
    expect(doc.statements[0]!.acceptAsGuidance).toBe(true);
  });

  it("round-trips through YAML", async () => {
    const doc = inferPolicy([rule({ id: "a", text: "Never push to main.", category: "protect-branch", targets: ["main"] })]);
    const root = await tmpRepo({ [POLICY_PATH]: renderPolicy(doc) });
    const loaded = await loadPolicy(root);
    expect(loaded!.doc.statements[0]).toMatchObject({ text: "Never push to main.", category: "protect-branch", targets: ["main"] });
  });
});

describe("loadPolicy", () => {
  it("returns null when there is no policy", async () => {
    expect(await loadPolicy(await tmpRepo({}))).toBeNull();
  });
  it("fails loudly on a policy that does not parse, rather than enforcing nothing quietly", async () => {
    const root = await tmpRepo({ [POLICY_PATH]: "version: 1\nstatements:\n  - [unclosed\n" });
    await expect(loadPolicy(root)).rejects.toThrow(/paperfence\.policy\.yaml/);
  });
});

const doc: PolicyDocument = validatePolicy({
  version: 1,
  statements: [
    { id: "branch", text: "Never push to main.", category: "protect-branch", targets: ["main"] },
    { id: "tests", text: "Do not weaken tests.", category: "protect-tests", targets: ["tests"] },
    { id: "before", text: "Run npm test before committing.", category: "require-before", before: "npm test" },
    { id: "ask", text: "Ask before publishing.", category: "ask-first", targets: ["npm publish"] },
    { id: "style", text: "Write clear commit messages.", category: "other", acceptAsGuidance: true },
  ],
});

describe("compilePolicy", () => {
  it("does not claim deny entries fully enforce a branch rule", () => {
    const c = compilePolicy(doc, "claude-code");
    const branch = c.statements.find((s) => s.statement.id === "branch")!;
    expect(branch.enforceability).toBe("partial");
    expect(branch.gaps.join(" ")).toContain("HEAD:main");
  });

  it("says a deny list cannot enforce an ordering rule at all", () => {
    const c = compilePolicy(doc, "claude-code");
    expect(c.statements.find((s) => s.statement.id === "before")!.enforceability).toBe("unenforceable");
  });

  it("puts ask-first outside the agent, because nobody answers in CI", () => {
    const c = compilePolicy(doc, "claude-code");
    const ask = c.statements.find((s) => s.statement.id === "ask")!;
    expect(ask.enforceability).toBe("org-control");
    expect(ask.elsewhere).toBeTruthy();
  });

  it("marks the guard target as needing the guard, not as free enforcement", () => {
    const c = compilePolicy(doc, "claude-code-hook");
    for (const id of ["branch", "tests", "before", "ask"]) {
      expect(c.statements.find((s) => s.statement.id === id)!.enforceability, id).toBe("needs-runtime-guard");
    }
  });

  it("says branch protection is the control that does not depend on the agent", () => {
    const c = compilePolicy(doc, "github");
    expect(c.statements.find((s) => s.statement.id === "branch")!.enforceability).toBe("enforced");
  });

  it("respects acceptAsGuidance everywhere, so an accepted rule never looks enforced", () => {
    for (const t of ["claude-code", "claude-code-hook", "github", "codex"] as TargetId[]) {
      const c = compilePolicy(doc, t);
      expect(c.statements.find((s) => s.statement.id === "style")!.enforceability, t).toBe("unenforceable");
    }
  });

  it("emits the files it would write for the Claude Code targets", () => {
    expect(Object.keys(compilePolicy(doc, "claude-code").artifacts)).toEqual([".claude/settings.json"]);
    expect(Object.keys(compilePolicy(doc, "claude-code-hook").artifacts).sort()).toEqual([".claude/hooks/paperfence-guard.cjs", ".claude/hooks/policy.json", ".claude/settings.json"]);
  });

  it("does not pretend to compile for Codex", () => {
    const c = compilePolicy(doc, "codex");
    expect(c.artifacts).toEqual({});
    expect(c.notes.join(" ")).toContain("does not write it yet");
    expect(c.statements.find((s) => s.statement.id === "branch")!.gaps.join(" ")).toContain("trusts them by content hash");
  });

  it("labels every target in words a reader can act on", () => {
    for (const t of Object.keys(TARGET_LABELS) as TargetId[]) expect(compilePolicy(doc, t).target).toBe(TARGET_LABELS[t]);
  });

  it("gives every statement a mechanism and a verdict", () => {
    for (const t of ["claude-code", "claude-code-hook", "github", "codex"] as TargetId[]) {
      for (const s of compilePolicy(doc, t).statements) {
        expect(s.mechanism, `${t}/${s.statement.id}`).toBeTruthy();
        expect(s.enforceability, `${t}/${s.statement.id}`).toBeTruthy();
      }
    }
  });
});

describe("unenforcedAnywhere", () => {
  it("finds statements no target can hold", () => {
    const compiled = [compilePolicy(doc, "claude-code"), compilePolicy(doc, "github")];
    const ids = unenforcedAnywhere(compiled).map((s) => s.statement.id);
    // "style" is guidance by the author's own choice; "ask" is enforceable nowhere in this set.
    expect(ids).toContain("style");
    expect(ids).toContain("ask");
    expect(ids).not.toContain("branch");
  });

  it("is empty once the guard target is in the set", () => {
    const compiled = [compilePolicy(doc, "claude-code-hook"), compilePolicy(doc, "github")];
    expect(unenforcedAnywhere(compiled).map((s) => s.statement.id)).toEqual(["style"]);
  });
});

describe("statementsAsRules", () => {
  it("carries the required step into the target list the hardening planner reads", () => {
    const rules = statementsAsRules(doc);
    expect(rules.find((r) => r.id === "before")!.targets[0]).toBe("npm test");
  });
});
