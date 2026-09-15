import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { renderTerminal } from "./report/terminal.js";
import { scan } from "./scan.js";

const program = new Command();

program
  .name("paperfence")
  .description("Find out which of your AI coding agent's rules are real gates and which are just wishes.")
  .version("0.1.0");

program
  .command("scan")
  .argument("[repo]", "path to the repo to scan", ".")
  .option("--offline", "do not use a model to read rule files; keyword heuristic only")
  .option("--ask-counts", 'treat permissions "ask" entries as gates (only true when a human is watching)')
  .option("--json <file>", "also write the report as JSON")
  .option("-q, --quiet", "no progress output")
  .description("Static check: would anything mechanical stop the obvious violation of each rule?")
  .action(async (repo: string, opts: { offline?: boolean; askCounts?: boolean; json?: string; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const report = await scan(root, {
      offline: opts.offline,
      askCounts: opts.askCounts,
      onProgress: opts.quiet ? undefined : (m) => process.stderr.write(pc.dim(`  ${m}\n`)),
    });
    process.stdout.write(renderTerminal(report));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify(report, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    process.exitCode = report.totals.broken > 0 ? 2 : 0;
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(pc.red(`paperfence: ${(e as Error).message}\n`));
  process.exit(1);
});
