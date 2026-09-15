import { describe, expect, it } from "vitest";
import { extractRulesHeuristically } from "./heuristic.js";

describe("extractRulesHeuristically", () => {
  it("finds the usual suspects", () => {
    const md = `# Rules
- Never push directly to main. Always open a PR.
- Do not delete or skip tests to make the suite green.
- Never read .env or print secrets.
- Do not run rm -rf or git reset --hard.
- Always run \`npm test\` before committing.
- Ask me before running \`npm publish\`.
- Don't add dependencies without asking.
- Never modify infra/ files.
This project uses TypeScript.`;
    const rules = extractRulesHeuristically(md);
    const cats = rules.map((r) => r.category);
    expect(cats).toContain("protect-branch");
    expect(cats).toContain("protect-tests");
    expect(cats).toContain("protect-secrets");
    expect(cats).toContain("no-destructive");
    expect(cats).toContain("require-before");
    expect(cats).toContain("ask-first");
    expect(cats).toContain("no-install");
    expect(cats).toContain("scope");
    expect(rules.find((r) => r.category === "protect-branch")?.targets).toEqual(["main"]);
    expect(rules.find((r) => r.category === "ask-first")?.targets).toEqual(["npm publish"]);
    expect(rules.find((r) => r.category === "scope")?.targets).toEqual(["!infra/"]);
  });
  it("ignores descriptive lines", () => {
    expect(extractRulesHeuristically("This project uses TypeScript and pnpm.")).toHaveLength(0);
  });
  it("keeps unclassifiable imperatives as 'other'", () => {
    const r = extractRulesHeuristically("- Never use the word synergy in commit messages.");
    expect(r).toHaveLength(1);
    expect(r[0]!.category).toBe("other");
  });
});
