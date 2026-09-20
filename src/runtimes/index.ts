import { promises as fs } from "node:fs";
import path from "node:path";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import type { RuntimeAdapter, RuntimeId } from "./types.js";

export { claudeCode } from "./claude-code.js";
export { codex } from "./codex.js";
export * from "./types.js";

export const ADAPTERS: RuntimeAdapter[] = [claudeCode, codex];

export function adapterFor(id: RuntimeId): RuntimeAdapter {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(`no adapter for runtime "${id}"; known: ${ADAPTERS.map((x) => x.id).join(", ")}`);
  return a;
}

/**
 * Which runtimes this repository is configured for.
 *
 * A repository with AGENTS.md and no .claude directory is a Codex repository,
 * and scanning it as if it were a Claude Code repository would report an
 * absence of Claude Code controls as an absence of controls.
 */
export async function detectRuntimes(root: string): Promise<{ adapter: RuntimeAdapter; markers: string[] }[]> {
  const out: { adapter: RuntimeAdapter; markers: string[] }[] = [];
  for (const adapter of ADAPTERS) {
    const found: string[] = [];
    for (const m of adapter.markers) {
      if (await fs.stat(path.join(root, m)).then(() => true).catch(() => false)) found.push(m);
    }
    if (found.length) out.push({ adapter, markers: found });
  }
  return out;
}

/** One line per runtime the repository is configured for, and what we could do about it. */
export function runtimeCoverage(found: { adapter: RuntimeAdapter; markers: string[] }[]): string[] {
  if (!found.length) return ["No agent configuration found for any runtime paperfence knows about."];
  return found.map(({ adapter, markers }) => {
    const covered = adapter.support.evaluate && adapter.support.drive;
    const verb = covered ? "fully supported" : adapter.support.discover ? "read only" : "not supported";
    return `${adapter.label} (${markers.join(", ")}): ${verb}. ${adapter.notes}`;
  });
}
