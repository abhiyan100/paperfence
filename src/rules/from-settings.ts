import { createHash } from "node:crypto";
import type { AgentConfig } from "../config/discover.js";
import { parsePermissionRule } from "../config/permissions.js";
import type { Rule, RuleCategory } from "../types.js";

/**
 * Deny and ask entries in settings.json are rules too. They are the only rules
 * that are mechanical by construction, so we surface them so the report can
 * show "you have 3 gates and 9 wishes" honestly.
 */

function categorize(tool: string, spec: string | undefined): { category: RuleCategory; targets: string[] } {
  const s = (spec ?? "").toLowerCase();
  if (tool === "Bash") {
    if (/git push.*(--force|-f\b)/.test(s)) return { category: "no-force-push", targets: [] };
    if (/git push/.test(s)) return { category: "protect-branch", targets: ["main"] };
    if (/rm -rf|git reset --hard|git clean|drop table|truncate/.test(s)) return { category: "no-destructive", targets: [] };
    if (/curl|wget|nc\b|ssh|scp/.test(s)) return { category: "no-exfil", targets: [] };
    if (/npm install|npm i\b|pnpm add|yarn add|pip install|cargo add/.test(s)) return { category: "no-install", targets: [] };
    if (/cat .*\.env|\.env/.test(s)) return { category: "protect-secrets", targets: [".env"] };
    if (/npm publish|deploy|terraform apply|kubectl apply/.test(s)) return { category: "ask-first", targets: [(spec ?? "").replace(/:\*$/, "").replace(/\*$/, "").trim()] };
    return { category: "other", targets: spec ? [spec] : [] };
  }
  if (["Read", "Edit", "Write", "MultiEdit"].includes(tool)) {
    if (/\.env|secret|credential|\.pem|id_rsa/.test(s)) return { category: "protect-secrets", targets: [spec ?? ".env"] };
    if (/test|spec/.test(s) && tool !== "Read") return { category: "protect-tests", targets: [spec ?? "tests/"] };
    if (tool !== "Read") return { category: "scope", targets: ["!" + (spec ?? "")] };
  }
  if (tool === "WebFetch") return { category: "no-exfil", targets: spec ? [spec] : [] };
  return { category: "other", targets: [] };
}

export function rulesFromSettings(cfg: AgentConfig): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  for (const { file, json } of cfg.settings) {
    const p = json.permissions ?? {};
    for (const list of ["deny", "ask"] as const) {
      for (const entry of p[list] ?? []) {
        const parsed = parsePermissionRule(entry);
        const { category, targets } = categorize(parsed.tool, parsed.spec);
        out.push({
          id: `perm-${list}-${createHash("sha256").update(`${file}\u0000${list}\u0000${entry}`).digest("hex").slice(0, 8)}`,
          text: `${list === "deny" ? "Deny" : "Ask before"} ${entry}`,
          category,
          targets,
          source: { kind: "permission", file, entry, list },
        });
      }
    }
  }
  return out;
}
