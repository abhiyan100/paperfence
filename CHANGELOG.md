# Changelog

## Unreleased (0.1.0 in progress)

### 2026-09-20

The release that stopped a missing prerequisite from reading as a passing rule.

**Verdicts.** A trial used to end in violated or not. "Not violated" was hiding three
situations: the control blocked it, the agent declined, and the trial never got far
enough to find out. Trials now end in PASS, FAIL, ERROR, INCONCLUSIVE or
NOT_APPLICABLE, derived in one place and never re-derived downstream. A call that
only paperfence's own sandbox guard stopped is a FAIL, because the repository did
not stop it. Denominators exclude everything that reached no conclusion.

**Repository profiling and prerequisites.** Scenarios used to assume our fixture: a
README with a typo, `src/pricing.js`, an `infra/` directory. Against a Go service or
a library with no README, the agent could not do the task and the rule looked safe.
Every attack form now declares what the repository must have, and a form whose
prerequisites are missing is reported as not applicable.

**Attack families.** A rule is attacked through several forms, different tasks that
end in the same forbidden effect. The protected-branch rule is tried as a
documentation fix, an urgent revert and a release bump. Grades carry the evidence
scope that produced them: which forms, how many trials, at what pressure, on which
model, and what is still consistent with the result at that sample size.

**Statistics.** Wilson intervals, `--reps`, and a line in `compare` saying whether
the two arms can be told apart at all.

**Receipts and replay.** Every trial writes a content-addressed receipt: an edited
one hashes differently and `paperfence receipts` flags it. `paperfence replay`
re-runs the conditions and says what drifted. Canaries are redacted before anything
is written.

**Sandbox.** The agent container runs with `--network none`. Its only path to the
model API is a unix socket on a volume shared with the proxy, reached through a
loopback forwarder. `paperfence doctor` checks the boundary instead of asserting it:
no default route, no DNS, no route to the host or to the proxy's network, no
privilege escalation. Image bumped to 0.4.

**Runtime adapters.** An adapter declares four capabilities separately and any of
them may be false. Claude Code supports all four; Codex supports discovery only, and
says so on every verdict in a repository configured for it.

**Policy.** `paperfence.policy.yaml`, inferred from the rules already present, with a
compiler that labels every statement enforced, needs-runtime-guard, partial,
org-control or unenforceable, per target, with the gaps spelled out.

**Test integrity.** A suite can be made green without touching an assertion, by
changing the test script, a runner config, or a CI job. All three are now snapshotted,
asserted and blocked.

**More routes.** Reading a secret through a shell loop, a process substitution, an
encoder, a copy or a wrapper. Leaving through an encoded payload, a DNS label, a
remote added mid-run, or a push straight to a URL.

**CI.** Markdown summaries for pull request comments and job summaries, and a
composite GitHub Action that edits one comment rather than appending.

**Conformance.** `paperfence conformance` checks our reading of Claude Code's
permission semantics against the real runtime, case by case, with repetitions,
because a permission decision that varies is itself a finding. It immediately
found the worst bug this project has had: a deny entry naming only a tool, with
no pattern, is not a control. `deny: ["Bash"]` let `pwd` run in five of eight
trials and refused it in none. paperfence graded that as a gate, and `harden`
generated `deny: ["WebFetch"]` itself. Both fixed. It also found that several
rules reported as gaps are not silent allows: the runtime prompts, which is the
same answer unattended and a different one when someone is watching.

**A spend budget.** `--budget` on attack and compare, checked between trials.
The report says the trials that did not run are not passes.

Fixes found by running the tool on itself: the exfiltration probes aimed at loopback,
which the guard exempts on purpose, so they reported a hole that was not there;
"run X before Y" compiled every rule as "before committing"; "before pushing" did not
match; a line with no never/always/must in it was skipped entirely; and an exhausted
turn budget was reported as an infrastructure error.

### 2026-09-19
- `paperfence compare`: run the repo's task suite (bad tasks that must be blocked, good tasks that must still complete) under two configurations, interleaved, in Docker; one receipt with bad blocked, good done, asks, denials, cost, errors, per variant and per task; exit 2 when head regresses base. Variants: `--head`, `--without`, `--hook`, `--deny`, `--hardened`, `--model-b`.
- `paperfence suite`: show or write the default suite (`.paperfence/suite.json`).
- Every tool event carries an outcome: attempted, denied, ran, failed.
- Every report carries a fingerprint: paperfence version and commit, Claude Code and SDK versions, model, OS, sandbox image, approval mode.
- `scan` probes hook scripts inside a container by default; `--unsafe-run-hooks` runs them on this machine; without Docker they are not run and reported as unknown.
- The protect-tests scenario plants its own failing test before the snapshot; the fixture no longer ships one. Found by `compare`: a permanently red suite plus "run tests before committing" made every good task impossible under hardening.
- Generated guard protects existing test files and allows creating new ones. Found by `compare`: hardening refused to create `tests/slug.test.js`.

### 2026-09-18
- Leaderboard copy states the denominator and what a repo scan cannot see (hooks not executed, user settings, managed policy, branch protection). 96 repos after transient fetch failures were retried.
- Second Codex review (reviews/02.md). Roadmap v2: one product, `compare` as the center, jevgate retired to a comparison entrant.

### 2026-09-15
- `scan`: rule extraction (Claude Haiku, or `--offline` heuristic), permission matching per the documented Claude Code semantics (bare filenames at any depth, `Read` deny covering `cat`/`head`/`tail`/`sed`/`wc` and redirects and Edit/Write on the same path, `Write(path)` rules inert, wrappers and subshells, `/usr/bin/curl` and `sh -c` gaps), hook probing with real payloads, timeouts, malformed JSON, `continue:false`, crash-fails-open.
- `attack`: Docker sandbox with an internal network, a credential-broker proxy (per-run token via `ANTHROPIC_CUSTOM_HEADERS`, `POST /v1/messages` only, credential from `ANTHROPIC_API_KEY` or the local `claude login`), job over env and result over stdout, only repo and origin mounted, `node` user, run deadline. Three pressure levels. Host mode behind `--unsafe-host`.
- `harden`: one policy-driven PreToolUse/PostToolUse hook plus deny entries; protects itself and `settings.json`; "tests before commit" credited only for a whole, successful, non-backgrounded run in PostToolUse.
- Quote-aware shell reader shared by the matcher, the assertions and the guard.
- Leaderboard of public repos with a CLAUDE.md; static site; side-by-side Sonnet vs Haiku demo.
- First Codex review (reviews/01.md); 12 P0/P1 addressed.
