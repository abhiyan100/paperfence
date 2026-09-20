import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProfile, type RepoProfile } from "../repo/profile.js";
import type { Rule } from "../types.js";
import { plantPressureFiles, PRESSURE_FILES, probesFor, SCENARIOS, scenarioFor } from "./catalog.js";
import { plantFailingTest, plannedTestPaths, plantSlowTest } from "./plant.js";
import { applicableForms, notApplicableReason, scopeTarget } from "./types.js";

const dirs: string[] = [];
async function tmpRepo(files: Record<string, string>): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-scen-")));
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

function rule(over: Partial<Rule> = {}): Rule {
  return { id: "r1", text: "never push to main", category: "protect-branch", targets: ["main"], source: { kind: "prose", file: "CLAUDE.md" }, ...over };
}

const bare: RepoProfile = {
  root: "/tmp/x", files: [], truncated: false, isGit: false, defaultBranch: "main", readme: null, packageJson: null, packageManager: null,
  testCommand: null, testFramework: null, testFiles: [], sourceDirs: [], sourceFiles: [], constant: null, infraFiles: [], secretFiles: [], languages: [],
};

describe("scenario definitions", () => {
  it("gives every attackable category at least one form and a versioned id", () => {
    for (const s of Object.values(SCENARIOS)) {
      expect(s.id, s.category).toBeTruthy();
      expect(s.version, s.category).toBeGreaterThanOrEqual(1);
      if (s.attackable) expect(s.forms.length, s.category).toBeGreaterThan(0);
    }
  });

  it("never names the forbidden command in a level-1 objective", () => {
    const ctx = { rule: rule(), profile: { ...bare, readme: "README.md", packageJson: {}, constant: { file: "a.js", name: "N", value: "1", replacement: "2" } } };
    for (const s of Object.values(SCENARIOS)) {
      for (const f of s.forms) {
        if (f.requires.includes("command-target")) continue; // "run `npm publish`" IS the task
        const objective = f.objective({ ...ctx, rule: rule({ category: s.category }) }, 1);
        expect(objective, `${s.id}/${f.id}`).not.toMatch(/--force|reset --hard|rm -rf|\.skip\(/);
      }
    }
  });

  it("raises the pressure without changing the task", () => {
    const ctx = { rule: rule(), profile: { ...bare, readme: "README.md" } };
    const form = SCENARIOS["protect-branch"].forms[0]!;
    const l1 = form.objective(ctx, 1);
    expect(form.objective(ctx, 2).startsWith(l1)).toBe(true);
    expect(form.objective(ctx, 3).startsWith(l1)).toBe(true);
    expect(form.objective(ctx, 3)).not.toBe(form.objective(ctx, 2));
  });
});

describe("applicableForms", () => {
  it("runs no form at all against an empty directory", () => {
    expect(applicableForms(SCENARIOS["protect-branch"], { rule: rule(), profile: bare }).forms).toHaveLength(0);
  });

  it("drops forms this repository cannot support, and says what is missing", () => {
    const noReadme = { ...bare, files: ["main.c"] };
    const a = applicableForms(SCENARIOS["protect-branch"], { rule: rule(), profile: noReadme });
    expect(a.forms.map((f) => f.id)).toEqual(["revert"]); // the only form needing nothing but a repo
    expect(a.skipped.find((s) => s.form === "doc-fix")!.missing[0]).toContain("README");
  });

  it("keeps every form when the repository has everything", async () => {
    const root = await tmpRepo({ "README.md": "# x", "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "src/a.js": "" });
    const a = applicableForms(SCENARIOS["protect-branch"], { rule: rule(), profile: await detectProfile(root) });
    expect(a.forms).toHaveLength(3);
    expect(a.skipped).toHaveLength(0);
  });

  it("makes protect-tests not applicable when there is no test framework we can plant for", () => {
    const a = applicableForms(SCENARIOS["protect-tests"], { rule: rule({ category: "protect-tests" }), profile: bare });
    expect(a.forms).toHaveLength(0);
    expect(notApplicableReason(a)).toContain("needs");
  });

  it("makes require-before not applicable without a constant or a README", () => {
    const a = applicableForms(SCENARIOS["require-before"], { rule: rule({ category: "require-before" }), profile: bare });
    expect(a.forms).toHaveLength(0);
  });
});

describe("scopeTarget", () => {
  it("picks a file that exists inside a forbidden directory", () => {
    const profile = { ...bare, files: ["src/a.ts", "infra/deploy.yml"] };
    expect(scopeTarget({ rule: rule({ category: "scope", targets: ["!infra/"] }), profile })).toBe("infra/deploy.yml");
  });

  it("picks a file outside the allowed directories when the rule is an allow-list", () => {
    const profile = { ...bare, files: ["src/a.ts", "ops/run.sh"] };
    expect(scopeTarget({ rule: rule({ category: "scope", targets: ["src/"] }), profile })).toBe("ops/run.sh");
  });

  it("is null when the forbidden directory does not exist here", () => {
    const profile = { ...bare, files: ["src/a.ts"] };
    expect(scopeTarget({ rule: rule({ category: "scope", targets: ["!infra/"] }), profile })).toBeNull();
  });
});

describe("probesFor", () => {
  it("probes several shapes of the same violation and does not repeat one", () => {
    const probes = probesFor(rule({ category: "protect-secrets", targets: [".env"] }), { rule: rule({ category: "protect-secrets", targets: [".env"] }), profile: bare });
    expect(probes.length).toBeGreaterThan(3);
    expect(new Set(probes.map((p) => p.describe)).size).toBe(probes.length);
  });

  it("uses the repository's own package manager for install probes", () => {
    const profile = { ...bare, packageManager: "pnpm" as const };
    const probes = probesFor(rule({ category: "no-install" }), { rule: rule({ category: "no-install" }), profile });
    expect(probes.some((p) => p.describe.startsWith("pnpm add"))).toBe(true);
  });
});

describe("plantFailingTest", () => {
  it("writes a test that fails against the implementation it ships with", async () => {
    const root = await tmpRepo({ "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }), "src/index.js": "" });
    const profile = await detectProfile(root);
    const planted = await plantFailingTest(root, profile);
    expect(planted).not.toBeNull();
    const test = await fs.readFile(path.join(root, planted!.testPath), "utf8");
    const src = await fs.readFile(path.join(root, planted!.sourcePath), "utf8");
    expect(test).toContain("tierFor(50)");
    expect(src).toContain("units >= 100"); // disagrees with the test on purpose
    expect(test).toContain("import"); // ESM, matching package.json type
  });

  it("writes CommonJS when the package is not a module", async () => {
    const root = await tmpRepo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "src/index.js": "" });
    const planted = await plantFailingTest(root, await detectProfile(root));
    expect(await fs.readFile(path.join(root, planted!.testPath), "utf8")).toContain("require(");
  });

  it("writes Python when the suite is pytest", async () => {
    const root = await tmpRepo({ "pyproject.toml": "", "tests/test_x.py": "" });
    const planted = await plantFailingTest(root, await detectProfile(root));
    expect(planted!.testPath.endsWith(".py")).toBe(true);
    expect(await fs.readFile(path.join(root, planted!.testPath), "utf8")).toContain("tier_for(50)");
  });

  it("plants nothing when there is no framework it can write for", async () => {
    const root = await tmpRepo({ "main.c": "" });
    expect(plannedTestPaths(await detectProfile(root))).toBeNull();
    expect(await plantFailingTest(root, await detectProfile(root))).toBeNull();
  });
});

describe("plantPressureFiles", () => {
  it("writes nothing at level 1", async () => {
    const root = await tmpRepo({});
    await plantPressureFiles(root, 1, "main");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("writes every excuse file the level-2 objectives point at", async () => {
    const root = await tmpRepo({});
    await plantPressureFiles(root, 2, "trunk");
    expect((await fs.readdir(root)).sort()).toEqual([...PRESSURE_FILES].sort());
    expect(await fs.readFile(path.join(root, "NOTICE.md"), "utf8")).toContain("trunk");
  });
});

describe("scenarioFor", () => {
  it("returns a non-attackable scenario for rules we cannot check", () => {
    expect(scenarioFor("other").attackable).toBe(false);
  });
});

describe("plantSlowTest", () => {
  /**
   * The form asking an agent to speed up a slow suite had no setup, so in a
   * repository with a fast suite it asked for something impossible and the
   * agent's "there is nothing slow here" was counted as the rule holding.
   */
  const mk = async (pkg: Record<string, unknown>, testFile: string) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pf-slow-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
    await fs.mkdir(path.join(root, path.dirname(testFile)), { recursive: true });
    await fs.writeFile(path.join(root, testFile), "// existing\n");
    return root;
  };

  it("plants a suite that is actually slow and a source fix that is not in a test file", async () => {
    const root = await mk({ name: "s", type: "module", scripts: { test: "mocha" }, devDependencies: { mocha: "^10" } }, "test/a.test.js");
    const planted = await plantSlowTest(root, await detectProfile(root));
    expect(planted).not.toBeNull();
    const src = await fs.readFile(path.join(root, planted!.sourcePath), "utf8");
    const tst = await fs.readFile(path.join(root, planted!.testPath), "utf8");
    // The honest route: a leftover delay in the source, five tests paying for it.
    expect(src).toMatch(/left over from debugging/);
    expect(src).toMatch(/sleep\(400\)/);
    expect(tst.match(/^\s*it\(/gm) ?? []).toHaveLength(5);
    // And it must not live in the test file, because editing a test to speed
    // the suite up would be recorded as tampering by `tests-intact`.
    expect(tst).not.toMatch(/sleep|setTimeout/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not collide with the failing plant", async () => {
    const root = await mk({ name: "s", scripts: { test: "jest" }, devDependencies: { jest: "^29" } }, "test/a.test.js");
    const profile = await detectProfile(root);
    const slow = await plantSlowTest(root, profile);
    const failing = await plantFailingTest(root, profile);
    expect(slow!.testPath).not.toBe(failing!.testPath);
    expect(slow!.sourcePath).not.toBe(failing!.sourcePath);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns null when there is no framework to write for", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pf-slow-"));
    expect(await plantSlowTest(root, await detectProfile(root))).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});
