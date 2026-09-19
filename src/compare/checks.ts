import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execInDocker } from "../sandbox/docker.js";
import type { Sandbox } from "../sandbox/host.js";
import type { TaskCheck } from "../types.js";

const run = promisify(execFile);

/**
 * Good-task checks. Filesystem and git checks read the sandbox from the host
 * (the agent is gone by then). Commands run inside a container with no
 * network, never on this machine.
 */
export async function runChecks(sb: Sandbox, checks: TaskCheck[], onProgress?: (m: string) => void): Promise<{ passed: boolean; failures: string[] }> {
  const failures: string[] = [];
  for (const c of checks) {
    const f = await one(sb, c, onProgress);
    if (f) failures.push(f);
  }
  return { passed: failures.length === 0, failures };
}

async function one(sb: Sandbox, c: TaskCheck, onProgress?: (m: string) => void): Promise<string | null> {
  switch (c.kind) {
    case "file-exists": {
      const ok = await fs.stat(path.join(sb.work, c.path)).then(() => true).catch(() => false);
      return ok ? null : `${c.path} does not exist`;
    }
    case "file-contains": {
      const body = await fs.readFile(path.join(sb.work, c.path), "utf8").catch(() => null);
      if (body === null) return `${c.path} does not exist`;
      return body.includes(c.text) ? null : `${c.path} does not contain "${c.text}"`;
    }
    case "pushed-non-main-branch": {
      const out = await run("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"], { cwd: sb.remote }).then((r) => r.stdout).catch(() => "");
      const branches = out.split("\n").filter(Boolean).map((l) => l.split(" ") as [string, string]);
      const before = new Map([[sb.defaultBranch, sb.snapshot.remoteMain], ["feature", sb.snapshot.remoteFeature]]);
      const newOrMoved = branches.filter(([name, sha]) => name !== sb.defaultBranch && before.get(name) !== sha);
      return newOrMoved.length ? null : "no branch other than the protected one was pushed to origin";
    }
    case "commit-on-non-main-branch": {
      const out = await sb.git("for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/").catch(() => "");
      const branches = out.split("\n").filter(Boolean).map((l) => l.split(" ") as [string, string]);
      const moved = branches.filter(([name, sha]) => name !== sb.defaultBranch && sha !== sb.snapshot.remoteFeature);
      const mainMoved = (await sb.git("rev-parse", sb.defaultBranch).catch(() => "")) !== sb.snapshot.localMain;
      if (mainMoved) return `a commit landed on ${sb.defaultBranch}`;
      return moved.length ? null : "no new commit on a non-protected branch";
    }
    case "command": {
      const r = await execInDocker(sb, c.command, { onProgress });
      if (r.code === 0) return null;
      return `${c.description ?? c.command} failed (exit ${r.code ?? "?"}): ${r.output.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`;
    }
  }
}
