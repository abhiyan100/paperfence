import os from "node:os";
import path from "node:path";
import { allSegments, parseSegment, type Segment } from "../shell.js";

/**
 * Claude Code permission rule matching, following the documented semantics
 * (code.claude.com/docs/en/permissions) as of Claude Code 2.1.27x:
 *
 *   Bash(rm *)          `*` matches any text, at any position. `Bash(ls:*)` == `Bash(ls *)`.
 *                       Deny/ask rules apply when ANY subcommand matches: split on
 *                       && || ; | |& & and newlines, and look inside $(...) and subshells.
 *                       They do NOT match the same program by path (/usr/bin/curl) or
 *                       inside sh -c '...'.
 *   Read(path)          gitignore patterns. Bare filename => any depth. `//` absolute,
 *   Edit(path)          `~/` home, `path` or `./path` relative to cwd. Deny rules on
 *                       Read/Edit also cover cat/head/tail/sed in Bash and the targets
 *                       of `< file` and `> file` redirections. They do not cover grep,
 *                       or a node/python script that opens the file itself. A Read deny
 *                       also blocks Edit and Write on that path (not NotebookEdit).
 *   Write(path) etc.    Accepted, never consulted. Only Read(path) and Edit(path) are
 *                       checked for file access. Tool-name-only rules still apply.
 *   WebFetch(domain:x)  hostname match, `*` wildcard, case-insensitive.
 *
 * Where the docs are silent we stay conservative: better to under-count gates
 * than to tell someone they are protected when they are not.
 */

export interface ParsedRule {
  raw: string;
  tool: string;
  spec?: string;
}

export function parsePermissionRule(raw: string): ParsedRule {
  const m = raw.match(/^([A-Za-z_][\w-]*)(?:\((.*)\))?$/s);
  if (!m) return { raw, tool: raw };
  return { raw, tool: m[1]!, spec: m[2] };
}

/** Path-scoped rules Claude Code accepts but never consults for file access. */
export const IGNORED_PATH_RULE_TOOLS = new Set(["Write", "NotebookEdit", "MultiEdit", "Glob"]);

/** Bash commands whose file arguments Read/Edit deny rules also cover. */
// Documented: cat, head, tail, sed. Observed in a live run: wc is covered too.
const BASH_FILE_READERS = new Set(["cat", "head", "tail", "sed", "wc"]);

// ---------- Bash ----------

function bashPatternToRegExp(spec: string): RegExp {
  // `:*` at the very end is the same as a trailing ` *`.
  let p = spec.endsWith(":*") ? spec.slice(0, -2) + " *" : spec;
  // A trailing " *" also matches the bare command with no arguments.
  let optionalTail = false;
  if (p.endsWith(" *")) {
    p = p.slice(0, -2);
    optionalTail = true;
  }
  const re = p
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}${optionalTail ? "(?:\\s.*)?" : ""}$`, "s");
}

export function bashSpecMatches(spec: string | undefined, command: string): boolean {
  if (spec === undefined) return true;
  return bashPatternToRegExp(spec).test(command.trim());
}

/**
 * The subcommands Claude Code checks a deny rule against: every separator,
 * subshell and command substitution, with quotes respected and wrappers
 * (command, env, sudo, xargs, ...) stripped so the rule sees the real program.
 */
export function splitSubcommands(command: string): string[] {
  return allSegments(command).map((seg) => [seg.prog, ...seg.args.map((a) => (a.quoted && /\s/.test(a.text) ? JSON.stringify(a.text) : a.text))].filter(Boolean).join(" "));
}

/** Files a Bash subcommand reads or writes in ways the file-permission checks see. */
export function bashFileTargets(sub: string): { reads: string[]; writes: string[] } {
  return segmentFileTargets(parseSegment(sub));
}

export function segmentFileTargets(seg: Segment): { reads: string[]; writes: string[] } {
  const reads = [...seg.reads];
  const writes = [...seg.writes];
  if (BASH_FILE_READERS.has(seg.base)) {
    let prev = "";
    for (const a of seg.args) {
      const isOptionValue = /^-(n|c|e|f|s)$/.test(prev) && !a.text.startsWith("-");
      if (!a.text.startsWith("-") && !isOptionValue) reads.push(a.text);
      prev = a.text;
    }
  }
  return { reads, writes };
}

// ---------- Paths ----------

function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  s = s.replace(/\/\.\//g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

function segmentGlobToRegExp(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(c)) re += "\\" + c;
    else re += c;
  }
  return re;
}

/**
 * Does a Read/Edit(spec) rule match this absolute or cwd-relative path?
 * `root` is the project directory the rule is relative to.
 */
export function pathSpecMatches(spec: string | undefined, filePath: string, root?: string): boolean {
  if (spec === undefined) return true;
  const cwd = normalizePath(root ?? process.cwd()).replace(/\/$/, "");
  let abs = normalizePath(filePath);
  if (!abs.startsWith("/")) abs = `${cwd}/${abs}`;
  abs = path.posix.normalize(abs);

  let pattern = spec.replace(/\\/g, "/");
  let anchor: string | null = null; // absolute directory the pattern is anchored at
  let explicitAnchor = false; // leading /, //, or ~/ pins the pattern to its anchor
  if (pattern.startsWith("//")) {
    anchor = "";
    pattern = pattern.slice(2);
    explicitAnchor = true;
  } else if (pattern.startsWith("~/")) {
    anchor = normalizePath(os.homedir()).replace(/\/$/, "");
    pattern = pattern.slice(2);
    explicitAnchor = true;
  } else if (pattern.startsWith("/")) {
    // Anchored at the settings source; for project settings that is the project dir.
    anchor = cwd;
    pattern = pattern.slice(1);
    explicitAnchor = true;
  } else {
    anchor = cwd;
    pattern = normalizePath(pattern);
  }
  pattern = pattern.replace(/\/$/, "");
  if (!pattern) return false;

  // Bare filename (no slash): gitignore semantics, any depth under the anchor.
  // With an explicit anchor (/.env, //x/.env, ~/.env) it is that one file.
  if (!pattern.includes("/")) {
    if (!(abs === anchor || abs.startsWith(anchor + "/"))) return false;
    if (explicitAnchor) return abs === `${anchor}/${pattern}` || new RegExp(`^${anchor.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}/${segmentGlobToRegExp(pattern)}$`).test(abs);
    const base = abs.split("/").pop() ?? "";
    return new RegExp(`^${segmentGlobToRegExp(pattern)}$`).test(base);
  }

  // Deny/ask "dir/**" for a single directory segment matches that directory at any depth.
  const relRe = segmentGlobToRegExp(pattern);
  const anchoredFull = new RegExp(`^${anchor === "" ? "" : anchor.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}/${relRe}(?:/.*)?$`);
  if (anchoredFull.test(abs)) return true;
  // Only relative patterns get the any-depth treatment; // and ~/ are anchored where they say.
  const single = !explicitAnchor ? pattern.match(/^([^/*?]+)\/\*\*$/) : null;
  if (single) {
    const dir = single[1]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${anchor === "" ? "" : anchor.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}/(?:.*/)?${dir}/.+$`).test(abs)) return true;
  }
  return false;
}

// ---------- Tool calls ----------

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Would this rule fire for this tool call? Returns the reason when it matches.
 */
export function ruleMatchesCall(rule: ParsedRule, call: ToolCall, root?: string): string | null {
  const toolName = call.tool;

  if (rule.spec === undefined) {
    // Tool-level rule. Edit-family aliases are not implied; a bare "Edit" deny only removes Edit.
    return rule.tool === toolName ? `${rule.raw} matched tool ${toolName}` : null;
  }

  // Path rules on tools Claude Code never consults.
  if (IGNORED_PATH_RULE_TOOLS.has(rule.tool)) return null;

  if (rule.tool === "Bash") {
    if (toolName !== "Bash") return null;
    const cmd = String(call.input.command ?? "");
    for (const sub of splitSubcommands(cmd)) {
      if (bashSpecMatches(rule.spec, sub)) return `${rule.raw} matched "${sub}"`;
    }
    return null;
  }

  if (rule.tool === "Read" || rule.tool === "Edit") {
    if (toolName === "Bash") {
      // Read/Edit deny rules also cover recognised file commands and redirections.
      const cmd = String(call.input.command ?? "");
      for (const seg of allSegments(cmd)) {
        const { reads, writes } = segmentFileTargets(seg);
        const targets = rule.tool === "Read" ? reads : writes;
        for (const t of targets) {
          if (pathSpecMatches(rule.spec, t, root)) return `${rule.raw} matched "${seg.raw}" (file command)`;
        }
      }
      return null;
    }
    // Read deny also blocks Edit and Write on the same path (v2.1.228+); NotebookEdit is not covered.
    const applies = rule.tool === "Read" ? ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"].includes(toolName) : EDIT_TOOLS.has(toolName);
    if (!applies) return null;
    const p = String(call.input.file_path ?? call.input.path ?? call.input.notebook_path ?? "");
    if (p && pathSpecMatches(rule.spec, p, root)) return `${rule.raw} matched "${p}"`;
    return null;
  }

  if (rule.tool === "WebFetch") {
    if (toolName !== "WebFetch") return null;
    const url = String(call.input.url ?? "");
    const m = rule.spec.match(/^domain:(.+)$/i);
    if (!m) return null;
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return null;
    }
    const pat = m[1]!.toLowerCase().replace(/\.$/, "");
    const re = new RegExp(`^${pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(host) ? `${rule.raw} matched ${host}` : null;
  }

  // Other tools with a spec (Agent(model:*), mcp tools): exact tool name match only.
  return rule.tool === toolName ? `${rule.raw} matched tool ${toolName}` : null;
}

export interface PermissionDecision {
  decision: "deny" | "ask" | "allow" | "none";
  reason: string;
}

/** deny wins, then ask, then allow. */
/**
 * A deny entry that names only a tool, with no pattern.
 *
 * Measured 2026-09-20 with `paperfence conformance`: a settings file with
 * `deny: ["Bash"]` let `pwd` run in five of eight trials and refused it in
 * none; `deny: ["Glob"]` behaved the same way. Whatever the documentation
 * says, this form is not a control, and grading it as one would tell someone
 * they were fenced when they were not.
 *
 * Reported as present and unreliable rather than dropped, because the entry is
 * still evidence of intent and the reader should see it.
 */
export function isBareToolNameDeny(raw: string): boolean {
  return parsePermissionRule(raw).spec === undefined;
}

export const BARE_TOOL_DENY_WHY =
  "a deny entry that names only a tool, with no pattern, did not stop the call in any trial we ran (see `paperfence conformance`). Use a pattern, or a PreToolUse hook.";

export function evaluatePermissions(
  lists: { allow?: string[]; deny?: string[]; ask?: string[] },
  call: ToolCall,
  root?: string,
): PermissionDecision {
  for (const raw of lists.deny ?? []) {
    const r = ruleMatchesCall(parsePermissionRule(raw), call, root);
    if (!r) continue;
    if (isBareToolNameDeny(raw)) return { decision: "none", reason: `${raw} matches, but ${BARE_TOOL_DENY_WHY}` };
    return { decision: "deny", reason: r };
  }
  for (const raw of lists.ask ?? []) {
    const r = ruleMatchesCall(parsePermissionRule(raw), call, root);
    if (r) return { decision: "ask", reason: r };
  }
  for (const raw of lists.allow ?? []) {
    const r = ruleMatchesCall(parsePermissionRule(raw), call, root);
    if (r) return { decision: "allow", reason: r };
  }
  return { decision: "none", reason: "no rule matched" };
}

/** Rules that look like protection but Claude Code never consults. Surfaced in reports. */
export function inertRules(lists: { deny?: string[]; ask?: string[] }): { raw: string; why: string }[] {
  const out: { raw: string; why: string }[] = [];
  for (const raw of lists.deny ?? []) {
    if (isBareToolNameDeny(raw)) out.push({ raw, why: BARE_TOOL_DENY_WHY });
  }
  for (const raw of [...(lists.deny ?? []), ...(lists.ask ?? [])]) {
    const r = parsePermissionRule(raw);
    if (r.spec !== undefined && IGNORED_PATH_RULE_TOOLS.has(r.tool)) {
      out.push({ raw, why: `Claude Code never consults ${r.tool}(path) rules for file access; write it as Edit(${r.spec}) or Read(${r.spec})` });
    }
    if (r.tool === "Bash" && /^command:/.test(r.spec ?? "")) {
      out.push({ raw, why: "Bash(command:...) is ignored at startup with a warning; use Bash(rm *) form" });
    }
  }
  return out;
}
