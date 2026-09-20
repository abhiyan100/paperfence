# First run against real repositories (2026-09-20)

Not a review of the code. A check of whether the output is *right* when pointed at repositories nobody here wrote.

Three public repositories were chosen for the awkward case: each has a `settings.json` with **zero** deny and ask entries and protection entirely in hooks. Config was fetched through the GitHub API; nothing was cloned and no hook script was executed.

| repository | rules found | mapped to a check | reported untestable |
|---|---|---|---|
| `darkroomengineering/cc-settings` | 40 | 6 | 34 |
| `alperhankendi/Ctxo` | 29 | 5 | 24 |
| `drakulavich/kesha-voice-kit` | 31 | 15 | 16 |

## What it got right

No repository was told it had a control it did not have. All three have empty deny lists, and every mapped rule came back `WISH`, which is correct. With `--no-hooks` the report says the hooks exist and were not run rather than treating their absence as an open door.

Most of what it called untestable genuinely is: "state the effect before the mechanism", "use an existing name for an existing thing", "surface conflicts, do not average". Those are judgement, and a category with a probe behind it would be the wrong place for them.

## False negatives: real rules reported as untestable

In `cc-settings`, at least two rules that paperfence can mechanically check were filed as untestable:

- *"Never commit code that does not typecheck, build, and pass tests. Run all three and fix failures."* That is `require-before` with three required steps before a commit. It is the single most checkable rule in the file.
- *"Regression: the assertion remains correct. Fix the code; never relax, weaken, or delete the assertion."* That is `protect-tests`, stated more carefully than most repositories state it.

A third is arguable: *"If uncertain, treat it as a regression and stop to confirm. Making the suite green alone never justifies changing an assertion."*

`Ctxo` had two, both the same rule extracted twice, which is its own small bug: the extractor can emit a duplicate for one line.

## False positives: rules mapped to a category that does not fit

In `cc-settings`, two of the six mapped rules are in the wrong category:

- *"Keep a bug fix confined to directly related files. Do not refactor adjacent code, update unrelated deps, or reformat."* → filed as `no-install`. It is a scope rule. paperfence will probe it with `npm install left-pad`, which tests nothing about it.
- *"Once the ladder says a bounded unit should exist, finish its edge cases, error paths..."* → filed as `protect-tests`. It is about writing tests, not protecting them.

Two more are borderline: rules about preferring one package manager are filed as `no-install`, which is the nearest category but not the same claim.

## Why a false positive here is worse than it looks

A rule inherits the verdict of its category. A style rule miscategorised as `no-install`, in a repository that does deny `npm install`, would be reported as **GATE**: protected by a control that has nothing to do with it. That is the same class of error as review 4 finding 1, one layer earlier, in extraction rather than in the graph.

It could not be reproduced on demand. The same sentence, alone in a small file, was categorised `other`; in a forty-rule document it became `no-install`.

**Correction, measured afterwards.** The first draft of this document called extraction non-deterministic. That is not what the evidence shows. A case set of thirty-nine sentences was run twice through the model extractor and every sentence got the same category both times, and both the model and the offline reader score every clear-cut case correctly on that set.

What changes the reading is **context, not chance**. These sentences are short, in a clean list, surrounded by other rules. A real rule file is long prose with headings, examples and commentary, and that is where rules get missed and miscategorised. So a hundred percent on the case set does not mean a hundred percent in the wild, and the three repositories above are the counter-example that proves it. The case set is easier than reality and should be said to be.

## What to do about it

Recorded rather than fixed, because the fix is a piece of work and not a patch:

1. Extraction should be checked the way the permission matcher is: a fixed set of real rule sentences with the category each should get, run as a suite, so miscategorisation is measurable instead of anecdotal.
2. A miscategorised rule should be cheaper to correct than to argue with. `paperfence policy init` already writes the category into a file a human edits; the scan should point at that when a rule looks miscategorised.
3. Duplicate extraction of one line should be deduplicated by source line, not only by category and targets.
4. The report should say that extraction is a model's reading and can be wrong, in the same breath as it prints the rules. `--offline` has the opposite failure and is also not stated.

None of these is a safety overclaim on its own. Together they are the difference between a report a team trusts and one they argue with, and the first one is the one that turns this from anecdote into a number.
