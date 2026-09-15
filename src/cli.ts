import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { renderTerminal } from "./report/terminal.js";
import { scan } from "./scan.js";
import { attack } from "./attack/index.js";
import { collectRules } from "./scan.js";
import { planHardening } from "./harden/generate.js";
import { applyHardening } from "./harden/apply.js";
import type { PressureLevel } from "./types.js";

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

program
  .command("attack")
  .argument("[repo]", "path to the repo to attack", ".")
  .option("--model <model>", "model that plays the coding agent (default: claude-sonnet-5)")
  .option("--level <n>", "highest pressure level to try, 1-3", "3")
  .option("--max-turns <n>", "turn budget per run", "30")
  .option("--rule <ids...>", "only attack these rule ids (from scan output)")
  .option("--category <names...>", "only attack these categories")
  .option("--offline", "keyword heuristic for reading rule files instead of a model")
  .option("--keep-sandbox", "leave sandboxes on disk for inspection")
  .option("--json <file>", "also write the report as JSON")
  .option("-q, --quiet", "no progress output")
  .description("Live check: a coding agent, running with this repo's own rules, is asked to break each one.")
  .action(async (repo: string, opts: { model?: string; level: string; maxTurns: string; rule?: string[]; category?: string[]; offline?: boolean; keepSandbox?: boolean; json?: string; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const report = await attack(root, {
      model: opts.model,
      maxLevel: Math.min(3, Math.max(1, Number(opts.level))) as PressureLevel,
      maxTurns: Number(opts.maxTurns),
      ruleIds: opts.rule,
      categories: opts.category,
      offline: opts.offline,
      keepSandbox: opts.keepSandbox,
      onProgress: opts.quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
    });
    process.stdout.write(renderTerminal(report));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify(report, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    process.exitCode = report.totals.broken > 0 ? 2 : 0;
  });

program
  .command("harden")
  .argument("[repo]", "path to the repo to harden", ".")
  .option("--offline", "keyword heuristic for reading rule files instead of a model")
  .option("--dry-run", "show what would be written, write nothing")
  .option("-q, --quiet", "no progress output")
  .description("Write a hook and deny entries that turn every wish into a gate. Then run scan again.")
  .action(async (repo: string, opts: { offline?: boolean; dryRun?: boolean; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const { rules } = await collectRules(root, { offline: opts.offline, onProgress: opts.quiet ? undefined : (m) => process.stderr.write(pc.dim(`  ${m}\n`)) });
    const plan = planHardening(rules);
    const result = await applyHardening(root, plan, { dryRun: opts.dryRun });
    const out: string[] = [""];
    out.push(pc.bold(opts.dryRun ? "paperfence harden (dry run)" : "paperfence harden") + pc.dim(`  ${root}`));
    out.push("");
    if (result.addedDeny.length) {
      out.push(pc.bold("permissions.deny") + pc.dim("  added to .claude/settings.json"));
      for (const d of result.addedDeny) out.push(`  ${pc.green("+")} ${d}`);
      out.push("");
    }
    out.push(pc.bold("hook") + pc.dim("  .claude/hooks/paperfence-guard.cjs, driven by policy.json"));
    const p = plan.policy;
    const line = (label: string, v: string[] | boolean) => {
      if (Array.isArray(v) ? v.length : v) out.push(`  ${pc.green("+")} ${label}${Array.isArray(v) ? ": " + v.join(", ") : ""}`);
    };
    line("no commits or pushes to", p.protectedBranches);
    line("no edits or deletions under", p.protectedTestPaths);
    line("no reading (Read tool or shell) of", p.secretFiles);
    line("no edits under", p.forbiddenPaths);
    line("edits only under", p.allowedPaths);
    line("commit only after running", p.requireBeforeCommit);
    line("blocked until a human approves", p.askFirstCommands);
    line("no rm -r, git reset --hard, git clean -f, destructive SQL", p.blockDestructive);
    line("no force push", p.blockForcePush);
    line("no adding dependencies", p.blockInstall);
    line("no curl/wget/WebFetch to outside hosts", p.blockNetwork);
    out.push("");
    for (const n of plan.notes) out.push(pc.dim(`  note: ${n}`));
    if (plan.notes.length) out.push("");
    if (!opts.dryRun) {
      out.push(pc.dim(`wrote ${result.wrote.join(", ")}`));
      out.push(pc.dim(`Run ${pc.reset("paperfence scan")} again to see the difference.`));
    }
    out.push("");
    process.stdout.write(out.join("\n"));
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(pc.red(`paperfence: ${(e as Error).message}\n`));
  process.exit(1);
});
