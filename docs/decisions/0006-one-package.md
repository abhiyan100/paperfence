# ADR 0006: One package, not a monorepo

Status: accepted, 2026-09-20

## Decision

paperfence stays a single npm package with one `src/` tree until there is a second consumer of one of its parts.

## Why this keeps coming up

The codebase now has pieces that look like libraries: a shell parser, a permission-semantics implementation, a policy compiler, a runtime adapter interface, a sandbox driver. The instinct is to split them so the boundaries are enforced by package manifests.

## Why not yet

The boundaries that matter are already enforced by something cheaper: a module that must not import another simply does not, and the review that catches it is the same review that would catch a bad dependency in a manifest. What a split would add today is version skew between parts that always ship together, a release process for five things instead of one, and a `pnpm install` that has to succeed in the sandbox image.

There is one boundary a split would genuinely protect, and it already has a stronger guard than a package manifest: `src/config/permissions.ts` implements Claude Code's semantics and must not drift toward what we wish they were. The thing that protects it is the test suite encoding the documented reading, plus the conformance suite when it lands, not a directory.

## What would change this

- A second consumer: the shell parser or the permission matcher used by something that is not paperfence.
- A published runtime adapter API, so third parties can add Cursor or Gemini without a pull request here.
- A server: the control plane in ADR 0007 would not share a release cadence with the CLI.

Any one of those is the signal. Until then the cost is real and the benefit is a diagram.
