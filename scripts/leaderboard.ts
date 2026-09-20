/**
 * Build the public leaderboard: the most-starred repos on GitHub that ship a
 * root CLAUDE.md, scanned with `paperfence scan`.
 *
 *   pnpm tsx scripts/leaderboard.ts discover   -> data/candidates.json
 *   pnpm tsx scripts/leaderboard.ts scan [N]   -> data/leaderboard.json (+ .md)
 *
 * Uses the gh CLI for GitHub access (already authenticated), shallow clones
 * into a temp dir, never writes to the cloned repos.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { scan } from "../src/scan.js";
import { VERSION } from "../src/report/build.js";
import type { ScanReport } from "../src/types.js";

const run = promisify(execFile);
const DATA = path.join(process.cwd(), "data");

interface Candidate {
  repo: string;
  stars: number;
  description: string;
  defaultBranch: string;
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run("gh", args, { maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

async function discover(): Promise<void> {
  const seen = new Set<string>();
  // Code search: root CLAUDE.md that contains rule-shaped words. Several queries to widen the net.
  const queries = ['"never"', '"do not"', '"always"', '"must"', '"ask"', '"before"', '"only"'];
  for (const q of queries) {
    for (let page = 1; page <= 10; page++) {
      let out = "";
      try {
        out = await gh(["api", "-X", "GET", "search/code", "-f", `q=filename:CLAUDE.md path:/ ${q}`, "-f", "per_page=100", "-f", `page=${page}`, "--jq", ".items[].repository.full_name"]);
      } catch (e) {
        process.stderr.write(`search ${q} p${page}: ${(e as Error).message.split("\n")[0]}\n`);
        break;
      }
      const names = out.split("\n").filter(Boolean);
      if (!names.length) break;
      for (const n of names) seen.add(n);
      process.stderr.write(`${q} page ${page}: ${seen.size} repos so far\n`);
      await new Promise((r) => setTimeout(r, 2500)); // code search is 10 req/min
    }
  }
  process.stderr.write(`fetching stars for ${seen.size} repos\n`);
  const candidates: Candidate[] = [];
  let i = 0;
  for (const repo of seen) {
    try {
      const out = await gh(["api", `repos/${repo}`, "--jq", "{s:.stargazers_count,d:.description,b:.default_branch,f:.fork,a:.archived}"]);
      const j = JSON.parse(out);
      if (j.f || j.a) continue;
      candidates.push({ repo, stars: j.s, description: j.d ?? "", defaultBranch: j.b });
    } catch {
      // gone or private
    }
    if (++i % 50 === 0) process.stderr.write(`  ${i}/${seen.size}\n`);
  }
  candidates.sort((a, b) => b.stars - a.stars);
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(path.join(DATA, "candidates.json"), JSON.stringify(candidates, null, 2));
  process.stderr.write(`wrote ${candidates.length} candidates; top: ${candidates.slice(0, 5).map((c) => `${c.repo} (${c.stars})`).join(", ")}\n`);
}

/**
 * Pull only the agent-config files through the API instead of cloning:
 * CLAUDE.md, AGENTS.md, .claude/settings*.json, .claude/rules/*.md, and the
 * names of .claude/hooks/*. A few requests per repo, no working tree.
 */
async function headCommit(repo: string, branch: string): Promise<string | undefined> {
  try {
    return (await gh(["api", `repos/${repo}/commits/${encodeURIComponent(branch)}`, "--jq", ".sha"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function fetchConfig(repo: string, branch: string, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const raw = async (p: string): Promise<string | null> => {
    try {
      return await gh(["api", `repos/${repo}/contents/${p}?ref=${encodeURIComponent(branch)}`, "-H", "Accept: application/vnd.github.raw+json"]);
    } catch {
      return null;
    }
  };
  const listDir = async (p: string): Promise<{ name: string; type: string }[]> => {
    try {
      const out = await gh(["api", `repos/${repo}/contents/${p}?ref=${encodeURIComponent(branch)}`]);
      const j = JSON.parse(out);
      return Array.isArray(j) ? j.map((e: { name: string; type: string }) => ({ name: e.name, type: e.type })) : [];
    } catch {
      return [];
    }
  };
  let got = 0;
  for (const f of ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json"]) {
    const body = await raw(f);
    if (body === null) continue;
    await fs.mkdir(path.join(dir, path.dirname(f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), body);
    got++;
  }
  for (const e of await listDir(".claude/rules")) {
    if (e.type !== "file" || !e.name.endsWith(".md")) continue;
    const body = await raw(`.claude/rules/${e.name}`);
    if (body === null) continue;
    await fs.mkdir(path.join(dir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude", "rules", e.name), body);
  }
  for (const e of await listDir(".claude/hooks")) {
    if (e.type !== "file") continue;
    // Presence is enough; we never execute hooks from repos we do not own.
    await fs.mkdir(path.join(dir, ".claude", "hooks"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude", "hooks", e.name), "# not fetched\n");
  }
  if (!got) throw new Error("no CLAUDE.md or settings found on the default branch");
}

interface Row {
  repo: string;
  stars: number;
  /** The commit the config was read from. A row is stale when the repo has moved past it. */
  commit?: string;
  /** How the rules were read. A heuristic row and a model row are not comparable. */
  extractor?: "offline-heuristic" | string;
  /** The paperfence version that produced the row. */
  paperfence?: string;
  description: string;
  rules: number;
  gates: number;
  wishes: number;
  untested: number;
  /** Rules a present-but-not-executed hook might cover. Excluded from the percentage. */
  unknown: number;
  wishPct: number;
  hasSettings: boolean;
  hasHooks: boolean;
  sample: { text: string; grade: string; summary: string }[];
  scannedAt: string;
  error?: string;
}

/**
 * Write through a temporary file and rename.
 *
 * The previous version wrote the accumulated list in place after every repo,
 * so a run that was interrupted, or that scanned a smaller slice, replaced a
 * hundred rows with however many it had reached. Renaming is atomic, and the
 * list being written is always the merged one.
 */
async function writeRows(rows: Row[]): Promise<void> {
  const target = path.join(DATA, "leaderboard.json");
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2));
  await fs.rename(tmp, target);
}

async function scanTop(n: number, offline: boolean): Promise<void> {
  const candidates: Candidate[] = JSON.parse(await fs.readFile(path.join(DATA, "candidates.json"), "utf8"));
  const existing: Row[] = await fs
    .readFile(path.join(DATA, "leaderboard.json"), "utf8")
    .then((s) => JSON.parse(s))
    .catch(() => []);
  // Start from what is already there. A run that scans the top 20 must not
  // delete rows 21 to 100, and a transient GitHub failure must not either.
  const byRepo = new Map(existing.map((r) => [r.repo, r]));
  const extractor = offline ? "offline-heuristic" : (process.env.PAPERFENCE_MODEL ?? "claude-haiku-4-5-20251001");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pf-lb-"));
  let rescanned = 0;
  let reused = 0;
  let failed = 0;

  for (const c of candidates.slice(0, n)) {
    const prev = byRepo.get(c.repo);
    const commit = await headCommit(c.repo, c.defaultBranch);
    // A cached row is good only if it recorded how it was produced and nothing
    // has moved since: the repo is at the same commit, read the same way, by
    // the same paperfence.
    const fresh =
      prev &&
      !prev.error &&
      typeof prev.unknown === "number" &&
      prev.extractor === extractor &&
      prev.paperfence === VERSION &&
      (commit === undefined || prev.commit === commit);
    if (fresh) {
      reused++;
      continue;
    }
    const dir = path.join(tmp, c.repo.replace("/", "__"));
    process.stderr.write(`\n== ${c.repo} (${c.stars} stars)${prev ? " [rescan]" : ""}\n`);
    try {
      await fetchConfig(c.repo, c.defaultBranch, dir);
      const report: ScanReport = await scan(dir, { offline, noHooks: true, onProgress: (m) => process.stderr.write(`  ${m}\n`) });
      const hasSettings = await fs.stat(path.join(dir, ".claude", "settings.json")).then(() => true).catch(() => false);
      const hasHooks = report.rules.some((r) => r.source.kind === "hook") || (await fs.readdir(path.join(dir, ".claude", "hooks")).catch(() => [])).length > 0;
      const unknown = report.verdicts.filter((v) => v.grade === "WISH" && /not run \(--no-hooks\)/.test(v.staticProbe?.evidence ?? "")).length;
      const wishes = report.totals.wish - unknown;
      const attackable = report.totals.gate + wishes;
      byRepo.set(c.repo, {
        repo: c.repo,
        stars: c.stars,
        commit,
        extractor,
        paperfence: VERSION,
        description: c.description,
        rules: report.rules.length,
        gates: report.totals.gate,
        wishes,
        untested: report.totals.untested,
        unknown,
        wishPct: attackable ? Math.round((100 * wishes) / attackable) : 0,
        hasSettings,
        hasHooks,
        sample: report.verdicts
          .filter((v) => v.grade !== "UNTESTED")
          .slice(0, 6)
          .map((v) => ({ text: v.rule.text.slice(0, 140), grade: v.grade, summary: v.summary.slice(0, 200) })),
        scannedAt: report.scannedAt,
      });
      rescanned++;
    } catch (e) {
      failed++;
      const message = (e as Error).message.split("\n")[0] ?? "scan failed";
      // A repo we could not reach this time keeps the row we already had. An
      // error row replaces a good one only when there was no good one.
      if (!prev || prev.error) {
        byRepo.set(c.repo, { repo: c.repo, stars: c.stars, commit, extractor, paperfence: VERSION, description: c.description, rules: 0, gates: 0, wishes: 0, untested: 0, unknown: 0, wishPct: 0, hasSettings: false, hasHooks: false, sample: [], scannedAt: new Date().toISOString(), error: message });
      } else {
        process.stderr.write(`  keeping the previous row: ${message}\n`);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    await writeRows([...byRepo.values()].sort((a, b) => b.stars - a.stars));
  }
  await fs.rm(tmp, { recursive: true, force: true });

  const rows = [...byRepo.values()].sort((a, b) => b.stars - a.stars);
  await writeRows(rows);
  process.stderr.write(`\n${rescanned} rescanned, ${reused} reused from cache, ${failed} could not be fetched, ${rows.length} rows total\n`);

  const scanned = rows.filter((r) => !r.error && r.gates + r.wishes > 0);
  const totalRules = scanned.reduce((a, r) => a + r.gates + r.wishes, 0);
  const totalWish = scanned.reduce((a, r) => a + r.wishes, 0);
  const md: string[] = [];
  md.push(`# The fence report: popular repos with a CLAUDE.md`);
  md.push("");
  const totalUnknown = scanned.reduce((a, r) => a + r.unknown, 0);
  const totalUntested = scanned.reduce((a, r) => a + r.untested, 0);
  md.push(`${scanned.length} repos. Of ${totalRules} action rules the static probe could map, ${totalWish} have no deny entry behind them and ${totalRules - totalWish} do (${(Math.round((1000 * totalWish) / Math.max(1, totalRules)) / 10).toFixed(1)}%). Not in that denominator: ${totalUnknown} rules a present-but-unexecuted hook may cover, and ${totalUntested} rules that could not be mapped to a check. Hook scripts were not run, and user-level settings, managed policy and remote branch protection are invisible to a repo scan, so this is a survey of what is checked into the repo, not of how well these projects are protected. Scanned ${new Date().toISOString().slice(0, 10)} with \`paperfence scan --no-hooks\`.`);
  md.push("");
  md.push("| repo | stars | rules | gates | wishes | unknown (hook not run) | wishes % | settings.json | hooks |");
  md.push("|---|---:|---:|---:|---:|---:|---:|:-:|:-:|");
  for (const r of scanned) md.push(`| [${r.repo}](https://github.com/${r.repo}) | ${r.stars.toLocaleString()} | ${r.gates + r.wishes + r.unknown} | ${r.gates} | ${r.wishes} | ${r.unknown} | ${r.wishPct}% | ${r.hasSettings ? "yes" : "no"} | ${r.hasHooks ? "yes" : "no"} |`);
  await fs.writeFile(path.join(DATA, "leaderboard.md"), md.join("\n") + "\n");
  process.stderr.write(`\nwrote data/leaderboard.json and data/leaderboard.md (${scanned.length} repos, ${Math.round((100 * totalWish) / Math.max(1, totalRules))}% wishes)\n`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "discover") await discover();
else if (cmd === "scan") await scanTop(Number(arg ?? 30), process.argv.includes("--offline"));
else {
  process.stderr.write("usage: leaderboard.ts discover | scan [N] [--offline]\n");
  process.exit(1);
}
