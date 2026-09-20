import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AttackRun, Fingerprint, Rule, ToolEvent, VerdictDetail } from "./types.js";

const run = promisify(execFile);

/**
 * A receipt is the evidence for one trial, in a form two people can point at
 * and mean the same thing.
 *
 * The id is the hash of the document, so an edited receipt is a different
 * receipt. Receipts hold no secrets: canary values are generated per run and
 * are replaced with a placeholder before anything is written down.
 *
 * `paperfence replay <id>` reproduces the conditions, not the outcome. Agent
 * behaviour is stochastic; a replay that comes out differently is a fact
 * about the agent, not a bug in the receipt.
 */

export const RECEIPT_DIR = ".paperfence/receipts";

export interface ReceiptRepo {
  root: string;
  commit?: string;
  dirty?: boolean;
  branch?: string;
}

export interface ReceiptTrial {
  scenario: string;
  scenarioVersion: number;
  form: string;
  formDescribe?: string;
  level: 1 | 2 | 3;
  rule: Pick<Rule, "id" | "text" | "category" | "targets">;
  objective: string;
  maxTurns: number;
}

export interface Receipt {
  /** Receipt format version, so a future reader knows what it is holding. */
  kind: "paperfence-receipt";
  formatVersion: 1;
  id: string;
  at: string;
  fingerprint: Fingerprint;
  repo: ReceiptRepo;
  trial: ReceiptTrial;
  /** Transforms applied to the repository config for this trial, if any. */
  variant?: { name: string; describe: string };
  verdict: VerdictDetail;
  events: ToolEvent[];
  finalText: string;
  turns: number;
  costUsd?: number;
  durationMs: number;
  /** How the run ended, when it did not end cleanly. */
  error?: string;
}

const CANARY = /PAPERFENCE_CANARY_[0-9a-f]{4,}/g;

/** Nothing that could be a live secret goes into a file we ask people to share. */
export function redact<T>(value: T, canary?: string): T {
  const scrub = (s: string): string => {
    let out = s.replace(CANARY, "<redacted canary>");
    if (canary) out = out.split(canary).join("<redacted canary>");
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      // Object.create(null) so a "__proto__" key stays an own property instead
      // of silently becoming a prototype assignment.
      const out = Object.create(null) as Record<string, unknown>;
      for (const k of Object.keys(v as Record<string, unknown>)) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Stable serialisation: object keys sorted, so the same content always hashes
 * the same.
 *
 * Built from key/value pairs rather than by assigning into an object, because
 * `out["__proto__"] = x` sets the prototype instead of creating an own
 * property. A receipt carrying a `__proto__` key, which `JSON.parse` produces
 * as an ordinary own property, would otherwise vanish from the canonical form
 * and two different documents would hash the same.
 */
export function canonical(value: unknown): string {
  const norm = (v: unknown): string => {
    if (v === undefined) return "null";
    // JSON.stringify turns Infinity and NaN into "null", so a receipt holding
    // null and one holding 1e400 canonicalise the same and share an id. Give
    // them their own token.
    if (typeof v === "number" && !Number.isFinite(v)) return JSON.stringify(`__nonfinite__:${String(v)}`);
    if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : norm(x))).join(",")}]`;
    if (typeof v !== "object") return JSON.stringify(String(v));
    const obj = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj).sort()) {
      const val = obj[k];
      if (val === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${norm(val)}`);
    }
    return `{${parts.join(",")}}`;
  };
  return norm(value);
}

export function receiptId(body: Omit<Receipt, "id">): string {
  return "pf_" + createHash("sha256").update(canonical(body)).digest("hex").slice(0, 12);
}

/** True when the document still hashes to the id it carries. */
export function verifyReceipt(r: Receipt): boolean {
  const { id, ...body } = r;
  return receiptId(body as Omit<Receipt, "id">) === id;
}

export async function repoState(root: string): Promise<ReceiptRepo> {
  const git = async (...args: string[]) => (await run("git", args, { cwd: root })).stdout.trim();
  try {
    const commit = await git("rev-parse", "HEAD");
    const status = await git("status", "--porcelain");
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => undefined);
    return { root, commit, dirty: status.length > 0, branch };
  } catch {
    return { root };
  }
}

export interface BuildReceiptArgs {
  run: AttackRun;
  fingerprint: Fingerprint;
  repo: ReceiptRepo;
  rule: Rule;
  objective: string;
  maxTurns: number;
  canary?: string;
  variant?: { name: string; describe: string };
}

export function buildReceipt(a: BuildReceiptArgs): Receipt {
  const body: Omit<Receipt, "id"> = redact(
    {
      kind: "paperfence-receipt" as const,
      formatVersion: 1 as const,
      at: new Date(a.run.startedAt).toISOString(),
      fingerprint: a.fingerprint,
      repo: a.repo,
      trial: {
        scenario: a.run.scenarioId ?? a.rule.category,
        scenarioVersion: a.run.scenarioVersion ?? 0,
        form: a.run.formId ?? "default",
        formDescribe: a.run.formDescribe,
        level: a.run.level,
        rule: { id: a.rule.id, text: a.rule.text, category: a.rule.category, targets: a.rule.targets },
        objective: a.objective,
        maxTurns: a.maxTurns,
      },
      variant: a.variant,
      verdict: a.run.verdict ?? { verdict: "ERROR", reason: "infrastructure-error", explain: "no verdict was recorded" },
      events: a.run.events,
      finalText: a.run.finalText,
      turns: a.run.turns,
      costUsd: a.run.costUsd,
      durationMs: a.run.endedAt - a.run.startedAt,
      error: a.run.error,
    },
    a.canary,
  );
  return { ...body, id: receiptId(body) };
}

export async function writeReceipt(root: string, r: Receipt): Promise<string> {
  const dir = path.join(root, RECEIPT_DIR);
  await fs.mkdir(dir, { recursive: true });
  // Keep receipts out of the repo's history unless someone opts in.
  const ignore = path.join(root, ".paperfence", ".gitignore");
  await fs.writeFile(ignore, "receipts/\n").catch(() => {});
  const file = path.join(dir, `${r.id}.json`);
  await fs.writeFile(file, JSON.stringify(r, null, 2) + "\n");
  return file;
}

export async function readReceipt(root: string, id: string): Promise<Receipt> {
  const clean = id.trim();
  const file = clean.endsWith(".json") ? clean : path.join(root, RECEIPT_DIR, `${clean}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`no receipt ${clean} (looked in ${path.join(root, RECEIPT_DIR)}); run \`paperfence receipts\` to list what is there`);
  }
  const parsed = JSON.parse(raw) as Receipt;
  if (parsed.kind !== "paperfence-receipt") throw new Error(`${file} is not a paperfence receipt`);
  return parsed;
}

export async function listReceipts(root: string): Promise<Receipt[]> {
  const dir = path.join(root, RECEIPT_DIR);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Receipt[] = [];
  for (const n of names.filter((n) => n.endsWith(".json"))) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as Receipt;
      if (r.kind === "paperfence-receipt") out.push(r);
    } catch {
      // a receipt we cannot parse is not a receipt
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** What changed between the conditions of two trials. Empty means they match. */
export function fingerprintDiff(a: Fingerprint, b: Fingerprint): string[] {
  const keys: (keyof Fingerprint)[] = ["paperfence", "paperfenceCommit", "claudeCode", "agentSdk", "model", "os", "sandbox", "image", "approvalMode"];
  const out: string[] = [];
  for (const k of keys) {
    if (a[k] !== b[k]) out.push(`${k}: ${String(a[k] ?? "unset")} -> ${String(b[k] ?? "unset")}`);
  }
  return out;
}
