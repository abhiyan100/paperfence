/**
 * Build the static site from data/leaderboard.json into site/.
 *   pnpm tsx scripts/site.ts
 * Deploy with: vercel deploy site --prod   (static, no functions, no keys)
 */
import { promises as fs } from "node:fs";
import path from "node:path";

interface Row {
  repo: string;
  stars: number;
  description: string;
  rules: number;
  gates: number;
  wishes: number;
  untested: number;
  unknown: number;
  wishPct: number;
  hasSettings: boolean;
  hasHooks: boolean;
  sample: { text: string; grade: string; summary: string }[];
  scannedAt: string;
  error?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const slug = (repo: string) => repo.replace("/", "__");

const CSS = `
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b6862;--line:#e6e2d9;--gate:#1f7a4d;--gate-bg:#e3f4ea;--wish:#a86a00;--wish-bg:#fff2d6;--broken:#b3261e;--broken-bg:#fde7e5;--untested-bg:#eeece7;--code:#f1efe9;--accent:#1c1b19}
@media(prefers-color-scheme:dark){:root{--bg:#141311;--fg:#ece9e2;--muted:#9a968e;--line:#2b2925;--gate:#6fd39a;--gate-bg:#12301f;--wish:#f0b64a;--wish-bg:#3a2a08;--broken:#ff8a80;--broken-bg:#3d1512;--untested-bg:#24221f;--code:#1f1d1a;--accent:#ece9e2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px}
main{max-width:920px;margin:0 auto;padding:44px 0 80px}
h1{font-size:34px;margin:0 0 6px;font-weight:650;letter-spacing:-.015em}h2{font-size:20px;margin:36px 0 10px;font-weight:650}
.lede{font-size:18px;color:var(--muted);margin:0 0 22px;max-width:680px}
.big{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0 30px}
.stat{flex:1 1 160px;border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.stat b{display:block;font-size:34px;font-weight:650;line-height:1.05}.stat span{color:var(--muted);font-size:13px}
.stat.wish b{color:var(--wish)}.stat.gate b{color:var(--gate)}
.bar{height:12px;border-radius:7px;overflow:hidden;display:flex;background:var(--untested-bg);margin:0 0 8px}
.bar i{display:block;height:100%}.bar .g{background:var(--gate)}.bar .w{background:var(--wish)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.mini{display:inline-block;width:90px;height:8px;border-radius:5px;overflow:hidden;background:var(--untested-bg);vertical-align:middle;margin-right:6px}.mini i{display:block;height:100%;background:var(--wish);float:left}.mini .g{background:var(--gate)}
a{color:inherit}a.repo{text-decoration:none;font-weight:600}a.repo:hover{text-decoration:underline}
.desc{color:var(--muted);font-size:13px;display:block;max-width:420px}
code{background:var(--code);padding:1px 5px;border-radius:4px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);padding:14px 16px;border-radius:10px;overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.rule{display:flex;gap:14px;border-top:1px solid var(--line);padding:16px 0}
.badge{flex:0 0 74px;text-align:center;font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;border-radius:6px;padding:4px 0;margin-top:3px;align-self:flex-start}
.gate .badge{background:var(--gate-bg);color:var(--gate)}.wish .badge{background:var(--wish-bg);color:var(--wish)}.broken .badge{background:var(--broken-bg);color:var(--broken)}
.rule h3{margin:0 0 4px;font-size:15px;font-weight:600}.rule p{margin:0;color:var(--muted);font-size:13px}
.yesno{font-size:12px;color:var(--muted)}
footer{color:var(--muted);font-size:13px;margin-top:48px;border-top:1px solid var(--line);padding-top:16px}
.small{font-size:13px;color:var(--muted)}
nav a{font-size:13px;color:var(--muted);text-decoration:none}nav a:hover{text-decoration:underline}
@media(max-width:640px){.hide-sm{display:none}}
`;

function page(title: string, body: string, description: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

function mini(r: Row): string {
  const total = r.gates + r.wishes;
  const w = total ? Math.round((100 * r.wishes) / total) : 0;
  return `<span class="mini"><i style="width:${w}%"></i><i class="g" style="width:${100 - w}%"></i></span>`;
}

async function main(): Promise<void> {
  const rows: Row[] = JSON.parse(await fs.readFile("data/leaderboard.json", "utf8"));
  const scanned = rows.filter((r) => !r.error && r.gates + r.wishes + (r.unknown ?? 0) > 0).sort((a, b) => b.stars - a.stars);
  const totalUnknown = scanned.reduce((a, r) => a + (r.unknown ?? 0), 0);
  const totalRules = scanned.reduce((a, r) => a + r.gates + r.wishes, 0);
  const totalWish = scanned.reduce((a, r) => a + r.wishes, 0);
  const totalGate = totalRules - totalWish;
  const pct = totalRules ? Math.round((100 * totalWish) / totalRules) : 0;
  const withSettings = scanned.filter((r) => r.hasSettings).length;
  const withHooks = scanned.filter((r) => r.hasHooks).length;
  const allWish = scanned.filter((r) => r.gates === 0).length;
  const date = new Date().toISOString().slice(0, 10);

  await fs.mkdir("site/r", { recursive: true });

  // Live-attack demo: same repo, two models, side by side.
  let demoLink = "";
  try {
    await fs.copyFile("data/fixture-attack.html", "site/demo-sonnet.html");
    await fs.copyFile("data/fixture-attack-haiku.html", "site/demo-haiku.html");
    type Rep = { verdicts: { rule: { id: string; text: string; category: string }; grade: string; runs: { level: number; violated: boolean; mechanicallyBlocked: boolean; error?: string; violationEvidence: string[] }[] }[] };
    const sonnet = JSON.parse(await fs.readFile("data/fixture-attack.json", "utf8")) as Rep;
    const haiku = JSON.parse(await fs.readFile("data/fixture-attack-haiku.json", "utf8")) as Rep;
    const cell = (v: Rep["verdicts"][number] | undefined) => {
      if (!v || !v.runs.length) return `<td class="small">not run</td>`;
      const broke = v.runs.find((r) => r.violated);
      if (broke) return `<td class="broken"><b>broke at level ${broke.level}</b><br><span class="small">${esc(broke.violationEvidence[0] ?? "")}</span></td>`;
      const blocked = v.runs.find((r) => r.mechanicallyBlocked);
      if (blocked) return `<td class="gate"><b>blocked</b><br><span class="small">by the repo's config</span></td>`;
      return `<td class="wish"><b>held ${v.runs.filter((r) => !r.error).length}/${v.runs.length}</b><br><span class="small">declined every time</span></td>`;
    };
    const ids = new Set([...sonnet.verdicts, ...haiku.verdicts].filter((v) => v.runs.length).map((v) => v.rule.id));
    const rowsHtml = [...ids]
      .map((id) => {
        const sv = sonnet.verdicts.find((v) => v.rule.id === id);
        const hv = haiku.verdicts.find((v) => v.rule.id === id);
        const text = (sv ?? hv)!.rule.text;
        return `<tr><td>${esc(text)}</td>${cell(sv)}${cell(hv)}</tr>`;
      })
      .join("\n");
    const demoPage = page(
      "paperfence · same rules, different model",
      `<nav><a href="index.html">← the fence report</a> · <a href="https://github.com/abhiyan100/paperfence">paperfence on GitHub</a></nav>
<h1>Same rules, different model</h1>
<p class="lede">One small repo with a typical CLAUDE.md: never push to main, never touch tests, never read .env, never run destructive commands, never send data out. Nothing mechanical behind any of them. Two coding agents, three levels of pressure each, in Docker.</p>
<table><thead><tr><th>rule</th><th>Claude Sonnet 5</th><th>Claude Haiku 4.5</th></tr></thead><tbody>${rowsHtml}</tbody></table>
<p class="small">Level 1 is a plain request. Level 2 plants a plausible excuse in a file in the repo. Level 3 is a user who insists the rule does not apply and says not to ask. No jailbreaks. Full transcripts: <a href="demo-sonnet.html">Sonnet run</a> · <a href="demo-haiku.html">Haiku run</a>.</p>
<h2>What this shows</h2>
<p>Every one of those rules is a <b>wish</b>. Whether a wish holds depends on which model is reading it that day, and on how the request is phrased. The rules did not change between the two columns. <code>paperfence harden</code> turns each of them into a gate that does not care which model is running.</p>
<style>td.broken{background:var(--broken-bg)}td.gate{background:var(--gate-bg)}td.wish{background:var(--wish-bg)}</style>`,
      "Same CLAUDE.md, two models: one held every rule, the other pushed to main, edited a test, ran git reset --hard and exfiltrated .env.",
    );
    await fs.writeFile("site/demo.html", demoPage);
    demoLink = `<p class="small">See what happens when a real agent is asked to break these rules: <a href="demo.html">same rules, different model</a>.</p>`;
  } catch (e) {
    process.stderr.write(`demo page skipped: ${(e as Error).message}\n`);
  }

  const tableRows = scanned
    .map(
      (r) => `<tr>
<td><a class="repo" href="r/${slug(r.repo)}.html">${esc(r.repo)}</a><span class="desc hide-sm">${esc(r.description.slice(0, 90))}</span></td>
<td class="n">${r.stars.toLocaleString()}</td>
<td class="n">${r.gates + r.wishes}${r.unknown ? `<span class="small"> +${r.unknown}?</span>` : ""}</td>
<td class="n">${mini(r)}${r.wishPct}%</td>
<td class="yesno hide-sm">${r.hasSettings ? "yes" : "no"}</td>
<td class="yesno hide-sm">${r.hasHooks ? "yes" : "no"}</td>
</tr>`,
    )
    .join("\n");

  const index = page(
    "paperfence · the fence report",
    `
<nav><a href="https://github.com/abhiyan100/paperfence">paperfence on GitHub</a></nav>
<h1>The fence report</h1>
<p class="lede">${scanned.length} public repos with a <code>CLAUDE.md</code>, ranked by stars. For every rule that tells the coding agent what not to do, we checked whether anything mechanical would actually stop it.</p>
<div class="big">
  <div class="stat wish"><b>${pct}%</b><span>of rules are wishes: nothing but the agent's good behaviour enforces them</span></div>
  <div class="stat gate"><b>${100 - pct}%</b><span>are gates: a deny rule or a blocking hook would stop the obvious violation</span></div>
  <div class="stat"><b>${allWish}</b><span>of ${scanned.length} repos have zero gates</span></div>
  <div class="stat"><b>${withHooks}</b><span>repos ship any hook at all (${withSettings} have a settings.json)</span></div>
</div>
<div class="bar"><i class="w" style="width:${pct}%"></i><i class="g" style="width:${100 - pct}%"></i></div>
<p class="small">${totalWish} wishes, ${totalGate} gates across ${totalRules} action rules${totalUnknown ? `, plus ${totalUnknown} rules where a hook is present but was not executed (counted as unknown, not as wishes)` : ""}. Scanned ${date} with <code>paperfence scan --no-hooks</code>: rules read by a model, violations checked against each repo's <code>permissions.deny</code>. We do not run hook scripts from repos we do not own; a rule a hook might cover is marked unknown rather than assumed either way.</p>
<h2>Repos</h2>
<table>
<thead><tr><th>repo</th><th class="n">stars</th><th class="n">rules</th><th class="n">wishes</th><th class="hide-sm">settings</th><th class="hide-sm">hooks</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>
<h2>What this means</h2>
<p>A <b>wish</b> is a rule like "never push to main" with nothing behind it but the sentence. The agent follows it because it is well-behaved, and it will keep following it right up until a user in a hurry, or a note planted in the repo, gives it a reason not to. A <b>gate</b> is a rule that is also backed by a <code>permissions.deny</code> entry or a <code>PreToolUse</code> hook that exits 2, so the tool call fails no matter what the agent decides.</p>
<p>This is not a ranking of who writes good rules. Most of these repos write very sensible rules. It is a measure of how much of that sense is load-bearing.</p>
<h2>Check your own</h2>
<pre>npx paperfence scan .
npx paperfence attack .    # a real agent tries to break each rule, in Docker
npx paperfence harden .    # turn the wishes into gates, then scan again</pre>
${demoLink}
<footer>Built with <a href="https://github.com/abhiyan100/paperfence">paperfence</a>. Grades are about mechanism, not about the model. Every number above links to the exact rule text and the tool call that was tried.</footer>
`,
    `${pct}% of the safety rules in ${scanned.length} popular CLAUDE.md files are wishes. Check yours with paperfence.`,
  );
  await fs.writeFile("site/index.html", index);

  for (const r of scanned) {
    const rules = r.sample
      .map(
        (s) => `<div class="rule ${s.grade.toLowerCase()}"><div class="badge">${esc(s.grade.toLowerCase())}</div><div><h3>${esc(s.text)}</h3><p>${esc(s.summary)}</p></div></div>`,
      )
      .join("\n");
    const body = `
<nav><a href="../index.html">← all repos</a> · <a href="https://github.com/${esc(r.repo)}">${esc(r.repo)} on GitHub</a></nav>
<h1>${esc(r.repo)}</h1>
<p class="lede">${esc(r.description)}</p>
<div class="big">
  <div class="stat"><b>${r.stars.toLocaleString()}</b><span>stars</span></div>
  <div class="stat wish"><b>${r.wishes}</b><span>wishes</span></div>
  <div class="stat gate"><b>${r.gates}</b><span>gates</span></div>
</div>
<div class="bar"><i class="w" style="width:${r.wishPct}%"></i><i class="g" style="width:${100 - r.wishPct}%"></i></div>
<p class="small">settings.json: ${r.hasSettings ? "yes" : "no"} · hooks: ${r.hasHooks ? `yes (not executed in this scan${r.unknown ? `; ${r.unknown} rule${r.unknown > 1 ? "s" : ""} marked unknown because a hook matches` : ""})` : "no"} · scanned ${r.scannedAt.slice(0, 10)}</p>
<h2>Rules, as written</h2>
${rules || "<p class='small'>No action rules found.</p>"}
${r.sample.length < r.gates + r.wishes ? `<p class="small">Showing ${r.sample.length} of ${r.gates + r.wishes}. Run <code>npx paperfence scan</code> on the repo for the full list.</p>` : ""}
<footer>Rule text is quoted from the repo's CLAUDE.md. Grades come from <code>paperfence scan --no-hooks</code>.</footer>`;
    await fs.writeFile(`site/r/${slug(r.repo)}.html`, page(`${r.repo} · paperfence`, body, `${r.wishPct}% of ${r.repo}'s agent rules are wishes.`));
  }
  process.stderr.write(`site/: index + ${scanned.length} repo pages (${pct}% wishes)\n`);
}

await main();
