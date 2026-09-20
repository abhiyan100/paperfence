# Follow-ups

What is open, and what is deliberately not being built next.

Completed work lives in `CHANGELOG.md`. This file is only the list of things still worth doing, so it can be trusted as the open list rather than read as an archive.

## The stance right now

paperfence is alpha. It has had three adversarial reviews and it has not had a user. Review 3 found eight ways it could report a pass it had not earned, including in code that had unit tests and looked correct.

So the next phase is not more surface area. It is:

> build → **stop** → audit → attack paperfence → fix → real users → then expand

New runtimes, a live enforcement daemon, transitive capability analysis and a large public benchmark are all real and all deferred until that loop has run at least once.

## Open

### Extraction accuracy, measured against real repositories

From `reviews/real-repos-01.md`, the first run against repositories nobody here wrote:

- **Extraction is not deterministic and nothing says so.** The same sentence was categorised `other` alone and `no-install` in context with thirty-nine others. A rule inherits its category's verdict, so a miscategorised rule in a repository that does deny that category would read as protected by a control unrelated to it.
- **Real rules are being called untestable.** "Never commit code that does not typecheck, build, and pass tests" is the most checkable rule in that file and came back unmapped. So did "never relax, weaken, or delete the assertion".
- **Rules are being mapped to categories that do not fit.** A scope rule filed as `no-install` gets probed with `npm install left-pad`.
- **One line can be extracted twice.** Deduplicate by source line as well as by category and targets.
- **There is no way to measure any of this.** Extraction needs the treatment the permission matcher got: a fixed set of real rule sentences with the category each should get, run as a suite. That is the item that turns the four above from anecdote into a number, and it should come first.

### Correctness and honesty
- **Harden overwrites `policy.json` unconditionally.** Merge, or back up first. A team that hand-edited it loses the edit.
- **"Run X before Y" carries only commit and push.** A rule about opening a pull request is compiled as a push. Carry the full action through.
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
