/**
 * Refuse to publish a package that would not work, or that ships something it
 * should not.
 *
 * Runs from prepublishOnly, after the build. Three questions:
 *   does the binary exist and run,
 *   does the tarball contain the files the binary needs,
 *   does it contain anything that should never leave this machine.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const problems = [];

// 1. The entry point the bin field promises.
const bin = pkg.bin?.paperfence;
if (!bin || !existsSync(bin)) problems.push(`bin points at ${bin}, which does not exist. Run the build.`);

// 2. The guard template is loaded from disk at runtime, so it has to ship.
if (!existsSync("templates/paperfence-guard.cjs")) problems.push("templates/paperfence-guard.cjs is missing; harden would fail for every user.");
if (!(pkg.files ?? []).includes("templates")) problems.push('"templates" is not in package.json files, so the guard would not ship.');

// 3. What the tarball actually contains.
let listed = [];
try {
  listed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))[0].files.map((f) => f.path);
} catch (e) {
  problems.push(`could not inspect the tarball: ${e.message.split("\n")[0]}`);
}

const mustNotShip = [
  [/(^|\/)\.env/, "an environment file"],
  [/(^|\/)\.paperfence\//, "receipts from a local run"],
  [/(^|\/)\.vercel\//, "Vercel project linkage"],
  [/(^|\/)data\//, "the leaderboard and benchmark data, which is large and not needed to run"],
  [/(^|\/)bench\//, "the benchmark corpus, which is not needed to run"],
  [/(^|\/)site\//, "the generated site and the control plane source"],
  [/(^|\/)fixtures\//, "test fixtures"],
  [/\.test\.(ts|js)$/, "test files"],
  [/(^|\/)reviews\//, "review notes"],
];
for (const f of listed) {
  for (const [re, why] of mustNotShip) {
    if (re.test(f)) problems.push(`${f} would ship, and it is ${why}.`);
  }
}

// 4. The binary has to actually start.
if (bin && existsSync(bin)) {
  try {
    const out = execFileSync("node", [bin, "--version"], { encoding: "utf8", timeout: 30_000 }).trim();
    if (!out) problems.push("the binary produced no output for --version.");
  } catch (e) {
    problems.push(`the binary did not run: ${e.message.split("\n")[0]}`);
  }
}

if (problems.length) {
  process.stderr.write(`\nnot publishing:\n${problems.map((p) => `  - ${p}`).join("\n")}\n\n`);
  process.exit(1);
}
process.stderr.write(`package looks publishable: ${listed.length} files, bin runs, guard template present\n`);
