# ADR 0008: Check the permission model against the runtime, not against the docs

Status: accepted, 2026-09-20

## Problem

`src/config/permissions.ts` implements Claude Code's permission semantics as documented. Every static verdict paperfence prints rests on that implementation being right, and it was checked only by unit tests that encode the same reading. A reading can be confidently wrong, and the runtime can change without telling us.

Being wrong has two directions and they are not symmetric. Reporting a gate where the runtime allows sends someone home believing they are fenced. Reporting a gap where the runtime refuses is merely wrong, and it makes every other finding less believable.

## Decision

`paperfence conformance`: a table of claims, each one a settings file, a call, and the decision we predict. Each case runs the real runtime in a container, asks an agent to make exactly that one call, and observes what happened. Three observable outcomes: the runtime refused, the runtime asked for approval, or the call ran.

A case the agent never attempted is inconclusive, not a pass. Models decline things, and a decline is a fact about the model.

Two things the suite had to be designed around, both found by running it:

**The commands are harmless.** `echo`, `pwd`, `wc`. The first draft used `git push origin main` and `cat .env`, and the agent declined both on its own judgement. What is being measured is the matcher, not the model's willingness; dangerous tasks belong in the attack suite.

**Every case allows the tool it exercises.** In the default permission mode the runtime asks about anything not explicitly allowed, so without a baseline allow, "asked" happens to everything and carries no information.

## What the first run found

Three cases documented as gaps are not silent allows. For `/bin/echo` against a `Bash(echo:*)` deny, for `sh -c 'echo hello'` against the same, and for `grep` against a `Read` deny, the runtime **prompts**. So does an `Edit` to a path outside an `Edit(vendor/**)` deny, despite a bare `Edit` allow.

This is the most useful thing the suite has produced, and it is a distinction paperfence was not making:

| | attended session | unattended run |
|---|---|---|
| the runtime | asks the developer | auto-approves |
| effect | the developer can say no | the call proceeds |

paperfence's matcher answers the unattended question, which is the one CI has, and says allow. That is correct for the setting this tool is built for and wrong for a developer sitting at a terminal. The suite reports these as "allowed unattended, prompted when watched" rather than as a disagreement, and the count is shown separately so nobody has to infer it.

## Consequences

- A runtime upgrade that changes a decision shows up as a failing case with the claim written next to it, rather than as a silently wrong report months later.
- `support.evaluate` for a new adapter is gated on its own conformance cases passing. That is what would promote Codex past discovery.
- The suite is a command, not part of `pnpm test`: it needs Docker and it spends money. CI can run it on a schedule.
- Each case's `claim` is written as a sentence, so the failure output is the claim that stopped being true.
