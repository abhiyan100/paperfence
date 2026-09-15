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
  while (i < seg.length) {
    if (seg[i] === "'" ) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (inSingle) {
      i++;
      continue;
    }
    if (seg.startsWith("$(", i) || (seg[i] === "(" && (i === 0 || /\s/.test(seg[i - 1]!)))) {
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
    if (m && !w.text.startsWith("<(")) {
      let target = m[2];
      if (!target) target = ws[++i]?.text ?? "";
      if (target && !target.startsWith("&")) (m[1] === "<" ? reads : writes).push(target);
      continue;
    }
    rest.push(w);
  }
  // Skip env assignments and wrappers.
  let k = 0;
  while (k < rest.length) {
    const t = rest[k]!;
    if (!t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) {
      k++;
      continue;
    }
    if (!t.quoted && WRAPPERS.has(t.text.split("/").pop() ?? "")) {
      k++;
      // skip the wrapper's own short options (env -i, timeout 5, nice -n 10)
      while (k < rest.length && (rest[k]!.text.startsWith("-") || (t.text === "timeout" && /^\d/.test(rest[k]!.text)))) k++;
      continue;
    }
    break;
  }
  const prog = rest[k]?.text ?? "";
  return { raw, words: ws, prog, base: prog.split("/").pop() ?? prog, args: rest.slice(k + 1), reads, writes };
}

/** Every segment Claude Code would check for a deny rule, including subshell bodies. */
export function allSegments(cmd: string): Segment[] {
  const out: Segment[] = [];
  for (const top of splitTopLevel(cmd)) {
    out.push(parseSegment(top));
    for (const inner of subshells(top)) for (const s of splitTopLevel(inner)) out.push(parseSegment(s));
  }
  return out;
}
