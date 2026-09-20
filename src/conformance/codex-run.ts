import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { codexAuthPresent, codexVersion, runCodex } from "../runtimes/codex-exec.js";
import { CODEX_CASES, type CodexCase, type CodexExpected } from "./codex-cases.js";

/**
 * Check what Codex's sandbox actually confines.
 *
 * This runs the Codex CLI on this machine, not in a container, and that is a
 * deliberate choice rather than a shortcut. The thing under test is Codex's own
 * confinement; running it inside a container where everything is disposable
 * would measure the container. The cases are chosen so that a total sandbox
 * failure does nothing worse than change a file in a temporary directory: no
 * network, no destructive commands, no credentials.
 *
 * `--ignore-user-config` keeps this machine's Codex settings out of the
 * measurement, so a result describes the sandbox flag and nothing else.
 */

export type CodexObserved = CodexExpected | "not-attempted" | "error";

export interface CodexCaseResult {
  case: CodexCase;
  observed: CodexObserved;
  observedAll?: CodexObserved[];
  agrees: boolean;
  unstable?: boolean;
  /**
   * True when the run produced no command record, so "the effect did not
   * happen" could equally be the sandbox confining it or the agent declining.
   */
  unobservable?: boolean;
  detail: string;
  tokens?: number;
}

export interface CodexConformanceReport {
  at: string;
  reps: number;
  runtime: { codex: string | null };
  results: CodexCaseResult[];
  agreed: number;
  disagreed: number;
  unstable: number;
  inconclusive: number;
  caveats: string[];
}

export interface CodexConformanceOptions {
  only?: string[];
  reps?: number;
  model?: string;
  timeoutMs?: number;
  onProgress?: (m: string) => void;
}

async function materialize(c: CodexCase): Promise<string> {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `pf-codex-${c.id}-`)));
  const dir = path.join(parent, "repo");
  await fs.mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(c.files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

export async function runCodexConformance(opts: CodexConformanceOptions = {}): Promise<CodexConformanceReport> {
  const log = opts.onProgress ?? (() => {});
  const version = await codexVersion();
  if (!version) throw new Error("the codex CLI is not on PATH, so there is nothing to check against");
  if (!(await codexAuthPresent())) throw new Error("no Codex credential found; run `codex login` first");

  const cases = opts.only?.length ? CODEX_CASES.filter((c) => opts.only!.includes(c.id)) : CODEX_CASES;
  const reps = Math.max(1, opts.reps ?? 1);
  const results: CodexCaseResult[] = [];

  for (const c of cases) {
    log(`${pc.dim("case")} ${c.id}: ${c.claim}`);
    const observedAll: CodexObserved[] = [];
    let detail = "";
    let tokens = 0;
    let unobservable = false;

    for (let rep = 0; rep < reps; rep++) {
      const dir = await materialize(c);
      try {
        const run = await runCodex(c.task, {
          cwd: dir,
          sandbox: c.sandbox,
          model: opts.model,
          ignoreUserConfig: true,
          timeoutMs: opts.timeoutMs ?? 4 * 60_000,
          onProgress: (m) => log(pc.dim(`    ${m}`)),
        });
        tokens += (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);

        if (run.error && !run.events.length && !run.finalText) {
          observedAll.push("error");
          detail = run.error;
          continue;
        }

        // The effect is the measurement, and for Codex it is the only one.
        // Measured 2026-09-20: when the sandbox confines a command, Codex emits
        // no command_execution item at all. The stream shows the agent saying
        // the write failed and nothing else. So a blocked attempt and a decline
        // are indistinguishable from the runtime's own record, and the honest
        // report is "the effect did not happen", not "the sandbox blocked it".
        const happened = await c.effectHappened(dir);
        observedAll.push(happened ? "allowed" : "confined");
        const observable = run.events.length > 0;
        if (!observable) unobservable = true;
        if (!detail || happened !== (c.expected === "allowed")) {
          const failures = run.events.filter((e) => e.outcome === "failed").map((e) => String((e.result ?? "").split("\n")[0] ?? "").slice(0, 100));
          detail = happened
            ? "the effect happened: the sandbox did not stand in the way"
            : observable
              ? `the effect did not happen${failures.length ? `; the command reported: ${failures[0]}` : ""}`
              : "the effect did not happen, and Codex recorded no command, so this cannot be told apart from the agent declining";
        }
      } finally {
        await fs.rm(path.dirname(dir), { recursive: true, force: true });
      }
    }

    const distinct = [...new Set(observedAll)];
    const unstable = distinct.length > 1;
    const observed: CodexObserved = unstable ? (distinct.includes("allowed") ? "allowed" : distinct[0]!) : distinct[0]!;
    const agrees = !unstable && observed === c.expected;
    if (unstable) detail = `not the same across ${reps} runs: ${observedAll.join(", ")}. ${detail}`;
    results.push({ case: c, observed, observedAll, agrees, unstable, detail, tokens, unobservable });

    const tag = unstable ? pc.red("UNSTABLE") : observed === "error" || observed === "not-attempted" ? pc.yellow(observed) : agrees ? pc.green("agrees") : pc.red("DISAGREES");
    log(`  ${tag} expected ${c.expected}, observed ${unstable ? observedAll.join("/") : observed}${agrees ? "" : pc.dim(` · ${detail}`)}`);
  }

  const conclusive = results.filter((r) => !r.unstable && r.observed !== "error" && r.observed !== "not-attempted");
  return {
    at: new Date().toISOString(),
    reps,
    runtime: { codex: version },
    results,
    agreed: conclusive.filter((r) => r.agrees).length,
    disagreed: conclusive.filter((r) => !r.agrees).length,
    unstable: results.filter((r) => r.unstable).length,
    inconclusive: results.length - conclusive.length - results.filter((r) => r.unstable).length,
    caveats: [
      "Codex confines rather than refusing, so 'blocked' here means the effect did not happen, not that a call was denied.",
      "These cases ran on this machine, not in a container, because the thing under test is Codex's own sandbox. They are chosen so that a total sandbox failure changes nothing outside a temporary directory.",
      "This machine's Codex configuration was ignored, so a result describes the sandbox flag and not a local setting.",
      "Hooks are not covered. paperfence does not yet know how to observe a Codex hook blocking a call, so it does not claim to.",
      "When the sandbox confines a command, Codex emits no record of that command. paperfence can see that the effect did not happen and cannot see what was attempted, which is a real limit on what any tool can report about a Codex run.",
    ],
  };
}

export function renderCodexConformance(r: CodexConformanceReport): string {
  const out: string[] = [""];
  out.push(pc.bold("paperfence conformance") + pc.dim(`  Codex ${r.runtime.codex ?? "?"} · what its sandbox actually confines`));
  out.push("");

  for (const x of r.results) {
    const tag = x.unstable ? pc.red("unstable") : x.observed === "error" || x.observed === "not-attempted" ? pc.yellow(x.observed) : x.agrees ? pc.green("agrees  ") : pc.red("DISAGREE");
    out.push(`  ${tag} ${x.case.claim}`);
    out.push(`           ${pc.dim(`sandbox ${x.case.sandbox} · expected ${x.case.expected} · ${x.detail}`)}`);
    if (x.unobservable) out.push(`           ${pc.yellow("note")} ${pc.dim("Codex kept no record of the command, so paperfence saw the outcome and not the attempt")}`);
  }
  out.push("");

  const gaps = r.results.filter((x) => x.agrees && x.case.gap);
  if (gaps.length) {
    out.push(pc.bold("Confirmed gaps"));
    for (const g of gaps) out.push(`  ${pc.dim("·")} ${g.case.claim}`);
    out.push("");
  }

  out.push(pc.bold("Result"));
  out.push(`  ${pc.green("agree")}        ${String(r.agreed).padStart(3)}`);
  out.push(`  ${r.disagreed ? pc.red("disagree") : pc.dim("disagree")}     ${String(r.disagreed).padStart(3)}`);
  out.push(`  ${r.unstable ? pc.red("unstable") : pc.dim("unstable")}     ${String(r.unstable).padStart(3)}`);
  out.push(`  ${pc.dim("not settled")}  ${String(r.inconclusive).padStart(3)}`);
  out.push("");
  out.push(pc.bold("What this does not cover"));
  for (const c of r.caveats) out.push(`  ${pc.dim("·")} ${pc.dim(c)}`);
  out.push("");
  return out.join("\n");
}
