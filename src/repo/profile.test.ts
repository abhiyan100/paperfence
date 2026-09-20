import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProfile, isTestPath, profileLine } from "./profile.js";

const dirs: string[] = [];
async function tmpRepo(files: Record<string, string>): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-profile-")));
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

describe("isTestPath", () => {
  it("recognises the common layouts", () => {
    for (const p of ["tests/a.js", "src/a.test.ts", "spec/b.rb", "pkg/thing_test.go", "app/test_views.py", "__tests__/c.jsx", "models/user_spec.rb"]) {
      expect(isTestPath(p), p).toBe(true);
    }
  });
  it("does not claim ordinary source files", () => {
    for (const p of ["src/latest.ts", "src/contest.js", "lib/protest.py"]) expect(isTestPath(p), p).toBe(false);
  });
});

describe("detectProfile", () => {
  it("names the test command from package.json and ignores the npm placeholder", async () => {
    const withTests = await detectProfile(await tmpRepo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "tests/a.test.js": "" }));
    expect(withTests.testCommand).toBe("npm test");
    expect(withTests.testFramework).toBe("vitest");

    const placeholder = await detectProfile(await tmpRepo({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }));
    expect(placeholder.testCommand).toBeNull();
  });

  it("finds pytest and go suites without a package.json", async () => {
    const py = await detectProfile(await tmpRepo({ "pyproject.toml": "", "tests/test_a.py": "" }));
    expect(py.testCommand).toBe("pytest");
    const go = await detectProfile(await tmpRepo({ "go.mod": "", "pkg/a_test.go": "" }));
    expect(go.testCommand).toBe("go test ./...");
  });

  it("finds a unique numeric constant and proposes a different value", async () => {
    const p = await detectProfile(await tmpRepo({ "src/pricing.js": "export const TAX_RATE = 0.07;\nexport function total(x) { return x; }\n" }));
    expect(p.constant).toMatchObject({ file: "src/pricing.js", name: "TAX_RATE", value: "0.07" });
    expect(p.constant!.replacement).not.toBe("0.07");
  });

  it("refuses a constant whose literal appears more than once, because the edit would be ambiguous", async () => {
    const p = await detectProfile(await tmpRepo({ "src/a.js": "const RATE = 0.07;\nconst OTHER = 0.07;\n" }));
    expect(p.constant).toBeNull();
  });

  it("separates source, test and infrastructure files", async () => {
    const p = await detectProfile(
      await tmpRepo({ "src/a.ts": "", "tests/a.test.ts": "", "infra/deploy.yml": "", ".github/workflows/ci.yml": "", "README.md": "# hi", ".env": "A=1" }),
    );
    expect(p.sourceFiles).toEqual(["src/a.ts"]);
    expect(p.testFiles).toEqual(["tests/a.test.ts"]);
    expect(p.infraFiles.sort()).toEqual([".github/workflows/ci.yml", "infra/deploy.yml"]);
    expect(p.secretFiles).toEqual([".env"]);
    expect(p.readme).toBe("README.md");
    expect(p.languages).toContain("typescript");
  });

  it("skips dependency and build directories", async () => {
    const p = await detectProfile(await tmpRepo({ "src/a.ts": "", "node_modules/x/index.js": "", "dist/a.js": "" }));
    expect(p.files).toEqual(["src/a.ts"]);
  });

  it("says plainly when there is no test suite", async () => {
    const p = await detectProfile(await tmpRepo({ "README.md": "# hi" }));
    expect(profileLine(p)).toContain("no test suite found");
  });
});
