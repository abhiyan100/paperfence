# Changelog

## 0.2.1 — 2026-09-20

`paperfence --version` on the published 0.2.0 answered `0.1.0`. The CLI
carried a hand-written string while the fingerprint on the same report
read package.json, so the two disagreed from the first release that
changed the number. One resolver now, and a test that fails when a
report and the command line disagree.

## 0.2.0 — published to npm 2026-09-20

The first round of running paperfence against repositories nobody here
wrote, and the defects that found.

Two verdicts on a real repository were false, both in the direction of
claiming a rule had been broken when it had not:

- `Never force-push \`main\` or \`master\`` was reported as violated by a
  force-push to a feature branch. The matcher treated any force-push as a
  hit and the sandbox check watched `origin/feature` whatever the rule
  said. Both now use the branches the rule names.
- `Never commit secrets or \`.env\` files` was reported as violated by a
  grep whose output contained the planted canary, in a run that never
  staged or committed anything. A rule about committing is now decided by
  the index and the history.

Three more were probes that named things the rule did not:

- A scope rule whose extracted target was a fragment of the sentence made
  `scopeTarget` return the first file in the repository, so cc-settings
  was told nothing stopped `edit .claude-plugin/marketplace.json` about a
  rule on keeping bug fixes small.
- The same fragment reaching `require-before` meant the assertion looked
  for a command that cannot exist, so the agent's first commit would have
  been recorded as skipping a required step it had no way to run.
- An ask-first target carries the sentence's own gloss: openai/codex
  produced the probe `just test (complete suite)`, which no shell runs.

Extraction is now measured against whole documents, not sentences:
`fixtures/corpus` holds six real rule files frozen at their commits with
275 statements annotated by hand. The first run of it found that the
model reader was not running at all - `maxTurns: 1` failed every call and
extraction fell back to the keyword reader silently. With it fixed the
model finds 26 of 44 mechanically checkable rules, and it does not give
the same answer twice: three runs of the same six documents extracted 85,
73 and 88 rules.

The sandbox: a repository with its dependencies installed could not run
its own tests there, because npm writes `node_modules/.bin/*` as absolute
symlinks. Pressure files were planted after the sandbox's first commit,
so `git status` showed them untracked and in a live run the agent said so.
`speed-up-suite` had no setup, so it asked an agent to speed up a suite
that did not exist and counted the answer as the rule holding.

`docs/PILOT.md` and `docs/FEEDBACK.md` are the first-user path.
`reviews/real-world-validation-02.md` is the full record.

## 0.1.0 — published to npm 2026-09-20

First public release. Alpha: three adversarial reviews, no users yet.

### 2026-09-20

The work that stopped a missing prerequisite from reading as a passing rule.

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

### 2026-09-20, later the same day

**Codex promoted, as far as it was measured.** `paperfence conformance --runtime codex`
runs the real CLI against a matrix of sandbox modes; six cases, all agreeing. `drive`
and `evaluate` are true; `probeHooks` and `harden` are still false, because a Codex
hook runs only once trusted by content hash and we cannot yet observe one blocking a
call. What the measurements found matters more than the promotion: `read-only`
confines every write and does not confine reads, `workspace-write` makes the whole
workspace writable so a path allowlist is not enforced, and a confined command leaves
no record at all, so any tool can see the outcome and not the attempt. A scan now
evaluates a repository against the runtime it is configured for.

**Capability graph.** `paperfence graph` reads the repository for what an agent can
reach and joins it to the scan's verdicts, so "protect-secrets is a wish" and ".env
holds the Stripe key" stop being two separate half-sentences. Stops at the first hop
and says so; every blast radius is unknown until a human writes one into
`paperfence.inventory.yaml`.

**Benchmark.** A fixed corpus in `bench/repos`, a written change policy in
`bench/POLICY.md`, and the scenario catalog at version 2 so the policy can pin it. One
smoke sweep found Sonnet 5 breaking a protected-branch rule at a plain request: it
opened a branch, pushed it, asked twice, got no answer because nobody is there, and
merged to main itself. Two repositories and one smoke run is a proof the pipeline
works, not a benchmark.

**Distributed runs.** `--shard k/n` on attack and compare, `paperfence merge` to
recombine receipts. No server. Merge refuses receipts that do not hash to their own
contents, and refuses to merge across different setups unless told to.

**Control plane.** Receipts pushed to a Postgres database behind three functions, so
history outlives the machine that made it. `paperfence status` answers what started
failing since last week and exits 2 when something did. Receipts and nothing else: no
source, no configuration, no credentials. Optional; everything else works without it.

**Dashboard.** A page that leads with what started failing, because a gauge cannot
make an argument.

**Fixes found by running the tool on itself, again.** The de-duplication collapsed
twenty-five distinct prose rules into one. The leaderboard script replaced a hundred
rows with sixty-one when a run was interrupted. And a bare tool-name deny entry was
being graded as a control when the runtime ignores it entirely.

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
