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

/** Does this shell command write to the filesystem? Enough for a sandbox question. */
function writesFromShell(call: ProbeCall): boolean {
  if (call.tool !== "Bash") return false;
  const cmd = String((call.input as { command?: string }).command ?? "");
  return /(^|[\s;&|])(rm|mv|cp|touch|mkdir|tee|truncate|install|ln|chmod|chown|sed\s+-i|dd)\b/.test(cmd) || />{1,2}/.test(cmd);
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
  // drive and evaluate are true because their conformance cases pass
  // (`paperfence conformance --runtime codex`). probeHooks and harden stay
  // false because nothing has been verified about Codex hooks.
  support: { discover: true, evaluate: true, probeHooks: false, drive: true, harden: false },
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
    "Codex confines rather than refusing: a command runs inside a restricted environment and the operation fails, so nothing is recorded as denied. Under read-only every write fails, including outside the workspace; under workspace-write the whole workspace is writable and the sandbox cannot express a path allowlist inside it. Measured with `paperfence conformance --runtime codex`. Two limits stand: when the sandbox confines a command, Codex emits no record of that command, so paperfence sees the outcome and not the attempt; and hooks are not covered, because a Codex hook only runs once trusted by content hash and paperfence cannot yet observe one blocking a call.",

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

  /**
   * What Codex's sandbox does to this call.
   *
   * Not a rule match. The question a confinement can be asked is whether the
   * operation would succeed, and the answer comes from the sandbox mode alone.
   * Anything the sandbox does not decide comes back unknown, and unknown is
   * rendered as unknown rather than as allowed.
   */
  evaluate(cfg: DiscoveredConfig, call: ProbeCall): StaticDecision {
    const toml = cfg.settingsFiles.find((f) => f.file.endsWith("config.toml"))?.json as CodexConfig | undefined;
    const mode = typeof toml?.sandbox_mode === "string" ? toml.sandbox_mode : undefined;
    if (!mode) {
      return { decision: "unknown", layer: "none", reason: "this repository sets no sandbox_mode, so the mode comes from the user's own configuration, which paperfence does not read. Unknown is not the same as allowed." };
    }
    if (mode === "danger-full-access") {
      return { decision: "allow", layer: "none", reason: 'sandbox_mode = "danger-full-access": nothing is confined' };
    }
    const writes = call.tool === "Edit" || call.tool === "Write" || call.tool === "MultiEdit" || call.tool === "NotebookEdit" || writesFromShell(call);
    if (mode === "read-only") {
      if (writes) return { decision: "deny", layer: "permission-deny", reason: 'sandbox_mode = "read-only": the command runs and the write fails with "operation not permitted"' };
      return { decision: "allow", layer: "none", reason: 'sandbox_mode = "read-only": reads are not confined' };
    }
    if (mode === "workspace-write") {
      if (!writes) return { decision: "allow", layer: "none", reason: 'sandbox_mode = "workspace-write": reads are not confined' };
      return {
        decision: "unknown",
        layer: "none",
        reason: 'sandbox_mode = "workspace-write": writes inside the workspace succeed and writes outside it fail, and the workspace is the whole repository, so this depends on the path rather than on any rule',
      };
    }
    return { decision: "unknown", layer: "none", reason: `sandbox_mode = ${JSON.stringify(mode)} is not a mode paperfence has measured` };
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
