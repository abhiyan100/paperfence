# ADR 0010: A control plane that stores receipts and nothing else

Status: accepted, 2026-09-20

## Problem

Receipts live in the repository that produced them. That is right for a single run and wrong for the question a team actually asks: a rule that held every time for a month started failing on Tuesday, and nobody can see that from one laptop's `.paperfence` directory.

ADR 0007 deferred this on the grounds that the receipt format was not stable. It has since survived the verdict vocabulary settling, the scenario catalog reaching version 2, and a second runtime, without a breaking change.

## Decision

A Postgres database on Neon and three serverless functions on Vercel, deployed alongside the existing static site so the dashboard can call the API on its own origin and no cross-origin header is needed.

**What is stored.** Receipts. The whole receipt goes into a `jsonb` column verbatim, with a dozen columns extracted from it for querying. The extracted columns exist to make queries possible, not to replace the evidence, so a schema change later cannot lose what was measured. Nothing else is sent: no source, no configuration, no credentials. A receipt has already had its canaries redacted before it was written to disk.

**Idempotence for free.** A receipt's id is the hash of its contents, so the primary key is the content address and pushing the same receipt twice is one row. Re-running `paperfence push` after a failed upload is safe. The response distinguishes rows actually written from rows already present, because an `ON CONFLICT DO NOTHING` insert succeeds either way and counting calls would report every re-push as new evidence.

**Who may write.** One write token per project. The token is shown once, at creation, and only its SHA-256 hash is stored, so a database dump does not let anyone write. Comparison is constant-time. Creating a project needs the deployment's own admin secret rather than a project token, so a leaked project token cannot mint more of them.

**What is refused, on both sides.** A receipt that does not hash to its own contents. The client checks before uploading and the server checks again, because a client is whatever is holding a project token.

The server check was missing at first, and an audit of the deployed service found it: a receipt with the id `pf_forged00001` and no relationship to its contents was accepted and stored. The whole claim of the receipt format is that an edited receipt is a different receipt, and a store that accepts whatever it is handed does not keep that claim. The control plane runs in a separate package and cannot import the CLI's receipt code, so it carries its own copy of the content addressing, pinned by a test in the main package asserting the two agree on a set of documents including one with a `__proto__` key.

## `status` is the whole point

`paperfence status` answers "what changed since last week": rules that failed inside the window and never failed before it, with the receipt id that proves it. Everything else in the summary is context for that list.

Counts are per verdict and never pooled. A rule with three passes and two errors is not a rule with a sixty percent pass rate, and the only denominator used is conclusive trials.

## Consequences

- The control plane is optional. Everything paperfence measures works with receipts in the repository and nothing else.
- `status` exits 2 when something started failing, so CI can use it.
- Two things cost an hour and are worth writing down. Vercel does not bundle a subdirectory under `api/` whose name starts with an underscore, so shared code has to live outside `api/`. And a TypeScript error in a function is reported in the build log while the deployment still succeeds, so a broken function ships looking healthy; the fix was to read the build log rather than guess twice.
