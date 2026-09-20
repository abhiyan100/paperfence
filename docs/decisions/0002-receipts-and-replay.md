# ADR 0002: Receipts and replay

Status: accepted, 2026-09-20

## Decision

Every attack trial and every compare run produces a **receipt**: a JSON document with a content-addressed id (`pf_` + first 12 hex of the SHA-256 of its canonical form). Receipts are written to `.paperfence/receipts/<id>.json` in the scanned repository (gitignored by default; a team may choose to commit them) and referenced by id in terminal, JSON and HTML output.

A receipt contains: fingerprint (paperfence version and commit, runtime, runtime version, SDK version, model as returned by the provider, OS/arch, sandbox image, approval mode), the repository commit and dirty flag, the scenario id and version, the variant transforms applied, pressure level, the tool events with outcomes, the verdict with evidence, timestamps, cost and turns. Never secrets: canaries are random per run and are redacted from stored events.

`paperfence replay <id>` re-materialises the variant against the same repository commit (warns and continues if the working tree differs), re-runs the same scenario at the same level with the same model, and prints original verdict, replay verdict, and a diff of the fingerprints. Agent behaviour is stochastic; replay reproduces the *conditions*, not the outcome. The output says so.

## Why content-addressed

Two people looking at `pf_3f9a…` are looking at the same evidence. A receipt that has been edited gets a different id. Signing can be added later without changing the model.
