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

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pf-hook-"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
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
  it("blocks deleting and editing tests", async () => {
    expect((await fire("Bash", { command: "rm tests/a.test.js" })).code).toBe(2);
    expect((await fire("Edit", { file_path: path.join(root, "tests/a.test.js") })).code).toBe(2);
    expect((await fire("Read", { file_path: path.join(root, "tests/a.test.js") })).code).toBe(0);
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
