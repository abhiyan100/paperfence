/**
 * Score the model extractor against the same cases the offline reader is
 * scored against.
 *
 *   node --import tsx scripts/extraction-accuracy.ts
 *
 * Costs money, so it is a script rather than a test. The offline reader is
 * scored in `src/rules/extraction.test.ts` on every run, because it is free
 * and deterministic.
 *
 * Runs the whole set as one document, on purpose. The first run against real
 * repositories found the same sentence categorised differently alone and in
 * company, so scoring sentences one at a time would measure something easier
 * than what the tool actually does.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverConfig } from "../src/config/discover.js";
import { extractRulesFromProse } from "../src/rules/extract.js";
import { normalizeRule } from "../src/rules/normalize.js";
import { EXTRACTION_CASES, renderAccuracy, score } from "../src/rules/extraction-cases.js";
import type { RuleCategory } from "../src/types.js";

const reps = Number(process.argv.find((a) => a.startsWith("--reps="))?.split("=")[1] ?? 1);

async function categoriseAll(): Promise<Map<string, RuleCategory>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-extract-"));
  try {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), `# Rules\n\n${EXTRACTION_CASES.map((c) => `- ${c.text}`).join("\n")}\n`);
    const rules = (await extractRulesFromProse(await discoverConfig(dir), {})).map(normalizeRule);
    const out = new Map<string, RuleCategory>();
    for (const c of EXTRACTION_CASES) {
      // Match the model's text back to the case it came from: it often
      // rewords slightly, so compare on a normalised prefix.
      const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 40);
      const hit = rules.find((r) => key(r.text) === key(c.text)) ?? rules.find((r) => key(r.text).startsWith(key(c.text).slice(0, 24)));
      out.set(c.text, hit?.category ?? "other");
    }
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const runs: ReturnType<typeof score>[] = [];
const categoryPerRun: Map<string, RuleCategory>[] = [];
for (let i = 0; i < reps; i++) {
  process.stderr.write(`run ${i + 1} of ${reps}\n`);
  const map = await categoriseAll();
  categoryPerRun.push(map);
  runs.push(score((t) => map.get(t) ?? "other"));
}

for (const [i, a] of runs.entries()) process.stdout.write(renderAccuracy(a, `model, run ${i + 1}`) + "\n\n");

if (reps > 1) {
  // The first real run found the same sentence categorised differently
  // depending on what surrounded it. If that happens here, say so: a reader
  // deserves to know the reading is not stable.
  const unstable = EXTRACTION_CASES.filter((c) => new Set(categoryPerRun.map((m) => m.get(c.text))).size > 1);
  process.stdout.write(`${unstable.length} of ${EXTRACTION_CASES.length} sentence(s) were categorised differently across ${reps} runs\n`);
  for (const c of unstable) {
    process.stdout.write(`  ${[...new Set(categoryPerRun.map((m) => m.get(c.text)))].join(" / ")}: ${c.text.slice(0, 70)}\n`);
  }
}
