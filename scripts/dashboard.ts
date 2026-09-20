/**
 * The dashboard page.
 *
 * Generated into the static site and served from the same origin as the API,
 * so it needs no cross-origin header and a team's evidence is not readable by
 * anyone else's page.
 *
 * Deliberately not a wall of gauges. The useful output of this tool is an
 * argument, and a gauge cannot make one. The page leads with the rules that
 * started failing inside the window, because that is the only part worth
 * waking up for; everything below it is context for that list.
 *
 * Rates are fractions with both parts visible. Trials that reached no
 * conclusion get their own line and are in no denominator.
 *
 * The token lives in this browser's localStorage and is sent only to this
 * origin. It is a per-project write token, which is also what reads, so the
 * page says so rather than pretending it is a login.
 */
export function dashboardHtml(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>paperfence dashboard</title>
<style>
:root{color-scheme:light;--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b6862;--line:#e6e2d9;--card:#fff;
--ok:#1f7a4d;--ok-bg:#e3f4ea;--warn:#a86a00;--warn-bg:#fff2d6;--bad:#b3261e;--bad-bg:#fde7e5;--code:#f1efe9}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141311;--fg:#ece9e2;--muted:#9a968e;--line:#2b2925;--card:#1b1a17;
--ok:#6fd39a;--ok-bg:#12301f;--warn:#f0b64a;--warn-bg:#3a2a08;--bad:#ff8a80;--bad-bg:#3d1512;--code:#1f1d1a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:0 16px}
main{max-width:940px;margin:0 auto;padding:40px 0 80px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:17px;margin:34px 0 12px;letter-spacing:-.005em}
p{margin:0 0 12px}
.small{font-size:12.5px;color:var(--muted)}
.setup{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:20px 0}
label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}
input,select,button{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
input{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
button{cursor:pointer;background:var(--fg);color:var(--bg);border-color:var(--fg);font-weight:600}
button.ghost{background:transparent;color:var(--fg);border-color:var(--line);font-weight:400}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:12px}
.row>div{flex:1 1 220px;min-width:0}
.row>button{flex:0 0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:12px}
.broke{border-left:3px solid var(--bad)}
.broke h3{margin:0 0 4px;font-size:15px;font-weight:600}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.fail{color:var(--bad);font-weight:600}
.pass{color:var(--ok)}
.bars{display:flex;gap:3px;align-items:flex-end;height:44px;margin-top:6px}
.bars div{flex:1 1 0;background:var(--line);border-radius:2px 2px 0 0;min-height:2px;position:relative}
.bars div.hasfail{background:var(--bad)}
.err{background:var(--bad-bg);color:var(--bad);border:1px solid var(--bad);border-radius:8px;padding:12px;margin:16px 0}
.empty{color:var(--muted);padding:8px 0}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:14px}
[hidden]{display:none!important}
@media(max-width:520px){main{padding:24px 0 60px}h1{font-size:22px}}
</style>
<main>
<h1>paperfence</h1>
<p class="small">What your agent's rules did, across every run you pushed.</p>

<section class="setup">
  <label for="token">Project token</label>
  <input id="token" type="password" placeholder="pfk_..." autocomplete="off" spellcheck="false">
  <div class="row">
    <div>
      <label for="days">Window</label>
      <select id="days">
        <option value="7">the last 7 days</option>
        <option value="30" selected>the last 30 days</option>
        <option value="90">the last 90 days</option>
        <option value="365">the last year</option>
      </select>
    </div>
    <button id="load">Load</button>
    <button id="forget" class="ghost" type="button">Forget token</button>
  </div>
  <p class="small" style="margin:12px 0 0">The token is kept in this browser only and sent to this site alone. It is the project's write token, so treat it as a credential. <code>paperfence project create</code> mints one.</p>
</section>

<div id="error" class="err" hidden></div>
<div id="out" hidden></div>

<footer class="small">
  Counts are per verdict and never pooled. A trial that reached no conclusion is in no denominator.
  Receipts are content-addressed, so every number here can be followed back to the tool calls that produced it with <code>paperfence replay</code>.
</footer>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KEY = "paperfence.token";

try { $("token").value = localStorage.getItem(KEY) || ""; } catch {}

$("forget").addEventListener("click", () => {
  try { localStorage.removeItem(KEY); } catch {}
  $("token").value = "";
  $("out").hidden = true;
  $("error").hidden = true;
});

$("load").addEventListener("click", load);
$("token").addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });

async function load() {
  const token = $("token").value.trim();
  const days = $("days").value;
  $("error").hidden = true;
  if (!token) { fail("Paste a project token first."); return; }
  try { localStorage.setItem(KEY, token); } catch {}
  $("load").textContent = "Loading…";
  try {
    const res = await fetch("/api/summary?since=" + encodeURIComponent(days) + "d", { headers: { authorization: "Bearer " + token } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { fail(body.error || ("The control plane returned " + res.status + ".")); return; }
    render(body);
  } catch (e) {
    fail("Could not reach the control plane: " + e.message);
  } finally {
    $("load").textContent = "Load";
  }
}

function fail(msg) {
  $("error").textContent = msg;
  $("error").hidden = false;
  $("out").hidden = true;
}

function render(s) {
  const t = s.totals || {};
  const pass = t.PASS || 0, failed = t.FAIL || 0;
  const conclusive = pass + failed;
  const noVerdict = (t.ERROR || 0) + (t.INCONCLUSIVE || 0) + (t.NOT_APPLICABLE || 0);
  const parts = [];

  parts.push('<h2>Started failing in the last ' + s.windowDays + ' days</h2>');
  if ((s.newlyBroken || []).length) {
    parts.push('<p class="small">These did not fail before this window. This is the part worth reading.</p>');
    for (const n of s.newlyBroken) {
      parts.push('<div class="card broke"><h3>' + esc(n.rule_text) + '</h3>' +
        '<div class="small">first failed ' + esc(new Date(n.first_failed).toLocaleString()) +
        ' &middot; <code>paperfence replay ' + esc(n.receipt) + '</code></div></div>');
    }
  } else if (conclusive > 0) {
    parts.push('<p class="empty">Nothing started failing. Across ' + conclusive + ' conclusive trial' + (conclusive === 1 ? "" : "s") + ', that is worth what the numbers below say it is.</p>');
  } else {
    parts.push('<p class="empty">No trial reached a conclusion in this window, so there is nothing to say yet.</p>');
  }

  parts.push('<h2>Trials</h2><table><tbody>' +
    '<tr><td class="pass">passed</td><td class="n">' + pass + '</td><td class="small">the forbidden effect did not happen and the trial concluded</td></tr>' +
    '<tr><td class="' + (failed ? "fail" : "") + '">failed</td><td class="n">' + failed + '</td><td class="small">the forbidden effect happened</td></tr>' +
    '<tr><td>no verdict</td><td class="n">' + noVerdict + '</td><td class="small">errored, ran out of turns, or the repository lacked what the scenario needed</td></tr>' +
    '<tr><td><b>conclusive</b></td><td class="n"><b>' + conclusive + '</b></td><td class="small">the only denominator used anywhere on this page</td></tr>' +
    '</tbody></table>');

  const failing = (s.byRule || []).filter((r) => r.failed > 0);
  if (failing.length) {
    parts.push('<h2>Rules that failed at least once</h2><table><thead><tr><th>rule</th><th>failed</th><th>last seen</th></tr></thead><tbody>' +
      failing.map((r) => '<tr><td>' + esc(r.rule_text) + '<br><span class="small">' + esc(r.rule_category) + '</span></td>' +
        '<td class="n fail">' + r.failed + ' / ' + (r.failed + r.passed) + '</td>' +
        '<td class="n small">' + esc(new Date(r.last_seen).toLocaleDateString()) + '</td></tr>').join("") +
      '</tbody></table>');
  }

  const held = (s.byRule || []).filter((r) => r.failed === 0 && r.passed > 0);
  if (held.length) {
    parts.push('<h2>Held every time</h2><p class="small">Held is not the same as enforced. A rule can hold because a control refused the call, or because the agent chose not to; the report from a run says which.</p>' +
      '<table><tbody>' + held.map((r) => '<tr><td>' + esc(r.rule_text) + '</td><td class="n pass">' + r.passed + ' / ' + r.passed + '</td></tr>').join("") + '</tbody></table>');
  }

  if ((s.models || []).length > 1) {
    parts.push('<h2>By model</h2><table><thead><tr><th>model</th><th>failed</th><th>trials</th></tr></thead><tbody>' +
      s.models.map((m) => '<tr><td><code>' + esc(m.model) + '</code></td><td class="n ' + (m.failed ? "fail" : "") + '">' + m.failed + '</td><td class="n">' + m.trials + '</td></tr>').join("") +
      '</tbody></table>');
  }

  const tl = s.timeline || [];
  if (tl.length) {
    const max = Math.max(...tl.map((d) => d.trials), 1);
    const cost = tl.reduce((a, d) => a + (d.cost || 0), 0);
    parts.push('<h2>Trials per day</h2><div class="bars">' +
      tl.map((d) => '<div class="' + (d.failed ? "hasfail" : "") + '" style="height:' + Math.max(4, Math.round((d.trials / max) * 100)) + '%" title="' +
        esc(new Date(d.day).toLocaleDateString()) + ': ' + d.trials + ' trial(s), ' + d.failed + ' failed"></div>').join("") +
      '</div><p class="small">' + tl.reduce((a, d) => a + d.trials, 0) + ' trial(s) across ' + tl.length + ' day(s), $' + cost.toFixed(2) + '. A red bar is a day something failed.</p>');
  }

  $("out").innerHTML = parts.join("");
  $("out").hidden = false;
}

if ($("token").value) load();
</script>
</html>`;
}
