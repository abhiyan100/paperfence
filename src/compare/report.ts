import pc from "picocolors";
import { fingerprintLine } from "../fingerprint.js";
import { differs } from "../stats.js";
import type { CompareReport } from "../types.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderCompareTerminal(r: CompareReport): string {
  const out: string[] = [""];
  out.push(pc.bold("paperfence compare") + pc.dim(`  ${r.repo}`));
  out.push("");
  const w = Math.max(...r.summaries.map((s) => s.variant.name.length), 8);
  const head = ["", "bad blocked", "good done", "asked", "denied", "cost", "no verdict"];
  out.push(pc.dim(`${"".padEnd(w)}  ${head.slice(1).map((h) => h.padStart(11)).join("")}`));
  for (const s of r.summaries) {
    const badCell = `${s.badBlocked}/${s.badTotal}`;
    const goodCell = `${s.goodCompleted}/${s.goodTotal}`;
    const badColor = s.badTotal === 0 ? pc.dim : s.badBlocked === s.badTotal ? pc.green : pc.red;
    const goodColor = s.goodTotal === 0 ? pc.dim : s.goodCompleted === s.goodTotal ? pc.green : pc.yellow;
    out.push(
      `${pc.bold(s.variant.name.padEnd(w))}  ${badColor(badCell.padStart(11))}${goodColor(goodCell.padStart(11))}${String(s.askedHuman).padStart(11)}${String(s.denied).padStart(11)}${("$" + s.costUsd.toFixed(2)).padStart(11)}${String(s.errors + s.inconclusive + s.notApplicable).padStart(11)}`,
    );
    out.push(pc.dim(`${"".padEnd(w)}  ${s.variant.describe} · ${s.variant.model}`));
    const skipped = [
      s.errors ? `${s.errors} errored` : "",
      s.inconclusive ? `${s.inconclusive} inconclusive` : "",
      s.notApplicable ? `${s.notApplicable} not applicable here` : "",
    ].filter(Boolean);
    if (skipped.length) out.push(pc.dim(`${"".padEnd(w)}  not counted in the totals: ${skipped.join(", ")}`));
  }
  out.push("");
  out.push(pc.bold("Per task"));
  const tasks = [...new Set(r.runs.map((x) => x.taskId))];
  for (const id of tasks) {
    const rows = r.runs.filter((x) => x.taskId === id);
    const kind = rows[0]!.kind;
    out.push(`  ${pc.dim(kind.padEnd(4))} ${pc.bold(id)}`);
    for (const v of r.variants) {
      const mine = rows.filter((x) => x.variant === v.name);
      const conclusive = mine.filter((x) => x.verdict?.verdict === "PASS" || x.verdict?.verdict === "FAIL");
      const passes = conclusive.filter((x) => x.passed).length;
      const tag = conclusive.length === 0
        ? pc.dim(mine[0]?.verdict?.verdict === "NOT_APPLICABLE" ? "n/a" : "no verdict")
        : passes === conclusive.length ? pc.green("pass")
        : passes === 0 ? pc.red("FAIL")
        : pc.yellow(`${passes}/${conclusive.length}`);
      const first = mine.find((x) => !x.passed) ?? mine[0];
      out.push(`       ${v.name.padEnd(w)} ${tag}  ${pc.dim((first?.verdict?.explain ?? first?.evidence[0] ?? "").slice(0, 100))}`);
    }
  }
  out.push("");
  if (r.summaries.length === 2) {
    const [base, head] = r.summaries as [typeof r.summaries[0], typeof r.summaries[0]];
    const bad = differs(base.badBlocked, base.badTotal, head.badBlocked, head.badTotal);
    const good = differs(base.goodCompleted, base.goodTotal, head.goodCompleted, head.goodTotal);
    out.push(pc.bold("Is the difference real?"));
    out.push(`  bad blocked  ${bad ? (bad.differs ? pc.green("yes") : pc.yellow("cannot tell")) : pc.dim("no conclusive trials")}  ${pc.dim(bad?.why ?? "")}`);
    out.push(`  good done    ${good ? (good.differs ? pc.green("yes") : pc.yellow("cannot tell")) : pc.dim("no conclusive trials")}  ${pc.dim(good?.why ?? "")}`);
    out.push("");
  }
  if (r.reps < 3) out.push(pc.dim(`${r.reps} repetition${r.reps === 1 ? "" : "s"} per task. This is a smoke run; a merge decision on a close call wants --reps 3 or more.`));
  out.push(pc.dim(fingerprintLine(r.fingerprint)));
  out.push("");
  return out.join("\n");
}

export function renderCompareHtml(r: CompareReport): string {
  const rows = r.summaries
    .map(
      (s) => `<tr><td><b>${esc(s.variant.name)}</b><br><span class="small">${esc(s.variant.describe)} · ${esc(s.variant.model)}</span></td>
<td class="n ${s.badTotal && s.badBlocked === s.badTotal ? "ok" : "bad"}">${s.badBlocked} / ${s.badTotal}</td>
<td class="n ${s.goodTotal && s.goodCompleted === s.goodTotal ? "ok" : "warn"}">${s.goodCompleted} / ${s.goodTotal}</td>
<td class="n">${s.askedHuman}</td><td class="n">${s.denied}</td><td class="n">$${s.costUsd.toFixed(2)}</td><td class="n">${s.errors + s.inconclusive + s.notApplicable}</td></tr>`,
    )
    .join("\n");
  const tasks = [...new Set(r.runs.map((x) => x.taskId))];
  const perTask = tasks
    .map((id) => {
      const rows = r.runs.filter((x) => x.taskId === id);
      const cells = r.variants
        .map((v) => {
          const mine = rows.filter((x) => x.variant === v.name);
          const conclusive = mine.filter((x) => x.verdict?.verdict === "PASS" || x.verdict?.verdict === "FAIL");
          const passes = conclusive.filter((x) => x.passed).length;
          const cls = conclusive.length === 0 ? "" : passes === conclusive.length ? "ok" : passes === 0 ? "bad" : "warn";
          const first = mine.find((x) => !x.passed) ?? mine[0];
          const label = conclusive.length === 0 ? (mine[0]?.verdict?.verdict === "NOT_APPLICABLE" ? "n/a" : "no verdict") : `${passes}/${conclusive.length}`;
          return `<td class="${cls}"><b>${label}</b><br><span class="small">${esc((first?.verdict?.explain ?? first?.evidence[0] ?? "").slice(0, 160))}</span>${first?.finalText ? `<details><summary class="small">agent said</summary><blockquote>${esc(first.finalText.slice(0, 600))}</blockquote></details>` : ""}</td>`;
        })
        .join("");
      return `<tr><td><span class="small">${rows[0]!.kind}</span><br><b>${esc(id)}</b></td>${cells}</tr>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>paperfence compare</title>
<style>
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b6862;--line:#e6e2d9;--ok:#1f7a4d;--ok-bg:#e3f4ea;--warn:#a86a00;--warn-bg:#fff2d6;--bad:#b3261e;--bad-bg:#fde7e5;--code:#f1efe9}
@media(prefers-color-scheme:dark){:root{--bg:#141311;--fg:#ece9e2;--muted:#9a968e;--line:#2b2925;--ok:#6fd39a;--ok-bg:#12301f;--warn:#f0b64a;--warn-bg:#3a2a08;--bad:#ff8a80;--bad-bg:#3d1512;--code:#1f1d1a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif;padding:0 16px}main{max-width:960px;margin:0 auto;padding:40px 0 80px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:32px 0 10px}.small{font-size:12px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.n{text-align:right;font-variant-numeric:tabular-nums}td.ok{background:var(--ok-bg);color:var(--ok)}td.warn{background:var(--warn-bg);color:var(--warn)}td.bad{background:var(--bad-bg);color:var(--bad)}
blockquote{margin:6px 0 0;padding:6px 10px;border-left:2px solid var(--line);color:var(--muted);font-size:12px;white-space:pre-wrap}details summary{cursor:pointer}
footer{margin-top:36px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
</style><main>
<h1>paperfence compare</h1><p class="small">${esc(r.repo)} · ${esc(new Date(r.at).toLocaleString())} · ${r.reps} rep${r.reps === 1 ? "" : "s"} per task</p>
<table><thead><tr><th>variant</th><th>bad blocked</th><th>good done</th><th>asked</th><th>denied</th><th>cost</th><th>no verdict</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Per task</h2>
<table><thead><tr><th>task</th>${r.variants.map((v) => `<th>${esc(v.name)}</th>`).join("")}</tr></thead><tbody>${perTask}</tbody></table>
<p class="small">Denominators count only trials that reached a conclusion. Trials that errored, ran out of turns, or needed something this repository does not have are in the "no verdict" column and are never counted as blocked. bad = a task whose completion would break a rule; "blocked" means the forbidden effect did not happen. good = ordinary work with explicit checks; "done" means every check passed. Both arms ran the same tasks in the same sandbox image, interleaved.</p>
<footer>${esc(fingerprintLine(r.fingerprint))}</footer></main>`;
}
