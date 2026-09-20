import { discoverConfig, effectiveSettings, type AgentConfig, type SettingsJson } from "../config/discover.js";
import { evaluatePermissions, inertRules } from "../config/permissions.js";
import type { ProbeCall } from "../types.js";
import type { DiscoveredConfig, RuntimeAdapter, StaticDecision } from "./types.js";

/**
 * Claude Code. The runtime paperfence implements in full: we read its
 * configuration, evaluate its permission rules against the documented
 * semantics, execute its hooks with the real payload shape, and drive it
 * through the Agent SDK.
 */

export function toAgentConfig(cfg: DiscoveredConfig): AgentConfig {
  return {
    root: cfg.root,
    proseFiles: cfg.proseFiles,
    settings: cfg.settingsFiles.map((s) => ({ file: s.file, json: s.json as SettingsJson })),
    hookScripts: cfg.hookScripts,
  };
}

export const claudeCode: RuntimeAdapter = {
  id: "claude-code",
  label: "Claude Code",
  markers: ["CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json", ".claude/rules"],
  support: { discover: true, evaluate: true, probeHooks: true, drive: true, harden: true },
  controls: {
    deny: true,
    ask: true,
    preToolHook: true,
    postToolHook: true,
    pathScoping: true,
    sandbox: false,
    inertSurfaces: ["Write(path)", "NotebookEdit(path)", "MultiEdit(path)", "Glob(path)"],
  },
  notes:
    "Deny entries and a PreToolUse hook that exits 2 are the only unattended controls. Ask entries need a human, so they enforce nothing in CI. Path-scoped rules are consulted for Read and Edit only; the same rule written for Write or MultiEdit is accepted and never used.",

  async discover(root: string): Promise<DiscoveredConfig> {
    const cfg = await discoverConfig(root);
    return {
      root: cfg.root,
      runtime: "claude-code",
      proseFiles: cfg.proseFiles,
      settingsFiles: cfg.settings.map((s) => ({ file: s.file, json: s.json })),
      hookScripts: cfg.hookScripts,
      outOfScope: [
        "~/.claude/settings.json (this user's personal settings)",
        "managed policy from an administrator, if any",
        "branch protection and required checks on the git host",
      ],
    };
  },

  evaluate(cfg: DiscoveredConfig, call: ProbeCall): StaticDecision {
    const settings = effectiveSettings(toAgentConfig(cfg));
    const r = evaluatePermissions(settings.permissions ?? {}, { tool: call.tool, input: call.input }, cfg.root);
    if (r.decision === "deny") return { decision: "deny", layer: "permission-deny", reason: r.reason };
    if (r.decision === "ask") return { decision: "ask", layer: "permission-ask", reason: r.reason };
    return { decision: "allow", layer: "none", reason: r.reason };
  },

  inert(cfg: DiscoveredConfig) {
    return inertRules(effectiveSettings(toAgentConfig(cfg)).permissions ?? {});
  },

  describeEnforcement(rule) {
    return `PreToolUse hook (exit 2) plus permissions.deny entries for ${rule.category}`;
  },
};
