import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProfile } from "../repo/profile.js";
import { buildReport } from "../report/build.js";
import type { Rule, ScanReport, StaticProbeResult } from "../types.js";
import { buildGraph, exposed, renderInventoryTemplate } from "./build.js";
import { AGENT_ID, discoverAssets } from "./discover.js";
import { renderGraphHtml, renderGraphTerminal } from "./report.js";

const dirs: string[] = [];
async function repo(files: Record<string, string>): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pf-graph-")));
  dirs.push(d);
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(d, rel)), { recursive: true });
    await fs.writeFile(path.join(d, rel), body);
  }
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function graphOf(files: Record<string, string>, report?: ScanReport) {
  const root = await repo(files);
  return buildGraph(root, await detectProfile(root), report);
}

function reportWith(grade: "GATE" | "WISH" | "BROKEN", category: Rule["category"]): ScanReport {
  const rule: Rule = { id: "r1", text: "never read .env", category, targets: [".env"], source: { kind: "prose", file: "CLAUDE.md" } };
  const p = { tool: "Read" as const, input: { file_path: ".env" }, describe: "Read .env" };
  const probe: StaticProbeResult = {
    ruleId: "r1",
    outcomes: [{ probe: p, blockedBy: grade === "GATE" ? "permission-deny" : "none", evidence: "x" }],
    probe: p,
    blockedBy: grade === "GATE" ? "permission-deny" : "none",
    evidence: "x",
  };
  const r = buildReport("/r", [rule], [probe], [], "static");
  r.verdicts[0]!.grade = grade;
  r.totals = { gate: grade === "GATE" ? 1 : 0, wish: grade === "WISH" ? 1 : 0, broken: grade === "BROKEN" ? 1 : 0, untested: 0, error: 0, notApplicable: 0 };
  return r;
}

describe("discoverAssets", () => {
  it("finds a credential the code reads and names the service it opens", async () => {
    const g = await graphOf({ "src/db.ts": 'const url = process.env.DATABASE_URL;\n', "package.json": "{}" });
    expect(g.assets.some((a) => a.name === "DATABASE_URL" && a.kind === "credential")).toBe(true);
    expect(g.assets.some((a) => a.name === "the primary database")).toBe(true);
    expect(g.edges.some((e) => e.to === "service:the primary database" && e.reach === "authenticate")).toBe(true);
  });

  it("reads the several ways a language asks for an environment variable", async () => {
    const g = await graphOf({
      "a.py": 'os.environ["STRIPE_SECRET_KEY"]\n',
      "b.go": 'os.Getenv("SLACK_WEBHOOK_URL")\n',
      "c.rb": 'ENV["SENTRY_DSN"]\n',
      "d.rs": 'env::var("AWS_SECRET_ACCESS_KEY")\n',
    });
    for (const n of ["STRIPE_SECRET_KEY", "SLACK_WEBHOOK_URL", "SENTRY_DSN", "AWS_SECRET_ACCESS_KEY"]) {
      expect(g.assets.some((a) => a.name === n), n).toBe(true);
    }
  });

  it("ignores ordinary configuration, which is not a credential", async () => {
    const g = await graphOf({ "a.ts": "process.env.NODE_ENV; process.env.PORT; process.env.LOG_LEVEL;\n" });
    expect(g.assets.filter((a) => a.kind === "credential")).toHaveLength(0);
  });

  it("traces a secrets file to the credentials inside it", async () => {
    const g = await graphOf({ ".env": "DATABASE_URL=postgres://x\nSTRIPE_SECRET_KEY=sk_test\n" });
    expect(g.edges.some((e) => e.from === "secret-file:.env" && e.to === "credential:DATABASE_URL")).toBe(true);
  });

  it("finds the secrets a workflow can reach, because the agent can edit the workflow", async () => {
    const g = await graphOf({ ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - run: deploy\n        env:\n          TOKEN: ${{ secrets.NPM_TOKEN }}\n" });
    expect(g.assets.some((a) => a.kind === "ci")).toBe(true);
    expect(g.assets.some((a) => a.name === "NPM_TOKEN")).toBe(true);
    expect(g.edges.some((e) => e.from === AGENT_ID && e.reach === "write" && e.to.startsWith("ci:"))).toBe(true);
  });

  it("names npm as a publish target when the package is named", async () => {
    const g = await graphOf({ "package.json": JSON.stringify({ name: "thing", version: "1.0.0" }) });
    expect(g.assets.some((a) => a.kind === "registry" && a.name === "npm")).toBe(true);
  });

  it("always says what it could not see", async () => {
    const g = await graphOf({ "a.ts": "" });
    expect(g.blindSpots.length).toBeGreaterThan(3);
    expect(g.blindSpots.join(" ")).toMatch(/does not say whether a key is read-only/);
  });

  it("says the blast radius is unknown when there is no inventory", async () => {
    const g = await graphOf({ "a.ts": "process.env.STRIPE_SECRET_KEY\n" });
    expect(g.blindSpots.join(" ")).toContain("no paperfence.inventory.yaml");
    expect(g.assets.find((a) => a.name === "STRIPE_SECRET_KEY")!.blast).toBeUndefined();
  });
});

describe("the inventory file", () => {
  it("takes a blast radius and a note from the team", async () => {
    const g = await graphOf({
      "a.ts": "process.env.STRIPE_SECRET_KEY\n",
      "paperfence.inventory.yaml": 'version: 1\nassets:\n  - name: STRIPE_SECRET_KEY\n    blast: high\n    note: "live key, can issue refunds"\n',
    });
    const a = g.assets.find((x) => x.name === "STRIPE_SECRET_KEY")!;
    expect(a.blast).toBe("high");
    expect(a.note).toContain("refunds");
  });

  it("adds assets the repository never mentions, which is the point of the file", async () => {
    const g = await graphOf({
      "a.ts": "",
      "paperfence.inventory.yaml": 'version: 1\nassets:\n  - name: the production cluster\n    kind: environment\n    blast: high\n',
    });
    expect(g.assets.some((x) => x.name === "the production cluster" && x.blast === "high")).toBe(true);
  });

  it("refuses a file it cannot read rather than ignoring it", async () => {
    await expect(graphOf({ "paperfence.inventory.yaml": "version: 2\n" })).rejects.toThrow(/version must be 1/);
  });

  it("writes a template listing what the repository found", async () => {
    const g = await graphOf({ "a.ts": "process.env.STRIPE_SECRET_KEY\n" });
    const t = renderInventoryTemplate(g);
    expect(t).toContain("STRIPE_SECRET_KEY");
    expect(t).toContain("blast: unknown");
  });
});

describe("joining the graph to the scan", () => {
  it("says an asset is behind a control when the rule protecting it is a gate", async () => {
    const g = await graphOf({ ".env": "STRIPE_SECRET_KEY=sk\n" }, reportWith("GATE", "protect-secrets"));
    expect(g.gates.find((x) => x.assetId === "secret-file:.env")!.status).toBe("gated");
  });

  it("says an asset is reachable when the rule protecting it is a wish", async () => {
    const g = await graphOf({ ".env": "STRIPE_SECRET_KEY=sk\n" }, reportWith("WISH", "protect-secrets"));
    expect(g.gates.find((x) => x.assetId === "secret-file:.env")!.status).toBe("ungated");
  });

  it("says nothing is even asked for when the repository has no such rule", async () => {
    const g = await graphOf({ ".env": "STRIPE_SECRET_KEY=sk\n" }, reportWith("GATE", "no-install"));
    const gate = g.gates.find((x) => x.assetId === "secret-file:.env")!;
    expect(gate.status).toBe("ungated");
    expect(gate.detail).toContain("no rule about");
  });

  it("is unknown, not open, when no scan ran", async () => {
    const g = await graphOf({ ".env": "STRIPE_SECRET_KEY=sk\n" });
    expect(g.gates.find((x) => x.assetId === "secret-file:.env")!.status).toBe("unknown");
  });

  it("ranks a declared high blast radius above an unknown one", async () => {
    const g = await graphOf(
      {
        "a.ts": "process.env.STRIPE_SECRET_KEY;\nprocess.env.SENTRY_DSN;\n",
        "paperfence.inventory.yaml": 'version: 1\nassets:\n  - name: STRIPE_SECRET_KEY\n    blast: high\n',
      },
      reportWith("WISH", "protect-secrets"),
    );
    expect(exposed(g)[0]!.asset.name).toBe("STRIPE_SECRET_KEY");
  });
});

describe("rendering", () => {
  it("says so plainly when the repository names nothing reachable", async () => {
    const g = await graphOf({ "README.md": "# hi" });
    expect(renderGraphTerminal(g)).toContain("Nothing in this repository names");
  });

  it("puts the blind spots in both outputs", async () => {
    const g = await graphOf({ ".env": "STRIPE_SECRET_KEY=sk\n" }, reportWith("WISH", "protect-secrets"));
    expect(renderGraphTerminal(g)).toContain("What this cannot see");
    expect(renderGraphHtml(g)).toContain("What this cannot see");
  });

  it("escapes a name that would otherwise break the HTML", async () => {
    const g = await graphOf({
      "a.ts": "",
      "paperfence.inventory.yaml": 'version: 1\nassets:\n  - name: "<script>alert(1)</script>"\n    kind: service\n',
    });
    expect(renderGraphHtml(g)).not.toContain("<script>alert(1)</script>");
  });
});
