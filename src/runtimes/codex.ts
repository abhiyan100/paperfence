import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ProbeCall } from "../types.js";
import type { DiscoveredConfig, RuntimeAdapter, StaticDecision } from "./types.js";

/**
 * Codex.
 *
 * What we can do: find and read its configuration, and say what its controls
 * would and would not enforce. What we deliberately do not do yet: claim a
 * static verdict on a specific call, or drive the agent.
 *
 * Codex does not decide a call with a permission rule list the way Claude Code
 * does. Its enforcement is three separate things:
 *
 *   sandbox_mode      read-only | workspace-write | danger-full-access
 *   approval_policy   untrusted | on-failure | on-request | never
 *   hooks             PreToolUse, blocking on decision "block",
 *                     permissionDecision "deny", or exit code 2
 *
 * Two details matter for anyone reading a paperfence report. A hook returning
 * permissionDecision "ask" is parsed and then ignored: there is no ask in
 * Codex's hook model, so a config that looks like it pauses for a human does
 * not. And hooks must be trusted by content hash before they run, so a hook
 * that exists in the repository is not necessarily a hook that fires.
 *
 * Until we have verified the decision procedure against the real CLI, this
 * adapter reports "unknown" rather than guessing, and unknown is rendered as
 * unknown, never as allowed. See docs/decisions/0004-runtime-adapters.md.
 */

interface CodexConfig {
  sandbox_mode?: string;
  approval_policy?: string;
  features?: { network_proxy?: unknown };
  [k: string]: unknown;
}

const PROSE = ["AGENTS.md", ".codex/AGENTS.md"];
const CONFIG = [".codex/config.toml", ".codex/hooks.json"];

async function readIfExists(p: string): Promise<string | null> {
  return fs.readFile(p, "utf8").catch(() => null);
}

export const codex: RuntimeAdapter = {
  id: "codex",
  label: "Codex",
  markers: ["AGENTS.md", ".codex/config.toml", ".codex/hooks.json"],
  support: { discover: true, evaluate: false, probeHooks: false, drive: false, harden: false },
  controls: {
    deny: false,
    ask: false,
    preToolHook: true,
    postToolHook: true,
    pathScoping: false,
    sandbox: true,
    inertSurfaces: ['hook permissionDecision "ask" (parsed, then ignored: Codex has no ask in its hook model)'],
  },
  notes:
    "Codex enforces through a sandbox mode and an approval policy rather than a permission rule list, so a rule-by-rule static verdict does not map onto it. Hooks can block, but only after a user has trusted them by content hash, so a hook file in a repository is not proof that it fires. paperfence reads the configuration and stops there until the decision procedure is verified against the real CLI.",

  async discover(root: string): Promise<DiscoveredConfig> {
    const abs = path.resolve(root);
    const proseFiles: DiscoveredConfig["proseFiles"] = [];
    const settingsFiles: DiscoveredConfig["settingsFiles"] = [];
    const hookScripts: DiscoveredConfig["hookScripts"] = [];

    for (const rel of PROSE) {
      const content = await readIfExists(path.join(abs, rel));
      if (content !== null) proseFiles.push({ file: rel, content });
    }
    for (const rel of CONFIG) {
      const raw = await readIfExists(path.join(abs, rel));
      if (raw === null) continue;
      try {
        settingsFiles.push({ file: rel, json: rel.endsWith(".toml") ? (parseToml(raw) as CodexConfig) : JSON.parse(raw) });
      } catch {
        // A config that does not parse enforces nothing. Record it as empty so
        // the report says the file exists and is unusable.
        settingsFiles.push({ file: rel, json: {} });
      }
    }
    for (const name of await fs.readdir(path.join(abs, ".codex", "hooks")).catch(() => [] as string[])) {
      const rel = path.join(".codex", "hooks", name);
      const content = await readIfExists(path.join(abs, rel));
      if (content !== null) hookScripts.push({ file: rel, content });
    }

    return {
      root: abs,
      runtime: "codex",
      proseFiles,
      settingsFiles,
      hookScripts,
      outOfScope: [
        "~/.codex/config.toml and ~/.codex/hooks.json (this user's personal settings)",
        "requirements.toml managed hooks from an administrator",
        "the hook trust store: a repository hook only runs once its hash is trusted",
        "branch protection and required checks on the git host",
      ],
    };
  },

  evaluate(_cfg: DiscoveredConfig, _call: ProbeCall): StaticDecision {
    return {
      decision: "unknown",
      layer: "none",
      reason: "paperfence does not implement Codex's decision procedure yet, so it cannot say whether this call would be refused. Unknown is not the same as allowed.",
    };
  },

  inert(cfg: DiscoveredConfig) {
    const out: { raw: string; why: string }[] = [];
    for (const s of cfg.settingsFiles) {
      const json = s.json as CodexConfig;
      if (s.file.endsWith("config.toml")) {
        if (json.approval_policy && json.approval_policy !== "never") {
          out.push({
            raw: `approval_policy = "${json.approval_policy}"`,
            why: "an approval policy needs a human to answer. An unattended run (codex exec, CI) has nobody, so this stops nothing there.",
          });
        }
        if (json.sandbox_mode === "danger-full-access") {
          out.push({ raw: 'sandbox_mode = "danger-full-access"', why: "the sandbox is off, so nothing in this file limits what the agent can reach." });
        }
      }
      if (s.file.endsWith("hooks.json")) {
        const raw = JSON.stringify(json);
        if (raw.includes('"ask"')) {
          out.push({ raw: 'a hook returning permissionDecision "ask"', why: 'Codex parses "ask" and then ignores it: there is no ask in its hook model, so the call proceeds.' });
        }
      }
    }
    return out;
  },
};
