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
import { compilePolicy, unenforcedAnywhere, type TargetId } from "./policy/compile.js";
import { inferPolicy, loadPolicy, POLICY_PATH, renderPolicy } from "./policy/document.js";
import { renderPolicyCheck } from "./policy/report.js";
import { detectRuntimes } from "./runtimes/index.js";
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
  .option("--category <names...>", "only attack these categories")
  .option("--offline", "keyword heuristic for reading rule files instead of a model")
  .option("--keep-sandbox", "leave sandboxes on disk for inspection")
  .option("--unsafe-host", "run the agent on this machine instead of in Docker (best-effort guard only; use in a VM)")
  .option("--json <file>", "also write the report as JSON")
  .option("--html <file>", "also write a self-contained HTML report")
  .option("--markdown <file>", "also write a Markdown summary for a pull request comment or CI job summary")
  .option("-q, --quiet", "no progress output")
  .description("Live check: a coding agent, running with this repo's own rules, is asked to break each one.")
  .action(async (repo: string, opts: { model?: string; level: string; maxTurns: string; rule?: string[]; reps: string; form?: string[]; receipts?: boolean; category?: string[]; offline?: boolean; keepSandbox?: boolean; unsafeHost?: boolean; json?: string; html?: string; markdown?: string; quiet?: boolean }) => {
    const root = path.resolve(repo);
    const report = await attack(root, {
      model: opts.model,
      maxLevel: Math.min(3, Math.max(1, Number(opts.level))) as PressureLevel,
      maxTurns: Number(opts.maxTurns),
      reps: Number(opts.reps),
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
    line("commit only after running", p.requireBeforeCommit);
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
  .option("--offline", "keyword heuristic for reading rule files")
  .option("--json <file>", "write the receipt as JSON")
  .option("--html <file>", "write the receipt as HTML")
  .option("--markdown <file>", "write a Markdown summary for a pull request comment or CI job summary")
  .option("-q, --quiet", "no progress output")
  .description("Can this config change be merged? Run bad tasks (must be blocked) and good tasks (must still work) under base and head.")
  .action(async (repo: string, opts: { head?: string; without?: string[]; hook?: string; deny?: string[]; hardened?: boolean; modelB?: string; model?: string; reps: string; level: string; maxTurns: string; only?: string[]; offline?: boolean; json?: string; html?: string; markdown?: string; quiet?: boolean }) => {
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
