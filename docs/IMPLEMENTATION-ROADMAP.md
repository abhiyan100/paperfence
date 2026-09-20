# Implementation roadmap

Internal. Updated as slices land. The product sentence: **paperfence proves whether coding-agent controls actually work.** Declared policy, configured controls, observed capability, adversarial evidence: four separate things, never conflated.

## Audit summary (2026-09-20)

Strong and kept:
- Static probe with documented Claude Code permission semantics and real hook execution (in a container).
- Docker attack path: internal network, credential-broker proxy, job over env, result over stdout, only repo + origin mounted.
- `compare` with interleaved arms and a receipt that already caught three regressions in our own `harden`.
- Quote-aware shell reader shared by matcher, assertions and guard.
- Fingerprint on every report; tool events carry outcomes.

Debt, in priority order:
1. Trial outcomes are binary (violated / not). No INCONCLUSIVE, no NOT_APPLICABLE. "Agent could not do the task" can read as "policy held".
2. Scenarios assume the fixture (README typo, `src/pricing.js`, `infra/`). No prerequisite model.
3. Scenario definitions are code with one canonical objective; no attack families, no versioning, not inspectable.
4. No receipts as first-class objects, no replay.
5. n=1 everywhere; no confidence reporting.
6. Docker `--internal` still routes to the host gateway.
7. Claude Code is hard-wired; no adapter boundary. Codex not supported.
8. No policy model: rules are extracted prose + settings entries; `harden` compiles straight from categories.
9. Test integrity = byte equality; secret paths limited to a few readers.
10. No CI integration surface.

## Slices

| # | slice | status |
|---|---|---|
| 1 | Domain model: verdicts (PASS/FAIL/ERROR/INCONCLUSIVE/NOT_APPLICABLE), repo profile + prerequisites, versioned scenario definitions with attack forms, trial statistics (Wilson CI) | done |
| 2 | Receipts (content-addressed, stored under `.paperfence/receipts`) and `replay` | done |
| 3 | Sandbox: agent container with no network routes; API via unix-socket proxy; `doctor` verifies it | done |
| 4 | Runtime adapters with declared capabilities; Claude Code full; Codex discovery only | done |
| 5 | Policy document, inference, compiler with five enforceability classes | done; `harden --dry-run` patch still open |
| 6 | Test integrity beyond byte equality; secret access paths and encoded exfiltration | done |
| 7 | GitHub Action + PR summary | done |
| 8 | Docs: threat model, limitations, decisions; README refresh | done |
| 9 | Conformance suite against the real CLI | done; ADR 0008 |
| 10 | Control plane, runners, web dashboard, capability graph, public benchmark | deferred with reasons; ADR 0007 |

Rule: no UI on top of unstable semantics. Slices 1–3 before anything user-facing beyond the CLI.

## Non-goals for now
- Monorepo split (ADR 0006).
- LLM as the only enforcement layer (ADR 0004: model advises, policy decides).
- A single-number leaderboard.

## Third review (Codex, 2026-09-20)

Eight findings, all real, all fixed with regression tests. Three were the tool
reporting a pass it had not earned, which is the failure this project exists to
find. See `reviews/03.md`.

## Still open

- Codex conformance cases, which is what would promote that adapter past
  discovery.
- Publishing to npm, without which the GitHub Action cannot run elsewhere.
- Leaderboard rows do not pin the scanned commit or the extractor model.
- The Dockerfile pins the SDK version by hand rather than reading package.json.
