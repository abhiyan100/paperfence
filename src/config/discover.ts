import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Everything in a repo that instructs a coding agent.
 * We look in the places Claude Code, Codex, Cursor, and friends actually read.
 */
export interface AgentConfig {
  root: string;
  proseFiles: { file: string; content: string }[];
  settings: { file: string; json: SettingsJson }[];
  hookScripts: { file: string; content: string }[];
}

export interface SettingsJson {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: string;
  };
  hooks?: Record<string, HookMatcherGroup[]>;
  [key: string]: unknown;
}

export interface HookMatcherGroup {
  matcher?: string;
  hooks: { type: "command" | "prompt" | string; command?: string; prompt?: string; timeout?: number }[];
}

const PROSE_CANDIDATES = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
const SETTINGS_CANDIDATES = [".claude/settings.json", ".claude/settings.local.json"];

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function listDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}

export async function discoverConfig(root: string): Promise<AgentConfig> {
  const abs = path.resolve(root);
  const proseFiles: AgentConfig["proseFiles"] = [];
  const settings: AgentConfig["settings"] = [];
  const hookScripts: AgentConfig["hookScripts"] = [];

  for (const rel of PROSE_CANDIDATES) {
    const content = await readIfExists(path.join(abs, rel));
    if (content !== null) proseFiles.push({ file: rel, content });
  }

  // .claude/rules/*.md are loaded by Claude Code as extra instructions.
  const rulesDir = path.join(abs, ".claude", "rules");
  for (const name of await listDir(rulesDir)) {
    if (!name.endsWith(".md")) continue;
    const rel = path.join(".claude", "rules", name);
    const content = await readIfExists(path.join(abs, rel));
    if (content !== null) proseFiles.push({ file: rel, content });
  }

  for (const rel of SETTINGS_CANDIDATES) {
    const raw = await readIfExists(path.join(abs, rel));
    if (raw === null) continue;
    try {
      settings.push({ file: rel, json: JSON.parse(raw) as SettingsJson });
    } catch {
      // A settings file that does not parse enforces nothing. Record it as empty.
      settings.push({ file: rel, json: {} });
    }
  }

  // Hook scripts that live in the repo. We read them so the report can show what they do.
  const hooksDir = path.join(abs, ".claude", "hooks");
  for (const name of await listDir(hooksDir)) {
    const rel = path.join(".claude", "hooks", name);
    const content = await readIfExists(path.join(abs, rel));
    if (content !== null) hookScripts.push({ file: rel, content });
  }

  return { root: abs, proseFiles, settings, hookScripts };
}

/** Merge all settings files into one effective view. Later files win, like Claude Code does it. */
export function effectiveSettings(cfg: AgentConfig): SettingsJson {
  const merged: SettingsJson = { permissions: { allow: [], deny: [], ask: [] }, hooks: {} };
  for (const { json } of cfg.settings) {
    const p = json.permissions ?? {};
    merged.permissions!.allow!.push(...(p.allow ?? []));
    merged.permissions!.deny!.push(...(p.deny ?? []));
    merged.permissions!.ask!.push(...(p.ask ?? []));
    if (p.defaultMode) merged.permissions!.defaultMode = p.defaultMode;
    for (const [event, groups] of Object.entries(json.hooks ?? {})) {
      merged.hooks![event] = [...(merged.hooks![event] ?? []), ...groups];
    }
  }
  return merged;
}
