import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { RepoProfile } from "../repo/profile.js";
import type { Asset, AssetKind, Edge, Inventory } from "./types.js";

/**
 * Read the repository for the names of things an agent could reach.
 *
 * Names, not values. The code says it reads `STRIPE_SECRET_KEY`; it does not
 * say what that key can charge. That gap is the point of the inventory file
 * and is stated in the output.
 */

const MAX_FILE = 400_000;
const MAX_FILES = 1500;

/** Environment variables a program reads, across the languages we see most. */
const ENV_PATTERNS: RegExp[] = [
  /process\.env(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*\])/g,
  /(?:os\.environ|environ)(?:\.get\(\s*["']([A-Z][A-Z0-9_]{2,})["']|\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\])/g,
  /os\.Getenv\(\s*"([A-Z][A-Z0-9_]{2,})"\s*\)/g,
  /ENV\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g,
  /env::var\(\s*"([A-Z][A-Z0-9_]{2,})"\s*\)/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})"\s*\)/g,
];

/** Variable names that are configuration, not credentials. */
const NOT_A_SECRET = /^(NODE_ENV|PORT|HOST|HOME|PATH|LANG|LC_|TZ|CI|DEBUG|LOG_LEVEL|PWD|USER|SHELL|TERM|npm_|VERCEL_ENV|NEXT_PUBLIC_)/;

/** Names that clearly carry authority. */
const LOOKS_LIKE_CREDENTIAL = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN|_URL|_URI|_CONN|AUTH|PRIVATE|CERT|SIGNING|WEBHOOK)/;

/** A service we can name from the shape of the variable. */
const SERVICE_HINTS: { re: RegExp; service: string }[] = [
  { re: /^(DATABASE|DB|POSTGRES|PG|MYSQL|MARIADB)/, service: "the primary database" },
  { re: /^(REDIS|CACHE)/, service: "Redis" },
  { re: /^(STRIPE)/, service: "Stripe" },
  { re: /^(AWS|S3)/, service: "AWS" },
  { re: /^(GCP|GOOGLE|GCS)/, service: "Google Cloud" },
  { re: /^(AZURE)/, service: "Azure" },
  { re: /^(OPENAI)/, service: "OpenAI" },
  { re: /^(ANTHROPIC|CLAUDE)/, service: "Anthropic" },
  { re: /^(GITHUB|GH)_/, service: "GitHub" },
  { re: /^(SLACK)/, service: "Slack" },
  { re: /^(SENDGRID|MAILGUN|SES|SMTP|POSTMARK|RESEND)/, service: "the email provider" },
  { re: /^(TWILIO)/, service: "Twilio" },
  { re: /^(SENTRY)/, service: "Sentry" },
  { re: /^(MONGO)/, service: "MongoDB" },
  { re: /^(KAFKA|RABBIT|SQS|PUBSUB)/, service: "the message queue" },
  { re: /^(VAULT|SECRETS_MANAGER|KMS)/, service: "the secret manager" },
];

const READABLE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".rs", ".java", ".kt", ".php", ".cs", ".ex", ".yml", ".yaml", ".toml", ".json", ".env", ".sh", ".bash", ".tf", ".tfvars", ".dockerfile", ""]);

function serviceFor(name: string): string | null {
  for (const h of SERVICE_HINTS) if (h.re.test(name)) return h.service;
  return null;
}

/**
 * A git remote with the credential taken out.
 *
 * `https://user:ghp_xxx@github.com/team/repo.git` was becoming an asset name
 * and an asset id, both of which end up in the graph's JSON, its terminal
 * output and its HTML. A tool that writes a token into a shareable report is
 * doing the thing it exists to catch.
 */
export function sanitizeRemote(url: string): { name: string; hadCredential: boolean } {
  let rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  let hadCredential = false;
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    const userinfo = rest.slice(0, at);
    // `git@github.com:team/repo` is a username, not a secret. Anything with a
    // colon in it is a password or a token.
    if (userinfo.includes(":")) {
      hadCredential = true;
      rest = rest.slice(at + 1);
    } else if (/^[\w.-]+$/.test(userinfo)) {
      rest = rest.slice(at + 1);
    }
  }
  return { name: rest.replace(/\.git$/, ""), hadCredential };
}

async function readCapped(abs: string): Promise<string | null> {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

function lineOf(body: string, index: number): number {
  return body.slice(0, index).split("\n").length;
}

export interface Discovered {
  assets: Asset[];
  edges: Edge[];
  blindSpots: string[];
}

export async function discoverAssets(root: string, profile: RepoProfile): Promise<Discovered> {
  const assets = new Map<string, Asset>();
  const edges: Edge[] = [];
  const add = (kind: AssetKind, name: string, ev: Asset["evidence"][number]): Asset => {
    const id = `${kind}:${name}`;
    const existing = assets.get(id);
    if (existing) {
      if (existing.evidence.length < 5 && !existing.evidence.some((e) => e.file === ev.file && e.line === ev.line)) existing.evidence.push(ev);
      return existing;
    }
    const a: Asset = { id, kind, name, evidence: [ev] };
    assets.set(id, a);
    return a;
  };
  const link = (from: string, to: string, reach: Edge["reach"], how: string) => {
    if (edges.some((e) => e.from === from && e.to === to && e.reach === reach)) return;
    edges.push({ from, to, reach, how });
  };

  const AGENT = "agent:this-repo";
  assets.set(AGENT, { id: AGENT, kind: "environment", name: "the agent working in this repository", evidence: [] });

  // ---------- credentials the code reads ----------
  const files = profile.files.filter((f) => READABLE_EXT.has(path.extname(f).toLowerCase())).slice(0, MAX_FILES);
  for (const rel of files) {
    const body = await readCapped(path.join(root, rel));
    if (body === null) continue;
    for (const re of ENV_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const name = m[1] ?? m[2];
        if (!name || NOT_A_SECRET.test(name)) continue;
        if (!LOOKS_LIKE_CREDENTIAL.test(name)) continue;
        const cred = add("credential", name, { file: rel, line: lineOf(body, m.index), snippet: m[0].slice(0, 80) });
        link(AGENT, cred.id, "read", `the code reads ${name} from the environment, so whatever holds it is in reach`);
        const service = serviceFor(name);
        if (service) {
          const svc = add("service", service, { file: rel, line: lineOf(body, m.index) });
          link(cred.id, svc.id, "authenticate", `${name} is what authenticates to ${service}`);
        }
      }
    }
  }

  // ---------- files that hold credentials ----------
  for (const rel of profile.secretFiles) {
    const f = add("secret-file", rel, { file: rel });
    link(AGENT, f.id, "read", `${rel} is in the repository's working tree`);
    const body = await readCapped(path.join(root, rel));
    if (body === null) continue;
    for (const [i, line] of body.split("\n").entries()) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/.exec(line);
      if (!m || NOT_A_SECRET.test(m[1]!)) continue;
      const cred = add("credential", m[1]!, { file: rel, line: i + 1 });
      link(f.id, cred.id, "read", `${m[1]} is set in ${rel}`);
      const service = serviceFor(m[1]!);
      if (service) {
        const svc = add("service", service, { file: rel, line: i + 1 });
        link(cred.id, svc.id, "authenticate", `${m[1]} is what authenticates to ${service}`);
      }
    }
  }

  // ---------- CI secrets ----------
  for (const rel of profile.files.filter((f) => /^\.github\/workflows\/.*\.ya?ml$/.test(f))) {
    const body = await readCapped(path.join(root, rel));
    if (body === null) continue;
    const ci = add("ci", "GitHub Actions", { file: rel });
    link(AGENT, ci.id, "write", `the agent can edit ${rel}, and a workflow runs with the repository's secrets`);
    const re = /secrets\.([A-Z][A-Z0-9_]{2,})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const cred = add("credential", m[1]!, { file: rel, line: lineOf(body, m.index) });
      link(ci.id, cred.id, "read", `${m[1]} is available to workflows in ${rel}`);
      const service = serviceFor(m[1]!);
      if (service) link(cred.id, add("service", service, { file: rel }).id, "authenticate", `${m[1]} is what authenticates to ${service}`);
    }
  }

  // ---------- git remotes ----------
  const gitConfig = await readCapped(path.join(root, ".git", "config"));
  if (gitConfig) {
    const re = /url\s*=\s*(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(gitConfig)) !== null) {
      const url = m[1]!;
      if (/^\.{0,2}\//.test(url)) continue; // a local path, not a remote
      const { name, hadCredential } = sanitizeRemote(url);
      const repo = add("repository", name, { file: ".git/config", line: lineOf(gitConfig, m.index) });
      link(AGENT, repo.id, "publish", "a configured git remote; a push reaches it");
      if (hadCredential) {
        // The URL itself is a credential store, which is worth reporting even
        // though the value is not.
        const cred = add("credential", `a token embedded in the ${name} remote URL`, { file: ".git/config", line: lineOf(gitConfig, m.index) });
        link(repo.id, cred.id, "read", ".git/config holds a credential in the remote URL, readable by anything that can read the repository");
      }
    }
  }

  // ---------- registries ----------
  for (const [rel, kind] of [[".npmrc", "npm"], ["pip.conf", "PyPI"], [".cargo/config.toml", "crates.io"]] as const) {
    const body = await readCapped(path.join(root, rel));
    if (!body) continue;
    const reg = add("registry", kind, { file: rel });
    link(AGENT, reg.id, "publish", `${rel} configures ${kind}, so a publish command has somewhere to go`);
    if (/_authToken|password|token/i.test(body)) {
      const cred = add("credential", `${kind} token`, { file: rel });
      link(reg.id, cred.id, "read", `${rel} contains an auth token`);
    }
  }
  if (profile.packageJson?.name) {
    const reg = add("registry", "npm", { file: "package.json" });
    link(AGENT, reg.id, "publish", `package.json names a package, so \`npm publish\` has a target`);
  }

  // ---------- deployment targets ----------
  for (const rel of profile.infraFiles.slice(0, 60)) {
    const body = await readCapped(path.join(root, rel));
    if (body === null) continue;
    let name = path.basename(path.dirname(rel));
    if (name === "." || name === "") name = rel;
    if (/\.tf$/.test(rel)) {
      const provider = /provider\s+"(\w+)"/.exec(body)?.[1];
      if (provider) name = `${provider} (terraform)`;
    } else if (/docker-compose/.test(rel)) {
      name = "the docker-compose stack";
    } else if (/^\.github\/workflows\//.test(rel)) {
      continue; // handled as CI above
    }
    const env = add("environment", name, { file: rel });
    link(AGENT, env.id, "write", `${rel} describes a deployment target and is editable`);
    // Hostnames that appear in infrastructure are things the deployment talks to.
    const hosts = new Set((body.match(/\b[a-z0-9-]+\.(internal|local|svc|cluster\.local)\b/g) ?? []).slice(0, 10));
    for (const h of hosts) link(env.id, add("service", h, { file: rel }).id, "authenticate", `${rel} points at ${h}`);
  }

  const blindSpots = [
    "What each credential can actually do. The repository names them; it does not say whether a key is read-only or can move money.",
    "Credentials that exist only in a secret manager, a CI setting, or a developer's shell, and are never named in the repository.",
    "What a service reaches in turn. This graph stops at the first hop.",
    "Whether a credential is currently valid, rotated, or already revoked.",
  ];
  if (profile.truncated) blindSpots.push(`The repository has more than ${profile.files.length} files and only the first were read.`);

  return { assets: [...assets.values()], edges, blindSpots };
}

/** A team's own statement about what the repository cannot say. */
export async function loadInventory(root: string): Promise<Inventory | null> {
  const raw = await fs.readFile(path.join(root, "paperfence.inventory.yaml"), "utf8").catch(() => null);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`paperfence.inventory.yaml: ${(e as Error).message}`);
  }
  const doc = parsed as Partial<Inventory>;
  if (doc?.version !== 1) throw new Error("paperfence.inventory.yaml: version must be 1");
  return { version: 1, assets: doc.assets ?? [], notes: doc.notes ?? [] };
}

export const AGENT_ID = "agent:this-repo";
