import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTERS, adapterFor, claudeCode, codex, detectRuntimes, runtimeCoverage, supportLine } from "./index.js";

const dirs: string[] = [];
async function tmpRepo(files: Record<string, string>): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-rt-")));
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

describe("adapters", () => {
  it("every adapter declares what it can and cannot do", () => {
    for (const a of ADAPTERS) {
      expect(a.id, a.label).toBeTruthy();
      expect(a.markers.length, a.label).toBeGreaterThan(0);
      expect(a.notes.length, a.label).toBeGreaterThan(40);
    }
  });

  it("refuses an unknown runtime by name", () => {
    expect(() => adapterFor("cursor")).toThrow(/no adapter for runtime "cursor"/);
  });

  it("says out loud what it cannot do", () => {
    expect(supportLine(codex)).toContain("cannot");
    expect(supportLine(claudeCode)).not.toContain("cannot");
  });
});

describe("claude-code adapter", () => {
  it("evaluates a deny rule against a real call", async () => {
    const root = await tmpRepo({ ".claude/settings.json": JSON.stringify({ permissions: { deny: ["Bash(git push:*)"] } }) });
    const cfg = await claudeCode.discover(root);
    const d = claudeCode.evaluate(cfg, { tool: "Bash", input: { command: "git push origin main" }, describe: "push" });
    expect(d.decision).toBe("deny");
  });

  it("separates ask from deny, because ask enforces nothing unattended", async () => {
    const root = await tmpRepo({ ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(npm publish:*)"] } }) });
    const cfg = await claudeCode.discover(root);
    expect(claudeCode.evaluate(cfg, { tool: "Bash", input: { command: "npm publish" }, describe: "publish" }).decision).toBe("ask");
  });

  it("names the config it did not look at", async () => {
    const cfg = await claudeCode.discover(await tmpRepo({ "CLAUDE.md": "# rules" }));
    expect(cfg.outOfScope.join(" ")).toMatch(/personal settings/);
    expect(cfg.outOfScope.join(" ")).toMatch(/branch protection/);
  });

  it("reports config surfaces the runtime accepts and never consults", async () => {
    const root = await tmpRepo({ ".claude/settings.json": JSON.stringify({ permissions: { deny: ["Write(./secrets/**)"] } }) });
    const inert = claudeCode.inert(await claudeCode.discover(root));
    expect(inert.length).toBeGreaterThan(0);
  });
});

describe("codex adapter", () => {
  it("reads config.toml and AGENTS.md", async () => {
    const root = await tmpRepo({
      "AGENTS.md": "# rules\nNever push to main.",
      ".codex/config.toml": 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n',
    });
    const cfg = await codex.discover(root);
    expect(cfg.proseFiles.map((f) => f.file)).toEqual(["AGENTS.md"]);
    expect((cfg.settingsFiles[0]!.json as { sandbox_mode?: string }).sandbox_mode).toBe("workspace-write");
  });

  it("records an unparseable config as present and empty rather than skipping it", async () => {
    const cfg = await codex.discover(await tmpRepo({ ".codex/config.toml": "this is not = = toml" }));
    expect(cfg.settingsFiles).toHaveLength(1);
    expect(cfg.settingsFiles[0]!.json).toEqual({});
  });

  it("returns unknown, not allow, when the repository sets no sandbox mode", async () => {
    const cfg = await codex.discover(await tmpRepo({ "AGENTS.md": "x" }));
    const d = codex.evaluate(cfg, { tool: "Bash", input: { command: "git push origin main" }, describe: "push" });
    expect(d.decision).toBe("unknown");
    expect(d.reason).toContain("not the same as allowed");
  });

  /**
   * Measured with `paperfence conformance --runtime codex`. Codex confines
   * rather than refusing, so these answers are about whether the operation
   * would succeed, not about whether a rule matches.
   */
  it("says a write under read-only does not happen", async () => {
    const cfg = await codex.discover(await tmpRepo({ ".codex/config.toml": 'sandbox_mode = "read-only"\n' }));
    for (const call of [
      { tool: "Write" as const, input: { file_path: "a.txt", content: "x" }, describe: "Write" },
      { tool: "Bash" as const, input: { command: "echo ok > a.txt" }, describe: "redirect" },
      { tool: "Bash" as const, input: { command: "rm notes.txt" }, describe: "rm" },
    ]) {
      expect(codex.evaluate(cfg, call).decision, call.describe).toBe("deny");
    }
  });

  it("says a read under read-only is not confined", async () => {
    const cfg = await codex.discover(await tmpRepo({ ".codex/config.toml": 'sandbox_mode = "read-only"\n' }));
    expect(codex.evaluate(cfg, { tool: "Read", input: { file_path: "a.txt" }, describe: "read" }).decision).toBe("allow");
  });

  it("says a write under workspace-write depends on the path, which is not a rule", async () => {
    const cfg = await codex.discover(await tmpRepo({ ".codex/config.toml": 'sandbox_mode = "workspace-write"\n' }));
    const d = codex.evaluate(cfg, { tool: "Write", input: { file_path: "a.txt", content: "x" }, describe: "write" });
    expect(d.decision).toBe("unknown");
    expect(d.reason).toContain("whole repository");
  });

  it("says nothing is confined under danger-full-access", async () => {
    const cfg = await codex.discover(await tmpRepo({ ".codex/config.toml": 'sandbox_mode = "danger-full-access"\n' }));
    expect(codex.evaluate(cfg, { tool: "Write", input: { file_path: "a.txt", content: "x" }, describe: "write" }).decision).toBe("allow");
  });

  it("does not guess at a sandbox mode it has never measured", async () => {
    const cfg = await codex.discover(await tmpRepo({ ".codex/config.toml": 'sandbox_mode = "something-new"\n' }));
    expect(codex.evaluate(cfg, { tool: "Write", input: { file_path: "a.txt", content: "x" }, describe: "write" }).decision).toBe("unknown");
  });

  it("flags an approval policy as unenforceable in an unattended run", async () => {
    const cfg = await codex.discover(await tmpRepo({ ".codex/config.toml": 'approval_policy = "on-request"\n' }));
    const inert = codex.inert(cfg);
    expect(inert[0]!.why).toContain("unattended");
  });

  it("flags a hook that returns ask, which Codex parses and ignores", async () => {
    const hooks = JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }], note: { permissionDecision: "ask" } });
    const cfg = await codex.discover(await tmpRepo({ ".codex/hooks.json": hooks }));
    expect(codex.inert(cfg).some((i) => i.why.includes("no ask in its hook model"))).toBe(true);
  });

  it("flags a disabled sandbox", async () => {
    const cfg = await codex.discover(await tmpRepo({ ".codex/config.toml": 'sandbox_mode = "danger-full-access"\n' }));
    expect(codex.inert(cfg).some((i) => i.raw.includes("danger-full-access"))).toBe(true);
  });

  it("names the hook trust store as out of scope, because a hook file is not a hook that runs", async () => {
    const cfg = await codex.discover(await tmpRepo({ "AGENTS.md": "x" }));
    expect(cfg.outOfScope.join(" ")).toContain("trust store");
  });
});

describe("detectRuntimes", () => {
  it("finds a Claude Code repository", async () => {
    const found = await detectRuntimes(await tmpRepo({ "CLAUDE.md": "x", ".claude/settings.json": "{}" }));
    expect(found.map((f) => f.adapter.id)).toEqual(["claude-code"]);
  });

  it("finds a Codex repository and says what it covers", async () => {
    const found = await detectRuntimes(await tmpRepo({ "AGENTS.md": "x", ".codex/config.toml": "" }));
    expect(found.map((f) => f.adapter.id)).toEqual(["codex"]);
    // Sandbox questions are measured, so Codex is covered; hooks are not, and
    // the note has to keep saying so.
    expect(runtimeCoverage(found)[0]).toContain("fully supported");
    expect(runtimeCoverage(found)[0]).toContain("hooks are not covered");
  });

  it("finds both when a repository is configured for both", async () => {
    const found = await detectRuntimes(await tmpRepo({ "CLAUDE.md": "x", "AGENTS.md": "y" }));
    expect(found.map((f) => f.adapter.id).sort()).toEqual(["claude-code", "codex"]);
  });

  it("says so when nothing is configured", async () => {
    expect(runtimeCoverage(await detectRuntimes(await tmpRepo({ "README.md": "x" })))[0]).toContain("No agent configuration");
  });
});

/**
 * A repository configured for Codex must not be judged by Claude Code's rules.
 * The absence of a deny entry says nothing about a runtime that has no deny
 * entries, and reporting it as an open door would be the same overclaim the
 * rest of this tool exists to prevent.
 */
describe("a scan uses the runtime the repository is configured for", () => {
  it("evaluates a Codex repository with Codex's semantics", async () => {
    const root = await tmpRepo({
      "AGENTS.md": "# Rules\n\nNever delete files with rm -rf.\nNever read .env.\n",
      ".codex/config.toml": 'sandbox_mode = "read-only"\n',
      ".env": "A=1\n",
      "src/a.js": "x\n",
    });
    const { scan } = await import("../scan.js");
    const report = await scan(root, { offline: true, noHooks: true });
    const evidence = report.verdicts.map((v) => v.summary).join(" ");
    expect(evidence).toContain("Codex:");
    expect(evidence).toContain("read-only");
  });

  it("reports that read-only does not protect a secret from being read", async () => {
    const root = await tmpRepo({
      "AGENTS.md": "# Rules\n\nNever read .env.\n",
      ".codex/config.toml": 'sandbox_mode = "read-only"\n',
      ".env": "A=1\n",
    });
    const { scan } = await import("../scan.js");
    const report = await scan(root, { offline: true, noHooks: true });
    const secrets = report.verdicts.find((v) => v.rule.category === "protect-secrets");
    expect(secrets?.grade).toBe("WISH");
    expect(secrets?.summary).toContain("reads are not confined");
  });

  it("still uses Claude Code's semantics for a Claude Code repository", async () => {
    const root = await tmpRepo({
      "CLAUDE.md": "# Rules\n\nNever read .env.\n",
      ".claude/settings.json": JSON.stringify({ permissions: { deny: ["Read(.env)"] } }),
      ".env": "A=1\n",
    });
    const { scan } = await import("../scan.js");
    const report = await scan(root, { offline: true, noHooks: true });
    expect(report.verdicts.map((v) => v.summary).join(" ")).not.toContain("Codex:");
  });
});
