import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate, bearer, json, sql } from "../lib/db.js";
import { verifyReceipt } from "../lib/receipt.js";

/**
 * Accept receipts from a run.
 *
 * Idempotent by construction: a receipt's id is the hash of its contents, so
 * pushing the same one twice is one row and re-running the CLI after a failed
 * upload is safe.
 *
 * The whole receipt is stored verbatim in `body`. The extracted columns exist
 * to make queries possible, not to replace the evidence, so a schema change
 * later cannot lose what was measured.
 */

const MAX_BATCH = 500;
const MAX_BODY = 8 * 1024 * 1024;

interface Receipt {
  id: string;
  kind: string;
  at: string;
  verdict: { verdict: string; reason: string; explain: string };
  trial: {
    scenario: string;
    scenarioVersion: number;
    form: string;
    level: number;
    rule: { id: string; text: string; category: string };
  };
  fingerprint: { model?: string; claudeCode?: string; paperfence?: string };
  repo: { commit?: string };
  costUsd?: number;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export default async function handler(req: IncomingMessage & { headers: Record<string, string | string[] | undefined> }, res: ServerResponse & { status: (n: number) => { end: (s: string) => void }; setHeader: (k: string, v: string) => void }) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });

  const who = await authenticate(bearer(req));
  if (!who) return json(res, 401, { error: "unknown or missing write token" });

  let payload: { receipts?: Receipt[] };
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { error: `body: ${(e as Error).message}` });
  }
  const receipts = payload.receipts ?? [];
  if (!Array.isArray(receipts) || !receipts.length) return json(res, 400, { error: "receipts must be a non-empty array" });
  if (receipts.length > MAX_BATCH) return json(res, 400, { error: `at most ${MAX_BATCH} receipts per request` });

  const db = sql();
  let stored = 0;
  let alreadyHad = 0;
  const rejected: { id: string; why: string }[] = [];

  for (const r of receipts) {
    if (r?.kind !== "paperfence-receipt" || !r.id || !r.verdict || !r.trial) {
      rejected.push({ id: r?.id ?? "(no id)", why: "not a paperfence receipt" });
      continue;
    }
    // A receipt's id is the hash of its own contents. The CLI checks this
    // before uploading, and the server checks it again, because a client is
    // whatever is holding a project token. A store of evidence that accepts
    // whatever it is handed is not a store of evidence.
    if (!verifyReceipt(r as unknown as Record<string, unknown>)) {
      rejected.push({ id: r.id, why: "does not hash to its own contents; a receipt that has been edited is not evidence" });
      continue;
    }
    try {
      const inserted = await db`
        INSERT INTO receipts (id, project_id, trial_at, verdict, reason, scenario, scenario_version, form, level,
                              rule_id, rule_text, rule_category, model, runtime, paperfence, repo_commit, cost_usd, body)
        VALUES (${r.id}, ${who.projectId}, ${r.at}, ${r.verdict.verdict}, ${r.verdict.reason},
                ${r.trial.scenario}, ${r.trial.scenarioVersion}, ${r.trial.form}, ${r.trial.level},
                ${r.trial.rule.id}, ${r.trial.rule.text}, ${r.trial.rule.category},
                ${r.fingerprint?.model ?? null}, ${r.fingerprint?.claudeCode ?? null}, ${r.fingerprint?.paperfence ?? null},
                ${r.repo?.commit ?? null}, ${r.costUsd ?? null}, ${JSON.stringify(r)}::jsonb)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
      // An insert that conflicts still succeeds, so counting calls would report
      // every re-push as new. Count the rows that were actually written.
      if (Array.isArray(inserted) && inserted.length > 0) stored++;
      else alreadyHad++;
    } catch (e) {
      rejected.push({ id: r.id, why: (e as Error).message.slice(0, 160) });
    }
  }

  return json(res, 200, { project: who.name, received: receipts.length, stored, alreadyHad, rejected });
}
