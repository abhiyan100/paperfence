import pc from "picocolors";
import type { CompiledPolicy, CompiledStatement, Enforceability } from "./types.js";
import { summarize } from "./types.js";

const BADGE: Record<Enforceability, (s: string) => string> = {
  enforced: (s) => pc.bgGreen(pc.black(s)),
  "needs-runtime-guard": (s) => pc.bgCyan(pc.black(s)),
  partial: (s) => pc.bgYellow(pc.black(s)),
  "org-control": (s) => pc.bgBlue(pc.white(s)),
  unenforceable: (s) => pc.bgRed(pc.white(s)),
};

const LABEL: Record<Enforceability, string> = {
  enforced: " ENFORCED ",
  "needs-runtime-guard": " GUARD ",
  partial: " PARTIAL ",
  "org-control": " ELSEWHERE ",
  unenforceable: " GUIDANCE ",
};

const MEANING: Record<Enforceability, string> = {
  enforced: "a control refuses it, with no human present",
  "needs-runtime-guard": "only paperfence's generated hook can express it; the runtime's own config cannot",
  partial: "some routes to the violation are closed and others are open",
  "org-control": "no agent-side control can do this; it belongs to the git host, CI, or a secret manager",
  unenforceable: "not mechanically checkable. This is guidance, and the policy should say so",
};

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

export function renderPolicyCheck(compiled: CompiledPolicy[], unenforced: CompiledStatement[]): string {
  const out: string[] = [""];
  out.push(pc.bold("paperfence policy check"));
  out.push("");

  for (const c of compiled) {
    const counts = summarize(c);
    out.push(pc.bold(c.target));
    const line = (["enforced", "needs-runtime-guard", "partial", "org-control", "unenforceable"] as Enforceability[])
      .filter((k) => counts[k] > 0)
      .map((k) => `${counts[k]} ${LABEL[k].trim().toLowerCase()}`)
      .join(" · ");
    out.push(pc.dim(`  ${line || "nothing to compile"}`));
    out.push("");
    for (const s of c.statements) {
      out.push(`  ${BADGE[s.enforceability](LABEL[s.enforceability])} ${s.statement.text}`);
      out.push(`         ${pc.dim(s.mechanism)}`);
      for (const g of s.gaps) out.push(`         ${pc.yellow("gap")} ${wrap(g, 86, "             ")}`);
      if (s.elsewhere) out.push(`         ${pc.blue("set")} ${wrap(s.elsewhere, 86, "             ")}`);
    }
    if (c.notes.length) {
      out.push("");
      for (const n of c.notes) out.push(pc.dim(`  note: ${wrap(n, 88, "        ")}`));
    }
    out.push("");
  }

  if (unenforced.length) {
    out.push(pc.bold("Enforced by nothing, anywhere"));
    out.push(pc.dim("  These exist only as prose. An agent follows them when it feels like it."));
    out.push("");
    for (const s of unenforced) out.push(`  ${pc.red("·")} ${s.statement.text}`);
    out.push("");
    out.push(pc.dim("  Either accept one as guidance (acceptAsGuidance: true in the policy, which stops it"));
    out.push(pc.dim("  being counted as a control), or move it somewhere that can hold it."));
    out.push("");
  }

  out.push(pc.bold("What the labels mean"));
  for (const k of ["enforced", "needs-runtime-guard", "partial", "org-control", "unenforceable"] as Enforceability[]) {
    out.push(`  ${BADGE[k](LABEL[k])} ${pc.dim(MEANING[k])}`);
  }
  out.push("");
  return out.join("\n");
}
