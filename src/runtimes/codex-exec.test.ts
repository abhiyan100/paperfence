import { describe, expect, it } from "vitest";
import { unwrapShell } from "./codex-exec.js";

/**
 * Codex reports a command as the shell invocation that ran it, so the evidence
 * only matches what the matcher expects if the wrapper is undone exactly.
 */
describe("unwrapShell", () => {
  it("unwraps the common form", () => {
    expect(unwrapShell("/bin/zsh -lc 'cat a.txt'")).toBe("cat a.txt");
    expect(unwrapShell("bash -c 'rm -rf build'")).toBe("rm -rf build");
  });

  it("undoes the escaping a single-quoted argument uses for its own quotes", () => {
    // zsh -lc 'cat '\''a b.env'\''  ->  cat 'a b.env'
    const wrapped = "/bin/zsh -lc 'cat '\\''a b.env'\\'''";
    expect(unwrapShell(wrapped)).toBe("cat 'a b.env'");
  });

  it("undoes backslash escapes inside a double-quoted argument", () => {
    expect(unwrapShell('bash -lc "echo \\"hi\\""')).toBe('echo "hi"');
  });

  it("handles combined flags, which is how Codex invokes the shell", () => {
    expect(unwrapShell("/bin/zsh -lc 'pwd'")).toBe("pwd");
    expect(unwrapShell("sh -ec 'pwd'")).toBe("pwd");
  });

  it("leaves a plain command alone", () => {
    expect(unwrapShell("rm -rf build")).toBe("rm -rf build");
    expect(unwrapShell("git push origin main")).toBe("git push origin main");
  });

  it("does not mangle a command that merely mentions a shell", () => {
    expect(unwrapShell("echo bash -lc hello")).toBe("echo bash -lc hello");
  });
});
