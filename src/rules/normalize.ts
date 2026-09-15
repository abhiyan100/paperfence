import type { Rule } from "../types.js";

/**
 * The model does the reading, but it sometimes files a rule under a category
 * whose probe would be meaningless (an "ask-first" rule whose target is a
 * sentence, not a command). Nudge those into the category with a real check.
 */
export function normalizeRule(rule: Rule): Rule {
  const t = rule.text.toLowerCase();
  const target = (rule.targets[0] ?? "").toLowerCase();
  const looksLikeCommand = /^[a-z][\w.-]*(\s|$)/.test(target) && !/\s(a|the|new|any)\s/.test(target);

  if (rule.category === "ask-first" && !looksLikeCommand) {
    if (/depend|package|install|library/.test(t + " " + target)) return { ...rule, category: "no-install", targets: [] };
    if (/push|commit/.test(t) && /\b(main|master)\b/.test(t)) return { ...rule, category: "protect-branch", targets: [t.match(/\b(main|master)\b/)?.[1] ?? "main"] };
    if (/force/.test(t)) return { ...rule, category: "no-force-push", targets: [] };
    if (/rm -rf|reset --hard|destructive|delete/.test(t)) return { ...rule, category: "no-destructive", targets: [] };
    if (/infra|deploy|migration|schema/.test(t)) {
      const path = t.match(/`([\w./-]+\/)`/)?.[1];
      return path ? { ...rule, category: "scope", targets: ["!" + path] } : rule;
    }
    return rule;
  }
  if (rule.category === "protect-branch" && rule.targets.length === 0) {
    return { ...rule, targets: [t.match(/\b(main|master|trunk|develop)\b/)?.[1] ?? "main"] };
  }
  if (rule.category === "protect-secrets") {
    const cleaned = rule.targets.map((x) => x.replace(/^`|`$/g, "")).filter((x) => /\.|\//.test(x));
    return { ...rule, targets: cleaned.length ? cleaned : [".env"] };
  }
  if (rule.category === "scope") {
    // Prefer a forbidden path ("!infra/") because that is what we can probe.
    const forbidden = rule.targets.filter((x) => x.startsWith("!"));
    const fromText = t.match(/never (?:touch|modify|edit|change) `?([\w./-]+\/)/)?.[1];
    if (forbidden.length === 0 && fromText) return { ...rule, targets: ["!" + fromText, ...rule.targets] };
  }
  return rule;
}
