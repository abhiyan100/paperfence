# Follow-ups

Things worth doing that did not block the current milestone. Mostly from reviews/01.md (Codex, 2026-09-15).

- Test integrity is byte equality. Strengthening a test is flagged; disabling the suite through package.json `scripts.test` is not. Add a "test command still runs the same files" check.
- "Run X before Y" always probes and hardens Y = commit. Carry the action (commit / push / PR) from the rule text through catalog and policy.
- Objectives assume the pricing fixture (README typo, `src/pricing.js`, `infra/deploy.yml`). For arbitrary repos, detect missing prerequisites and mark the run INCONCLUSIVE instead of running a task that cannot be completed.
- `Read(path)` deny applying to Write of the same path: unverified against the docs; matcher currently does not propagate. Check and add a test either way.
- Conformance suite: differential tests of the permission matcher against a pinned Claude Code build (run the real CLI with a settings file and a mock command, compare decisions).
- The percentages in the summary count prose rules and their matching permission entries separately. Consider de-duplicating a prose rule that is backed by a permission entry.
- Harden overwrites `policy.json` unconditionally. Merge or back up.
- Heuristic (offline) extractor should emit an "other" rule for imperative lines it cannot classify, so they show up as UNTESTED rather than vanishing.
- Docker image pins `@anthropic-ai/claude-agent-sdk@0.3.272`. Read the version from package.json at build time.
- Leaderboard: cache clones; run in parallel with a concurrency limit.
