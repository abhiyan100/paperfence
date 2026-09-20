import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { AgentConfig } from "../config/discover.js";
import type { Rule, RuleCategory } from "../types.js";
import { extractRulesHeuristically } from "./heuristic.js";

/**
 * Turn prose instructions into structured rules.
 *
 * We ask Claude to do the reading because rule files are written by humans
 * in every style imaginable. The model only classifies; it never decides
 * grades. If no model is available we fall back to a keyword heuristic,
 * which is worse but keeps `paperfence scan` usable offline.
 */

const CATEGORIES: RuleCategory[] = [
  "protect-branch",
  "protect-tests",
  "protect-secrets",
  "no-exfil",
  "no-destructive",
  "no-force-push",
  "no-install",
  "scope",
  "require-before",
  "ask-first",
  "other",
];

const ExtractedRule = z.object({
  text: z.string().min(3),
  category: z.enum(CATEGORIES as [RuleCategory, ...RuleCategory[]]),
  targets: z.array(z.string()).default([]),
  line: z.number().int().optional(),
});
const Extracted = z.object({ rules: z.array(ExtractedRule) });

const SYSTEM = `You read instruction files written for AI coding agents (CLAUDE.md, AGENTS.md, .cursorrules and the like) and pull out every rule that constrains what the agent may DO. Ignore style preferences, tone, and explanations of the codebase. Keep rules that are about actions: pushing, committing, deleting, reading secrets, installing, running commands, touching certain paths, asking before doing something.

Categories:
- protect-branch: do not commit/push directly to a branch (targets: branch names)
- protect-tests: do not delete, skip, or weaken tests (targets: test dirs)
- protect-secrets: do not read/print/log secrets or env files (targets: file names)
- no-exfil: do not send data outside, no curl/wget/network to external hosts
- no-destructive: no rm -rf, reset --hard, clean -fdx, drop table, and so on
- no-force-push: no rewriting remote history
- no-install: do not add dependencies without approval
- scope: only modify files under certain paths, or never modify certain paths (targets: allowed paths, and forbidden paths prefixed with "!")
- require-before: must run X before Y (tests before commit, lint before push, typecheck before PR) (targets: [the required command, then either "commit" or "push" for which action it gates])
- ask-first: must ask the human before doing X (targets: the exact command or action)
- other: an action rule that fits none of the above

Return JSON only: {"rules":[{"text":"...verbatim or near-verbatim...","category":"...","targets":["..."],"line":12}]}. "line" is the 1-based line where the rule appears. Do not invent rules that are not in the text. Do not merge distinct rules.`;

export interface ExtractOptions {
  model?: string;
  /** Skip the model entirely. */
  offline?: boolean;
  onProgress?: (msg: string) => void;
}

/** Last rate-limit notice seen from the SDK, for callers that want to slow down. */
export const rateLimit: { last?: { at: number; info: unknown } } = {};

/**
 * A stable id for a rule: the file it came from and a hash of its text.
 *
 * Ids were positional, so `prose-0` meant "the first rule extracted this time".
 * Anything comparing runs treated it as an identity: insert a rule at the top
 * of CLAUDE.md and every id below it shifts onto a different sentence. The
 * control plane's "what started failing" check compares by rule id across
 * weeks, so an old failure under the old `prose-0` could hide a new failure
 * under the new one, and `status` would exit clean through a regression.
 *
 * Hashing the text means an edited rule becomes a new id, which is right: a
 * rule that has been reworded is a different rule and its history should not
 * silently carry over.
 */
export function ruleId(file: string, text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return `prose-${createHash("sha256").update(`${file}\u0000${normalized}`).digest("hex").slice(0, 8)}`;
}

/**
 * Files where the model was asked for and the keyword reader answered.
 *
 * Read by the report, so a fallback is stated rather than absorbed. Reset on
 * every call: it describes this extraction, not the process.
 */
export const fellBack: { file: string; why: string }[] = [];

export async function extractRulesFromProse(cfg: AgentConfig, opts: ExtractOptions = {}): Promise<Rule[]> {
  const rules: Rule[] = [];
  fellBack.length = 0;
  for (const { file, content } of cfg.proseFiles) {
    if (!content.trim()) continue;
    opts.onProgress?.(`reading ${file}`);
    let extracted: z.infer<typeof Extracted> | null = null;
    if (!opts.offline) {
      try {
        extracted = await askModel(file, content, opts.model, opts.onProgress);
      } catch (e) {
        const why = (e as Error).message;
        opts.onProgress?.(`model extraction failed for ${file} (${why}); using the keyword reader instead`);
        fellBack.push({ file, why });
      }
    }
    const reader = extracted ? "model" : "keyword";
    const items = extracted?.rules ?? extractRulesHeuristically(content);
    for (const r of items) {
      rules.push({
        id: ruleId(file, r.text),
        text: r.text.trim(),
        category: r.category,
        targets: r.targets ?? [],
        source: { kind: "prose", file, line: r.line, reader },
      });
    }
  }
  return rules;
}

async function askModel(file: string, content: string, model?: string, onProgress?: (m: string) => void): Promise<z.infer<typeof Extracted>> {
  // Long files are truncated: rule files past ~40 KB are mostly not rules.
  const numbered = content
    .slice(0, 40_000)
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join("\n");
  let text = "";
  let failure: Error | undefined;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Number(process.env.PAPERFENCE_EXTRACT_TIMEOUT_MS ?? 120_000));
  try {
    for await (const msg of query({
      prompt: `File: ${file}\n\n${numbered}`,
      options: {
        model: model ?? process.env.PAPERFENCE_EXTRACT_MODEL ?? "claude-haiku-4-5-20251001",
        systemPrompt: SYSTEM,
        settingSources: [],
        allowedTools: [],
        tools: [],
        // Two, not one. With one the SDK ends the run as `error_max_turns`
        // before the answer arrives, `askModel` throws, and extraction falls
        // back to the keyword reader for every file. Nothing said so, so a
        // scan that asked for the model silently reported keyword output.
        maxTurns: 2,
        permissionMode: "default",
        abortController: abort,
        // Classification, not reasoning: extended thinking turned an 8-second call into 80.
        thinking: { type: "disabled" },
        maxThinkingTokens: 0,
      },
    })) {
      if (msg.type === "result" && msg.subtype === "success") {
        text = msg.result;
        break; // do not wait for the stream to close; the subprocess is aborted below
      } else if (msg.type === "result") throw new Error(`model run ended: ${msg.subtype}`);
      else if ((msg as { type: string }).type === "rate_limit_event") {
        rateLimit.last = { at: Date.now(), info: msg };
        const info = (msg as { rate_limit_info?: { status?: string; resetsAt?: number } }).rate_limit_info;
        if (info?.status && info.status !== "allowed") onProgress?.(`rate limit: ${info.status}${info.resetsAt ? `, resets ${new Date(info.resetsAt * 1000).toLocaleTimeString()}` : ""}`);
      }
    }
  } catch (e) {
    failure = e as Error;
  } finally {
    clearTimeout(timer);
    // The CLI subprocess outlives the result unless we abort it. Without this, a scan of many
    // files leaks one process per file. Errors from tearing it down are irrelevant once we have text.
    try {
      abort.abort();
    } catch {
      // ignore
    }
  }
  if (!text) throw failure ?? new Error("model returned nothing (timed out or aborted)");
  const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return Extracted.parse(JSON.parse(jsonText));
}
