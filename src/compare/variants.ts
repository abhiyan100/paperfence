import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SettingsJson } from "../config/discover.js";
import { applyHardening } from "../harden/apply.js";
import { planHardening } from "../harden/generate.js";
import { collectRules } from "../scan.js";
import type { Variant } from "../types.js";

const run = promisify(execFile);

/**
 * A variant is a directory holding one version of the repo's agent config,
 * plus the model to run it with. Variants are materialised into temp dirs so
 * transforms never touch the user's checkout.
 */

export interface VariantSpec {
  name: string;
  /** Path or git ref to start from. Default: the repo as it is. */
  from?: string;
  /** Remove every rule line containing this text from CLAUDE.md / AGENTS.md / .claude/rules. */
  without?: string[];
  /** Replace all PreToolUse hooks with this one command. */
  hook?: string;
  /** Apply `paperfence harden` on top. */
  hardened?: boolean;
  /** Extra permissions.deny entries. */
  deny?: string[];
  model?: string;
  offline?: boolean;
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".paperfence", "target", "__pycache__", ".venv", "venv"]);

async function copyTree(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else if (!e.isSymbolicLink()) await fs.copyFile(s, d);
  }
}

async function isGitRef(root: string, ref: string): Promise<boolean> {
  if (await fs.stat(ref).then(() => true).catch(() => false)) return false;
  return run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root }).then(() => true).catch(() => false);
}

export async function materialize(root: string, spec: VariantSpec, defaultModel: string): Promise<Variant & { destroy: () => Promise<void> }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `paperfence-variant-${spec.name}-`)));
  const describe: string[] = [];

  if (spec.from && (await isGitRef(root, spec.from))) {
    // git archive the ref into the variant dir
    const tar = path.join(dir, "..", `pf-${spec.name}-${Date.now()}.tar`);
    await run("git", ["archive", "-o", tar, spec.from], { cwd: root });
    await run("tar", ["-xf", tar, "-C", dir]);
    await fs.rm(tar, { force: true });
    describe.push(`config from ${spec.from}`);
  } else {
    await copyTree(spec.from ?? root, dir);
    if (spec.from) describe.push(`config from ${spec.from}`);
  }

  if (spec.without?.length) {
    const files = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"];
    for (const name of await fs.readdir(path.join(dir, ".claude", "rules")).catch(() => [] as string[])) files.push(path.join(".claude", "rules", name));
    let removed = 0;
    for (const f of files) {
      const p = path.join(dir, f);
      const body = await fs.readFile(p, "utf8").catch(() => null);
      if (body === null) continue;
      const kept = body.split("\n").filter((line) => {
        const hit = spec.without!.some((w) => line.toLowerCase().includes(w.toLowerCase()));
        if (hit) removed++;
        return !hit;
      });
      await fs.writeFile(p, kept.join("\n"));
    }
    describe.push(`without ${spec.without.map((w) => `"${w}"`).join(", ")} (${removed} line${removed === 1 ? "" : "s"} removed)`);
  }

  if (spec.hook !== undefined || spec.deny?.length) {
    const sp = path.join(dir, ".claude", "settings.json");
    const settings: SettingsJson = await fs.readFile(sp, "utf8").then((s) => JSON.parse(s)).catch(() => ({}));
    if (spec.hook !== undefined) {
      settings.hooks ??= {};
      settings.hooks.PreToolUse = spec.hook ? [{ matcher: "", hooks: [{ type: "command", command: spec.hook, timeout: 30 }] }] : [];
      describe.push(spec.hook ? `PreToolUse hook: ${spec.hook}` : "PreToolUse hooks removed");
    }
    if (spec.deny?.length) {
      settings.permissions ??= {};
      settings.permissions.deny = [...(settings.permissions.deny ?? []), ...spec.deny];
      describe.push(`deny +${spec.deny.length}`);
    }
    await fs.mkdir(path.dirname(sp), { recursive: true });
    await fs.writeFile(sp, JSON.stringify(settings, null, 2) + "\n");
  }

  if (spec.hardened) {
    const { rules } = await collectRules(dir, { offline: spec.offline });
    const plan = planHardening(rules);
    const r = await applyHardening(dir, plan);
    describe.push(`hardened (+${r.addedDeny.length} deny, hook ${r.hookRegistered ? "installed" : "already present"})`);
  }

  const model = spec.model ?? defaultModel;
  if (spec.model) describe.push(`model ${spec.model}`);

  return {
    name: spec.name,
    dir,
    model,
    describe: describe.length ? describe.join("; ") : "as is",
    destroy: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
