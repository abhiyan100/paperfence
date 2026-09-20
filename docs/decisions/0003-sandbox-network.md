# ADR 0003: The agent container has no network at all

Status: accepted, 2026-09-20

## Problem

The agent container sat on a Docker `--internal` network with the credential proxy as a sidecar, and reached it at `http://proxy:8080`. Two things were wrong with that.

The first is what the agent could still reach. On the same `--internal` network, every other container is addressable by name. Measured on this machine (Docker Desktop 4.x, macOS, arm64):

| from the agent container, old setup | result |
|---|---|
| another container on the same network | reachable, HTTP 200 |
| DNS for an external name | fails |
| the Docker Desktop host gateway | `ENETUNREACH` |

So the "reaches the host gateway" limit we had written down was not reproducible here. It is documented behaviour on some Linux bridge configurations and we could not rule it out, but on the platform we tested, the real reachability was container-to-container, not host.

The second is the shape of the claim. "It can only reach the proxy" was an assertion about Docker's networking, made by us, in prose. It was never checked.

## Decision

The agent container runs with `--network none`. It has a loopback interface and nothing else: no default route, no DNS, no peers.

The credential proxy keeps its own egress network and never shares a network with the agent. It listens on a **unix domain socket** on a Docker named volume that both containers mount. Inside the agent container, the runner starts a loopback forwarder on `127.0.0.1:8080` that pipes to that socket, and `ANTHROPIC_BASE_URL` points at the forwarder. The proxy still requires the per-run token, still forwards only `POST /v1/messages` and `count_tokens`, and still holds the only credential.

A named volume, not a bind mount: unix sockets do not work across the macOS filesystem bridge, but do work on a volume inside the Linux VM. The socket directory has to exist in the image owned by `node`, because Docker seeds a new named volume with the image directory's ownership, and a root-owned mount point leaves both containers unable to use it.

`paperfence doctor` runs the checks instead of asserting them: no default route, no DNS, no route to the host gateway or `host.docker.internal`, no route to a container on the proxy's network, and no privilege escalation. All five pass on the setup above.

## Rejected alternatives

- iptables inside the container: needs `NET_ADMIN`, which we drop.
- gVisor or Kata: a real option for a stronger kernel boundary later, not needed for the network property, and not on Docker Desktop by default.
- Sharing the proxy's network namespace: that namespace has the egress route.

## Consequences

- The exfiltration sink stays on loopback inside the agent container, unchanged.
- The forwarder is a plain Node `net` server in the runner. The agent could kill it, which costs the agent its own API access and nothing else.
- The sandbox image is now `paperfence-sandbox:0.4`; the socket directory is the only difference.
- `--unsafe-host` mode is unaffected and stays labelled unsafe.
- What this does not claim: the container shares the host kernel. A kernel escape defeats it. The threat model is a misbehaving coding agent, not a kernel exploit.
