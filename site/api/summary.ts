import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate, bearer, json, sql } from "../lib/db.js";

/**
 * What changed since last week.
 *
 * The one question a control plane is for. A single run tells you the state
 * now; the value of keeping receipts is being able to say that a rule which
 * held every time for a month started failing on Tuesday, and to point at the
 * receipt.
 *
 * Counts are per verdict and never pooled: a rule with three passes and two
 * errors is not a rule with a sixty percent pass rate.
 */

function windowDays(spec: string | undefined): number {
  const m = /^(\d+)d$/.exec(spec ?? "");
  const n = m ? Number(m[1]) : 7;
  return Math.min(365, Math.max(1, n));
}

export default async function handler(
  req: IncomingMessage & { headers: Record<string, string | string[] | undefined>; url?: string },
  res: ServerResponse & { status: (n: number) => { end: (s: string) => void }; setHeader: (k: string, v: string) => void },
) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });
  const who = await authenticate(bearer(req));
  if (!who) return json(res, 401, { error: "unknown or missing token" });

  const url = new URL(req.url ?? "/", "http://localhost");
  const days = windowDays(url.searchParams.get("since") ?? undefined);
  const db = sql();

  const totals = (await db`
    SELECT verdict, count(*)::int AS n
    FROM receipts
    WHERE project_id = ${who.projectId} AND trial_at > now() - (${days} || ' days')::interval
    GROUP BY verdict`) as { verdict: string; n: number }[];

  const byRule = (await db`
    SELECT rule_id, rule_text, rule_category,
           count(*) FILTER (WHERE verdict = 'FAIL')::int AS failed,
           count(*) FILTER (WHERE verdict = 'PASS')::int AS passed,
           count(*) FILTER (WHERE verdict NOT IN ('FAIL','PASS'))::int AS no_verdict,
           max(trial_at) AS last_seen
    FROM receipts
    WHERE project_id = ${who.projectId} AND trial_at > now() - (${days} || ' days')::interval
    GROUP BY rule_id, rule_text, rule_category
    ORDER BY failed DESC, rule_id`) as {
    rule_id: string;
    rule_text: string;
    rule_category: string;
    failed: number;
    passed: number;
    no_verdict: number;
    last_seen: string;
  }[];

  // A rule that failed inside the window and never failed before it. The thing
  // worth waking up for.
  const newlyBroken = (await db`
    SELECT DISTINCT r.rule_id, r.rule_text, min(r.trial_at) AS first_failed,
           (SELECT id FROM receipts x
             WHERE x.project_id = r.project_id AND x.rule_id = r.rule_id AND x.verdict = 'FAIL'
             ORDER BY x.trial_at ASC LIMIT 1) AS receipt
    FROM receipts r
    WHERE r.project_id = ${who.projectId}
      AND r.verdict = 'FAIL'
      AND r.trial_at > now() - (${days} || ' days')::interval
      AND NOT EXISTS (
        SELECT 1 FROM receipts p
        WHERE p.project_id = r.project_id AND p.rule_id = r.rule_id
          AND p.verdict = 'FAIL' AND p.trial_at <= now() - (${days} || ' days')::interval)
    GROUP BY r.project_id, r.rule_id, r.rule_text
    ORDER BY first_failed DESC`) as { rule_id: string; rule_text: string; first_failed: string; receipt: string }[];

  const runs = (await db`
    SELECT date_trunc('day', trial_at) AS day,
           count(*)::int AS trials,
           count(*) FILTER (WHERE verdict = 'FAIL')::int AS failed,
           coalesce(sum(cost_usd), 0)::float AS cost
    FROM receipts
    WHERE project_id = ${who.projectId} AND trial_at > now() - (${days} || ' days')::interval
    GROUP BY day ORDER BY day`) as { day: string; trials: number; failed: number; cost: number }[];

  const models = (await db`
    SELECT coalesce(model, 'unknown') AS model, count(*)::int AS trials,
           count(*) FILTER (WHERE verdict = 'FAIL')::int AS failed
    FROM receipts
    WHERE project_id = ${who.projectId} AND trial_at > now() - (${days} || ' days')::interval
    GROUP BY model ORDER BY trials DESC`) as { model: string; trials: number; failed: number }[];

  return json(res, 200, {
    project: who.name,
    windowDays: days,
    totals: Object.fromEntries(totals.map((t) => [t.verdict, t.n])),
    byRule,
    newlyBroken,
    timeline: runs,
    models,
    note: "Counts are per verdict and never pooled. A trial that reached no conclusion is in no denominator.",
  });
}
