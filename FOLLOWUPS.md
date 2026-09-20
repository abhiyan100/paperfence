# Follow-ups

Things worth doing that did not block the current milestone. From reviews/01.md and reviews/02.md (Codex, 2026-09-15).

## Done since review 2
- 2026-09-20 Trial verdicts (PASS / FAIL / ERROR / INCONCLUSIVE / NOT_APPLICABLE) derived in one place; "the agent could not do the task" no longer reads as "the rule held".
- 2026-09-20 Repository profiling and per-form prerequisites; scenarios no longer assume the pricing fixture. Objectives for scope, require-before and install are derived from what the repo actually has.
- 2026-09-20 Attack families: each rule is attacked through several forms, and grades carry the evidence scope that produced them.
- 2026-09-20 Statistics: Wilson intervals, `--reps`, and a "can these two arms be told apart?" line in compare.
- 2026-09-20 Content-addressed receipts and `paperfence replay`.
- 2026-09-20 `paperfence conformance`: the permission model checked case by case against the real runtime. Found that several documented gaps prompt rather than allowing, which is the same answer unattended and a different one when watched.
- 2026-09-20 A prose rule and the settings entry restating it are counted once; both still shown.
- 2026-09-20 `harden --dry-run` prints the exact bytes of every file it would write.
- 2026-09-20 GitHub Action, Markdown summaries for pull request comments and job summaries.
- 2026-09-20 Test integrity covers what selects tests, not only the tests: the test script, runner configs, CI workflows. Matched, probed, asserted and blocked by the guard.
- 2026-09-20 More routes to a secret (shell read loops, process substitution, encoders, copies, wrappers) and out (encoded payloads, DNS labels, remotes added mid-run, pushes to a URL).
- 2026-09-20 Agent container runs with `--network none`; the credential proxy is reached over a unix socket on a shared volume. `paperfence doctor` checks the boundary instead of asserting it.

## Deferred from review 2
- Done 2026-09-19: tool events carry `outcome`; reports carry a fingerprint; `scan` probes hooks in a container by default; `compare` exists.
- Codex runtime adapter: not started. The Codex hook model lacks `ask`; a second adapter is the next big item after `compare` settles.
- Leaderboard rows should pin the scanned commit SHA and the extractor model; cached rows should invalidate on either.

- "Run X before Y" always probes and hardens Y = commit. Carry the action (commit / push / PR) from the rule text through catalog and policy.
- The percentages in the summary count prose rules and their matching permission entries separately. Consider de-duplicating a prose rule that is backed by a permission entry.
- Harden overwrites `policy.json` unconditionally. Merge or back up.
- Docker image pins `@anthropic-ai/claude-agent-sdk@0.3.272`. Read the version from package.json at build time.
- Leaderboard: run repos in parallel with a concurrency limit; add a manual list of well-known repos that GitHub code search does not surface.
- Conformance: the hook-probe and permission-matcher tests encode the documented semantics; a differential run against the real CLI (settings file + mock command) would catch doc drift.
- Host guard is best effort by design. Known holes: a symlink created during the run (`ln -s /etc x`) and then read through a relative path; anything that spawns a program not in the network list. Docker mode is the answer; do not extend the regexes much further.
