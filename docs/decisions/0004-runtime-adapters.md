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

## Codex was promoted on 2026-09-20, and only as far as the measurements go

`paperfence conformance --runtime codex` runs the real CLI against a matrix of sandbox modes. Six cases, all agreeing. On that basis `drive` and `evaluate` are now true, and `probeHooks` and `harden` are still false.

What the measurements established:

- Under `read-only`, every write fails, including outside the workspace, and **reads are not confined**. A Codex repository whose rule says "never read .env" gets nothing from its sandbox.
- Under `workspace-write`, the whole workspace is writable. The sandbox cannot express a path allowlist inside it, so a "only touch src/" rule is not enforced by it either.
- Under `danger-full-access`, nothing is confined.

Two limits came out of the same work and are now in the adapter's own notes:

- **Codex confines rather than refusing.** A command runs inside a restricted environment and the operation fails; nothing is recorded as denied. So "blocked" for Codex means the effect did not happen, which is the only question a confinement can be asked.
- **A confined command leaves no record.** When the sandbox blocks a write, `codex exec --json` emits no `command_execution` item at all: the stream shows the agent saying the write failed and nothing else. paperfence can see that the effect did not happen and cannot see what was attempted. That is a limit on what any tool can report about a Codex run, not only this one.

Hooks remain uncovered. A Codex hook runs only once trusted by content hash, and we have not established how to observe one blocking a call, so the adapter does not claim to.

## Judging a repository by its own runtime

Promotion exposed an inconsistency: the adapter said Codex was covered while the static probe still evaluated every repository with Claude Code's permission matcher. A repository with `AGENTS.md` and no `.claude` directory was being told it had no deny entries, which is true and meaningless.

`scan` now picks the adapter from what the repository is configured for, and hands it its own discovery rather than a translation of someone else's. Codex's discovery reads `.codex` and parses TOML; Claude Code's reads `.claude` and parses JSON. Handing the Codex adapter a translated Claude config made it report that a file it had never read was absent.

## Consequences

- `scan` and `attack` report runtime coverage, and an uncovered runtime is stated, not implied.
- The policy compiler (ADR 0005) targets a runtime's declared controls, so a policy rule that a runtime cannot express is reported as unenforceable there rather than silently dropped.
- Adding Cursor, Copilot or Gemini is an adapter plus its conformance suite, not a change to the core.
