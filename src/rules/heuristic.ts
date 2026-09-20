import type { RuleCategory } from "../types.js";

/**
 * Offline fallback. Looks for imperative lines ("never", "do not", "always",
 * "must", "ask before") and guesses a category from keywords. Good enough to
 * produce a useful static report without any model.
 */

interface Hit {
  text: string;
  category: RuleCategory;
  targets: string[];
  line: number;
}

// "Run the tests before committing." is a rule, and it contains none of the
// usual imperative words. An ordering instruction is imperative by shape.
const IMPERATIVE = /\b(never|do not|don't|dont|must not|mustn't|always|must\b|ask (?:me |the user |a human )?(?:before|first)|require[sd]?)\b|^\s*(run|check|verify|ensure|make sure)\b[^.]*\b(before|prior to)\b/i;

function guess(line: string): { category: RuleCategory; targets: string[] } | null {
  const l = line.toLowerCase();
  const branch = l.match(/\b(main|master|trunk|develop|production|prod)\b/);
  if (/\b(push|commit)/.test(l) && /force|-f\b|rewrite history/.test(l)) return { category: "no-force-push", targets: [] };
  if (/\b(push|commit|merge)\b/.test(l) && branch && /(directly|straight|never|do not|don't)/.test(l)) return { category: "protect-branch", targets: [branch[1]!] };
  if (/\bonly (?:touch|modify|edit|change)\b/.test(l) || (/\b(?:never|do not|don't) (?:touch|modify|edit|change)\b.*[\w.-]+\//.test(l) && !/\btests?\b.*(?:pass|green)/.test(l))) {
    // Prefer the forbidden path ("never touch infra/") over the allowed ones.
    const forbiddenMatch = l.match(/(?:never|do not|don't) (?:touch|modify|edit|change) `?([\w.-]+(?:\/[\w.-]+)*\/)/);
    const anyPath = l.match(/(?:^|[\s`])([\w.-]+(?:\/[\w.-]+)*\/)/)?.[1];
    if (forbiddenMatch) return { category: "scope", targets: ["!" + forbiddenMatch[1]] };
    if (anyPath) return { category: "scope", targets: [anyPath] };
    return { category: "scope", targets: [] };
  }
  if (/\btests?\b|\bspec\b/.test(l) && /(delete|remove|skip|disable|modify|edit|weaken|touch|change)/.test(l) && /(never|do not|don't|must not)/.test(l)) {
    const dir = l.match(/\b(tests?\/|__tests__\/|spec\/)/)?.[1] ?? "tests/";
    return { category: "protect-tests", targets: [dir] };
  }
  if (/\.env|secret|credential|api key|token|password|\.pem/.test(l) && /(never|do not|don't|must not|read|print|log|expose|commit)/.test(l)) {
    const f = l.match(/\.env[\w.]*/)?.[0] ?? ".env";
    return { category: "protect-secrets", targets: [f] };
  }
  if (/\b(curl|wget|network|external|upload|send|exfil|http)/.test(l) && /(never|do not|don't|must not)/.test(l)) return { category: "no-exfil", targets: [] };
  if (/rm -rf|reset --hard|clean -fdx|drop table|destructive|delete (files|data)|truncate/.test(l)) return { category: "no-destructive", targets: [] };
  if (/\b(install|add|dependenc|package)/.test(l) && /(never|do not|don't|without|ask)/.test(l)) return { category: "no-install", targets: [] };
  if (/\b(before|prior to)\b/.test(l) && /(commit|push|pr|pull request|merge)/.test(l) && /(test|lint|typecheck|build|format)/.test(l)) {
    const cmd = l.match(/`([^`]+)`/)?.[1] ?? "npm test";
    // Which action is gated. "lint before pushing" is not a rule about committing.
    const after = l.split(/\b(?:before|prior to)\b/)[1] ?? "";
    // "pushing" and "opening a PR" are the same gate as "push".
    const action = /\b(push(ing|es)?|pr\b|pull request|merg(e|ing))\b/.test(after) && !/\bcommit/.test(after) ? "push" : "commit";
    return { category: "require-before", targets: [cmd, action] };
  }
  if (/ask (?:me |the user |a human )?(?:before|first)|confirm(?:ation)? (?:before|first)|get approval|without (?:asking|approval|permission)/.test(l)) {
    const cmd = l.match(/`([^`]+)`/)?.[1];
    return { category: "ask-first", targets: cmd ? [cmd] : [] };
  }
  return null;
}

export function extractRulesHeuristically(content: string): Hit[] {
  const hits: Hit[] = [];
  const lines = content.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/^[\s>*\-•\d.)]+/, "").trim();
    if (line.length < 8 || !IMPERATIVE.test(line)) return;
    const g = guess(line);
    // An imperative we cannot classify is still a rule; report it as "other" so it shows up as untested.
    hits.push(g ? { text: line, category: g.category, targets: g.targets, line: i + 1 } : { text: line, category: "other", targets: [], line: i + 1 });
  });
  return hits;
}
