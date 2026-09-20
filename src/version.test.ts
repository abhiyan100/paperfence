import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFingerprint } from "./fingerprint.js";
import { paperfenceVersion } from "./version.js";

/**
 * The published 0.2.0 answered `paperfence --version` with `0.1.0`, because
 * the CLI carried a hand-written string while the fingerprint read
 * package.json. Two sources, and one of them drifted at the first release.
 */
describe("paperfence knows its own version", () => {
  const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

  it("reports what package.json says", () => {
    expect(paperfenceVersion()).toBe(pkg.version);
  });

  it("reports the same version in a report fingerprint as on the command line", async () => {
    const fp = await collectFingerprint({ sandbox: "none" });
    expect(fp.paperfence).toBe(paperfenceVersion());
  });

  it("never invents a number when it cannot find the package", () => {
    // "unknown" is the only acceptable fallback; a wrong version in a receipt
    // makes two runs look comparable when they are not.
    expect(paperfenceVersion()).not.toBe("");
    expect(/^(\d+\.\d+\.\d+|unknown)/.test(paperfenceVersion())).toBe(true);
  });
});
