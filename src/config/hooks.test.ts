import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firePreToolUseHooks } from "./hooks.js";
import type { SettingsJson } from "./discover.js";

let dir: string;
const call = { tool: "Bash", input: { command: "rm -rf build" } };
const settingsWith = (command: string, timeout?: number): SettingsJson => ({
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, ...(timeout !== undefined ? { timeout } : {}) }] }] },
});

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-hooks-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("firePreToolUseHooks", () => {
  it("exit 2 blocks", async () => {
    const r = await firePreToolUseHooks(settingsWith("echo nope >&2; exit 2"), call, dir);
    expect(r[0]!.blocked).toBe(true);
    expect(r[0]!.reason).toBe("nope");
  });
  it("exit 0 with a well-formed deny blocks", async () => {
    const json = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}';
    const r = await firePreToolUseHooks(settingsWith(`echo '${json}'`), call, dir);
    expect(r[0]!.blocked).toBe(true);
  });
  it("a deny without hookEventName does not block", async () => {
    const json = '{"hookSpecificOutput":{"permissionDecision":"deny"}}';
    const r = await firePreToolUseHooks(settingsWith(`echo '${json}'`), call, dir);
    expect(r[0]!.blocked).toBe(false);
    expect(r[0]!.reason).toMatch(/ignores/);
  });
  it("continue:false blocks", async () => {
    const r = await firePreToolUseHooks(settingsWith(`echo '{"continue":false,"stopReason":"halt"}'`), call, dir);
    expect(r[0]!.blocked).toBe(true);
  });
  it("exit 1 without JSON does not block", async () => {
    const r = await firePreToolUseHooks(settingsWith("exit 1"), call, dir);
    expect(r[0]!.blocked).toBe(false);
    expect(r[0]!.exitCode).toBe(1);
  });
  it("exit 1 with a well-formed deny still blocks", async () => {
    const json = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}';
    const r = await firePreToolUseHooks(settingsWith(`echo '${json}'; exit 1`), call, dir);
    expect(r[0]!.blocked).toBe(true);
  });
  it("a hook that exceeds its own timeout does not block", async () => {
    const r = await firePreToolUseHooks(settingsWith("sleep 1; exit 2", 0.2), call, dir);
    expect(r[0]!.blocked).toBe(false);
    expect(r[0]!.timedOut).toBe(true);
  });
  it("matchers filter by tool", async () => {
    const s: SettingsJson = { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "exit 2" }] }] } };
    expect(await firePreToolUseHooks(s, call, dir)).toHaveLength(0);
    expect(await firePreToolUseHooks(s, { tool: "Write", input: {} }, dir)).toHaveLength(1);
  });
  it("hooks do not see the caller's environment", async () => {
    process.env.PAPERFENCE_TEST_SECRET = "leak";
    const r = await firePreToolUseHooks(settingsWith('test -z "$PAPERFENCE_TEST_SECRET" && exit 2; exit 0'), call, dir);
    delete process.env.PAPERFENCE_TEST_SECRET;
    expect(r[0]!.blocked).toBe(true); // exit 2 only when the variable is absent
  });
});
