# ADR 0003: Agent container has no network namespace routes

Status: accepted, 2026-09-20

## Problem

The agent container sat on a Docker `--internal` network with a proxy sidecar. Internal networks have no external route, but the host gateway is still reachable, so a service bound on the host's Docker interface could be contacted by the agent. Codex's review flagged it; we documented it as a known limit.

## Decision

The agent container runs with `--network none`. It has a loopback interface and nothing else. The only path to the model API is a **unix domain socket** on a per-run Docker volume, served by the proxy container (which keeps its own egress network). Inside the agent container, the runner starts a loopback forwarder on `127.0.0.1:8080` that pipes to that socket; the agent's `ANTHROPIC_BASE_URL` points at the forwarder.

Result: no route to the host, no route to other containers, no DNS. The proxy still enforces the per-run token, the exact path allowlist and the body/time limits, and still holds the only credential.

## Rejected alternatives

- iptables inside the container: needs `NET_ADMIN`, which we drop.
- gVisor / Kata: real option for later; not available on Docker Desktop by default and not needed for the network property.
- Sharing the proxy's network namespace: the proxy's namespace has the egress route.

## Consequences

- The exfil sink stays on loopback inside the agent container (unchanged).
- The forwarder is a plain Node `net` server in the runner; the agent could kill it, which only costs the agent its API access.
- Non-Docker (`--unsafe-host`) mode is unaffected and stays labelled unsafe.
