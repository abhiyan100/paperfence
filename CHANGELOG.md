# Changelog

## Unreleased (0.1.0 in progress)

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
