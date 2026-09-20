import pc from "picocolors";
import type { Grade, RuleVerdict, ScanReport } from "../types.js";
import { fingerprintLine } from "../fingerprint.js";
import { scopeLine } from "../verdict.js";

const BADGE: Record<Grade, string> = {
  GATE: pc.bgGreen(pc.black(" GATE ")),
  WISH: pc.bgYellow(pc.black(" WISH ")),
  BROKEN: pc.bgRed(pc.white(" BROKEN ")),
  UNTESTED: pc.bgWhite(pc.black(" ? ")),
  ERROR: pc.bgMagenta(pc.white(" ERROR ")),
  NOT_APPLICABLE: pc.bgBlack(pc.white(" N/A ")),
};

function sourceLabel(v: RuleVerdict): string {
  const s = v.rule.source;
  if (s.kind === "prose") return `${s.file}${s.line ? ":" + s.line : ""}`;
  if (s.kind === "permission") return `${s.file} (${s.list})`;
  return `${s.file} (hook)`;
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur.trim());
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

export function renderTerminal(report: ScanReport): string {
  const out: string[] = [];
  const { totals } = report;
  const attackable = totals.gate + totals.wish + totals.broken;
  const restated = report.verdicts.filter((v) => v.restates).length;
  out.push("");
  out.push(pc.bold(`paperfence ${report.mode === "attack" ? "attack" : "scan"}`) + pc.dim(`  ${report.repo}`));
  out.push("");

  if (report.profile) {
    out.push(pc.dim(`  ${report.profile.line}`));
    out.push("");
  }

  const order: Grade[] = ["BROKEN", "WISH", "GATE", "ERROR", "NOT_APPLICABLE", "UNTESTED"];
  const sorted = [...report.verdicts].sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade));
  for (const v of sorted) {
    const badge = BADGE[v.grade];
    out.push(`${badge} ${pc.bold(v.rule.text)}`);
    out.push(`         ${pc.dim(sourceLabel(v))}${v.restates ? pc.dim(`  ·  the same control as "${v.restates.ruleId}" in ${v.restates.where}; counted once`) : ""}`);
    out.push(`         ${wrap(v.summary, 90, "         ")}`);
    if (v.evidence && v.evidence.trials > 0) out.push(pc.dim(`         evidence: ${wrap(scopeLine(v.evidence), 90, "         ")}`));
    if (v.grade === "BROKEN" && v.runs.length) {
      const run = v.runs.find((r) => r.violated);
      if (run) {
        for (const e of run.violationEvidence.slice(0, 3)) out.push(`         ${pc.red("▸")} ${e}`);
      }
    }
    out.push("");
  }

  const pct = (n: number) => (attackable ? Math.round((100 * n) / attackable) : 0);
  const denom = pc.dim(`of ${attackable} rule${attackable === 1 ? "" : "s"} we could test here`);
  out.push(pc.bold("Fence report"));
  out.push(`  ${pc.green("gates")}   ${String(totals.gate).padStart(3)}   ${pc.dim(`${pct(totals.gate)}% ${denom}: a control would stop the violation`)}`);
  out.push(`  ${pc.yellow("wishes")}  ${String(totals.wish).padStart(3)}   ${pc.dim(`${pct(totals.wish)}% rely entirely on the agent choosing to obey`)}`);
  if (report.mode === "attack" || totals.broken) {
    out.push(`  ${pc.red("broken")}  ${String(totals.broken).padStart(3)}   ${pc.dim(`${pct(totals.broken)}% were violated in a live run`)}`);
  }
  if (totals.error) out.push(`  ${pc.magenta("error")}   ${String(totals.error).padStart(3)}   ${pc.dim("live runs did not complete; no verdict")}`);
  if (totals.notApplicable) out.push(`  ${pc.dim("n/a")}     ${String(totals.notApplicable).padStart(3)}   ${pc.dim("this repository has nothing the scenario needs; not a statement that the rule holds")}`);
  if (totals.untested) out.push(`  ${pc.dim("untested")} ${String(totals.untested).padStart(2)}   ${pc.dim("could not be mapped to a check")}`);
  if (restated) out.push(`  ${pc.dim("restated")} ${String(restated).padStart(2)}   ${pc.dim("the same control written twice (a rule and the settings entry backing it); counted once")}`);
  out.push("");
  if (totals.wish + totals.broken > 0) {
    out.push(pc.dim(`Run ${pc.reset("paperfence harden")} to turn wishes into gates, then scan again.`));
    out.push("");
  }
  const uncovered = (report.runtimes ?? []).filter((r) => !r.covered);
  if (uncovered.length) {
    out.push(pc.bold("Runtimes this report does not cover"));
    for (const r of uncovered) {
      out.push(`  ${pc.yellow(r.label)} ${pc.dim(`(${r.markers.join(", ")})`)}`);
      out.push(`         ${wrap(r.notes, 90, "         ")}`);
    }
    out.push(pc.dim("  Nothing above is a verdict about these. paperfence read their configuration and stopped there."));
    out.push("");
  }
  if (report.fingerprint) {
    out.push(pc.dim(fingerprintLine(report.fingerprint)));
    out.push("");
  }
  return out.join("\n");
}
