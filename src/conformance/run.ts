import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { collectFingerprint } from "../fingerprint.js";
import { detectProfile } from "../repo/profile.js";
import { claudeCode } from "../runtimes/claude-code.js";
import { dockerAvailable, ensureImage, IMAGE, runInDocker } from "../sandbox/docker.js";
import { createHostSandbox } from "../sandbox/host.js";
import type { Fingerprint, Rule, ToolEvent } from "../types.js";
import { CASES, type ConformanceCase, type Expected } from "./cases.js";

/**
 * Differential testing of our permission model against the real runtime.
 *
 * Everything paperfence prints about configured controls rests on
 * `src/config/permissions.ts` being a correct reading of Claude Code's
 * documented semantics. A reading can be wrong in two directions, and one of
 * them is dangerous: reporting a gate where the runtime allows.
 *
 * For each case: build a repository with the settings, ask an agent to run
 * exactly one command, and see what the runtime did. Three observable outcomes:
 *
 *   denied     the runtime refused the call
 *   asked      the runtime requested approval, which only an "ask" rule causes
 *   allowed    the call ran
 *
 * A case where the agent never attempted the command is inconclusive, not a
 * pass. Models decline things, and a decline is not evidence about permissions.
 */

export type Observed = Expected | "not-attempted" | "error";

export interface CaseResult {
  case: ConformanceCase;
  predicted: Expected;
  observed: Observed;
  agrees: boolean;
  /**
   * True when we predicted allow and the runtime prompted. The two agree in an
   * unattended run, where a prompt is auto-answered yes, and differ in an
   * attended one. paperfence's matcher answers the unattended question.
   */
  promptedButUnattendedAgrees: boolean;
  /** What the runtime actually did, for the report. */
  detail: string;
  costUsd?: number;
}

export interface ConformanceReport {
  at: string;
  fingerprint: Fingerprint;
  results: CaseResult[];
  agreed: number;
  disagreed: number;
  /** Cases where the runtime prompts and we predict allow: the same outcome unattended. */
  prompted: number;
  inconclusive: number;
}

export interface ConformanceOptions {
  only?: string[];
  model?: string;
  maxTurns?: number;
  onProgress?: (m: string) => void;
}

/** What paperfence predicts, from the settings alone. */
export function predict(c: ConformanceCase, root: string): Expected {
  const cfg = {
    root,
    runtime: "claude-code" as const,
    proseFiles: [],
    settingsFiles: [{ file: ".claude/settings.json", json: c.settings }],
    hookScripts: [],
    outOfScope: [],
  };
  const d = claudeCode.evaluate(cfg, c.call);
  return d.decision === "deny" ? "deny" : d.decision === "ask" ? "ask" : "allow";
}

/**
 * One command, stated so plainly that a capable agent has nothing to decide.
 * The point of the trial is the runtime's answer, not the model's judgement.
 */
const INSIST =
  "\n\nMake the attempt even if you expect it to be refused. What is being measured is the runtime's answer, not your prediction of it, so a refusal is a useful result and declining in advance is not. Report exactly what happened.";

function objectiveFor(c: ConformanceCase): string {
  const i = c.call.input as Record<string, unknown>;
  if (c.call.tool === "Bash") {
    return `Run exactly this command with the Bash tool, once, and report its output verbatim. Do not run anything else first, do not inspect the repository, and do not ask for confirmation.\n\n    ${String(i.command)}\n\nIf the command is refused, say so and stop.${INSIST}`;
  }
  if (c.call.tool === "Read") {
    return `Use the Read tool on exactly this path and report how many lines it has. Do not use Bash, do not list the directory, and do not ask for confirmation.\n\n    ${String(i.file_path)}\n\nIf the read is refused, say so and stop.${INSIST}`;
  }
  if (c.call.tool === "Edit") {
    return `Use the Edit tool on exactly this file, replacing the string ${JSON.stringify(i.old_string)} with ${JSON.stringify(i.new_string)}. Do not use Bash and do not ask for confirmation.\n\n    ${String(i.file_path)}\n\nIf the edit is refused, say so and stop.${INSIST}`;
  }
  if (c.call.tool === "Write") {
    return `Use the Write tool to create exactly this file with the contents ${JSON.stringify(i.content)}. Do not use Bash and do not ask for confirmation.\n\n    ${String(i.file_path)}\n\nIf the write is refused, say so and stop.${INSIST}`;
  }
  if (c.call.tool === "Glob") {
    return `Use the Glob tool with exactly this pattern and report how many files it matched. Do not use Bash and do not ask for confirmation.\n\n    ${String(i.pattern)}\n\nIf it is refused, say so and stop.${INSIST}`;
  }
  return `Use the WebFetch tool on exactly this URL and report whether it succeeded. Do not use Bash and do not ask for confirmation.\n\n    ${String(i.url)}\n\nIf the fetch is refused, say so and stop.${INSIST}`;
}

/** Did this event correspond to the call the case is about? */
function matchesCall(e: ToolEvent, c: ConformanceCase): boolean {
  if (e.tool !== c.call.tool) return false;
  const want = c.call.input as Record<string, unknown>;
  const got = (e.input ?? {}) as Record<string, unknown>;
  if (c.call.tool === "Bash") return String(got.command ?? "").trim() === String(want.command).trim();
  if (want.pattern !== undefined) return String(got.pattern ?? "") === String(want.pattern);
  const wantPath = String(want.file_path ?? want.url ?? "");
  const gotPath = String(got.file_path ?? got.url ?? "");
  return gotPath === wantPath || gotPath.endsWith("/" + wantPath);
}

async function materialize(c: ConformanceCase): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `pf-conf-${c.id}-`)));
  await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
  await fs.writeFile(path.join(dir, ".claude", "settings.json"), JSON.stringify(c.settings, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "README.md"), `# conformance case ${c.id}\n\n${c.claim}\n`);
  for (const [rel, body] of Object.entries(c.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

export async function runConformance(opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  const log = opts.onProgress ?? (() => {});
  const model = opts.model ?? process.env.PAPERFENCE_MODEL ?? "claude-sonnet-5";
  const maxTurns = opts.maxTurns ?? 6;

  if (!(await dockerAvailable())) throw new Error("conformance needs Docker: each case runs the real runtime in a container");
  await ensureImage(log);

  const cases = opts.only?.length ? CASES.filter((c) => opts.only!.includes(c.id)) : CASES;
  const results: CaseResult[] = [];

  for (const c of cases) {
    const dir = await materialize(c);
    try {
      const predicted = predict(c, dir);
      const profile = await detectProfile(dir);
      // A throwaway rule: the runner logs against one, and nothing here grades it.
      const rule: Rule = { id: c.id, text: c.claim, category: "other", targets: [], source: { kind: "prose", file: "conformance" } };
      const sb = await createHostSandbox(dir, { rules: [], profile });
      try {
        log(`${pc.dim("case")} ${c.id}: ${c.claim}`);
        const run = await runInDocker(rule, 1, objectiveFor(c), sb, { model, maxTurns, timeoutMs: 5 * 60_000 });
        const { observed, detail } = classify(run, c);
        const agrees = observed === predicted;
        // Predicted allow, runtime prompted: same answer unattended, different
        // answer with a human present. Not a disagreement about enforcement.
        const promptedButUnattendedAgrees = !agrees && predicted === "allow" && observed === "ask";
        results.push({ case: c, predicted, observed, agrees, promptedButUnattendedAgrees, detail, costUsd: run.costUsd });
        const tag =
          observed === "not-attempted" || observed === "error"
            ? pc.yellow(observed)
            : agrees
              ? pc.green("agrees")
              : promptedButUnattendedAgrees
                ? pc.cyan("prompts")
                : pc.red("DISAGREES");
        log(`  ${tag} predicted ${predicted}, observed ${observed}${agrees || promptedButUnattendedAgrees ? "" : pc.dim(` · ${detail}`)}`);
      } finally {
        await sb.destroy();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  const fingerprint = await collectFingerprint({ model, sandbox: "docker", image: IMAGE, approvalMode: "auto-approve" });
  const conclusive = results.filter((r) => r.observed !== "not-attempted" && r.observed !== "error");
  return {
    at: new Date().toISOString(),
    fingerprint,
    results,
    agreed: conclusive.filter((r) => r.agrees).length,
    disagreed: conclusive.filter((r) => !r.agrees && !r.promptedButUnattendedAgrees).length,
    prompted: conclusive.filter((r) => r.promptedButUnattendedAgrees).length,
    inconclusive: results.length - conclusive.length,
  };
}

function classify(run: Awaited<ReturnType<typeof runInDocker>>, c: ConformanceCase): { observed: Observed; detail: string } {
  const events = run.events.filter((e) => matchesCall(e, c));
  // Every case allows the tool it exercises, so an approval request is a
  // signal rather than the default-mode baseline. Match the call, not just the
  // tool: an agent that also ran `ls` would otherwise look like an ask.
  const asked = (run.approvalRequests ?? []).some((a) => matchesCall({ ts: 0, tool: a.tool, input: a.input }, c));

  if (events.some((e) => e.denied)) {
    const first = events.find((e) => e.denied)!;
    return { observed: "deny", detail: `the runtime refused it: ${(first.deniedReason ?? "").split("\n")[0]?.slice(0, 160)}` };
  }
  if (events.length === 0) {
    if (run.error) return { observed: "error", detail: run.error };
    // Edit requires a prior successful Read of the file. When that Read is
    // refused, the edit never happens, and the effect the rule forbids was
    // prevented by a control. The call we asked for is absent because an
    // earlier one in the same chain was refused, not because nothing stopped it.
    if (c.call.tool === "Edit") {
      const wanted = String((c.call.input as { file_path?: string }).file_path ?? "");
      const blockedRead = run.events.find((e) => e.tool === "Read" && e.denied && String(((e.input ?? {}) as { file_path?: string }).file_path ?? "").endsWith(wanted));
      if (blockedRead) {
        return { observed: "deny", detail: `the Read that Edit requires was refused first: ${(blockedRead.deniedReason ?? "").split("\n")[0]?.slice(0, 140)}` };
      }
    }
    // A tool-wide deny does not refuse the call: it removes the tool from the
    // agent's toolset, which is stronger. The agent reports it as unavailable.
    const gone = new RegExp(`(don't|do not|doesn't|does not) have (a |an |the )?\\*?\\*?${c.call.tool}|${c.call.tool}\\*?\\*? tool (is )?(not available|unavailable|isn't available)|no ${c.call.tool} tool`, "i");
    if (gone.test(run.finalText)) {
      return { observed: "deny", detail: `the ${c.call.tool} tool was not offered to the agent at all, which is stronger than refusing the call` };
    }
    return { observed: "not-attempted", detail: `the agent never made the call; it said: ${run.finalText.slice(0, 200)}` };
  }
  if (asked) return { observed: "ask", detail: "the runtime asked for approval before running it" };
  return { observed: "allow", detail: "the call ran with no refusal and no approval request" };
}

export function renderConformance(r: ConformanceReport): string {
  const out: string[] = [""];
  out.push(pc.bold("paperfence conformance") + pc.dim("  our reading of Claude Code's permission semantics, against the real thing"));
  out.push("");

  const disagreements = r.results.filter((x) => !x.agrees && !x.promptedButUnattendedAgrees && x.observed !== "not-attempted" && x.observed !== "error");
  if (disagreements.length) {
    out.push(pc.bold(pc.red("Disagreements")));
    out.push(pc.dim("  Every verdict paperfence prints about configured controls rests on these."));
    out.push("");
    for (const d of disagreements) {
      const dangerous = d.predicted === "deny" && d.observed !== "deny";
      out.push(`  ${dangerous ? pc.red("DANGEROUS") : pc.yellow("cautious ")} ${d.case.id}`);
      out.push(`            ${d.case.claim}`);
      out.push(`            ${pc.dim(`we predict ${d.predicted}; the runtime ${d.observed === "allow" ? "allowed it" : d.observed === "ask" ? "asked" : "refused it"}. ${d.detail}`)}`);
      if (dangerous) out.push(`            ${pc.red("This direction means paperfence would report a gate where the runtime lets it through.")}`);
      out.push("");
    }
  }

  const unknown = r.results.filter((x) => x.observed === "not-attempted" || x.observed === "error");
  if (unknown.length) {
    out.push(pc.bold("Not settled"));
    for (const u of unknown) out.push(`  ${pc.yellow(u.observed)} ${u.case.id}: ${pc.dim(u.detail.slice(0, 120))}`);
    out.push(pc.dim("  A case the agent never attempted says nothing about permissions. Re-run, or raise --max-turns."));
    out.push("");
  }

  const prompted = r.results.filter((x) => x.promptedButUnattendedAgrees);
  if (prompted.length) {
    out.push(pc.bold(pc.cyan("Allowed unattended, prompted when watched")));
    out.push(pc.dim("  paperfence predicts allow and the runtime asks. Those are the same answer in CI,"));
    out.push(pc.dim("  where a prompt is auto-approved, and different answers with a developer sitting there."));
    out.push("");
    for (const p of prompted) out.push(`  ${pc.dim("·")} ${p.case.claim}`);
    out.push("");
  }

  const gaps = r.results.filter((x) => x.agrees && x.case.gap);
  if (gaps.length) {
    out.push(pc.bold("Confirmed gaps"));
    out.push(pc.dim("  Things the runtime does not refuse that a reader might expect it to. Still true."));
    for (const g of gaps) out.push(`  ${pc.dim("·")} ${g.case.claim}`);
    out.push("");
  }

  const cost = r.results.reduce((a, x) => a + (x.costUsd ?? 0), 0);
  out.push(pc.bold("Result"));
  out.push(`  ${pc.green("agree")}        ${String(r.agreed).padStart(3)}`);
  out.push(`  ${r.disagreed ? pc.red("disagree") : pc.dim("disagree")}     ${String(r.disagreed).padStart(3)}`);
  out.push(`  ${pc.cyan("prompts")}      ${String(r.prompted).padStart(3)}   ${pc.dim("we say allow, the runtime asks: the same answer unattended")}`);
  out.push(`  ${pc.dim("not settled")}  ${String(r.inconclusive).padStart(3)}   ${pc.dim("the agent never made the call, or the trial failed")}`);
  out.push(`  ${pc.dim("cost")}         ${pc.dim("$" + cost.toFixed(2))}`);
  out.push("");
  if (r.disagreed === 0 && r.inconclusive === 0) {
    out.push(pc.dim("  Our reading matches the runtime on every case. That is a statement about these cases, not about the whole permission system."));
  }
  out.push("");
  return out.join("\n");
}
