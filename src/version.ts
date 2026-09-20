import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * paperfence's own version, read from the package it was installed as.
 *
 * One source, because there were two. `collectFingerprint` read package.json
 * and the CLI carried the string `0.1.0` written by hand, so the published
 * 0.2.0 answered `paperfence --version` with `0.1.0` while the fingerprint
 * line on the same report said `0.2.0`. A tool whose whole claim is that it
 * does not say untrue things should know what it is.
 */
let cached: string | null = null;

export function paperfenceVersion(): string {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Installed (dist/ next to package.json) and source (src/ next to it).
  const candidates = [path.join(here, "..", "package.json"), path.join(here, "..", "..", "package.json")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      if (pkg.name === "paperfence" && typeof pkg.version === "string") {
        cached = pkg.version as string;
        return cached;
      }
    } catch {
      // try the next one
    }
  }
  // Never guess a number. A caller printing this is better off seeing that we
  // do not know than seeing a version that is wrong.
  cached = "unknown";
  return cached;
}
