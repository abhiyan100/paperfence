import type { RuleCategory } from "../types.js";

/**
 * What an agent working in this repository can reach, and what each control
 * actually protects.
 *
 * paperfence's other commands answer "can this call be refused". This one
 * answers the question underneath it: if the call is not refused, what does
 * the agent get to? A `Read(.env)` deny is worth whatever is in `.env`, and
 * a team looking at a list of rules cannot see that from the rules.
 *
 * Everything here is derived from the repository, which is a real limit and
 * is stated in the output rather than implied away. The repository knows the
 * names of the credentials it reads and the services it deploys to. It does
 * not know what those credentials can do. An inventory file is where a team
 * says the part the code cannot.
 */

export type AssetKind =
  /** A named secret the code expects to exist. */
  | "credential"
  /** A file that holds credentials. */
  | "secret-file"
  /** Something the credential talks to: a database, an API, a queue. */
  | "service"
  /** A git remote. */
  | "repository"
  /** A package or image registry the repo publishes to or installs from. */
  | "registry"
  /** A deployment target described by infrastructure files. */
  | "environment"
  /** A continuous integration system holding its own secrets. */
  | "ci";

/** How much damage reaching this asset would do. Declared, never guessed. */
export type Blast = "unknown" | "low" | "medium" | "high";

export interface Asset {
  id: string;
  kind: AssetKind;
  name: string;
  /** Where in the repository we learned about it. */
  evidence: { file: string; line?: number; snippet?: string }[];
  /** Set from an inventory file. Absent means we do not know, and the report says so. */
  blast?: Blast;
  /** A human note from the inventory file. */
  note?: string;
}

export type Reach =
  /** The agent can read the asset's value. */
  | "read"
  /** The agent can change it. */
  | "write"
  /** The agent can use it to reach something else. */
  | "authenticate"
  /** The agent can publish to it. */
  | "publish";

export interface Edge {
  from: string;
  to: string;
  reach: Reach;
  /** One line: how the agent would do it. */
  how: string;
}

/** A control that stands between the agent and an asset. */
export interface Gate {
  assetId: string;
  /** The rule categories that would refuse the reach. */
  categories: RuleCategory[];
  /** What the scan said about those rules. */
  status: "gated" | "partial" | "ungated" | "unknown";
  detail: string;
}

export interface CapabilityGraph {
  root: string;
  at: string;
  assets: Asset[];
  edges: Edge[];
  gates: Gate[];
  /** What this graph could not see. Always populated. */
  blindSpots: string[];
}

export interface Inventory {
  version: 1;
  assets?: { name: string; kind?: AssetKind; blast?: Blast; note?: string; reaches?: string[] }[];
  notes?: string[];
}
