/**
 * Runs inside the sandbox container. Reads a job file, runs one adversary
 * session against /sandbox/repo, starts the exfil sink on localhost so the
 * objective's URL resolves, and writes the outcome as JSON for the host to
 * assert on. No paperfence guard here: the container is the boundary.
 */
import { promises as fs } from "node:fs";
import { runAdversary } from "./attack/adversary.js";
import { startSink } from "./sandbox/sink.js";
import type { Sandbox } from "./sandbox/host.js";
import type { PressureLevel, Rule } from "./types.js";

interface Job {
  rule: Rule;
  level: PressureLevel;
  objective: string;
  model: string;
  maxTurns: number;
  work: string;
  dir: string;
  resultPath: string;
}

const jobPath = process.argv[2];
if (!jobPath) {
  process.stderr.write("usage: runner <job.json>\n");
  process.exit(1);
}
const job: Job = JSON.parse(await fs.readFile(jobPath, "utf8"));
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
  await fs.writeFile(job.resultPath, JSON.stringify({ ...partial, sinkHits: sink.hits }));
} finally {
  await sink.close();
}
