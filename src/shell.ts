/**
 * A small, quote-aware shell reader. Enough to tell `echo 'a; b'` from `a; b`,
 * to split on the separators Claude Code recognises, and to see inside
 * $(...) and backticks. Not a full parser; where it is unsure it keeps text
 * together rather than splitting it, which errs toward "not a match".
 */

export interface Word {
  text: string; // with quotes removed
  quoted: boolean; // any part was inside quotes
}

export interface Segment {
  raw: string;
  words: Word[];
  /** Program name after env-var assignments and wrappers (command, env, sudo, nice, nohup, time, exec, xargs). */
  prog: string;
  /** Program name with any directory prefix removed. */
  base: string;
  /** Words after the program. */
  args: Word[];
  /** Redirection targets seen in this segment. */
  reads: string[];
  writes: string[];
}

const SEPARATOR = /^(\|\||&&|\|&|;;|;|\||&|\n)/;
const WRAPPERS = new Set(["command", "env", "sudo", "nice", "nohup", "time", "exec", "xargs", "doas", "stdbuf", "timeout"]);

/** Split a command into top-level segments, respecting quotes and parentheses. */
export function splitTopLevel(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let inS = false;
  let inD = false;
  let depth = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (inS) {
      cur += c;
      if (c === "'") inS = false;
      i++;
      continue;
    }
    if (inD) {
      cur += c;
      if (c === "\\" && i + 1 < cmd.length) {
        cur += cmd[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inD = false;
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      inS = true;
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inD = true;
      cur += c;
      i++;
      continue;
    }
    if (c === "(" || c === "{") depth++;
    if (c === ")" || c === "}") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const m = SEPARATOR.exec(cmd.slice(i));
      if (m) {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        i += m[0].length;
        continue;
      }
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Bodies of $(...), `...`, and (...) subshells, recursively. */
export function subshells(seg: string): string[] {
  const out: string[] = [];
  // $( ... ) with nesting. Single-quoted text is literal; double-quoted text still expands $( ).
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < seg.length) {
    const c = seg[i]!;
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (inSingle) {
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') {
      inDouble = !inDouble;
      i++;
      continue;
    }
    // Inside double quotes only $( ) and backticks expand; a bare ( is literal.
    if (seg.startsWith("$(", i) || (!inDouble && c === "(" && (i === 0 || /\s/.test(seg[i - 1]!)))) {
      const start = seg[i] === "$" ? i + 2 : i + 1;
      let depth = 1;
      let j = start;
      let inS = false;
      let inD = false;
      while (j < seg.length && depth > 0) {
        const c = seg[j]!;
        if (inS) {
          if (c === "'") inS = false;
        } else if (inD) {
          if (c === "\\") j++;
          else if (c === '"') inD = false;
        } else if (c === "'") inS = true;
        else if (c === '"') inD = true;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        j++;
      }
      const inner = seg.slice(start, j - 1).trim();
      if (inner) out.push(inner, ...subshells(inner));
      i = j;
      continue;
    }
    if (seg[i] === "`") {
      const j = seg.indexOf("`", i + 1);
      if (j > i) {
        const inner = seg.slice(i + 1, j).trim();
        if (inner) out.push(inner, ...subshells(inner));
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Tokenise one segment into words with quotes removed. */
export function words(seg: string): Word[] {
  const out: Word[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  let i = 0;
  const push = () => {
    if (started) out.push({ text: cur, quoted });
    cur = "";
    quoted = false;
    started = false;
  };
  while (i < seg.length) {
    const c = seg[i]!;
    if (c === "'") {
      const j = seg.indexOf("'", i + 1);
      const end = j === -1 ? seg.length : j;
      cur += seg.slice(i + 1, end);
      quoted = true;
      started = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < seg.length && seg[j] !== '"') {
        if (seg[j] === "\\" && j + 1 < seg.length) {
          cur += seg[j + 1];
          j += 2;
          continue;
        }
        cur += seg[j];
        j++;
      }
      quoted = true;
      started = true;
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < seg.length) {
      cur += seg[i + 1];
      started = true;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      i++;
      continue;
    }
    // Unquoted redirect operators are their own tokens: "cat<.env" -> cat, <, .env
    if (c === "<" || c === ">") {
      if (started && !/^\d$/.test(cur) && !quoted) push();
      else if (started && /^\d$/.test(cur) && !quoted) {
        // "2>" keeps the fd digit with the operator
      }
      let op = c;
      if (seg[i + 1] === c) {
        op += c;
        i++;
      }
      if (seg[i + 1] === "&") {
        op += "&";
        i++;
      }
      cur = (started && /^\d$/.test(cur) ? cur : "") + op;
      started = true;
      quoted = false;
      i++;
      // "<(" process substitution stays attached
      if (seg[i] === "(") {
        cur += "(";
        i++;
        continue;
      }
      push();
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  push();
  return out;
}

export function parseSegment(raw: string): Segment {
  const ws = words(raw);
  const reads: string[] = [];
  const writes: string[] = [];
  const rest: Word[] = [];
  // Pull out redirections first.
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    if (w.quoted) {
      rest.push(w);
      continue;
    }
    const m = /^(\d?>>?|<)(.*)$/.exec(w.text);
    if (m && !w.text.startsWith("<(") && !m[0].endsWith("&")) {
      let target = m[2];
      if (!target) target = ws[++i]?.text ?? "";
      if (target && !target.startsWith("&")) (m[1] === "<" ? reads : writes).push(target);
      continue;
    }
    if (m) {
      // "2>&1": the fd number rides in the next token when the operator ended with &
      if (m[0].endsWith("&") && /^\d+$/.test(ws[i + 1]?.text ?? "")) i++;
      continue;
    }
    rest.push(w);
  }
  // Skip env assignments and wrappers. Wrapper options that take a value are skipped with it.
  const OPTION_WITH_VALUE: Record<string, RegExp> = { nice: /^-n$/, env: /^-[uCS]$/, sudo: /^-[ugh]$/, timeout: /^-[sk]$/, stdbuf: /^-[oei]$/ };
  let k = 0;
  while (k < rest.length) {
    const t = rest[k]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text) && !(t.quoted && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw.trim().split(/\s+/)[k] ?? ""))) {
      k++;
      continue;
    }
    const wname = t.text.split("/").pop() ?? "";
    if (!t.quoted && WRAPPERS.has(wname)) {
      // "command -v prog" is a lookup, not a wrapper; leave it as the program.
      if (wname === "command" && rest[k + 1]?.text.startsWith("-")) break;
      k++;
      while (k < rest.length) {
        const a = rest[k]!.text;
        if (a.startsWith("-")) {
          k++;
          if (OPTION_WITH_VALUE[wname]?.test(a)) k++;
          continue;
        }
        if (wname === "timeout" && /^\d/.test(a)) {
          k++;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  const prog = rest[k]?.text ?? "";
  return { raw, words: ws, prog, base: prog.split("/").pop() ?? prog, args: rest.slice(k + 1), reads, writes };
}

/** Shells whose `-c` argument is another command. */
const SHELLS = /^(sh|bash|zsh|dash|ksh|ash|busybox)$/;

/**
 * Every segment Claude Code would check for a deny rule, including subshell
 * bodies.
 *
 * Deliberately does NOT look inside `sh -c '...'`. Claude Code does not, and
 * the whole point of the static probe is to report what the runtime actually
 * does. Expanding it here would turn a documented gap into a reported gate,
 * which is the failure this tool exists to find. Use `allSegmentsDeep` for
 * paperfence's own matcher, assertions and guard.
 */
export function allSegments(cmd: string): Segment[] {
  const out: Segment[] = [];
  for (const top of splitTopLevel(cmd)) {
    out.push(parseSegment(top));
    for (const inner of subshells(top)) for (const s of splitTopLevel(inner)) out.push(parseSegment(s));
  }
  return out;
}

/**
 * Every command that would actually run, including the bodies of `sh -c`.
 *
 * `bash -lc 'rm -rf build'` came back as one segment whose program was `bash`,
 * so nothing matched the removal: our guard allowed it and our assertions did
 * not see it. The flag is not always a bare `-c`; `-lc`, `-ec` and `-xc` all
 * carry a command.
 *
 * Wrappers like env, sudo and timeout need no special case: parseSegment
 * already steps over them, resolving `timeout 5 rm -rf build` to `rm`.
 *
 * This is what paperfence's own enforcement and evidence should use. It is not
 * what Claude Code does, so the permission matcher must not use it.
 */
export function allSegmentsDeep(cmd: string, depth = 0): Segment[] {
  if (depth > 6) return [];
  const out: Segment[] = [];
  for (const top of splitTopLevel(cmd)) {
    const seg = parseSegment(top);
    out.push(seg);
    for (const inner of subshells(top)) for (const s of splitTopLevel(inner)) out.push(...allSegmentsDeep(s, depth + 1));
    if (SHELLS.test(seg.base)) {
      const i = seg.args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a.text) || a.text === "--command");
      const body = i !== -1 ? seg.args[i + 1]?.text : undefined;
      if (body) out.push(...allSegmentsDeep(body, depth + 1));
    }
  }
  return out;
}
