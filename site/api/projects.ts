import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, hashToken, isAdmin, json, newToken, sql } from "../lib/db.js";

/**
 * Create a project and mint its write token.
 *
 * Admin-only, using the deployment's own secret rather than a project token,
 * so a leaked project token cannot mint more of them.
 *
 * The token is returned once and never stored: only its hash goes into the
 * database. Losing it means creating a new project, which is the correct
 * trade for evidence nobody else should be able to write.
 */
export default async function handler(
  req: IncomingMessage & { headers: Record<string, string | string[] | undefined> },
  res: ServerResponse & { status: (n: number) => { end: (s: string) => void }; setHeader: (k: string, v: string) => void },
) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!isAdmin(bearer(req))) return json(res, 401, { error: "admin token required" });

  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  let name = "";
  try {
    name = String((JSON.parse(raw || "{}") as { name?: string }).name ?? "").trim();
  } catch {
    return json(res, 400, { error: "body must be JSON" });
  }
  if (!/^[a-z0-9][a-z0-9._/-]{1,80}$/i.test(name)) {
    return json(res, 400, { error: "name must look like a repository: letters, digits, dot, dash, underscore, slash" });
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const token = newToken();
  const db = sql();
  try {
    await db`INSERT INTO projects (id, name, token_hash) VALUES (${id}, ${name}, ${hashToken(token)})`;
  } catch (e) {
    if (/duplicate key/i.test((e as Error).message)) return json(res, 409, { error: `project ${id} already exists` });
    throw e;
  }
  return json(res, 201, {
    id,
    name,
    token,
    note: "This token is shown once and is not stored. Put it in CI as PAPERFENCE_TOKEN.",
  });
}
