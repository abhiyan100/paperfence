import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyRun, copyDependencyTree } from "./capability.js";

/**
 * The invariant these guard: a PASS requires a task environment in which the
 * intended legitimate operation was actually possible.
 *
 * Both halves have already been wrong. The probe called a missing runner a
 * working environment because the pattern list named vitest and jest and the
 * repository used mocha, and the copy produced a dependency tree whose every
 * launcher dangled. Either one turns "the agent could not do the forbidden
 * thing" into a pass it did not earn.
 */

describe("classifying an attempt at the test command", () => {
  it("calls a passing suite a working environment", () => {
    const e = classifyRun("npm test", 0, "12 passed");
    expect(e.canRunTests).toBe(true);
    expect(e.reason).toBe("ok");
  });

  it("calls a failing suite a working environment, because that is what the attack creates", () => {
    const e = classifyRun("npm test", 1, "1 failed, 11 passed\nAssertionError: expected 4 to be 5");
    expect(e.canRunTests).toBe(true);
    expect(e.reason).toBe("ok");
  });

  it("refuses exit 127 whatever the runner is called", () => {
    // Named runners were the old bug: `sh: 1: mocha: not found` scored as a
    // working environment because the list only knew vitest and jest.
    for (const out of ["sh: 1: mocha: not found", "sh: 1: ava: not found", "sh: 1: some-runner-nobody-has: not found", ""]) {
      const e = classifyRun("npm test", 127, out);
      expect(e.canRunTests, out).toBe(false);
      expect(e.reason, out).toBe("missing-runner");
    }
  });

  it("refuses exit 126, which is found but not executable", () => {
    expect(classifyRun("./run-tests.sh", 126, "sh: 1: ./run-tests.sh: Permission denied").reason).toBe("missing-runner");
  });

  it("separates a tree built for another machine from a tree that is not there", () => {
    const e = classifyRun("npm test", 1, "Error: Cannot find module @rollup/rollup-linux-arm64-gnu. npm has a bug related to optional dependencies", ["node_modules"]);
    expect(e.canRunTests).toBe(false);
    expect(e.reason).toBe("platform-mismatch");
    // The distinction is the whole point: telling someone their framework is
    // missing when it is installed sends them to reinstall what they have.
    expect(e.detail).toMatch(/installed on .+ and the sandbox is linux/);
  });

  it.each([
    ["invalid ELF header", "Error: /sandbox/repo/node_modules/x/x.node: invalid ELF header"],
    ["a darwin build under linux", "Cannot find module 'better-sqlite3-darwin-arm64'"],
    ["a node ABI mismatch", "Error: The module was compiled against a different Node.js version"],
  ])("reads %s as a platform mismatch", (_label, out) => {
    expect(classifyRun("npm test", 1, out, ["node_modules"]).reason).toBe("platform-mismatch");
  });

  it("reports a missing python module as a missing runner", () => {
    expect(classifyRun("pytest", 1, "ModuleNotFoundError: No module named 'pytest'").reason).toBe("missing-runner");
  });

  it("reports a timeout as its own thing, not as a working environment", () => {
    const e = classifyRun("npm test", null, "");
    expect(e.canRunTests).toBe(false);
    expect(e.reason).toBe("did-not-finish");
  });

  it("says what was copied, so the message is actionable either way", () => {
    expect(classifyRun("npm test", 127, "not found").detail).toMatch(/no network to install it/);
    expect(classifyRun("npm test", 127, "not found", ["node_modules"]).detail).toMatch(/even after copying node_modules/);
  });
});

describe("copying a dependency tree somewhere else", () => {
  it("rewrites an absolute in-tree link so it resolves at the destination", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-dep-")));
    const src = path.join(root, "node_modules");
    await fs.mkdir(path.join(src, ".bin"), { recursive: true });
    await fs.mkdir(path.join(src, "vitest"), { recursive: true });
    await fs.writeFile(path.join(src, "vitest", "vitest.mjs"), "#!/usr/bin/env node\n");
    // This is what npm writes: an absolute path into the checkout it installed in.
    await fs.symlink(path.join(src, "vitest", "vitest.mjs"), path.join(src, ".bin", "vitest"));
    // And one pointing outside the tree, which is what a pnpm store looks like.
    const outside = path.join(root, "..", `pf-store-${process.pid}.mjs`);
    await fs.writeFile(outside, "x");
    await fs.symlink(outside, path.join(src, ".bin", "stored"));

    const dest = path.join(root, "moved", "node_modules");
    const r = await copyDependencyTree(src, dest, root);

    const link = path.join(dest, ".bin", "vitest");
    expect(path.isAbsolute(await fs.readlink(link))).toBe(false);
    // The real check is not the shape of the link but whether it resolves.
    await expect(fs.readFile(link, "utf8")).resolves.toContain("env node");
    expect(r.links).toBe(1);
    // An unusable link is left out rather than copied dangling.
    expect(r.skipped).toBe(1);
    await expect(fs.lstat(path.join(dest, ".bin", "stored"))).rejects.toThrow();

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  });

  it("keeps a link that was already relative working", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-dep-")));
    const src = path.join(root, "node_modules");
    await fs.mkdir(path.join(src, ".bin"), { recursive: true });
    await fs.mkdir(path.join(src, "mocha", "bin"), { recursive: true });
    await fs.writeFile(path.join(src, "mocha", "bin", "mocha.js"), "run\n");
    await fs.symlink("../mocha/bin/mocha.js", path.join(src, ".bin", "mocha"));

    const dest = path.join(root, "moved", "node_modules");
    await copyDependencyTree(src, dest, root);
    await expect(fs.readFile(path.join(dest, ".bin", "mocha"), "utf8")).resolves.toBe("run\n");
    await fs.rm(root, { recursive: true, force: true });
  });
});
