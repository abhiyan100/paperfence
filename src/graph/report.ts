import pc from "picocolors";
import { AGENT_ID } from "./discover.js";
import { exposed } from "./build.js";
import type { Asset, CapabilityGraph, Gate } from "./types.js";

const KIND_LABEL: Record<Asset["kind"], string> = {
  credential: "credential",
  "secret-file": "file",
  service: "service",
  repository: "repository",
  registry: "registry",
  environment: "environment",
  ci: "CI",
};

const STATUS: Record<Gate["status"], (s: string) => string> = {
  gated: (s) => pc.green(s),
  partial: (s) => pc.yellow(s),
  ungated: (s) => pc.red(s),
  unknown: (s) => pc.dim(s),
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function wrap(text: string, width: number, indent: string): string {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if ((cur + " " + w).trim().length > width) {
      out.push(cur.trim());
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) out.push(cur.trim());
  return out.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

export function renderGraphTerminal(g: CapabilityGraph): string {
  const out: string[] = [""];
  out.push(pc.bold("paperfence graph") + pc.dim(`  ${g.root}`));
  out.push("");

  const assets = g.assets.filter((a) => a.id !== AGENT_ID);
  if (!assets.length) {
    out.push(pc.dim("  Nothing in this repository names a credential, a remote, a registry or a deployment target."));
    out.push(pc.dim("  That is a statement about the repository, not about what the agent can reach."));
    out.push("");
    return out.join("\n");
  }

  const risky = exposed(g);
  if (risky.length) {
    out.push(pc.bold("Reachable with nothing in the way"));
    out.push(pc.dim("  What an agent working here gets to, and what the repository's rules do about it."));
    out.push("");
    for (const { asset, gate } of risky.slice(0, 14)) {
      const blast = asset.blast && asset.blast !== "unknown" ? ` ${pc.bold(asset.blast)}` : pc.dim(" blast unknown");
      out.push(`  ${STATUS[gate.status](gate.status.padEnd(8))} ${pc.bold(asset.name)} ${pc.dim(`(${KIND_LABEL[asset.kind]})`)}${blast}`);
      out.push(`           ${pc.dim(wrap(gate.detail, 86, "           "))}`);
      const first = asset.evidence[0];
      if (first) out.push(`           ${pc.dim(`seen in ${first.file}${first.line ? ":" + first.line : ""}`)}`);
      if (asset.note) out.push(`           ${asset.note}`);
      const opens = g.edges.filter((e) => e.from === asset.id);
      for (const e of opens.slice(0, 3)) {
        const to = g.assets.find((a) => a.id === e.to);
        if (to) out.push(`           ${pc.dim(`→ ${to.name}: ${e.how}`)}`);
      }
      out.push("");
    }
    if (risky.length > 14) out.push(pc.dim(`  and ${risky.length - 14} more.`));
  }

  const gated = g.gates.filter((x) => x.status === "gated");
  if (gated.length) {
    out.push(pc.bold("Behind a control"));
    for (const x of gated.slice(0, 10)) {
      const a = g.assets.find((y) => y.id === x.assetId);
      if (a) out.push(`  ${pc.green("·")} ${a.name} ${pc.dim(`(${KIND_LABEL[a.kind]})`)}`);
    }
    out.push("");
  }

  const byKind = new Map<Asset["kind"], number>();
  for (const a of assets) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  out.push(pc.bold("What this repository reaches"));
  for (const [kind, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${String(n).padStart(3)}  ${KIND_LABEL[kind]}${n === 1 ? "" : "s"}`);
  }
  out.push("");

  out.push(pc.bold("What this cannot see"));
  for (const b of g.blindSpots) out.push(`  ${pc.dim("·")} ${pc.dim(wrap(b, 88, "    "))}`);
  out.push("");
  return out.join("\n");
}

export function renderGraphHtml(g: CapabilityGraph): string {
  const assets = g.assets.filter((a) => a.id !== AGENT_ID);
  const risky = exposed(g);
  const gateOf = (id: string) => g.gates.find((x) => x.assetId === id);

  const rows = risky
    .map(({ asset, gate }) => {
      const opens = g.edges
        .filter((e) => e.from === asset.id)
        .slice(0, 4)
        .map((e) => {
          const to = g.assets.find((a) => a.id === e.to);
          return to ? `<li>${esc(to.name)} <span class="small">${esc(e.how)}</span></li>` : "";
        })
        .join("");
      const ev = asset.evidence
        .slice(0, 3)
        .map((e) => `<code>${esc(e.file)}${e.line ? ":" + e.line : ""}</code>`)
        .join(" ");
      return `<tr class="${gate.status}">
<td><b>${esc(asset.name)}</b><br><span class="small">${KIND_LABEL[asset.kind]}${asset.blast && asset.blast !== "unknown" ? ` · blast ${esc(asset.blast)}` : " · blast unknown"}</span></td>
<td>${esc(gate.status)}<br><span class="small">${esc(gate.detail)}</span></td>
<td class="small">${ev}${asset.note ? `<br>${esc(asset.note)}` : ""}${opens ? `<ul>${opens}</ul>` : ""}</td>
</tr>`;
    })
    .join("\n");

  const gatedRows = g.gates
    .filter((x) => x.status === "gated")
    .map((x) => {
      const a = g.assets.find((y) => y.id === x.assetId);
      return a ? `<li><b>${esc(a.name)}</b> <span class="small">${KIND_LABEL[a.kind]} · ${esc(x.detail)}</span></li>` : "";
    })
    .join("");

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>paperfence graph</title>
<style>
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b6862;--line:#e6e2d9;--ok:#1f7a4d;--ok-bg:#e3f4ea;--warn:#a86a00;--warn-bg:#fff2d6;--bad:#b3261e;--bad-bg:#fde7e5}
@media(prefers-color-scheme:dark){:root{--bg:#141311;--fg:#ece9e2;--muted:#9a968e;--line:#2b2925;--ok:#6fd39a;--ok-bg:#12301f;--warn:#f0b64a;--warn-bg:#3a2a08;--bad:#ff8a80;--bad-bg:#3d1512}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif;padding:0 16px}main{max-width:1000px;margin:0 auto;padding:40px 0 80px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:32px 0 10px}.small{font-size:12px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr.ungated td:nth-child(2){background:var(--bad-bg);color:var(--bad)}tr.partial td:nth-child(2){background:var(--warn-bg);color:var(--warn)}
code{font-size:12px}ul{margin:4px 0 0 16px;padding:0}
footer{margin-top:36px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
</style><main>
<h1>What this repository reaches</h1>
<p class="small">${esc(g.root)} · ${esc(new Date(g.at).toLocaleString())} · ${assets.length} asset${assets.length === 1 ? "" : "s"}</p>
<h2>Reachable with nothing in the way</h2>
${rows ? `<table><thead><tr><th>asset</th><th>what stops the agent</th><th>where it came from</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="small">Nothing reachable was found without a control in front of it.</p>`}
${gatedRows ? `<h2>Behind a control</h2><ul>${gatedRows}</ul>` : ""}
<h2>What this cannot see</h2>
<ul>${g.blindSpots.map((b) => `<li class="small">${esc(b)}</li>`).join("")}</ul>
<footer>Derived from the repository. The code names the credentials it reads; it does not say what they can do. paperfence.inventory.yaml is where a team says the part the code cannot.</footer>
</main>`;
}
