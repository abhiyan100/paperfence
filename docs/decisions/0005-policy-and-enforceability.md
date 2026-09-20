# ADR 0005: A policy document, and five enforceability classes

Status: accepted, 2026-09-20

## Problem

Rules lived in two places that could not be reconciled: prose in CLAUDE.md, extracted by a model, and entries in settings.json, parsed. `harden` compiled straight from a rule category to a deny entry and a hook clause. Nothing in the system could answer the question a team actually has, which is not "is this rule followed" but:

> Of the twenty things our policy says, which ones can anything actually stop?

## Decision

A policy document at `paperfence.policy.yaml`. Deliberately not a rule language: every statement is one of a small set of shapes (`forbid`, `require`, `restrict`) with a category, targets, and the team's own wording as its text. Expressiveness is not the goal. Being able to answer the question above for every line is.

`paperfence policy init` drafts one from the rules already in the repository, keeping the team's wording. `paperfence policy check` compiles it for each target and reports, per statement, one of five classes:

| class | meaning |
|---|---|
| enforced | a control refuses it, unattended, today |
| needs-runtime-guard | only paperfence's generated hook can express it; the runtime's own configuration cannot |
| partial | some routes to the violation are closed and others are open |
| org-control | no agent-side control can do it. It belongs to the git host, CI, or a secret manager |
| unenforceable | not mechanically checkable. Guidance, and the policy should say so |

Every statement also carries its **gaps**: what the named mechanism will not catch. A `partial` with no gaps listed would be a lie by omission, so the compiler writes them for every class, including `enforced`.

Targets are `claude-code` (deny entries only), `claude-code-hook` (with the generated guard), `codex`, and `github`. The first two are separate on purpose: what a team gets from settings.json alone is weaker than most people expect, and hiding that behind "we'll install a hook" would lose the most useful finding in the output.

`unenforcedAnywhere` lists the statements no target in the set can hold. Those exist only as prose. Exit code 2 when any remain that the author has not explicitly accepted with `acceptAsGuidance: true`, so accepting a rule as guidance is a deliberate act recorded in the policy, not a silent downgrade.

## Why the classes are not a score

A number invites optimising the number. "Nine partial" is not eight tenths of "eleven enforced": partial means a specific set of routes is open, and the gaps say which. The output is a list a reviewer reads, not a grade.

## Consequences

- `harden` becomes one consumer of the compiler rather than the only path from rules to controls.
- Adding a target is an assessor function plus the artifacts it emits.
- The same enforceability vocabulary can label a PR comment, a GitHub check, and a dashboard row without redefining it.
- A statement marked `acceptAsGuidance` is never counted as a control anywhere, which is what makes the rest of the numbers trustworthy.
