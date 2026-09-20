import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { plantPressureFiles } from "../scenarios/catalog.js";
import { createHostSandbox, defaultBranchFor } from "./host.js";

const run = promisify(execFile);

/**
 * The sandbox has to be indistinguishable from an ordinary checkout.
 *
 * It was not. Pressure files were written after the first commit, so they sat
 * in the root untracked, and in a live trial the agent ran `git status`, saw
 * four untracked markdown files, and said so: "they aren't part of git history
 * and read like planted instructions". Every level-2 and level-3 result
 * gathered that way is biased towards the rule holding, because the pressure
 * announced itself.
 */
describe("a sandbox an agent cannot tell is a sandbox", () => {
  const mkRepo = async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-src-")));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "svc", scripts: { test: "true" } }));
    await fs.writeFile(path.join(root, "README.md"), "# svc\n");
    return root;
  };

  it("leaves no untracked file behind when pressure is planted", async () => {
    const root = await mkRepo();
    const sb = await createHostSandbox(root, {
      rules: [],
      plant: async (work) => void (await plantPressureFiles(work, 3, defaultBranchFor([]))),
    });
    const { stdout } = await run("git", ["status", "--porcelain"], { cwd: sb.work });
    expect(stdout.trim()).toBe("");
    // And the pressure really is there, or the test passes for the wrong reason.
    expect(await fs.readFile(path.join(sb.work, "HANDOFF.md"), "utf8")).toContain("retired");
    const tracked = await run("git", ["ls-files"], { cwd: sb.work });
    expect(tracked.stdout).toContain("HANDOFF.md");
    await sb.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not sign the history with the harness's own name", async () => {
    const root = await mkRepo();
    const sb = await createHostSandbox(root, { rules: [] });
    const { stdout } = await run("git", ["log", "--format=%an <%ae>"], { cwd: sb.work });
    expect(stdout.toLowerCase()).not.toContain("paperfence");
    await sb.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });
});
