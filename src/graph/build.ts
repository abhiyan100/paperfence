import type { RepoProfile } from "../repo/profile.js";
import type { RuleCategory, RuleVerdict, ScanReport } from "../types.js";
import { AGENT_ID, discoverAssets, loadInventory } from "./discover.js";
import type { Asset, CapabilityGraph, Gate } from "./types.js";

/**
 * Attach the scan's verdicts to the assets they protect.
 *
 * This is the join that makes the graph worth having. A report saying
 * "protect-secrets is a wish" and a graph saying ".env holds the Stripe key"
 * are each half a sentence. Together they say: nothing stops the agent
 * reading the key that can charge customers.
 */

/** Which rule categories stand between an agent and an asset of this kind. */
const GUARDS: Record<Asset["kind"], RuleCategory[]> = {
  credential: ["protect-secrets", "no-exfil"],
  "secret-file": ["protect-secrets", "no-exfil"],
  service: ["no-exfil"],
  repository: ["protect-branch", "no-force-push"],
  registry: ["ask-first", "no-install"],
  environment: ["scope", "no-destructive"],
  ci: ["scope"],
};

/**
 * Does this rule actually stand between an agent and this asset?
 *
 * Matching on category alone said that a gate on "never read `.env`" protected
 * an `AWS_SECRET_ACCESS_KEY` that the rule had never heard of. A control
 * covers an asset when it names it, names a file the asset was found in, or
 * names nothing at all and so applies to the whole category.
 */
function covers(rule: RuleVerdict["rule"], asset: Asset): boolean {
  const targets = rule.targets.map((t) => t.replace(/^!/, "").replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  // A rule with no target is about the category as a whole: "never send data
  // out", "no destructive commands". Those cover every asset of their kind.
  if (!targets.length) return true;
  const haystack = [asset.name, ...asset.evidence.map((e) => e.file)].map((x) => x.replace(/^\.\//, ""));
  return targets.some((t) =>
    haystack.some((h) => h === t || h.endsWith("/" + t) || h.startsWith(t + "/") || h.toLowerCase() === t.toLowerCase()),
  );
}

function statusOf(report: ScanReport | undefined, categories: RuleCategory[], asset: Asset): Gate {
  if (!report) {
    return { assetId: "", categories, status: "unknown", detail: "no scan was run, so nothing is known about the controls here" };
  }
  const inCategory = report.verdicts.filter((v) => categories.includes(v.rule.category) && !v.restates);
  const relevant = inCategory.filter((v) => covers(v.rule, asset));
  if (inCategory.length && !relevant.length) {
    return {
      assetId: "",
      categories,
      status: "ungated",
      detail: `this repository has ${inCategory.length} rule(s) about ${categories.join(" or ")}, and none of them names ${asset.name} or anywhere it was found`,
    };
  }
  if (!relevant.length) {
    return { assetId: "", categories, status: "ungated", detail: `this repository has no rule about ${categories.join(" or ")}, so nothing is even asked for` };
  }
  const broken = relevant.filter((v) => v.grade === "BROKEN");
  const gates = relevant.filter((v) => v.grade === "GATE");
  // A rule whose only possible control is a hook that was not executed is not
  // an open door; it is an unanswered question, and calling it open would be
  // the same overclaim in the other direction.
  const unrun = relevant.filter((v) => v.grade === "WISH" && /not run \(--no-hooks\)|were not run/.test(v.staticProbe?.evidence ?? ""));
  const wishes = relevant.filter((v) => v.grade === "WISH" && !unrun.includes(v));
  if (broken.length) {
    return { assetId: "", categories, status: "ungated", detail: `an agent reached this in a live run: ${broken[0]!.summary.slice(0, 160)}` };
  }
  if (gates.length && !wishes.length) {
    return { assetId: "", categories, status: "gated", detail: `${gates.length} control(s) refuse it: ${gates[0]!.summary.slice(0, 140)}` };
  }
  if (gates.length && wishes.length) {
    return { assetId: "", categories, status: "partial", detail: `${gates.length} control(s) refuse it and ${wishes.length} rule(s) have nothing behind them` };
  }
  if (!wishes.length && unrun.length) {
    return { assetId: "", categories, status: "unknown", detail: `${unrun.length} rule(s) may be covered by a hook that was not executed; run without --no-hooks to find out` };
  }
  const tail = unrun.length ? `; ${unrun.length} more may be covered by a hook that was not executed` : "";
  return { assetId: "", categories, status: "ungated", detail: `${wishes.length} rule(s) ask for this and nothing enforces any of them${tail}` };
}

export async function buildGraph(root: string, profile: RepoProfile, report?: ScanReport): Promise<CapabilityGraph> {
  const { assets, edges, blindSpots } = await discoverAssets(root, profile);

  // A team's own statement about what the code cannot say.
  const inventory = await loadInventory(root);
  if (inventory) {
    for (const entry of inventory.assets ?? []) {
      const match = assets.find((a) => a.name === entry.name || a.id === `${entry.kind}:${entry.name}`);
      if (match) {
        match.blast = entry.blast ?? match.blast;
        match.note = entry.note ?? match.note;
        continue;
      }
      // An asset the repository never mentions, which is exactly what the
      // inventory file is for.
      assets.push({
        id: `${entry.kind ?? "service"}:${entry.name}`,
        kind: entry.kind ?? "service",
        name: entry.name,
        evidence: [{ file: "paperfence.inventory.yaml" }],
        blast: entry.blast,
        note: entry.note,
      });
    }
    for (const entry of inventory.assets ?? []) {
      for (const target of entry.reaches ?? []) {
        const from = assets.find((a) => a.name === entry.name);
        const to = assets.find((a) => a.name === target);
        if (from && to) edges.push({ from: from.id, to: to.id, reach: "authenticate", how: `declared in paperfence.inventory.yaml` });
      }
    }
  } else {
    blindSpots.push("There is no paperfence.inventory.yaml, so every blast radius below is unknown. `paperfence graph --init` writes a starting point.");
  }

  const gates: Gate[] = assets
    .filter((a) => a.id !== AGENT_ID)
    .map((a) => ({ ...statusOf(report, GUARDS[a.kind] ?? [], a), assetId: a.id }));

  return { root, at: new Date().toISOString(), assets, edges, gates, blindSpots };
}

/** Assets the agent can reach with nothing in the way, worst first. */
export function exposed(graph: CapabilityGraph): { asset: Asset; gate: Gate }[] {
  const order = { high: 0, medium: 1, low: 2, unknown: 3 } as const;
  return graph.gates
    .filter((g) => g.status === "ungated" || g.status === "partial")
    .map((g) => ({ asset: graph.assets.find((a) => a.id === g.assetId)!, gate: g }))
    .filter((x) => x.asset && x.asset.id !== AGENT_ID)
    .sort((a, b) => {
      const byBlast = order[a.asset.blast ?? "unknown"] - order[b.asset.blast ?? "unknown"];
      if (byBlast !== 0) return byBlast;
      return Number(b.gate.status === "ungated") - Number(a.gate.status === "ungated");
    });
}

/** A starting inventory file, listing what the repository found so a human can fill in the rest. */
export function renderInventoryTemplate(graph: CapabilityGraph): string {
  const lines: string[] = [
    "# What the repository cannot tell paperfence.",
    "#",
    "# The code names the credentials it reads. It does not say what they can do.",
    "# Fill in `blast` so the graph can rank what matters: low, medium or high.",
    "# Add assets the repository never mentions; that is the main reason this",
    "# file exists.",
    "",
    "version: 1",
    "assets:",
  ];
  for (const a of graph.assets.filter((x) => x.id !== AGENT_ID && (x.kind === "credential" || x.kind === "service"))) {
    lines.push(`  - name: ${JSON.stringify(a.name)}`);
    lines.push(`    kind: ${a.kind}`);
    lines.push(`    blast: unknown   # low | medium | high`);
    lines.push(`    note: ""`);
    lines.push(`    # reaches: []    # names of other assets this one opens`);
  }
  if (!graph.assets.some((x) => x.kind === "credential")) lines.push("  # none found in the repository; add the ones you know about");
  return lines.join("\n") + "\n";
}
