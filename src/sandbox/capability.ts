import { promises as fs } from "node:fs";
import path from "node:path";
import type { RepoProfile } from "../repo/profile.js";
import { execInDocker } from "./docker.js";
import type { Sandbox } from "./host.js";

/**
 * What can actually be done inside this sandbox.
 *
 * Not what the source repository looks capable of. The two are different, and
 * the difference has already produced a false pass once: the sandbox copies
 * the repository without `node_modules`, so a project whose tests need an
 * installed framework cannot run them there, the agent gives up, and
 * "the agent declined" was recorded as the rule holding.
 *
 * The first fix for that predicted runnability by looking for `node_modules`
 * in the source tree. That was the same mistake one layer up: a developer
 * running paperfence on their own installed repository was told the suite was
 * runnable, and it still was not, because the copy leaves the dependencies
 * behind.
 *
 * So this module does not predict. It runs the repository's own test command
 * inside the sandbox and reports what happened. The probe is the arbiter, and
 * an environment that cannot host the legitimate task makes the scenario
 * NOT APPLICABLE rather than a pass.
 */

export type EnvironmentReason =
  /** The command ran and the runner did its job. Failing tests still count. */
  | "ok"
  /** The repository states no test command. */
  | "no-command"
  /** The runner is not installed in the sandbox. */
  | "missing-runner"
  /** The runner is installed, for a different operating system than the sandbox. */
  | "platform-mismatch"
  /** It started and did not come back inside the timeout. */
  | "did-not-finish"
  /** Nothing was tried. Host mode does not run the repository's own commands on this machine. */
  | "not-probed";

export interface TaskEnvironment {
  /** The command that was tried, as the repository states it. */
  command: string | null;
  /** True only when that command ran and the runner did its job. */
  canRunTests: boolean;
  /** One line a human can act on. */
  detail: string;
  /** Why, in a form a report can group by. */
  reason: EnvironmentReason;
  /** Exit code, when the probe got that far. */
  exitCode?: number | null;
  /** Last few lines of output, for the report. Never the whole log. */
  output?: string;
  /** What was copied in to make the attempt possible. */
  materialized: string[];
}

/**
 * Output that means "the runner is missing", as opposed to "the tests failed".
 *
 * A failing suite is a perfectly good environment; that is the situation the
 * protect-tests scenario deliberately creates. A missing runner is not.
 */
const MISSING_RUNNER = [
  /cannot find module/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /no such file or directory/i,
  /ModuleNotFoundError/i,
  /ImportError: No module named/i,
  /npm ERR! Missing script/i,
  /npm error Missing script/i,
  /executable file not found/i,
  /\bENOENT\b/,
  /could not determine executable to run/i,
  /go: (cannot find|no such|updates to go\.mod needed|missing go\.sum entry)/i,
  /error: no such command/i,
  /cargo: command not found/i,
  /No module named pytest/i,
  // Any runner, not a list of the ones we happened to try. Naming vitest and
  // jest let `sh: 1: mocha: not found` through, and a missing runner reported
  // as a working environment is the direction that ends in a false pass.
  /(^|\n)[^\n]{0,80}?: (command )?not found\b/i,
];

/**
 * Exit codes that mean the shell could not start the command at all.
 *
 * 127 is "command not found" and 126 is "found but not executable", in every
 * POSIX shell. They say the same thing as the patterns above without depending
 * on the wording of a message, and a runner that never started cannot have
 * produced a test result.
 */
const CANNOT_START_CODES = new Set([126, 127]);

/**
 * Output that means "the runner is here, built for a different machine".
 *
 * This is its own outcome and not a missing runner, because the fix is
 * different and telling a developer their framework is missing when it is
 * sitting right there sends them to reinstall something that is already
 * installed. A tree installed on macOS carries `@rollup/rollup-darwin-arm64`
 * and not the linux build, so the runner starts inside the container and then
 * cannot load its own native half.
 *
 * Checked before MISSING_RUNNER, because "Cannot find module" matches both and
 * the more specific reading is the true one.
 */
const PLATFORM_MISMATCH = [
  /cannot find module ['"`]?@?[\w@/.-]*-(linux|darwin|win32|android|freebsd)-(x64|arm64|arm|ia32|musl)/i,
  /invalid ELF header/i,
  /wrong ELF class/i,
  /is not a valid Win32 application/i,
  /\.(dylib|so)['"`]?: cannot open shared object file/i,
  /incompatible architecture|mach-o file, but is an incompatible architecture/i,
  /was compiled against a different Node\.js version/i,
  /prebuild(-install)? .*not found for platform/i,
];

/** Ecosystem directories that make an offline run possible when they are already present. */
const DEPENDENCY_DIRS: { dir: string; why: string; frameworks: string[] }[] = [
  { dir: "node_modules", why: "the installed npm tree", frameworks: ["vitest", "jest", "mocha", "node-test", "other"] },
  { dir: "vendor", why: "the vendored Go modules", frameworks: ["go-test"] },
  { dir: ".venv", why: "the Python virtual environment", frameworks: ["pytest"] },
];

/** A cap, because a sandbox per trial times a large dependency tree is a lot of copying. */
const MAX_DEPENDENCY_BYTES = 1_500_000_000;

async function treeSize(dir: string, budget: number): Promise<number | null> {
  let total = 0;
  const walk = async (d: string): Promise<boolean> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!(await walk(p))) return false;
      } else {
        const st = await fs.stat(p).catch(() => null);
        total += st?.size ?? 0;
        if (total > budget) return false;
      }
    }
    return true;
  };
  return (await walk(dir)) ? total : null;
}

/**
 * Copy the dependency directories the sandbox left behind, when they exist and
 * are small enough to be worth copying.
 *
 * Deliberately a copy of what the developer already has, never an install:
 * the sandbox has no network on purpose, and fetching packages for an
 * untrusted repository would be a much worse idea than reporting that the
 * suite cannot run.
 */
export async function materializeDependencies(sourceRoot: string, work: string, profile: RepoProfile): Promise<string[]> {
  const copied: string[] = [];
  for (const { dir, frameworks } of DEPENDENCY_DIRS) {
    if (!frameworks.includes(profile.testFramework ?? "other")) continue;
    const from = path.join(sourceRoot, dir);
    const stat = await fs.stat(from).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const size = await treeSize(from, MAX_DEPENDENCY_BYTES);
    if (size === null) continue; // over the cap; the probe will report it cannot run
    await copyDependencyTree(from, path.join(work, dir), sourceRoot);
    copied.push(dir);
  }
  return copied;
}

/**
 * Copy a dependency tree so it still works somewhere else.
 *
 * A plain copy does not. npm writes the launchers in `node_modules/.bin` as
 * **absolute** symlinks into the checkout they were installed in, so copying
 * them preserves a path that does not exist inside the container and every one
 * of them dangles. The probe then reports, correctly, that the runner is not
 * there, and a repository with its dependencies properly installed still
 * cannot run its own tests.
 *
 * A link whose target is inside the tree being copied is rewritten relative, so
 * it resolves wherever the copy lands. A link pointing outside, which is what a
 * pnpm store looks like, is left out: it cannot be made to work and pretending
 * otherwise would put the dangling link back.
 */
export async function copyDependencyTree(from: string, to: string, sourceRoot: string): Promise<{ links: number; skipped: number }> {
  let links = 0;
  let skipped = 0;
  const walk = async (src: string, dst: string): Promise<void> => {
    await fs.mkdir(dst, { recursive: true });
    let entries;
    try {
      entries = await fs.readdir(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isSymbolicLink()) {
        const target = await fs.readlink(s).catch(() => null);
        if (target === null) continue;
        const resolved = path.resolve(path.dirname(s), target);
        const inside = resolved === sourceRoot || resolved.startsWith(sourceRoot + path.sep);
        if (!inside) {
          skipped++;
          continue;
        }
        // Where that target will live once copied, expressed from the new link.
        const movedTarget = path.join(to, path.relative(path.join(sourceRoot, path.basename(from)), resolved));
        await fs.symlink(path.relative(path.dirname(d), movedTarget), d).catch(() => {});
        links++;
        continue;
      }
      if (e.isDirectory()) await walk(s, d);
      else await fs.copyFile(s, d).catch(() => {});
    }
  };
  await walk(from, to);
  return { links, skipped };
}

/**
 * Run the repository's test command inside the sandbox and report what happened.
 *
 * Three outcomes, and only the first lets a test-related scenario run:
 *   the runner ran      exit code irrelevant; a failing suite is a fine environment
 *   the runner is gone  a missing framework, a missing script, a missing binary
 *   no command at all   nothing to try
 */
/**
 * Turn one attempt at the test command into a verdict about the environment.
 *
 * Separate from the running so it can be tested without a container. Every
 * branch here decides whether a test-related scenario is allowed to run at
 * all, so each one wants a case in the suite rather than a live probe.
 */
export function classifyRun(
  command: string,
  code: number | null,
  output: string,
  materialized: string[] = [],
): TaskEnvironment {
  const tail = output.trim().split("\n").slice(-6).join("\n").slice(0, 800);
  if (code === null) {
    return { command, canRunTests: false, reason: "did-not-finish", detail: `\`${command}\` did not finish inside the sandbox`, exitCode: null, output: tail, materialized };
  }
  if (PLATFORM_MISMATCH.some((re) => re.test(output))) {
    return {
      command,
      canRunTests: false,
      reason: "platform-mismatch",
      detail: `\`${command}\` cannot run in the sandbox: ${materialized.join(" and ") || "the dependency tree"} was installed on ${process.platform}-${process.arch} and the sandbox is linux, so its native packages do not load there`,
      exitCode: code,
      output: tail,
      materialized,
    };
  }
  if (CANNOT_START_CODES.has(code) || MISSING_RUNNER.some((re) => re.test(output))) {
    return {
      command,
      canRunTests: false,
      reason: "missing-runner",
      detail: `\`${command}\` cannot run in the sandbox: the runner is not there${materialized.length ? ` even after copying ${materialized.join(", ")}` : ", and the sandbox has no network to install it"}`,
      exitCode: code,
      output: tail,
      materialized,
    };
  }
  return {
    command,
    canRunTests: true,
    reason: "ok",
    detail: code === 0 ? `\`${command}\` runs and passes in the sandbox` : `\`${command}\` runs in the sandbox and exits ${code}, which is a working environment with failing tests`,
    exitCode: code,
    output: tail,
    materialized,
  };
}

export async function probeTaskEnvironment(sb: Sandbox, opts: { materialized?: string[]; timeoutMs?: number; onProgress?: (m: string) => void } = {}): Promise<TaskEnvironment> {
  const command = sb.profile.testCommand;
  const materialized = opts.materialized ?? [];
  if (!command) {
    return { command: null, canRunTests: false, reason: "no-command", detail: "this repository states no test command, so there is nothing to run", materialized };
  }
  const r = await execInDocker(sb, command, { timeoutMs: opts.timeoutMs ?? 3 * 60_000, onProgress: opts.onProgress });
  return classifyRun(command, r.code, r.output ?? "", materialized);
}

/** One line for a report. */
export function environmentLine(e: TaskEnvironment): string {
  if (!e.command) return "no test command";
  return `${e.detail}${e.materialized.length ? ` (copied ${e.materialized.join(", ")} from your checkout)` : ""}`;
}
