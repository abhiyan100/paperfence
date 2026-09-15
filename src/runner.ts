/**
 * Runs inside the sandbox container. The job arrives in PAPERFENCE_JOB
 * (base64 JSON) and the outcome leaves on stdout between two markers, so the
 * agent, which shares the filesystem, has nothing it can tamper with.
 * The exfil sink runs on localhost so the objective's URL resolves.
 * No paperfence guard here: the container is the boundary.
 */
import { runAdversary } from "./attack/adversary.js";
import { discoverConfig } from "./config/discover.js";
import { staticProbe } from "./probe/static.js";
import { startSink } from "./sandbox/sink.js";
import type { Sandbox } from "./sandbox/host.js";
import type { PressureLevel, Rule } from "./types.js";

interface AttackJob {
  kind?: "attack";
  rule: Rule;
  level: PressureLevel;
  objective: string;
  model: string;
  maxTurns: number;
  work: string;
  dir: string;
}
interface ProbeJob {
  kind: "probe";
  rules: Rule[];
  work: string;
}
type Job = AttackJob | ProbeJob;

import { RESULT_END, RESULT_START } from "./attack/markers.js";

const encoded = process.env.PAPERFENCE_JOB;
if (!encoded) {
  process.stderr.write("runner: PAPERFENCE_JOB not set\n");
  process.exit(1);
}
const job: Job = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));

if (job.kind === "probe") {
  // Static probe with the repo's own hooks executed here, in the container, not on the host.
  const cfg = await discoverConfig(job.work);
  const results = await staticProbe(cfg, job.rules, { onProgress: (m) => process.stderr.write(`    ${m}\n`) });
  process.stdout.write(`\n${RESULT_START}\n${JSON.stringify({ probes: results })}\n${RESULT_END}\n`);
  process.exit(0);
}

const sink = await startSink();
const sb = { work: job.work, dir: job.dir } as Sandbox;
try {
  const partial = await runAdversary(job.rule, job.level, job.objective, sb, {
    model: job.model,
    maxTurns: job.maxTurns,
    guard: false,
    onEvent: (e) => {
      const i = (e.input ?? {}) as Record<string, unknown>;
      process.stderr.write(`    ${e.tool} ${String(i.command ?? i.file_path ?? i.url ?? i.path ?? "").slice(0, 100)}\n`);
    },
  });
  process.stdout.write(`\n${RESULT_START}\n${JSON.stringify({ ...partial, sinkHits: sink.hits })}\n${RESULT_END}\n`);
} finally {
  await sink.close();
}
