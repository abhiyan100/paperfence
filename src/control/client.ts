import pc from "picocolors";
import { listReceipts, verifyReceipt, type Receipt } from "../receipt.js";

/**
 * Talk to a control plane.
 *
 * The control plane is optional. Everything paperfence measures works with
 * receipts in the repository and nothing else; this exists so a team can ask
 * "what changed since last week" without collecting every laptop's
 * `.paperfence` directory by hand.
 *
 * Two rules the client keeps. It never sends a receipt that does not hash to
 * its own contents, because uploading evidence that has been edited is worse
 * than uploading none. And it sends receipts and nothing else: no source, no
 * configuration, no credentials. A receipt has already had its canaries
 * redacted before it was written.
 */

export const DEFAULT_ENDPOINT = "https://paperfence.vercel.app";

export interface PushResult {
  sent: number;
  stored: number;
  /** Receipts the control plane already had. Re-pushing is safe and not new evidence. */
  alreadyHad: number;
  skipped: { id: string; why: string }[];
  rejected: { id: string; why: string }[];
  project: string;
}

function endpointOf(explicit?: string): string {
  return (explicit ?? process.env.PAPERFENCE_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

function tokenOf(explicit?: string): string {
  const t = explicit ?? process.env.PAPERFENCE_TOKEN;
  if (!t) {
    throw new Error("no control plane token. Set PAPERFENCE_TOKEN, or pass --token. A project and its token are created with `paperfence project create`.");
  }
  return t;
}

async function fail(res: Response, what: string): Promise<never> {
  const text = await res.text();
  let why = text.slice(0, 300);
  try {
    why = (JSON.parse(text) as { error?: string }).error ?? why;
  } catch {
    // not JSON, keep the raw text
  }
  throw new Error(`the control plane refused ${what} (${res.status}): ${why}`);
}

/** Receipts the repository holds that are safe to send. */
export async function sendable(root: string): Promise<{ ok: Receipt[]; skipped: { id: string; why: string }[] }> {
  const all = await listReceipts(root);
  const ok: Receipt[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const r of all) {
    if (!verifyReceipt(r)) {
      skipped.push({ id: r.id, why: "does not hash to its own contents; not uploading evidence that has been edited" });
      continue;
    }
    ok.push(r);
  }
  return { ok, skipped };
}

export async function push(root: string, opts: { endpoint?: string; token?: string; onProgress?: (m: string) => void } = {}): Promise<PushResult> {
  const log = opts.onProgress ?? (() => {});
  const endpoint = endpointOf(opts.endpoint);
  const token = tokenOf(opts.token);
  const { ok, skipped } = await sendable(root);
  if (!ok.length) return { sent: 0, stored: 0, alreadyHad: 0, skipped, rejected: [], project: "" };

  let stored = 0;
  let alreadyHad = 0;
  let project = "";
  const rejected: { id: string; why: string }[] = [];
  const BATCH = 200;
  for (let i = 0; i < ok.length; i += BATCH) {
    const slice = ok.slice(i, i + BATCH);
    log(`sending ${slice.length} receipt(s) to ${endpoint}`);
    const res = await fetch(`${endpoint}/api/receipts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ receipts: slice }),
    });
    if (!res.ok) await fail(res, "the upload");
    const body = (await res.json()) as PushResult & { received: number };
    stored += body.stored;
    alreadyHad += body.alreadyHad ?? 0;
    project = body.project;
    rejected.push(...(body.rejected ?? []));
  }
  return { sent: ok.length, stored, alreadyHad, skipped, rejected, project };
}

export interface Summary {
  project: string;
  windowDays: number;
  totals: Record<string, number>;
  byRule: { rule_id: string; rule_text: string; rule_category: string; failed: number; passed: number; no_verdict: number; last_seen: string }[];
  newlyBroken: { rule_id: string; rule_text: string; first_failed: string; receipt: string }[];
  timeline: { day: string; trials: number; failed: number; cost: number }[];
  models: { model: string; trials: number; failed: number }[];
  note: string;
}

export async function summary(opts: { endpoint?: string; token?: string; days?: number } = {}): Promise<Summary> {
  const endpoint = endpointOf(opts.endpoint);
  const token = tokenOf(opts.token);
  const res = await fetch(`${endpoint}/api/summary?since=${Math.max(1, opts.days ?? 7)}d`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) await fail(res, "the request");
  return (await res.json()) as Summary;
}

export async function createProject(name: string, opts: { endpoint?: string; adminToken?: string } = {}): Promise<{ id: string; name: string; token: string }> {
  const endpoint = endpointOf(opts.endpoint);
  const admin = opts.adminToken ?? process.env.PAPERFENCE_ADMIN_TOKEN;
  if (!admin) throw new Error("creating a project needs the deployment's admin token in PAPERFENCE_ADMIN_TOKEN");
  const res = await fetch(`${endpoint}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) await fail(res, "creating the project");
  return (await res.json()) as { id: string; name: string; token: string };
}

export function renderSummary(s: Summary): string {
  const out: string[] = [""];
  out.push(pc.bold("paperfence status") + pc.dim(`  ${s.project} · the last ${s.windowDays} day${s.windowDays === 1 ? "" : "s"}`));
  out.push("");

  if (s.newlyBroken.length) {
    out.push(pc.bold(pc.red("Started failing in this window")));
    out.push(pc.dim("  These did not fail before it. This is the part worth reading."));
    out.push("");
    for (const n of s.newlyBroken) {
      out.push(`  ${pc.red("·")} ${n.rule_text}`);
      out.push(`    ${pc.dim(`first failed ${new Date(n.first_failed).toLocaleString()} · receipt ${n.receipt}`)}`);
    }
    out.push("");
  }

  const t = s.totals;
  const conclusive = (t.PASS ?? 0) + (t.FAIL ?? 0);
  const noVerdict = (t.ERROR ?? 0) + (t.INCONCLUSIVE ?? 0) + (t.NOT_APPLICABLE ?? 0);
  out.push(pc.bold("Trials"));
  out.push(`  ${pc.green("passed")}        ${String(t.PASS ?? 0).padStart(5)}`);
  out.push(`  ${(t.FAIL ?? 0) ? pc.red("failed") : pc.dim("failed")}        ${String(t.FAIL ?? 0).padStart(5)}`);
  out.push(`  ${pc.dim("no verdict")}    ${String(noVerdict).padStart(5)}   ${pc.dim("errored, ran out of turns, or not applicable here")}`);
  out.push(`  ${pc.dim("conclusive")}    ${String(conclusive).padStart(5)}   ${pc.dim("the only denominator used below")}`);
  out.push("");

  const failing = s.byRule.filter((r) => r.failed > 0);
  if (failing.length) {
    out.push(pc.bold("Rules that failed at least once"));
    for (const r of failing.slice(0, 15)) {
      out.push(`  ${pc.red(`${r.failed}/${r.failed + r.passed}`.padStart(7))}  ${r.rule_text.slice(0, 74)}`);
    }
    out.push("");
  } else if (conclusive > 0) {
    out.push(pc.dim("  No rule failed in this window. Across this many trials that is worth what the numbers above say it is."));
    out.push("");
  }

  if (s.models.length > 1) {
    out.push(pc.bold("By model"));
    for (const m of s.models) out.push(`  ${m.model.padEnd(28)} ${String(m.failed).padStart(4)} failed of ${m.trials} trial(s)`);
    out.push("");
  }

  const cost = s.timeline.reduce((a, d) => a + d.cost, 0);
  out.push(pc.dim(`  ${s.timeline.reduce((a, d) => a + d.trials, 0)} trial(s) across ${s.timeline.length} day(s), $${cost.toFixed(2)}`));
  out.push(pc.dim(`  ${s.note}`));
  out.push("");
  return out.join("\n");
}
