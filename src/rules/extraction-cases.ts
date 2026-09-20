import type { RuleCategory } from "../types.js";

/**
 * Rule sentences with the category each one should get.
 *
 * Every verdict paperfence prints is attached to a rule, and a rule is
 * attached to a category by reading a sentence. If that reading is wrong the
 * verdict is about something else: a scope rule filed as `no-install` gets
 * probed with `npm install left-pad`, and in a repository that denies that
 * command it would be reported as protected by a control with nothing to do
 * with it.
 *
 * Until this file existed, extraction accuracy was anecdote. The first run
 * against real repositories (`reviews/real-repos-01.md`) found two real rules
 * called untestable and two style rules mapped to categories that did not fit,
 * and the same sentence categorised differently depending on what surrounded
 * it. None of that was measurable.
 *
 * Most sentences here are taken verbatim from public repositories, which is
 * the point: rule files are written by people in every style there is, and a
 * suite of sentences we wrote ourselves would only measure our own habits.
 *
 * **This set is easier than reality, and a perfect score on it is not a claim
 * about real repositories.** The sentences are short and sit in a clean list.
 * A real rule file is long prose with headings, examples and commentary, and
 * that is where rules get missed: the three repositories in
 * `reviews/real-repos-01.md` produced misses that these same sentences do not.
 * Both readers score every clear-cut case here and neither scored that well in
 * the wild. Closing that gap means scoring against whole documents, not
 * sentences, and that is not built yet.
 */

export interface ExtractionCase {
  text: string;
  /** The category this sentence should be filed under. */
  expect: RuleCategory;
  /** Set when a reasonable reader could pick a different category. Counted separately. */
  arguable?: boolean;
  /** Where the sentence came from, when it is not ours. */
  source?: string;
  note?: string;
}

export const EXTRACTION_CASES: ExtractionCase[] = [
  // ---------- protected branches ----------
  { text: "Never push directly to main. Always open a pull request.", expect: "protect-branch" },
  { text: "Never commit or push directly to `main`; every change goes through a pull request.", expect: "protect-branch" },
  { text: "Do not commit straight to master. Work on a branch.", expect: "protect-branch" },
  { text: "All changes land on `develop` via PR; direct pushes are rejected.", expect: "protect-branch", arguable: true },

  // ---------- tests ----------
  { text: "Do not delete, skip, or modify tests in `tests/` to make the suite pass. Fix the code instead.", expect: "protect-tests" },
  {
    text: "Regression: the assertion remains correct. Fix the code; never relax, weaken, or delete the assertion.",
    expect: "protect-tests",
    source: "darkroomengineering/cc-settings",
    note: "Reported as untestable on the first real run.",
  },
  { text: "Never disable a failing test to get a green build.", expect: "protect-tests" },
  { text: "Making the suite green alone never justifies changing an assertion.", expect: "protect-tests", arguable: true, source: "darkroomengineering/cc-settings" },

  // ---------- required steps ----------
  { text: "Always run `npm test` before committing.", expect: "require-before" },
  {
    text: "Never commit code that does not typecheck, build, and pass tests. Run all three and fix failures.",
    expect: "require-before",
    source: "darkroomengineering/cc-settings",
    note: "The most checkable rule in that file, and it was reported as untestable.",
  },
  { text: "Run `pnpm lint` before opening a pull request.", expect: "require-before" },
  { text: "Run the test suite before you push.", expect: "require-before" },

  // ---------- secrets ----------
  { text: "Never read `.env` or print secrets to the console or into your responses.", expect: "protect-secrets" },
  { text: "Never commit secrets or `.env` files.", expect: "protect-secrets", source: "darkroomengineering/cc-settings" },
  { text: "Do not open credentials.json or echo API keys.", expect: "protect-secrets" },

  // ---------- destructive ----------
  { text: "Never run `rm -rf`, `git reset --hard`, or `git clean -fdx`.", expect: "no-destructive" },
  { text: "Do not delete files outside the working directory.", expect: "no-destructive", arguable: true },
  { text: "Never drop or truncate a database table.", expect: "no-destructive" },

  // ---------- force push ----------
  { text: "Do not force push. Ever.", expect: "no-force-push" },
  { text: "Never force-push `main` or `master`.", expect: "no-force-push", source: "darkroomengineering/cc-settings" },
  { text: "Do not rewrite history on a shared branch.", expect: "no-force-push", arguable: true },

  // ---------- dependencies ----------
  { text: "Don't add new dependencies without asking first.", expect: "no-install" },
  { text: "Never add a package without approval.", expect: "no-install" },
  { text: "Darkroom projects are Bun-first. Never mix package managers within a session.", expect: "no-install", arguable: true, source: "darkroomengineering/cc-settings" },

  // ---------- scope ----------
  { text: "Only modify files under `src/` and `tests/`. Never touch `infra/`.", expect: "scope" },
  { text: "Never edit anything in `vendor/`.", expect: "scope" },
  {
    text: "Keep a bug fix confined to directly related files. Do not refactor adjacent code, update unrelated deps, or reformat.",
    expect: "scope",
    arguable: true,
    source: "darkroomengineering/cc-settings",
    note: "Mapped to no-install on the first real run, which would probe it with `npm install`.",
  },

  // ---------- ask first ----------
  { text: "Ask me before running `npm publish`.", expect: "ask-first" },
  { text: "Get approval before deploying to production.", expect: "ask-first" },

  // ---------- network ----------
  { text: "Never send repo contents to any external service, no curl or wget to outside hosts.", expect: "no-exfil" },
  { text: "Do not make outbound network requests.", expect: "no-exfil" },

  // ---------- genuinely not mechanical ----------
  // These matter as much as the rest: filing judgement under a category with a
  // probe behind it produces a verdict about a command nobody asked for.
  { text: "State the effect before the mechanism. Never clip sentences or remove substance to be shorter.", expect: "other", source: "darkroomengineering/cc-settings" },
  { text: "Use an existing name for an existing thing; never coin or capitalize a replacement concept.", expect: "other", source: "darkroomengineering/cc-settings" },
  { text: "Never change code you have not read in this session. Read the file, trace callers, and understand it first.", expect: "other", source: "darkroomengineering/cc-settings" },
  { text: "After 2 failed attempts with one approach, stop using it and summarize what you tried.", expect: "other", source: "darkroomengineering/cc-settings" },
  { text: "Never fabricate Lighthouse, bundle-size, profiler, or build output.", expect: "other", source: "darkroomengineering/cc-settings" },
  { text: "When existing patterns conflict, choose one and flag the conflict rather than averaging them.", expect: "other", source: "darkroomengineering/cc-settings" },
  { text: "Write clear commit messages in the imperative mood.", expect: "other" },
  { text: "Prefer composition over inheritance.", expect: "other" },
];

export interface Accuracy {
  total: number;
  correct: number;
  /** Cases where a reasonable reader could disagree, scored separately. */
  arguableTotal: number;
  arguableCorrect: number;
  /** A rule that should be checkable and was filed as `other`. The dangerous direction. */
  missed: { text: string; expect: RuleCategory; got: RuleCategory }[];
  /** Judgement filed under a category with a probe behind it. */
  overreached: { text: string; expect: RuleCategory; got: RuleCategory }[];
  /** Everything else that came out wrong. */
  wrong: { text: string; expect: RuleCategory; got: RuleCategory }[];
}

/** Score one categoriser against the whole set. */
export function score(categorise: (text: string) => RuleCategory): Accuracy {
  const a: Accuracy = { total: 0, correct: 0, arguableTotal: 0, arguableCorrect: 0, missed: [], overreached: [], wrong: [] };
  for (const c of EXTRACTION_CASES) {
    const got = categorise(c.text);
    const ok = got === c.expect;
    if (c.arguable) {
      a.arguableTotal++;
      if (ok) a.arguableCorrect++;
      continue;
    }
    a.total++;
    if (ok) {
      a.correct++;
      continue;
    }
    const row = { text: c.text, expect: c.expect, got };
    if (c.expect !== "other" && got === "other") a.missed.push(row);
    else if (c.expect === "other" && got !== "other") a.overreached.push(row);
    else a.wrong.push(row);
  }
  return a;
}

export function renderAccuracy(a: Accuracy, label: string): string {
  const pct = a.total ? Math.round((100 * a.correct) / a.total) : 0;
  const lines = [
    `${label}: ${a.correct}/${a.total} clear-cut cases (${pct}%), ${a.arguableCorrect}/${a.arguableTotal} arguable ones`,
  ];
  if (a.missed.length) {
    lines.push(`  ${a.missed.length} checkable rule(s) filed as untestable:`);
    for (const m of a.missed) lines.push(`    want ${m.expect}: ${m.text.slice(0, 74)}`);
  }
  if (a.overreached.length) {
    lines.push(`  ${a.overreached.length} judgement rule(s) filed under a category with a probe:`);
    for (const m of a.overreached) lines.push(`    got ${m.got}: ${m.text.slice(0, 74)}`);
  }
  if (a.wrong.length) {
    lines.push(`  ${a.wrong.length} in the wrong category:`);
    for (const m of a.wrong) lines.push(`    want ${m.expect}, got ${m.got}: ${m.text.slice(0, 62)}`);
  }
  return lines.join("\n");
}
