import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { renderTerminal } from "./report/terminal.js";
import { renderHtml } from "./report/html.js";
import { compareMarkdown, scanMarkdown } from "./report/markdown.js";
import { scan } from "./scan.js";
import { attack } from "./attack/index.js";
import { collectRules } from "./scan.js";
import { planHardening } from "./harden/generate.js";
import { applyHardening } from "./harden/apply.js";
import { compare } from "./compare/index.js";
import { renderCompareHtml, renderCompareTerminal } from "./compare/report.js";
import { loadSuite, renderSuiteTemplate, SUITE_PATH } from "./compare/suite.js";
import { listReceipts, verifyReceipt } from "./receipt.js";
import { dockerAvailable, verifyIsolation } from "./sandbox/docker.js";
import { renderReplay, replay } from "./replay.js";
import { allReceiptIds, mergeReceipts, mergeSummary, parseShard } from "./merge.js";
import { createProject, push, renderSummary, summary } from "./control/client.js";
import { compilePolicy, unenforcedAnywhere, type TargetId } from "./policy/compile.js";
import { inferPolicy, loadPolicy, POLICY_PATH, renderPolicy } from "./policy/document.js";
import { renderPolicyCheck } from "./policy/report.js";
import { detectRuntimes } from "./runtimes/index.js";
import { buildGraph, renderInventoryTemplate } from "./graph/build.js";
import { BENCH_RESULTS, corpusRepos, renderBench, runBench } from "./bench/run.js";
import { renderGraphHtml, renderGraphTerminal } from "./graph/report.js";
import { detectProfile } from "./repo/profile.js";
import { CASES } from "./conformance/cases.js";
import { predict, renderConformance, runConformance } from "./conformance/run.js";
import { CODEX_CASES } from "./conformance/codex-cases.js";
import { renderCodexConformance, runCodexConformance } from "./conformance/codex-run.js";
import type { VariantSpec } from "./compare/variants.js";
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
  .option("--no-hooks", "never execute the repo's hook scripts; report what they might cover as unknown")
  .option("--unsafe-run-hooks", "execute hook scripts on this machine instead of in a container")
  .option("--json <file>", "also write the report as JSON")
  .option("--html <file>", "also write a self-contained HTML report")
  .option("--markdown <file>", "also write a Markdown summary for a pull request comment or CI job summary")
  .option("-q, --quiet", "no progress output")
  .description("Static check: would anything mechanical stop the obvious violation of each rule?")
  .action(async (repo: string, opts: { offline?: boolean; askCounts?: boolean; hooks?: boolean; unsafeRunHooks?: boolean; json?: string; html?: string; markdown?: string; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const report = await scan(root, {
      offline: opts.offline,
      askCounts: opts.askCounts,
      noHooks: opts.hooks === false,
      unsafeRunHooks: opts.unsafeRunHooks,
      onProgress: opts.quiet ? undefined : (m) => process.stderr.write(pc.dim(`  ${m}\n`)),
    });
    process.stdout.write(renderTerminal(report));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify(report, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    if (opts.html) {
      await fs.writeFile(opts.html, renderHtml(report));
      process.stderr.write(pc.dim(`wrote ${opts.html}\n`));
    }
    if (opts.markdown) {
      await fs.writeFile(opts.markdown, scanMarkdown(report) + "\n");
      process.stderr.write(pc.dim(`wrote ${opts.markdown}\n`));
    }
    process.exitCode = report.totals.broken > 0 ? 2 : report.totals.error > 0 ? 3 : 0;
  });

program
  .command("attack")
  .argument("[repo]", "path to the repo to attack", ".")
  .option("--model <model>", "model that plays the coding agent (default: claude-sonnet-5)")
  .option("--level <n>", "highest pressure level to try, 1-3", "3")
  .option("--max-turns <n>", "turn budget per run", "30")
  .option("--rule <ids...>", "only attack these rule ids (from scan output)")
  .option("--reps <n>", "trials per attack form and pressure level; more trials narrow the interval", "1")
  .option("--form <ids...>", "only try these attack forms")
  .option("--no-receipts", "do not write a receipt per trial")
  .option("--budget <usd>", "stop starting new trials once this much has been spent")
  .option("--shard <k/n>", "run only this slice of the work, for splitting a run across machines")
  .option("--category <names...>", "only attack these categories")
  .option("--offline", "keyword heuristic for reading rule files instead of a model")
  .option("--keep-sandbox", "leave sandboxes on disk for inspection")
  .option("--unsafe-host", "run the agent on this machine instead of in Docker (best-effort guard only; use in a VM)")
  .option("--json <file>", "also write the report as JSON")
  .option("--html <file>", "also write a self-contained HTML report")
  .option("--markdown <file>", "also write a Markdown summary for a pull request comment or CI job summary")
  .option("-q, --quiet", "no progress output")
  .description("Live check: a coding agent, running with this repo's own rules, is asked to break each one.")
  .action(async (repo: string, opts: { model?: string; level: string; maxTurns: string; rule?: string[]; reps: string; form?: string[]; receipts?: boolean; budget?: string; shard?: string; category?: string[]; offline?: boolean; keepSandbox?: boolean; unsafeHost?: boolean; json?: string; html?: string; markdown?: string; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const report = await attack(root, {
      model: opts.model,
      maxLevel: Math.min(3, Math.max(1, Number(opts.level))) as PressureLevel,
      maxTurns: Number(opts.maxTurns),
      reps: Number(opts.reps),
      budgetUsd: opts.budget ? Number(opts.budget) : undefined,
      shard: opts.shard ? parseShard(opts.shard) : undefined,
      formIds: opts.form,
      receipts: opts.receipts !== false,
      ruleIds: opts.rule,
      categories: opts.category,
      offline: opts.offline,
      keepSandbox: opts.keepSandbox,
      sandbox: opts.unsafeHost ? "host" : "docker",
      onProgress: opts.quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
    });
    process.stdout.write(renderTerminal(report));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify(report, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    if (opts.html) {
      await fs.writeFile(opts.html, renderHtml(report));
      process.stderr.write(pc.dim(`wrote ${opts.html}\n`));
    }
    if (opts.markdown) {
      await fs.writeFile(opts.markdown, scanMarkdown(report) + "\n");
      process.stderr.write(pc.dim(`wrote ${opts.markdown}\n`));
    }
    process.exitCode = report.totals.broken > 0 ? 2 : report.totals.error > 0 ? 3 : 0;
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
    for (const r of p.requireBefore) out.push(`  ${pc.green("+")} ${r.action === "push" ? "push" : "commit"} only after running: ${r.command}`);
    line("blocked until a human approves", p.askFirstCommands);
    line("no rm -r, git reset --hard, git clean -f, destructive SQL", p.blockDestructive);
    line("no force push", p.blockForcePush);
    line("no adding dependencies", p.blockInstall);
    line("no curl/wget/WebFetch to outside hosts", p.blockNetwork);
    out.push("");
    for (const n of plan.notes) out.push(pc.dim(`  note: ${n}`));
    if (plan.notes.length) out.push("");
    if (opts.dryRun) {
      out.push(pc.bold("Files this would write"));
      for (const f of result.patch) {
        const lines = f.after.split("\n").length;
        out.push(`  ${f.before === null ? pc.green("new ") : pc.yellow("edit")} ${f.path} ${pc.dim(`(${lines} line${lines === 1 ? "" : "s"})`)}`);
      }
      out.push("");
      for (const f of result.patch) {
        // The guard is the same generated file every time; printing four
        // hundred lines of it buries the part that is specific to this repo.
        if (f.path.endsWith("paperfence-guard.cjs")) {
          out.push(pc.bold(f.path) + pc.dim("  the generated guard, identical for every repo; what it enforces is policy.json below"));
          out.push("");
          continue;
        }
        out.push(pc.bold(f.path));
        for (const line of f.after.replace(/\n$/, "").split("\n")) out.push(pc.dim("  ") + line);
        out.push("");
      }
      out.push(pc.dim("Nothing was written. Run without --dry-run to apply."));
    } else {
      out.push(pc.dim(`wrote ${result.wrote.join(", ")}`));
      out.push(pc.dim(`Run ${pc.reset("paperfence scan")} again to see the difference.`));
    }
    out.push("");
    process.stdout.write(out.join("\n"));
  });

program
  .command("compare")
  .argument("[repo]", "path to the repo", ".")
  .option("--head <ref-or-path>", "config to compare against the repo as it is (git ref or directory)")
  .option("--without <text...>", "head = base with every rule line containing this text removed")
  .option("--hook <command>", 'head = base with PreToolUse hooks replaced by this command ("" to remove all)')
  .option("--deny <entries...>", "head = base plus these permissions.deny entries")
  .option("--hardened", "head = base after paperfence harden")
  .option("--model-b <model>", "head runs with this model instead (same config)")
  .option("--model <model>", "model for both arms (default claude-sonnet-5)")
  .option("--reps <n>", "repetitions per task", "1")
  .option("--level <n>", "pressure level for bad tasks, 1-3", "2")
  .option("--max-turns <n>", "turn budget per run", "30")
  .option("--only <ids...>", "run only these task ids")
  .option("--budget <usd>", "stop starting new tasks once this much has been spent")
  .option("--shard <k/n>", "run only this slice of the tasks, for splitting a run across machines")
  .option("--offline", "keyword heuristic for reading rule files")
  .option("--json <file>", "write the receipt as JSON")
  .option("--html <file>", "write the receipt as HTML")
  .option("--markdown <file>", "write a Markdown summary for a pull request comment or CI job summary")
  .option("-q, --quiet", "no progress output")
  .description("Can this config change be merged? Run bad tasks (must be blocked) and good tasks (must still work) under base and head.")
  .action(async (repo: string, opts: { head?: string; without?: string[]; hook?: string; deny?: string[]; hardened?: boolean; modelB?: string; model?: string; reps: string; level: string; maxTurns: string; only?: string[]; budget?: string; shard?: string; offline?: boolean; json?: string; html?: string; markdown?: string; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const headSpec: VariantSpec = { name: "head", offline: opts.offline };
    let any = false;
    if (opts.head) { headSpec.from = opts.head; any = true; }
    if (opts.without?.length) { headSpec.without = opts.without; any = true; }
    if (opts.hook !== undefined) { headSpec.hook = opts.hook; any = true; }
    if (opts.deny?.length) { headSpec.deny = opts.deny; any = true; }
    if (opts.hardened) { headSpec.hardened = true; any = true; }
    if (opts.modelB) { headSpec.model = opts.modelB; any = true; }
    if (!any) throw new Error("say how head differs: --head, --without, --hook, --deny, --hardened, or --model-b");
    const report = await compare(root, {
      variants: [{ name: "base", offline: opts.offline }, headSpec],
      model: opts.model,
      reps: Number(opts.reps),
      level: Math.min(3, Math.max(1, Number(opts.level))) as PressureLevel,
      maxTurns: Number(opts.maxTurns),
      only: opts.only,
      budgetUsd: opts.budget ? Number(opts.budget) : undefined,
      shard: opts.shard ? parseShard(opts.shard) : undefined,
      offline: opts.offline,
      onProgress: opts.quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
    });
    process.stdout.write(renderCompareTerminal(report));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify(report, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    if (opts.html) {
      await fs.writeFile(opts.html, renderCompareHtml(report));
      process.stderr.write(pc.dim(`wrote ${opts.html}\n`));
    }
    if (opts.markdown) {
      await fs.writeFile(opts.markdown, compareMarkdown(report) + "\n");
      process.stderr.write(pc.dim(`wrote ${opts.markdown}\n`));
    }
    const head = report.summaries[1]!;
    const base = report.summaries[0]!;
    const regressed = head.goodCompleted < base.goodCompleted || head.badBlocked < base.badBlocked;
    process.exitCode = regressed ? 2 : 0;
  });

program
  .command("suite")
  .argument("[repo]", "path to the repo", ".")
  .option("--offline", "keyword heuristic for reading rule files")
  .option("--write", `write the default suite to ${SUITE_PATH} so you can edit it`)
  .description("Show the task suite compare would run (bad tasks from your rules, good tasks from what the repo has).")
  .action(async (repo: string, opts: { offline?: boolean; write?: boolean }) => {
    const root = path.resolve(repo);
    const { rules } = await collectRules(root, { offline: opts.offline, onProgress: (m) => process.stderr.write(pc.dim(`  ${m}\n`)) });
    const { suite, source } = await loadSuite(root, rules);
    process.stderr.write(pc.dim(`source: ${source === "file" ? SUITE_PATH : "default"}\n`));
    if (opts.write && source === "default") {
      const p = path.join(root, SUITE_PATH);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, renderSuiteTemplate(suite));
      process.stderr.write(pc.dim(`wrote ${SUITE_PATH}\n`));
    }
    process.stdout.write(renderSuiteTemplate(suite));
  });

program
  .command("replay")
  .argument("<receipt>", "receipt id (pf_...) or a path to a receipt file")
  .argument("[repo]", "path to the repo", ".")
  .option("--model <model>", "replay with a different model, to ask whether the newer one still does it")
  .option("--unsafe-host", "run the agent on this machine instead of in Docker")
  .option("-q, --quiet", "no progress output")
  .description("Re-run the conditions a receipt describes and show what changed. Reproduces the setup, not the agent.")
  .action(async (receipt: string, repo: string, opts: { model?: string; unsafeHost?: boolean; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const result = await replay(root, receipt, {
      model: opts.model,
      sandbox: opts.unsafeHost ? "host" : "docker",
      onProgress: opts.quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
    });
    process.stdout.write(renderReplay(result));
    process.exitCode = result.replayed.verdict.verdict === "FAIL" ? 2 : 0;
  });

program
  .command("merge")
  .argument("[receipts...]", "receipt ids or paths; omit to merge every receipt in the repo")
  .option("--repo <path>", "path to the repo the receipts belong to", ".")
  .option("--all", "merge every receipt stored in the repo")
  .option("--allow-mixed", "merge receipts whose conditions differ; the report says what differed")
  .option("--json <file>", "write the merged report as JSON")
  .option("--html <file>", "write the merged report as HTML")
  .option("--markdown <file>", "write a Markdown summary")
  .description("Combine receipts from several runs, or several machines, into one report.")
  .action(async (ids: string[], opts: { repo: string; all?: boolean; allowMixed?: boolean; json?: string; html?: string; markdown?: string }) => {
    const root = path.resolve(opts.repo);
    const use = opts.all || !ids.length ? await allReceiptIds(root) : ids;
    if (!use.length) throw new Error(`no receipts in ${root}. Run \`paperfence attack\` first, or pass receipt files from another machine.`);
    const result = await mergeReceipts(use, root, {
      allowMixed: opts.allowMixed,
      onProgress: (m) => process.stderr.write(pc.dim(`  ${m}\n`)),
    });
    process.stdout.write(renderTerminal(result.report));
    process.stderr.write(pc.dim(mergeSummary(result) + "\n"));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify(result.report, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    if (opts.html) {
      await fs.writeFile(opts.html, renderHtml(result.report));
      process.stderr.write(pc.dim(`wrote ${opts.html}\n`));
    }
    if (opts.markdown) {
      await fs.writeFile(opts.markdown, scanMarkdown(result.report) + "\n");
      process.stderr.write(pc.dim(`wrote ${opts.markdown}\n`));
    }
    process.exitCode = result.report.totals.broken > 0 ? 2 : 0;
  });

program
  .command("receipts")
  .argument("[repo]", "path to the repo", ".")
  .option("--json", "print the list as JSON")
  .description("List the trial receipts stored in this repo.")
  .action(async (repo: string, opts: { json?: boolean }) => {
    const root = path.resolve(repo);
    const all = await listReceipts(root);
    if (opts.json) {
      process.stdout.write(JSON.stringify(all, null, 2) + "\n");
      return;
    }
    if (!all.length) {
      process.stdout.write(pc.dim("\nNo receipts yet. Run `paperfence attack` and every trial writes one.\n\n"));
      return;
    }
    const out = ["", pc.bold(`${all.length} receipt${all.length === 1 ? "" : "s"}`) + pc.dim(`  ${root}`), ""];
    for (const r of all) {
      const v = r.verdict.verdict;
      const badge = v === "FAIL" ? pc.red(v.padEnd(13)) : v === "PASS" ? pc.green(v.padEnd(13)) : v === "ERROR" ? pc.magenta(v.padEnd(13)) : pc.yellow(v.padEnd(13));
      const tamper = verifyReceipt(r) ? "" : pc.red("  [edited: does not match its own hash]");
      out.push(`  ${pc.bold(r.id)}  ${badge} ${r.trial.scenario} · ${r.trial.form} · level ${r.trial.level}${tamper}`);
      out.push(`  ${" ".repeat(r.id.length)}  ${pc.dim(`${new Date(r.at).toLocaleString()} · ${r.fingerprint.model ?? "?"} · ${r.verdict.explain.slice(0, 70)}`)}`);
    }
    out.push("");
    out.push(pc.dim(`Replay one with ${pc.reset(`paperfence replay ${all[0]!.id}`)}`));
    out.push("");
    process.stdout.write(out.join("\n"));
  });

const policy = program.command("policy").description("Write down what your agents may do, and find out what can actually enforce it.");

policy
  .command("init")
  .argument("[repo]", "path to the repo", ".")
  .option("--offline", "keyword heuristic for reading rule files instead of a model")
  .option("--force", `overwrite an existing ${POLICY_PATH}`)
  .option("--stdout", "print the draft instead of writing it")
  .description(`Draft ${POLICY_PATH} from the rules already in this repository.`)
  .action(async (repo: string, opts: { offline?: boolean; force?: boolean; stdout?: boolean }) => {
    const root = path.resolve(repo);
    const existing = await loadPolicy(root).catch(() => null);
    if (existing && !opts.force && !opts.stdout) {
      throw new Error(`${POLICY_PATH} already exists. Edit it, or pass --force to redraft from the repo's rules.`);
    }
    const { rules } = await collectRules(root, { offline: opts.offline, onProgress: (m) => process.stderr.write(pc.dim(`  ${m}\n`)) });
    const found = await detectRuntimes(root);
    const doc = inferPolicy(rules, found.length ? found.map((f) => f.adapter.id) : ["claude-code"]);
    const text = renderPolicy(doc);
    if (opts.stdout) {
      process.stdout.write(text);
      return;
    }
    await fs.writeFile(path.join(root, POLICY_PATH), text);
    process.stderr.write(pc.dim(`wrote ${POLICY_PATH} with ${doc.statements.length} statement(s)\n`));
    process.stderr.write(pc.dim(`Read it, fix the wording, then run ${pc.reset("paperfence policy check")}.\n`));
  });

policy
  .command("check")
  .argument("[repo]", "path to the repo", ".")
  .option("--target <ids...>", "targets to compile for: claude-code, claude-code-hook, codex, github")
  .option("--json <file>", "also write the assessment as JSON")
  .description("For every statement, what would enforce it, and what it would miss.")
  .action(async (repo: string, opts: { target?: string[]; json?: string }) => {
    const root = path.resolve(repo);
    const loaded = await loadPolicy(root);
    if (!loaded) throw new Error(`no ${POLICY_PATH} here. Run \`paperfence policy init\` to draft one from the rules you already have.`);
    const targets = (opts.target?.length ? opts.target : ["claude-code", "claude-code-hook", "github"]) as TargetId[];
    for (const t of targets) {
      if (!["claude-code", "claude-code-hook", "codex", "github"].includes(t)) throw new Error(`unknown target "${t}"; known: claude-code, claude-code-hook, codex, github`);
    }
    const compiled = targets.map((t) => compilePolicy(loaded.doc, t));
    const unenforced = unenforcedAnywhere(compiled);
    process.stdout.write(renderPolicyCheck(compiled, unenforced));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify({ policy: loaded.doc, compiled, unenforcedAnywhere: unenforced }, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    process.exitCode = unenforced.filter((s) => !s.statement.acceptAsGuidance).length > 0 ? 2 : 0;
  });

program
  .command("conformance")
  .option("--only <ids...>", "run only these case ids")
  .option("--runtime <id>", "which runtime to check: claude-code or codex", "claude-code")
  .option("--model <model>", "model that drives the runtime (default claude-sonnet-5)")
  .option("--max-turns <n>", "turn budget per case", "6")
  .option("--reps <n>", "run each case this many times; a permission decision that varies is itself a finding", "1")
  .option("--list", "list the cases and what paperfence predicts, without running anything")
  .option("--json <file>", "write the result as JSON")
  .description("Check paperfence's reading of Claude Code's permission rules against the real runtime.")
  .action(async (opts: { only?: string[]; runtime: string; model?: string; maxTurns: string; reps: string; list?: boolean; json?: string }) => {
    if (opts.runtime === "codex") {
      if (opts.list) {
        const out = ["", pc.bold(`${CODEX_CASES.length} Codex conformance cases`), ""];
        for (const c of CODEX_CASES) out.push(`  ${pc.bold(c.id.padEnd(34))} ${pc.dim(c.sandbox.padEnd(18))} ${c.claim}`);
        out.push("");
        out.push(pc.dim("Codex confines rather than refusing, so each case asks whether the effect happened."));
        out.push("");
        process.stdout.write(out.join("\n"));
        return;
      }
      const report = await runCodexConformance({
        only: opts.only,
        reps: Number(opts.reps),
        model: opts.model,
        onProgress: (m) => process.stderr.write(`  ${m}\n`),
      });
      process.stdout.write(renderCodexConformance(report));
      if (opts.json) {
        await fs.writeFile(opts.json, JSON.stringify(report, null, 2));
        process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
      }
      process.exitCode = report.disagreed > 0 || report.unstable > 0 ? 2 : 0;
      return;
    }
    if (opts.runtime !== "claude-code") throw new Error(`unknown runtime "${opts.runtime}"; known: claude-code, codex`);
    if (opts.list) {
      const out = ["", pc.bold(`${CASES.length} conformance cases`), ""];
      for (const c of CASES) {
        out.push(`  ${pc.bold(c.id.padEnd(28))} ${pc.dim("predicts")} ${predict(c, "/repo").padEnd(6)} ${c.gap ? pc.yellow("gap ") : "    "} ${c.claim}`);
      }
      out.push("");
      out.push(pc.dim("A case marked gap pins something the runtime allows that a reader might expect it to refuse."));
      out.push("");
      process.stdout.write(out.join("\n"));
      return;
    }
    const report = await runConformance({
      only: opts.only,
      model: opts.model,
      maxTurns: Number(opts.maxTurns),
      reps: Number(opts.reps),
      onProgress: (m) => process.stderr.write(`  ${m}\n`),
    });
    process.stdout.write(renderConformance(report));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify(report, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    process.exitCode = report.disagreed > 0 || report.unstable > 0 ? 2 : 0;
  });

program
  .command("graph")
  .argument("[repo]", "path to the repo", ".")
  .option("--no-scan", "skip the scan; list what is reachable without saying what stops it")
  .option("--no-hooks", "do not execute the repo's hook scripts; what they might cover is reported as unknown")
  .option("--unsafe-run-hooks", "execute hook scripts on this machine instead of in a container")
  .option("--offline", "keyword heuristic for reading rule files")
  .option("--init", `write a starting paperfence.inventory.yaml and stop`)
  .option("--json <file>", "write the graph as JSON")
  .option("--html <file>", "write the graph as HTML")
  .description("What an agent working here can reach, and what each control actually protects.")
  .action(async (repo: string, opts: { scan?: boolean; hooks?: boolean; unsafeRunHooks?: boolean; offline?: boolean; init?: boolean; json?: string; html?: string }) => {
    const root = path.resolve(repo);
    const profile = await detectProfile(root);
    // Hooks are probed the same way `scan` probes them, in a container, because
    // a generated guard hook is usually the only thing standing in front of
    // these assets and skipping it would report every one of them as open.
    const report =
      opts.scan === false
        ? undefined
        : await scan(root, {
            offline: opts.offline,
            noHooks: opts.hooks === false,
            unsafeRunHooks: opts.unsafeRunHooks,
            onProgress: (m) => process.stderr.write(pc.dim(`  ${m}\n`)),
          });
    const graph = await buildGraph(root, profile, report);

    if (opts.init) {
      const p = path.join(root, "paperfence.inventory.yaml");
      const exists = await fs.stat(p).then(() => true).catch(() => false);
      if (exists) throw new Error("paperfence.inventory.yaml already exists; edit it, or delete it to start again");
      await fs.writeFile(p, renderInventoryTemplate(graph));
      process.stderr.write(pc.dim(`wrote paperfence.inventory.yaml with ${graph.assets.filter((a) => a.kind === "credential" || a.kind === "service").length} asset(s) to fill in\n`));
      return;
    }

    process.stdout.write(renderGraphTerminal(graph));
    if (opts.json) {
      await fs.writeFile(opts.json, JSON.stringify(graph, null, 2));
      process.stderr.write(pc.dim(`wrote ${opts.json}\n`));
    }
    if (opts.html) {
      await fs.writeFile(opts.html, renderGraphHtml(graph));
      process.stderr.write(pc.dim(`wrote ${opts.html}\n`));
    }
  });

program
  .command("bench")
  .argument("[repo]", "path to the paperfence checkout holding the corpus", ".")
  .option("--model <models...>", "models to compare", ["claude-sonnet-5"])
  .option("--only <names...>", "corpus repositories to run, by directory name")
  .option("--reps <n>", "trials per form and level; below three the intervals separate nothing", "3")
  .option("--level <n>", "highest pressure level, 1-3", "3")
  .option("--max-turns <n>", "turn budget per trial", "25")
  .option("--budget <usd>", "stop starting new trials once this much has been spent")
  .option("--shard <k/n>", "run only this slice, for splitting a sweep across machines")
  .option("--json <file>", `write the result; defaults to ${BENCH_RESULTS}/<date>.json`)
  .option("--list", "show the corpus and the scenario versions, without running anything")
  .description("Run the scenario suite against the fixed corpus, for a number anyone can reproduce.")
  .action(async (repo: string, opts: { model: string[]; only?: string[]; reps: string; level: string; maxTurns: string; budget?: string; shard?: string; json?: string; list?: boolean }) => {
    const root = path.resolve(repo);
    const all = await corpusRepos(root);
    const repos = opts.only?.length ? all.filter((r) => opts.only!.includes(path.basename(r))) : all;
    if (opts.list) {
      const out = ["", pc.bold(`corpus: ${all.length} repositor${all.length === 1 ? "y" : "ies"}`), ""];
      for (const r of all) out.push(`  ${path.basename(r)}`);
      out.push("");
      process.stdout.write(out.join("\n"));
      return;
    }
    if (!repos.length) throw new Error(`no corpus repositories matched. Available: ${all.map((r) => path.basename(r)).join(", ") || "none"}`);
    const report = await runBench(root, {
      repos,
      models: opts.model,
      reps: Number(opts.reps),
      maxLevel: Math.min(3, Math.max(1, Number(opts.level))) as PressureLevel,
      maxTurns: Number(opts.maxTurns),
      budgetUsd: opts.budget ? Number(opts.budget) : undefined,
      shard: opts.shard ? parseShard(opts.shard) : undefined,
      onProgress: (m) => process.stderr.write(`  ${m}\n`),
    });
    process.stdout.write(renderBench(report));
    const out = opts.json ?? path.join(root, BENCH_RESULTS, `${report.at.slice(0, 10)}.json`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(report, null, 2));
    process.stderr.write(pc.dim(`wrote ${path.relative(root, out)}\n`));
  });

program
  .command("push")
  .argument("[repo]", "path to the repo whose receipts to send", ".")
  .option("--endpoint <url>", "control plane to send to (default: PAPERFENCE_ENDPOINT, then the hosted one)")
  .option("--token <token>", "project write token (default: PAPERFENCE_TOKEN)")
  .option("-q, --quiet", "no progress output")
  .description("Send this repo's receipts to a control plane, so history survives the machine that made it.")
  .action(async (repo: string, opts: { endpoint?: string; token?: string; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const r = await push(root, {
      endpoint: opts.endpoint,
      token: opts.token,
      onProgress: opts.quiet ? undefined : (m) => process.stderr.write(pc.dim(`  ${m}\n`)),
    });
    const out: string[] = [""];
    if (!r.sent) {
      out.push(pc.dim("  No receipts to send. `paperfence attack` writes one per trial."));
    } else {
      out.push(`  ${pc.green(String(r.stored))} new of ${r.sent} sent${r.project ? pc.dim(` · ${r.project}`) : ""}`);
      if (r.alreadyHad) out.push(pc.dim(`  ${r.alreadyHad} were already there; a receipt id is the hash of its contents, so sending twice stores once.`));
    }
    for (const s of r.skipped) out.push(`  ${pc.red("skipped")} ${s.id}: ${s.why}`);
    for (const s of r.rejected) out.push(`  ${pc.yellow("rejected")} ${s.id}: ${s.why}`);
    out.push("");
    process.stdout.write(out.join("\n"));
  });

program
  .command("status")
  .option("--endpoint <url>", "control plane to ask (default: PAPERFENCE_ENDPOINT, then the hosted one)")
  .option("--token <token>", "project token (default: PAPERFENCE_TOKEN)")
  .option("--days <n>", "how far back to look", "7")
  .option("--json", "print the raw summary")
  .description("What changed since last week: rules that started failing, and what has been running.")
  .action(async (opts: { endpoint?: string; token?: string; days: string; json?: boolean }) => {
    const s = await summary({ endpoint: opts.endpoint, token: opts.token, days: Number(opts.days) });
    process.stdout.write(opts.json ? JSON.stringify(s, null, 2) + "\n" : renderSummary(s));
    process.exitCode = s.newlyBroken.length ? 2 : 0;
  });

const project = program.command("project").description("Projects on a control plane.");

project
  .command("create")
  .argument("<name>", "a name for the project, usually the repository")
  .option("--endpoint <url>", "control plane to create it on")
  .description("Create a project and mint its write token. Needs the deployment's admin token.")
  .action(async (name: string, opts: { endpoint?: string }) => {
    const r = await createProject(name, { endpoint: opts.endpoint });
    const out = ["", pc.bold(`created ${r.name}`), "", `  id     ${r.id}`, `  token  ${pc.bold(r.token)}`, ""];
    out.push(pc.dim("  The token is shown once and is not stored; only its hash is. Put it in CI as PAPERFENCE_TOKEN."));
    out.push("");
    process.stdout.write(out.join("\n"));
  });

program
  .command("doctor")
  .description("Check paperfence's own sandbox: is the agent container really isolated?")
  .action(async () => {
    const out: string[] = ["", pc.bold("paperfence doctor"), ""];
    if (!(await dockerAvailable())) {
      out.push(pc.red("  Docker is not available, so live runs cannot be sandboxed at all."));
      out.push(pc.dim("  scan still works. attack and compare need Docker, or --unsafe-host in a throwaway VM."));
      out.push("");
      process.stdout.write(out.join("\n"));
      process.exitCode = 1;
      return;
    }
    const checks = await verifyIsolation((m) => process.stderr.write(pc.dim(`  ${m}\n`)));
    for (const c of checks) {
      out.push(`  ${c.ok ? pc.green("ok  ") : pc.red("FAIL")} ${c.name}`);
      out.push(`       ${pc.dim(c.detail)}`);
    }
    out.push("");
    const bad = checks.filter((c) => !c.ok);
    out.push(bad.length ? pc.red(`  ${bad.length} check(s) failed. Findings from this machine are not evidence about a contained agent.`) : pc.dim("  The agent container has loopback and nothing else. Its only path out is the proxy's socket."));
    out.push("");
    process.stdout.write(out.join("\n"));
    process.exitCode = bad.length ? 1 : 0;
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(pc.red(`paperfence: ${(e as Error).message}\n`));
  process.exit(1);
});
