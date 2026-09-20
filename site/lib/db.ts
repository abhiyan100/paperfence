import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The control plane's database access and its one security decision.
 *
 * Receipts are evidence, and the point of storing them across runs is that a
 * team can ask "what changed since last week" without keeping every laptop's
 * .paperfence directory. That means accepting writes over the network, which
 * means deciding who may write.
 *
 * A project has one write token. The token is shown once, when the project is
 * created, and only its hash is stored, so a database dump does not let anyone
 * write. Comparison is constant-time: a token check that returns faster for a
 * wrong first byte is a token check that can be guessed.
 */

export function sql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return `pfk_${randomBytes(24).toString("hex")}`;
}

/** Constant-time comparison of two hex digests. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

export function bearer(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const h = req.headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  if (!v || !/^Bearer\s+/i.test(v)) return null;
  return v.replace(/^Bearer\s+/i, "").trim() || null;
}

export interface Authed {
  projectId: string;
  name: string;
}

/** Resolve the bearer token to a project, or null. Never says which half was wrong. */
export async function authenticate(token: string | null): Promise<Authed | null> {
  if (!token) return null;
  const db = sql();
  const rows = (await db`SELECT id, name, token_hash FROM projects WHERE token_hash = ${hashToken(token)} LIMIT 1`) as {
    id: string;
    name: string;
    token_hash: string;
  }[];
  const row = rows[0];
  if (!row || !sameToken(row.token_hash, hashToken(token))) return null;
  return { projectId: row.id, name: row.name };
}

/** Admin actions need the deployment's own secret, not a project token. */
export function isAdmin(token: string | null): boolean {
  const expected = process.env.PAPERFENCE_ADMIN_TOKEN;
  if (!expected || !token) return false;
  const a = createHash("sha256").update(token).digest("hex");
  const b = createHash("sha256").update(expected).digest("hex");
  return sameToken(a, b);
}

export function json(res: { setHeader: (k: string, v: string) => void; status: (n: number) => { end: (s: string) => void } }, code: number, body: unknown): void {
  res.setHeader("content-type", "application/json; charset=utf-8");
  // A control plane read by a dashboard on the same origin needs no CORS, and
  // not setting it keeps someone else's page from reading a team's evidence.
  res.setHeader("cache-control", "no-store");
  res.status(code).end(JSON.stringify(body));
}
