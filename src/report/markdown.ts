import { profileLine } from "../repo/profile.js";
import { fingerprintLine } from "../fingerprint.js";
import { scopeLine } from "../verdict.js";
import type { CompareReport, Grade, ScanReport } from "../types.js";
import { differs } from "../stats.js";

/**
 * Markdown for a pull request comment or a CI job summary.
 *
 * Written for someone who did not run the command and will read it once, in a
 * narrow column, while deciding whether to merge. The first line has to be the
 * answer. Everything a reader might want to check comes after, in a fold.
 */

const GRADE_EMOJI: Record<Grade, string> = {
  BROKEN: "🔴",
  WISH: "🟡",
  GATE: "🟢",
  ERROR: "🟣",
  NOT_APPLICABLE: "⚪",
  UNTESTED: "⚪",
};

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function scanMarkdown(report: ScanReport): string {
  const t = report.totals;
  const tested = t.gate + t.wish + t.broken;
  const out: string[] = [];

  // Nothing concluded is not the same as nothing wrong. A report where every
  // trial errored used to read "All 0 testable rules have a control behind
  // them", which is a green headline for a run that measured nothing.
  const headline =
    t.broken > 0
      ? `**${t.broken} of ${tested} rule${tested === 1 ? "" : "s"} ${t.broken === 1 ? "was" : "were"} broken in a live run.**`
      : tested === 0
        ? t.error > 0
          ? `**Nothing was measured: ${t.error} rule${t.error === 1 ? "" : "s"} could not be checked because the trials did not complete.**`
          : t.notApplicable > 0
            ? `**Nothing was measured: this repository has none of the prerequisites the ${t.notApplicable} rule${t.notApplicable === 1 ? "" : "s"} would need.**`
            : `**No rule in this repository could be mapped to a mechanical check.**`
        : t.wish > 0
          ? `**${t.wish} of ${tested} rule${tested === 1 ? "" : "s"} ${t.wish === 1 ? "has" : "have"} nothing mechanical behind ${t.wish === 1 ? "it" : "them"}.**`
          : `**All ${tested} testable rule${tested === 1 ? " has" : "s have"} a control behind ${tested === 1 ? "it" : "them"}.**`;

  out.push(`### paperfence`);
  out.push("");
  out.push(headline);
  out.push("");
  if (report.profile) out.push(`<sub>${esc(report.profile.line)}</sub>`);
  out.push("");

  const order: Grade[] = ["BROKEN", "WISH", "GATE", "ERROR", "NOT_APPLICABLE", "UNTESTED"];
  const sorted = [...report.verdicts].sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade));
  const shown = sorted.filter((v) => v.grade === "BROKEN" || v.grade === "WISH").slice(0, 10);

  const errored = sorted.filter((v) => v.grade === "ERROR");
  if (errored.length) {
    out.push(`> **${errored.length} rule${errored.length === 1 ? "" : "s"} could not be checked.** The trials did not complete, so nothing below is a statement about ${errored.length === 1 ? "it" : "them"}.`);
    out.push("");
    for (const v of errored.slice(0, 5)) out.push(`- ${esc(v.rule.text)}: ${esc(v.summary.slice(0, 180))}`);
    out.push("");
  }

  if (shown.length) {
    out.push("| | rule | what stops it |");
    out.push("|---|---|---|");
    for (const v of shown) out.push(`| ${GRADE_EMOJI[v.grade]} | ${esc(v.rule.text)} | ${esc(v.summary.slice(0, 220))} |`);
    out.push("");
    if (sorted.filter((v) => v.grade === "BROKEN" || v.grade === "WISH").length > shown.length) {
      out.push(`<sub>and ${sorted.filter((v) => v.grade === "BROKEN" || v.grade === "WISH").length - shown.length} more.</sub>`);
      out.push("");
    }
  }

  const na = sorted.filter((v) => v.grade === "NOT_APPLICABLE");
  if (na.length) {
    out.push(`<details><summary>${na.length} rule${na.length === 1 ? "" : "s"} could not be tested in this repository</summary>`);
    out.push("");
    for (const v of na) out.push(`- **${esc(v.rule.text)}** ${esc(v.notApplicable?.reason ?? "")}`);
    out.push("");
    out.push("<sub>Not a statement that these hold.</sub>");
    out.push("");
    out.push("</details>");
    out.push("");
  }

  const uncovered = (report.runtimes ?? []).filter((r) => !r.covered);
  if (uncovered.length) {
    out.push(`> **This report does not cover ${uncovered.map((r) => r.label).join(" or ")}.** ${esc(uncovered[0]!.notes)}`);
    out.push("");
  }

  if (report.mode === "attack") {
    const withEvidence = sorted.filter((v) => v.evidence && v.evidence.trials > 0);
    if (withEvidence.length) {
      out.push("<details><summary>What these verdicts are based on</summary>");
      out.push("");
      for (const v of withEvidence) out.push(`- **${esc(v.rule.text.slice(0, 80))}** ${esc(scopeLine(v.evidence!))}`);
      out.push("");
      out.push("</details>");
      out.push("");
    }
  }

  out.push(`<sub>${esc(report.fingerprint ? fingerprintLine(report.fingerprint) : `paperfence ${report.version}`)}</sub>`);
  return out.join("\n");
}

export function compareMarkdown(r: CompareReport): string {
  const out: string[] = [];
  const [base, head] = r.summaries as [(typeof r.summaries)[0] | undefined, (typeof r.summaries)[0] | undefined];
  out.push("### paperfence compare");
  out.push("");

  const nothingRan = r.summaries.every((s) => s.badTotal === 0 && s.goodTotal === 0);
  if (nothingRan) {
    const lost = r.summaries.reduce((a, s) => a + s.errors + s.inconclusive + s.notApplicable, 0);
    out.push(`**Nothing was measured.** No task reached a conclusion in either arm${lost ? ` (${lost} errored, ran out of turns, or needed something this repository does not have)` : ""}, so this run says nothing about the change.`);
    out.push("");
  } else if (base && head) {
    const badWorse = head.badBlocked < base.badBlocked;
    const goodWorse = head.goodCompleted < base.goodCompleted;
    out.push(
      badWorse && goodWorse
        ? "**This change lets more forbidden things through and breaks ordinary work.**"
        : badWorse
          ? "**This change lets more forbidden things through.**"
          : goodWorse
            ? "**This change blocks ordinary work that used to succeed.**"
            : "**No regression: forbidden tasks stay blocked and ordinary work still completes.**",
    );
    out.push("");
  }

  out.push("| variant | bad blocked | good done | asked | denied | cost | no verdict |");
  out.push("|---|---|---|---|---|---|---|");
  for (const s of r.summaries) {
    out.push(
      `| **${esc(s.variant.name)}**<br><sub>${esc(s.variant.describe)}</sub> | ${s.badBlocked}/${s.badTotal} | ${s.goodCompleted}/${s.goodTotal} | ${s.askedHuman} | ${s.denied} | $${s.costUsd.toFixed(2)} | ${s.errors + s.inconclusive + s.notApplicable} |`,
    );
  }
  out.push("");

  if (base && head) {
    const bad = differs(base.badBlocked, base.badTotal, head.badBlocked, head.badTotal);
    const good = differs(base.goodCompleted, base.goodTotal, head.goodCompleted, head.goodTotal);
    out.push("**Can this run tell the two apart?**");
    out.push("");
    out.push(`- bad blocked: ${bad ? (bad.differs ? "yes" : "no") : "no conclusive trials"}. <sub>${esc(bad?.why ?? "")}</sub>`);
    out.push(`- good done: ${good ? (good.differs ? "yes" : "no") : "no conclusive trials"}. <sub>${esc(good?.why ?? "")}</sub>`);
    out.push("");
  }

  const failed = r.runs.filter((x) => x.verdict?.verdict === "FAIL");
  if (failed.length) {
    out.push("<details><summary>What failed</summary>");
    out.push("");
    for (const f of failed.slice(0, 20)) out.push(`- \`${esc(f.taskId)}\` in **${esc(f.variant)}**: ${esc(f.verdict?.explain ?? f.evidence[0] ?? "")}`);
    out.push("");
    out.push("</details>");
    out.push("");
  }

  out.push(`<sub>${r.reps} repetition${r.reps === 1 ? "" : "s"} per task. Denominators count only trials that reached a conclusion. ${esc(fingerprintLine(r.fingerprint))}</sub>`);
  return out.join("\n");
}
