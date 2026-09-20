# ADR 0004: Runtime adapters declare what they cannot do

Status: accepted, 2026-09-20

## Problem

Claude Code was wired through the codebase: its settings paths, its permission grammar, its hook payload shape, its SDK. A repository configured for a different agent would scan clean, and a clean scan reads as safety.

The temptation is to add a second runtime by approximating its rules. That produces the failure this tool exists to find: a verdict that sounds mechanical and is not.

## Decision

A runtime adapter declares support for four capabilities separately, and every one of them is allowed to be false:

| capability | meaning |
|---|---|
| discover | find and read the files that instruct this agent |
| evaluate | decide, statically, whether a configured control refuses a given call |
| probeHooks | execute the repository's own hooks with this runtime's payload shape |
| drive | run the agent unattended and observe its tool calls |

An adapter that cannot evaluate returns `unknown`, never `allow`. Reports render unknown as unknown. A repository configured for a runtime we cannot verify gets a section saying so, above the fingerprint, in the same report as the findings.

Claude Code supports all four. Codex supports discovery only.

## Why Codex is read-only for now

Codex does not decide a call from a permission rule list. It composes three separate things: `sandbox_mode` (read-only, workspace-write, danger-full-access), `approval_policy` (untrusted, on-failure, on-request, never), and hooks that block on `decision: "block"`, `permissionDecision: "deny"`, or exit code 2. There is no rule grammar to match a call against, so "would this call be refused" is a question about the sandbox and the approval flow, not about a pattern.

Two facts a reader of a paperfence report needs, which the adapter reports today:

- A hook returning `permissionDecision: "ask"` is parsed and then ignored. Codex has no ask in its hook model, so a configuration that looks like it pauses for a human does not.
- Hooks run only once a user has trusted them by content hash. A hook file in a repository is not evidence that the hook fires.

Guessing at the decision procedure would produce confident wrong answers. The adapter reads the configuration, names what it found, names what it did not look at, and stops.

## What promotes Codex to evaluate and drive

A conformance suite: drive the real `codex exec` against a matrix of configurations and commands, and diff our predicted decision against the observed one. Same for the hook payload shape. Until those pass, `support.evaluate` stays false.

## Consequences

- `scan` and `attack` report runtime coverage, and an uncovered runtime is stated, not implied.
- The policy compiler (ADR 0005) targets a runtime's declared controls, so a policy rule that a runtime cannot express is reported as unenforceable there rather than silently dropped.
- Adding Cursor, Copilot or Gemini is an adapter plus its conformance suite, not a change to the core.
