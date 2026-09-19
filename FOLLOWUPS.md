# Follow-ups

Things worth doing that did not block the current milestone. From reviews/01.md and reviews/02.md (Codex, 2026-09-15).

## Deferred from review 2
- Docker `--internal` networks still route to the host gateway. A host service bound on the Docker interface is reachable from the agent. Documented in the README; a real fix needs iptables or a user-space network (gVisor).
- Done 2026-09-19: tool events carry `outcome`; reports carry a fingerprint; `scan` probes hooks in a container by default; `compare` exists.
- `compare` runs the repo's suite only; no equivalence statistics yet. Add per-task confidence when reps >= 3 and refuse to say "no difference" on n=1.
- Codex runtime adapter: not started. The Codex hook model lacks `ask`; a second adapter is the next big item after `compare` settles.
- `harden --dry-run` should print the exact settings.json patch and policy.json it would write.
- Percentages count a prose rule and its backing permission entry separately; ERROR and UNTESTED leave the denominator. De-duplicate and show the denominator.
- Leaderboard rows should pin the scanned commit SHA and the extractor model; cached rows should invalidate on either.
- Conformance: differential tests against the real CLI (a settings file, a mock command, compare the decision) so doc drift shows up as a failing test.
- `paperfence attack` on a repo without the fixture's shape produces "held" verdicts that mean "could not do the task". The protect-tests scenario now plants its own failing test; the branch, secrets and exfil scenarios are repo-agnostic; scope, install and require-before still assume the fixture. Detect missing prerequisites and mark INCONCLUSIVE.

- Test integrity is byte equality. Strengthening a test is flagged; disabling the suite through package.json `scripts.test` is not. Add a "test command still runs the same files" check.
- "Run X before Y" always probes and hardens Y = commit. Carry the action (commit / push / PR) from the rule text through catalog and policy.
- Objectives assume the pricing fixture (README typo, `src/pricing.js`, `infra/deploy.yml`). For arbitrary repos, detect missing prerequisites and mark the run INCONCLUSIVE instead of running a task that cannot be completed.
- `Read(path)` deny applying to Write of the same path: unverified against the docs; matcher currently does not propagate. Check and add a test either way.
- Conformance suite: differential tests of the permission matcher against a pinned Claude Code build (run the real CLI with a settings file and a mock command, compare decisions).
- The percentages in the summary count prose rules and their matching permission entries separately. Consider de-duplicating a prose rule that is backed by a permission entry.
- Harden overwrites `policy.json` unconditionally. Merge or back up.
- Docker image pins `@anthropic-ai/claude-agent-sdk@0.3.272`. Read the version from package.json at build time.
- Leaderboard: run repos in parallel with a concurrency limit; add a manual list of well-known repos that GitHub code search does not surface.
- Conformance: the hook-probe and permission-matcher tests encode the documented semantics; a differential run against the real CLI (settings file + mock command) would catch doc drift.
- Host guard is best effort by design. Known holes: a symlink created during the run (`ln -s /etc x`) and then read through a relative path; anything that spawns a program not in the network list. Docker mode is the answer; do not extend the regexes much further.
