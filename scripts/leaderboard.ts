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

interface Row {
  repo: string;
  stars: number;
  description: string;
  rules: number;
  gates: number;
  wishes: number;
  untested: number;
  wishPct: number;
  hasSettings: boolean;
  hasHooks: boolean;
  sample: { text: string; grade: string; summary: string }[];
  scannedAt: string;
  error?: string;
}

async function scanTop(n: number, offline: boolean): Promise<void> {
  const candidates: Candidate[] = JSON.parse(await fs.readFile(path.join(DATA, "candidates.json"), "utf8"));
  const existing: Row[] = await fs
    .readFile(path.join(DATA, "leaderboard.json"), "utf8")
    .then((s) => JSON.parse(s))
    .catch(() => []);
  const done = new Map(existing.map((r) => [r.repo, r]));
  const rows: Row[] = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pf-lb-"));

  for (const c of candidates.slice(0, n)) {
    const prev = done.get(c.repo);
    if (prev && !prev.error) {
      rows.push(prev);
      continue;
    }
    const dir = path.join(tmp, c.repo.replace("/", "__"));
    process.stderr.write(`\n== ${c.repo} (${c.stars} stars)\n`);
    try {
      await run("git", ["clone", "-q", "--depth", "1", "--filter=blob:none", `https://github.com/${c.repo}.git`, dir], { timeout: 120_000 });
      const report: ScanReport = await scan(dir, { offline, noHooks: true, onProgress: (m) => process.stderr.write(`  ${m}\n`) });
      const hasSettings = await fs.stat(path.join(dir, ".claude", "settings.json")).then(() => true).catch(() => false);
      const hasHooks = report.rules.some((r) => r.source.kind === "hook") || (await fs.readdir(path.join(dir, ".claude", "hooks")).catch(() => [])).length > 0;
      const attackable = report.totals.gate + report.totals.wish;
      rows.push({
        repo: c.repo,
        stars: c.stars,
        description: c.description,
        rules: report.rules.length,
        gates: report.totals.gate,
        wishes: report.totals.wish,
        untested: report.totals.untested,
        wishPct: attackable ? Math.round((100 * report.totals.wish) / attackable) : 0,
        hasSettings,
        hasHooks,
        sample: report.verdicts
          .filter((v) => v.grade !== "UNTESTED")
          .slice(0, 6)
          .map((v) => ({ text: v.rule.text.slice(0, 140), grade: v.grade, summary: v.summary.slice(0, 200) })),
        scannedAt: report.scannedAt,
      });
    } catch (e) {
      rows.push({ repo: c.repo, stars: c.stars, description: c.description, rules: 0, gates: 0, wishes: 0, untested: 0, wishPct: 0, hasSettings: false, hasHooks: false, sample: [], scannedAt: new Date().toISOString(), error: (e as Error).message.split("\n")[0] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    await fs.writeFile(path.join(DATA, "leaderboard.json"), JSON.stringify(rows, null, 2));
  }
  await fs.rm(tmp, { recursive: true, force: true });

  const scanned = rows.filter((r) => !r.error && r.gates + r.wishes > 0);
  const totalRules = scanned.reduce((a, r) => a + r.gates + r.wishes, 0);
  const totalWish = scanned.reduce((a, r) => a + r.wishes, 0);
  const md: string[] = [];
  md.push(`# The fence report: popular repos with a CLAUDE.md`);
  md.push("");
  md.push(`${scanned.length} repos, ${totalRules} action rules, ${Math.round((100 * totalWish) / Math.max(1, totalRules))}% of them wishes. Scanned ${new Date().toISOString().slice(0, 10)} with \`paperfence scan\`.`);
  md.push("");
  md.push("| repo | stars | rules | gates | wishes | wishes % | settings.json | hooks |");
  md.push("|---|---:|---:|---:|---:|---:|:-:|:-:|");
  for (const r of scanned) md.push(`| [${r.repo}](https://github.com/${r.repo}) | ${r.stars.toLocaleString()} | ${r.gates + r.wishes} | ${r.gates} | ${r.wishes} | ${r.wishPct}% | ${r.hasSettings ? "yes" : "no"} | ${r.hasHooks ? "yes" : "no"} |`);
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
