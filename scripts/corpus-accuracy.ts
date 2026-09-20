#!/usr/bin/env node
/**
 * Score extraction against whole documents, not sentences.
 *
 *   npx tsx scripts/corpus-accuracy.ts            both readers
 *   npx tsx scripts/corpus-accuracy.ts --offline  only the keyword reader
 *   npx tsx scripts/corpus-accuracy.ts --model    only the model
 *   npx tsx scripts/corpus-accuracy.ts --detail   list every miss
 *   npx tsx scripts/corpus-accuracy.ts --repeat 3 run each reader N times and report the spread
 *
 * The two readers are reported separately and never averaged. They fail in
 * opposite directions and a combined number would hide both.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, renderCorpus, scoreDoc, type DocScore } from "../src/rules/corpus.js";
import { extractRulesFromProse } from "../src/rules/extract.js";
import type { AgentConfig } from "../src/config/discover.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const detail = argv.includes("--detail");
const only = argv.includes("--offline") ? ["offline"] : argv.includes("--model") ? ["model"] : ["offline", "model"];
const repeat = Math.max(1, Number(argv[argv.indexOf("--repeat") + 1]) || 1);

const corpus = await loadCorpus(root);
console.log(`corpus: ${corpus.length} documents, ${corpus.reduce((a, d) => a + d.expected.policies.length, 0)} annotated policies, ${corpus.reduce((a, d) => a + d.expected.traps.length, 0)} annotated traps\n`);
for (const d of corpus) {
  const mech = d.expected.policies.filter((p) => p.testable === "mechanical").length;
  console.log(`  ${d.slug.padEnd(16)} ${d.repo}@${d.commit.slice(0, 7)} ${String(d.expected.policies.length).padStart(3)} policies (${mech} mechanical)`);
}
console.log();

for (const reader of only) {
  const runs: DocScore[][] = [];
  for (let i = 0; i < repeat; i++) {
    const scores: DocScore[] = [];
    for (const d of corpus) {
      const cfg = { root, proseFiles: [{ file: d.path, content: d.body }], settingsFiles: [], hooks: [] } as unknown as AgentConfig;
      const rules = await extractRulesFromProse(cfg, { offline: reader === "offline" });
      scores.push(scoreDoc(d, rules));
    }
    runs.push(scores);
  }
  const scores = runs[0]!;
  console.log(renderCorpus(scores, reader === "offline" ? "offline keyword reader" : "model reader"));
  if (repeat > 1) {
    // Reported, not averaged. A reader whose answer moves between runs is a
    // different fact about the tool than a reader with a low score.
    const sum = (rs: DocScore[], f: (s: DocScore) => number) => rs.reduce((a, s) => a + f(s), 0);
    const spread = (name: string, f: (s: DocScore) => number) => {
      const v = runs.map((r) => sum(r, f));
      const same = v.every((x) => x === v[0]);
      console.log(`  ${name.padEnd(28)} ${v.join(", ")}${same ? "  (same every run)" : "  (moves between runs)"}`);
    };
    console.log(`\n  across ${repeat} runs:`);
    spread("rules extracted", (s) => s.extracted);
    spread("mechanical found", (s) => s.foundMechanical);
    spread("guidance made mechanical", (s) => s.guidanceMadeMechanical.length);
    spread("targets exact", (s) => s.targetsExact);
  }
  console.log();
  if (detail) {
    for (const s of scores) {
      const lines: string[] = [];
      for (const m of s.missed) lines.push(`    missed (${m.want}): ${m.quote}`);
      for (const m of s.testableCalledUntestable) lines.push(`    called untestable (${m.want}): ${m.quote}`);
      for (const m of s.guidanceMadeMechanical) lines.push(`    guidance -> ${m.got}: ${m.quote}`);
      for (const f of s.falsePolicies.slice(0, 8)) lines.push(`    no such policy (${f.category})${f.trap ? " [known trap]" : ""}: ${f.text}`);
      if (lines.length) console.log(`  ${s.slug}\n${lines.join("\n")}`);
    }
    console.log();
  }
}
