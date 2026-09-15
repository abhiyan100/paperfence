/**
 * Claude Code permission rule matching.
 *
 * Rules look like:
 *   Bash                     any bash command
 *   Bash(git push:*)         bash commands starting with "git push"
 *   Bash(npm run test)       exactly that command
 *   Read(.env)               read of .env (relative to project)
 *   Read(./.env)             same
 *   Read(**\/*.env)          glob
 *   Edit(src/**)             glob
 *   WebFetch(domain:example.com)
 *   mcp__server__tool
 *
 * We implement the parts that matter for safety rules. Where Claude Code's
 * behaviour is subtle we stay conservative: if we are not sure a deny rule
 * would fire, we say it would not. Better to under-count gates than to
 * tell someone they are protected when they are not.
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

function globToRegExp(glob: string): RegExp {
  // Minimal glob: ** matches across separators, * within a segment, ? one char.
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  s = s.replace(/\/\.\//g, "/"); // collapse /./
  while (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("//")) s = s.slice(1);
  return s;
}

/** Does a Bash(spec) rule match this command? */
export function bashSpecMatches(spec: string | undefined, command: string): boolean {
  if (spec === undefined) return true;
  const cmd = command.trim();
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2);
    // Claude Code treats "git push:*" as prefix match on the command string.
    return cmd === prefix || cmd.startsWith(prefix + " ") || cmd.startsWith(prefix);
  }
  if (spec.endsWith("*")) {
    return cmd.startsWith(spec.slice(0, -1));
  }
  return cmd === spec;
}

/** Does a Read/Edit/Write(spec) rule match this path (relative to project root)? */
export function pathSpecMatches(spec: string | undefined, filePath: string, root?: string): boolean {
  if (spec === undefined) return true;
  let target = normalizePath(filePath);
  if (root) {
    const r = normalizePath(root).replace(/\/$/, "");
    if (target.startsWith(r + "/")) target = target.slice(r.length + 1);
  }
  const pattern = normalizePath(spec);
  if (pattern.includes("*") || pattern.includes("?")) {
    return globToRegExp(pattern).test(target) || globToRegExp(pattern).test(target.split("/").pop() ?? "");
  }
  // Exact relative path, or a directory prefix.
  return target === pattern || target.startsWith(pattern.replace(/\/$/, "") + "/");
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Would this rule fire for this tool call?
 * Returns the reason string when it matches, null otherwise.
 */
export function ruleMatchesCall(rule: ParsedRule, call: ToolCall, root?: string): string | null {
  const toolName = call.tool;
  const toolAlias: Record<string, string[]> = {
    Edit: ["Edit", "MultiEdit", "Write", "NotebookEdit"],
    Write: ["Write"],
    Read: ["Read"],
  };
  const applies = rule.tool === toolName || (toolAlias[rule.tool] ?? []).includes(toolName);
  if (!applies) return null;

  if (toolName === "Bash") {
    const cmd = String(call.input.command ?? "");
    // Compound commands: a deny on any segment counts. Claude Code checks the whole string
    // and each segment split on && ; || |, so we do the same.
    const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
    for (const seg of [cmd, ...segments]) {
      if (bashSpecMatches(rule.spec, seg)) return `${rule.raw} matched "${seg}"`;
    }
    return null;
  }
  if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    const p = String(call.input.file_path ?? call.input.path ?? call.input.notebook_path ?? "");
    if (pathSpecMatches(rule.spec, p, root)) return `${rule.raw} matched "${p}"`;
    return null;
  }
  if (toolName === "WebFetch") {
    const url = String(call.input.url ?? "");
    if (rule.spec === undefined) return `${rule.raw} matched any WebFetch`;
    const m = rule.spec.match(/^domain:(.+)$/);
    if (m) {
      try {
        const host = new URL(url).hostname;
        if (host === m[1] || host.endsWith("." + m[1])) return `${rule.raw} matched ${host}`;
      } catch {
        return null;
      }
    }
    return null;
  }
  // Unknown tool with no spec: tool-wide rule.
  if (rule.spec === undefined) return `${rule.raw} matched tool ${toolName}`;
  return null;
}

export interface PermissionDecision {
  decision: "deny" | "ask" | "allow" | "none";
  reason: string;
}

/**
 * Evaluate a tool call against allow/deny/ask lists the way Claude Code does:
 * deny wins over everything, then ask, then allow.
 */
export function evaluatePermissions(
  lists: { allow?: string[]; deny?: string[]; ask?: string[] },
  call: ToolCall,
  root?: string,
): PermissionDecision {
  for (const raw of lists.deny ?? []) {
    const r = ruleMatchesCall(parsePermissionRule(raw), call, root);
    if (r) return { decision: "deny", reason: r };
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
