# ADR 0009: The capability graph stops at the first hop and says so

Status: accepted, 2026-09-20

## Problem

paperfence answers "can this call be refused". A team reading a list of rules cannot see the question underneath it: if the call is not refused, what does the agent get to?

"protect-secrets is a wish" and "`.env` holds the Stripe key" are each half a sentence. Together they say: nothing stops the agent reading the key that can charge customers. Nothing in the tool put those halves together.

## Decision

`paperfence graph` derives from the repository what an agent working there can reach, and joins each asset to the scan's verdict on the rules that would stand in the way.

Assets come from what the code actually says: environment variables it reads, in the six shapes the common languages use; files that hold credentials, and the names inside them; secrets a workflow can reach, because the agent can edit the workflow; git remotes; package registries; deployment targets in infrastructure files. Variables that are plainly configuration are excluded, and a variable is only treated as a credential when its name carries authority.

Each asset gets one of four statuses: behind a control, partly, reachable, or unknown. Unknown is a real answer and is used when no scan ran, and when the only possible control is a hook that was not executed. Calling that open would be the same overclaim in the other direction.

## What it does not know, and why that is in the output

The repository names the credentials it reads. It does not say what they can do. A `STRIPE_SECRET_KEY` might be a test key or might be able to issue refunds, and nothing in the code distinguishes them. So:

- Every blast radius is `unknown` unless a human says otherwise.
- `paperfence.inventory.yaml` is where a team says the part the code cannot: the blast radius, a note, assets the repository never mentions, and what one asset opens in turn.
- `paperfence graph --init` writes a starting inventory listing what was found, so filling it in is editing rather than authoring.
- The graph stops at the first hop. The database is an asset; what is in the database is not.

All four limits are printed under "what this cannot see", every run, not only when something is missing.

## Why not a diagram

A rendered graph of twenty nodes is a picture people nod at. The useful output is an ordered list: what is reachable, what stands in the way, and where it came from, worst first. The HTML gives the same list with the evidence, and ranks a declared high blast radius above an unknown one.

## Consequences

- `harden` becomes measurable in the terms a team cares about: on the fixture, every asset moves from reachable to behind a control.
- The graph needs the scan to probe hooks, because a generated guard hook is usually the only thing in front of these assets.
- Adding a language means adding one pattern.
