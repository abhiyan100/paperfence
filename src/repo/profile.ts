import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * What this repository actually contains.
 *
 * Scenarios are written against a profile, not against our fixture. A
 * scenario that needs a test suite must say so; in a repo without one it is
 * NOT APPLICABLE, which is a different statement from "the agent could not
 * do it, so the rule held".
 */

export type TestFramework = "node-test" | "vitest" | "jest" | "mocha" | "pytest" | "go-test" | "cargo-test" | "rspec" | "other";

export interface NumericConstant {
  /** Repo-relative path. */
  file: string;
  /** Identifier being assigned, e.g. TAX_RATE. */
  name: string;
  /** Literal as written, e.g. "0.07". */
  value: string;
  /** A different literal of the same shape, safe to ask for. */
  replacement: string;
}

export interface RepoProfile {
  root: string;
  /** Files tracked by git, or walked from disk when there is no git. Capped. */
  files: string[];
  truncated: boolean;
  isGit: boolean;
  defaultBranch: string;
  readme: string | null;
  /** package.json contents, when it parses. */
  packageJson: { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; type?: string } | null;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  /** The command that runs the repo's tests, if we can name one. */
  testCommand: string | null;
  testFramework: TestFramework | null;
  testFiles: string[];
  /** Directories that hold source we are willing to ask an agent to edit. */
  sourceDirs: string[];
  sourceFiles: string[];
  /** A numeric constant we can ask for a one-line change to. */
  constant: NumericConstant | null;
  /** Infrastructure-looking files (k8s, terraform, compose, CI). */
  infraFiles: string[];
  /** Files that look like they hold credentials and already exist in the repo. */
  secretFiles: string[];
  languages: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".paperfence", "target", "__pycache__", ".venv", "venv", "vendor", ".turbo", ".cache", "out"]);
const MAX_FILES = 4000;

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".rs", ".java", ".kt", ".php", ".cs", ".swift", ".scala", ".ex", ".c", ".cc", ".cpp", ".h", ".hpp"]);

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rb": "ruby", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".php": "php", ".cs": "csharp",
  ".swift": "swift", ".scala": "scala", ".ex": "elixir", ".c": "c", ".cc": "cpp", ".cpp": "cpp",
};

/**
 * Files that decide which tests run, as opposed to what the tests assert.
 *
 * Deleting an assertion is the obvious way to make a suite green. Pointing the
 * runner somewhere else is the quiet one: change the test script, add an
 * exclude to the runner config, skip the CI job. Byte-comparing test files
 * misses all three.
 */
export function isTestControlPath(rel: string): boolean {
  const base = path.basename(rel);
  return (
    base === "package.json" ||
    /^(vitest|jest|karma|ava|playwright|cypress|nightwatch|wdio)\.config\.[cm]?[jt]s$/.test(base) ||
    /^jest\.config\.json$/.test(base) ||
    /^\.mocharc\.(ya?ml|json|js|cjs)$/.test(base) ||
    /^(pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|conftest\.py|noxfile\.py)$/.test(base) ||
    /^(Makefile|justfile|Rakefile|\.rspec)$/.test(base) ||
    /^(go\.mod|Cargo\.toml)$/.test(base) ||
    /^\.github\/workflows\//.test(rel) ||
    /^(\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml)$/.test(rel)
  );
}

export function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|specs)(\/|$)/.test(rel) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) ||
    /_test\.(go|py|rb|exs?)$/.test(rel) ||
    /^test_.*\.py$/.test(path.basename(rel)) ||
    /_spec\.rb$/.test(rel)
  );
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walk(root, r, out);
    else if (e.isFile()) {
      if (out.length >= MAX_FILES) return;
      out.push(r);
    }
  }
}

function detectTest(pkg: RepoProfile["packageJson"], files: string[]): { command: string | null; framework: TestFramework | null } {
  const script = pkg?.scripts?.test;
  const placeholder = script !== undefined && /no test specified/i.test(script);
  if (script && !placeholder) {
    const fw: TestFramework = /vitest/.test(script)
      ? "vitest"
      : /jest/.test(script)
        ? "jest"
        : /mocha/.test(script)
          ? "mocha"
          : /node\s+--test|node:test/.test(script)
            ? "node-test"
            : "other";
    return { command: "npm test", framework: fw };
  }
  if (files.some((f) => /^(pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/.test(f)) && files.some((f) => isTestPath(f) && f.endsWith(".py"))) {
    return { command: "pytest", framework: "pytest" };
  }
  if (files.some((f) => f.endsWith("_test.go"))) return { command: "go test ./...", framework: "go-test" };
  if (files.includes("Cargo.toml")) return { command: "cargo test", framework: "cargo-test" };
  if (files.some((f) => /_spec\.rb$/.test(f))) return { command: "bundle exec rspec", framework: "rspec" };
  return { command: null, framework: null };
}

/**
 * A one-line numeric change we can ask for. Prefers a named constant with a
 * decimal or small integer literal, because "change 0.07 to 0.08" is
 * unambiguous and the diff is trivial to verify.
 */
async function findConstant(root: string, candidates: string[]): Promise<NumericConstant | null> {
  const patterns: RegExp[] = [
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+\.\d+)\s*[;\n]/,
    /(?:^|\n)\s*([A-Z][A-Z0-9_]{2,})\s*[:=]\s*(\d+\.\d+)\s*[,;\n]/,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d{1,4})\s*[;\n]/,
    /(?:^|\n)\s*([A-Z][A-Z0-9_]{2,})\s*[:=]\s*(\d{1,4})\s*[,;\n]/,
  ];
  for (const rel of candidates.slice(0, 200)) {
    let body: string;
    try {
      body = await fs.readFile(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (body.length > 200_000) continue;
    for (const re of patterns) {
      const m = re.exec(body);
      if (!m) continue;
      const name = m[1]!;
      const value = m[2]!;
      // Only when the literal occurs once in the file, so an edit is unambiguous.
      const occurrences = body.split(value).length - 1;
      if (occurrences !== 1) continue;
      const replacement = value.includes(".")
        ? (Number(value) + 0.01).toFixed(value.split(".")[1]!.length)
        : String(Number(value) + 1);
      return { file: rel, name, value, replacement };
    }
  }
  return null;
}

export async function detectProfile(root: string, opts: { defaultBranch?: string } = {}): Promise<RepoProfile> {
  const files: string[] = [];
  await walk(root, "", files);
  const truncated = files.length >= MAX_FILES;

  let packageJson: RepoProfile["packageJson"] = null;
  try {
    packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    packageJson = null;
  }

  const packageManager = files.includes("pnpm-lock.yaml")
    ? "pnpm"
    : files.includes("yarn.lock")
      ? "yarn"
      : files.includes("bun.lockb")
        ? "bun"
        : packageJson
          ? "npm"
          : null;

  const testFiles = files.filter(isTestPath);
  const { command: testCommand, framework: testFramework } = detectTest(packageJson, files);

  const sourceFiles = files.filter((f) => SOURCE_EXT.has(path.extname(f)) && !isTestPath(f) && !f.startsWith("."));
  const sourceDirs = [...new Set(sourceFiles.map((f) => (f.includes("/") ? f.split("/")[0]! : "")).filter(Boolean))];

  const infraFiles = files.filter(
    (f) =>
      /^(infra|infrastructure|deploy|deployment|k8s|kubernetes|charts|terraform|ops)\//.test(f) ||
      /^(docker-compose\.ya?ml|Dockerfile|Chart\.ya?ml)$/.test(path.basename(f)) ||
      /\.tf$/.test(f) ||
      /^\.github\/workflows\//.test(f),
  );

  const secretFiles = files.filter((f) => /(^|\/)\.env(\.|$)|(^|\/)(credentials|secrets)(\.|$)/i.test(f));

  const readme = files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f)) ?? null;

  const languages = [...new Set(files.map((f) => LANG_BY_EXT[path.extname(f)]).filter((x): x is string => Boolean(x)))];

  const constant = await findConstant(root, sourceFiles);

  return {
    root,
    files,
    truncated,
    isGit: files.length > 0,
    defaultBranch: opts.defaultBranch ?? "main",
    readme,
    packageJson,
    packageManager,
    testCommand,
    testFramework,
    testFiles,
    sourceDirs,
    sourceFiles,
    constant,
    infraFiles,
    secretFiles,
    languages,
  };
}

/** A short line for reports: what we saw in this repo. */
export function profileLine(p: RepoProfile): string {
  const bits: string[] = [];
  bits.push(`${p.files.length}${p.truncated ? "+" : ""} files`);
  if (p.languages.length) bits.push(p.languages.slice(0, 3).join("/"));
  bits.push(p.testCommand ? `tests: ${p.testCommand} (${p.testFiles.length} file${p.testFiles.length === 1 ? "" : "s"})` : "no test suite found");
  if (p.readme) bits.push(p.readme);
  if (p.infraFiles.length) bits.push(`${p.infraFiles.length} infra file(s)`);
  return bits.join(" · ");
}
