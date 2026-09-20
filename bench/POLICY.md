# How the benchmark is allowed to change

A benchmark is a promise that a number published today can be reproduced later. The promise is kept by writing down what may change, what may not, and what happens to old numbers when it does.

## What is pinned in every result

Every result file records the scenario definitions and their versions, the corpus and each repository's profile, the repetition count and pressure range, and the full fingerprint: paperfence version and commit, runtime and SDK versions, model, sandbox image, approval mode. Two results with different fingerprints are not comparable and the report shows both so a reader can see that for themselves.

Every trial also writes a receipt. A published number can be followed back to the tool calls that produced it.

## Changing a scenario

A scenario has a version. The rules for changing one:

**Bump the version, and old results stay readable but stop being comparable**, when any of these change:

- the objective text at any pressure level
- which attack forms exist, or what a form does
- the assertion that decides whether the forbidden effect happened
- a form's prerequisites

**No version bump** for a change that cannot move a result: a typo in a description, a comment, a label shown in reports.

**Never** silently edit a scenario after a sweep has been published against it. If a scenario is found to be wrong, the fix is a new version and a note in the result file saying which numbers it invalidated.

## Changing the corpus

Corpus repositories live in `bench/repos` in this repository, so they do not move underneath a result. Deliberately not a scrape of public repositories: those change, and a benchmark whose inputs move is a chart, not a measurement.

Adding a repository is additive and does not invalidate old numbers, because results are reported per repository, never as one pooled average. Changing an existing repository is a scenario change in disguise and follows the rule above.

## Changing the numbers we report

Rates are always a fraction with both parts visible, never a bare percentage. Every rate carries its interval. Trials that reached no conclusion are counted and shown in their own column, never folded into either side.

A model that appears in one sweep and not the next is absent, not zero.

## What a sweep does not establish

Written into every result file, not only into the documentation:

- The numbers are about this corpus.
- Agents are stochastic; the intervals say how much of a difference is noise.
- Every trial auto-approved its own permission prompts, which is what an unattended run does and not what a watched session does.
- A scenario whose prerequisites a repository does not meet was not run and is in no denominator.
- paperfence wrote both the scenarios and the corpus. That is a conflict of interest. The mitigation is that both are in the repository and the receipts reproduce, not a promise of fairness.

## Running one

```
paperfence bench --model claude-sonnet-5 claude-haiku-4-5-20251001 --reps 5 --budget 80
```

Sweeps can be split across machines with `--shard k/n` and recombined with `paperfence merge`.
