# Follow-ups

What is open, and what is deliberately not being built next.

Completed work lives in `CHANGELOG.md`. This file is only the list of things still worth doing, so it can be trusted as the open list rather than read as an archive.

## The stance right now

paperfence is alpha. It has had five adversarial reviews, two rounds against real repositories, and no users.

**Round two ran on 2026-09-20** and is written up in `reviews/real-world-validation-02.md`. Six public repositories across five ecosystems, every mapped rule checked by hand, one live `attack`. It found five defects, two of them false `BROKEN` verdicts — paperfence stating that a repository's rule had been violated when it had not. It also found that the model extractor had not been running at all: every call failed on `maxTurns: 1`, extraction fell back to the keyword reader, and nothing said so.

That is the prediction of the stance below coming true. Running it against the world found things five code reviews did not, and the single worst one was invisible to every test because everything downstream of it kept working.

Review 5 is the one to weigh. It was blind: the reviewer was given no steering, no list of recent changes, no hint where to look. It found nine more paths where paperfence reported evidence it had not earned, plus a credential exposure. Two of those are worth remembering:

- One would have affected nearly every real repository, and four code reviews had missed it, because they read the code rather than asking what happens when it meets a normal project.
- One was introduced by a commit whose justification was a conformance suite that passed. The suite measured what it measured; nothing checked that the promoted feature was wired into the path claiming to use it.

The honest reading: reviewing the code is not the same as running it against the world, and the rate of unearned passes has not yet reached zero for any reviewer who looked hard.

So the next phase is not more surface area. It is:

> build → **stop** → audit → attack paperfence → fix → real users → then expand

Where that stands: audit has run five times and keeps finding things, so it has not converged. Real-world validation has now run twice and also keeps finding things, at a higher yield per hour than the reviews. The next round should be **a person who is not us**, running `npx paperfence scan .` on a repository we have never seen. `docs/PILOT.md` and `docs/FEEDBACK.md` exist for exactly that, and `0.2.0` is prepared but not published.

New runtimes, a live enforcement daemon, transitive capability analysis and a large public benchmark are all real and all deferred until that loop has run at least once.

## Open

### Extraction accuracy

Now measured against whole documents: `fixtures/corpus` holds six real rule files frozen at their commits with 272 statements annotated by hand, scored by `scripts/corpus-accuracy.ts`. The model reader finds 26 of 44 mechanically checkable rules and gets 15 of 31 target sets exactly right. Still open:

- **Judgement filed under a category with a probe behind it: 23 instances.** `Do not add tests for values that are statically defined.` → `protect-tests`. `Target Rust modules under 500 LoC` → `scope`. In a repository with deny entries this is the path to a false `GATE`, which is the worst output paperfence can produce. The invented-target guard does not catch it, because the probe it builds names a file that really exists; the rule is simply read as the wrong kind of rule.
- **Extraction is not reproducible at document length.** Three runs of the same six documents: 85, 73 and 88 rules. Two runs of the same scan can disagree on a category. Nothing in the output warns a reader of this, and it should.
- **Targets are exactly right 48% of the time at best.** A rule naming two paths where paperfence found one is reported as fully handled. Partial target extraction should be visible in the report.
- **A rule whose document names its own enforcement is reported as unenforced.** `Type checking: pyright (enforced in CI)`, airflow's `check-no-new-airflow-exceptions` prek hook, vercel's `require-validate-url` oxlint rule. paperfence models deny entries and hooks and has no notion of CI or a lint rule as a control. Either model them with their own evidence, or say "this rule names an enforcement paperfence does not check" instead of "nothing enforces this". Guessing is not an option.
- **The sentence set is still worth keeping.** `src/rules/extraction-cases.ts` is the fast deterministic check that a change did not break the easy cases; the corpus is the evidence about real documents.

### Coverage gaps found by running against real repositories

- **Test-suite detection misses two common layouts.** `apache/airflow` (uv + pytest behind a `breeze` wrapper) and `openai/codex` (`just test` over cargo) both came back as "no test suite found". Nothing false is claimed, but every test-related scenario is skipped in both, and the reason is ours.
- **A macOS developer with native npm dependencies gets no runnable test environment.** The copied `node_modules` is built for darwin and the sandbox is linux. Reported honestly as `platform-mismatch`; not solved.
- **Rules an agent can mechanically violate that paperfence has no category for.** "Never run pytest directly on the host, always use breeze"; "No `assert` in production code"; "Never list an agent as a commit co-author". 14 of them across the corpus. Filing them as `other` is right today; whether any deserves a scenario is a product question, not a bug.

### Correctness and honesty
- **"Run X before Y" now carries commit, push and pull-request**, and the guard gates `gh pr create` for the third. Real repositories also state the ordering the other way round — grafana's "Backend service init changes require `make gen-go`", codex's "run `just fmt` after you have finished making code changes" — and paperfence records those as `before` because it has no other shape.
- **Live coverage is one repository deep.** The static path has been checked against six repositories; `attack` has been run against one, in three categories. The two false `BROKEN` verdicts both came out of that single run, which is not a reassuring ratio.
- **The host guard has known holes by design.** A symlink created during a run and then read through a relative path; anything spawning a program not in the network list. Docker is the answer; do not extend the regexes much further.

### Runtimes
- **Codex hooks.** The adapter discovers, evaluates and drives. Hooks are untouched: a Codex hook runs only once trusted by content hash, and we have not established how to observe one blocking a call. Until we can, `probeHooks` and `harden` stay false.
- **Cursor, Gemini, Copilot.** The adapter boundary exists and each would be an adapter plus its own conformance cases. Not before the audit.

### Benchmark
- **A publishable sweep.** The harness, the fixed corpus, and the change policy exist, and one smoke sweep has run. A real sweep is a budget decision: more repository archetypes, more models, five or more repetitions. Two repositories and one smoke run is a proof that the pipeline works, not a benchmark.

### Infrastructure
- **Provenance on releases.** The release workflow publishes with `--provenance` on a version tag, which needs an `NPM_TOKEN` secret on the GitHub repository. Until that is set, releases are published from a laptop without provenance.
- **Leaderboard concurrency.** Repositories are scanned one at a time. Add a concurrency limit, and a manual list of well-known repositories that GitHub code search does not surface.

### Capability graph
- **It stops at the first hop, on purpose.** An AWS credential opening a role opening a function opening a database credential is the interesting chain and is not traced. Going further needs either an inventory a team writes or live introspection of the cloud account, and neither should be guessed at.

## Not being built next, and why

| | |
|---|---|
| A vendor-neutral enforcement daemon | paperfence tests and compiles controls today. Sitting in the live path of every agent action is a different product with a much worse failure mode, and it should not be built by the same burst that wrote the tests for it. |
| A judgement model in the decision path | The generated guard is deterministic and inspectable. Adding a model to the allow/deny decision makes every verdict probabilistic. There is a slot for it in the policy compiler's unenforceable class; it stays empty until the deterministic layer has users. |
| Organisation accounts, roles, single sign-on | The control plane has one write token per project. That is the right amount of authentication for a tool with no users. |
| A GitHub App | The Action covers the same ground without asking anyone to install a third-party app with repository write access. |

## Known-good, do not regress

Recorded because several of these were bugs once and the tests that catch them are the only thing keeping them fixed.

- A deny entry naming only a tool is not a control. Measured; the matcher reports it as present and unreliable.
- `NOT_APPLICABLE` and `ERROR` are not `PASS`, and are in no denominator.
- A command's own error text is not enforcement. Only a runtime or hook refusal counts.
- Receipt canonicalisation must not lose a `__proto__` key.
- Redaction happens at the sandbox boundary, not only in receipts.
- `allSegments` stays faithful to Claude Code and does not look inside `sh -c`. `allSegmentsDeep` is what paperfence's own matcher and guard use.
- The control plane verifies a receipt's content address server-side. The client checking it is not enough; a client is whatever holds a project token.
