# ADR 0007: What is deferred, and what would unblock it

Status: **superseded, 2026-09-20.** Superseded by ADR 0009 (capability graph), ADR 0010 (control plane), `bench/POLICY.md` (benchmark), and the sharding and dashboard work of the same day.

Five of the six things this record deferred were built within hours of writing it, because each one's stated unblocking condition turned out to be already met or cheap to meet. The record is kept because the *reasons* still hold and each is now carried by the ADR that superseded it. What changed, and where the current answer lives:

| deferred here | status | where it is decided now |
|---|---|---|
| hosted control plane | built | ADR 0010 |
| web dashboard | built | ADR 0010, and the dashboard's own header comment |
| capability graph | built, first hop only | ADR 0009 |
| public benchmark | harness and corpus built; no publishable sweep | `bench/POLICY.md` |
| distributed runners | built as sharding plus receipt merge | the `runners:` commit and `src/merge.ts` |
| conformance suite | built for both runtimes | ADR 0008 |

The one thing this record deferred that is *still* deferred, and the one it did not anticipate, are both now in `FOLLOWUPS.md`, which is the authoritative open list.

Read what follows as the reasoning of the day, not as the current state.

---

Recorded so that "not built yet" is a decision with a reason, rather than a gap someone has to infer.

## Deferred

### A hosted control plane

A service that stores receipts across a fleet, tracks a policy over time, and answers "what changed since last week" for an organisation.

Not yet, because the thing it would store is not stable. Verdicts gained three new values this month and the scenario catalog is on version 1. A schema migration on someone else's data is a much worse problem than a missing feature.

**Unblocked by:** the receipt format surviving a few months without a breaking change, and someone running the CLI often enough that they want the history.

### A web dashboard

Not yet, for the same reason plus one more: the interesting output is an argument, not a number. "Nine partial, one elsewhere, one guidance, with the gaps listed" is a paragraph a reviewer reads. A dashboard that turns it into a gauge would lose the part that matters, and a dashboard that does not is a worse version of the terminal.

**Unblocked by:** a user who has run this enough times to want a trend, and a clear statement of what the trend is of.

### A capability graph

Modelling what an agent can reach transitively: this credential opens that service, which can write that bucket, which is read by that deploy. Genuinely valuable and a different product from the one being built. paperfence answers "can this call be refused"; the graph answers "what does refusing it protect".

**Unblocked by:** the adapter layer covering more than one runtime properly, so the graph has more than one source.

### A public benchmark

A leaderboard of models and runtimes against a fixed scenario suite. The existing leaderboard scans public repositories for configuration, which is a different and cheaper thing.

Not yet, because a benchmark is a promise: stable scenarios, pinned versions, reproducible numbers, and the discipline not to change the suite when the numbers are unflattering. Publishing one before the scenario catalog is stable would produce numbers nobody can reproduce in six months.

**Unblocked by:** the scenario catalog at version 2 or later with no pending changes, the conformance suite passing, and a written policy for changing a scenario.

### Distributed runners

Running trials on a fleet rather than one machine. A cost and wall-clock problem, not a correctness one. The receipt format already carries everything needed to merge results from several machines.

**Unblocked by:** someone whose compare run takes longer than they will wait.

## Not deferred, and next

- **A conformance suite against the real CLI.** Differential tests: a settings file, a command, our predicted decision against the observed one. This is what promotes the Codex adapter from discovery to evaluation, and it is what keeps `src/config/permissions.ts` honest as Claude Code changes. It is the single highest-value thing not yet built.
- **Publishing to npm.** The GitHub Action installs from npm and therefore does not work outside this repository yet.
