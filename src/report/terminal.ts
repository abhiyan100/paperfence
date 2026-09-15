import pc from "picocolors";
import type { Grade, RuleVerdict, ScanReport } from "../types.js";

const BADGE: Record<Grade, string> = {
  GATE: pc.bgGreen(pc.black(" GATE ")),
  WISH: pc.bgYellow(pc.black(" WISH ")),
  BROKEN: pc.bgRed(pc.white(" BROKEN ")),
  UNTESTED: pc.bgWhite(pc.black(" ? ")),
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
  out.push("");
  out.push(pc.bold(`paperfence ${report.mode === "attack" ? "attack" : "scan"}`) + pc.dim(`  ${report.repo}`));
  out.push("");

  const order: Grade[] = ["BROKEN", "WISH", "GATE", "UNTESTED"];
  const sorted = [...report.verdicts].sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade));
  for (const v of sorted) {
    const badge = BADGE[v.grade];
    out.push(`${badge} ${pc.bold(v.rule.text)}`);
    out.push(`         ${pc.dim(sourceLabel(v))}`);
    out.push(`         ${wrap(v.summary, 90, "         ")}`);
    if (v.grade === "BROKEN" && v.runs.length) {
      const run = v.runs.find((r) => r.violated);
      if (run) {
        for (const e of run.violationEvidence.slice(0, 3)) out.push(`         ${pc.red("▸")} ${e}`);
      }
    }
    out.push("");
  }

  const pct = (n: number) => (attackable ? Math.round((100 * n) / attackable) : 0);
  out.push(pc.bold("Fence report"));
  out.push(`  ${pc.green("gates")}   ${String(totals.gate).padStart(3)}   ${pc.dim(`${pct(totals.gate)}% of rules would stop a misbehaving agent`)}`);
  out.push(`  ${pc.yellow("wishes")}  ${String(totals.wish).padStart(3)}   ${pc.dim(`${pct(totals.wish)}% rely entirely on the agent choosing to obey`)}`);
  if (report.mode === "attack" || totals.broken) {
    out.push(`  ${pc.red("broken")}  ${String(totals.broken).padStart(3)}   ${pc.dim(`${pct(totals.broken)}% were violated in a live run`)}`);
  }
  if (totals.untested) out.push(`  ${pc.dim("untested")} ${String(totals.untested).padStart(2)}   ${pc.dim("could not be mapped to a check")}`);
  out.push("");
  if (totals.wish + totals.broken > 0) {
    out.push(pc.dim(`Run ${pc.reset("paperfence harden")} to turn wishes into gates, then scan again.`));
    out.push("");
  }
  return out.join("\n");
}
