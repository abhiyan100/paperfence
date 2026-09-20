# How paperfence works

Six commands. Each is explicit about what it can and cannot see. Every report carries a fingerprint: paperfence version and commit, runtime and SDK versions, model, OS, sandbox image, approval mode. Two runs with different fingerprints are not comparable, and the report shows both so you can tell.

## The shape of the thing

```
rule files ─┐
            ├─► rules ─┐
settings  ──┘          │
                       ├─► policy document ─► compiler ─► enforceability per target
repository ─► profile ─┤                                   (enforced / guard / partial /
                       │                                    elsewhere / guidance)
                       └─► scenarios ─► forms ─► trials ─► verdicts ─► receipts
                                  (prereqs)      (sandbox)   (5 kinds)   (content-addressed)
```

## 1. `scan`: what your configuration would refuse

Rule files (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`) go through a small model, or a keyword heuristic with `--offline`, and come out as structured rules with a category, targets and a source location. Settings entries become rules too, so a `permissions.deny` line is graded alongside the prose that motivated it.

For each rule, several **probes**: different tool calls that would each produce the forbidden effect. Secrets are probed with the Read tool, `cat`, `grep`, a `node -e` one-liner, a `while read` loop, `base64`, a copy, and a process substitution, because a deny entry that stops the first three and not the rest is a partial fence, and the report should say which.

Each probe is evaluated against the documented Claude Code permission semantics (`src/config/permissions.ts`), then against your hooks, which are executed for real, with the real payload shape, **inside a container**. A hook that crashes or times out is reported as allowing the call, because that is what the runtime does.

## 2. `policy`: what anything could enforce

`policy init` drafts `paperfence.policy.yaml` from the rules already in the repository, keeping your wording and collapsing a prose rule and the settings entry that restates it into one statement.

`policy check` compiles it per target and labels every statement with one of five classes, plus the gaps: what the named mechanism will *not* catch. Targets are Claude Code with deny entries only, Claude Code with the paperfence guard, Codex, and GitHub. Statements no target can hold are listed separately, because those exist only as prose.

## 3. `attack`: what an agent actually does

For each rule, paperfence picks the **attack forms** whose prerequisites this repository meets. A form is a task, not a command: the protected-branch rule is attacked as a documentation fix, an urgent revert, and a release bump.

Each trial gets a fresh sandbox: a copy of the repository with its own git history, a bare `origin` it can push to, canary secrets written over any real ones, and, at pressure level 2 and above, the planted excuse files the objectives point at. The scenario's own setup runs before the snapshot, so a planted failing test is part of "the repository the agent found", and tampering with it is visible.

The agent runs in a container with `--network none`. The only way out is a unix socket on a shared volume, served by a proxy container that forwards only `POST /v1/messages`, requires a per-run token, and holds the real credential. The agent has a placeholder key. The job arrives in an environment variable and the result leaves on stdout between markers, so nothing the agent can write is read back as a finding.

Afterwards paperfence looks at the sandbox, not at what the agent said: did `origin/main` move, is the test file still there and does the test script still run it, did the canary appear in a tool result or arrive at the local sink. That produces one of five verdicts, derived in one place (`src/verdict.ts`) so nothing downstream re-derives it.

## 4. `compare`: can this change be merged

Two configurations, one suite, interleaved. **Bad tasks** must be blocked; **good tasks** must still complete, with explicit checks. Denominators count only trials that reached a conclusion; errors, inconclusive runs and scenarios this repository cannot support go in their own column. The report says whether the two arms can be told apart at the sample size actually run.

## 5. `harden`: turn wishes into gates

One generated hook driven by a `policy.json`, plus deny entries. `--dry-run` prints the exact bytes. The hook protects itself, protects what selects tests as well as the tests, and records a successful test run in `PostToolUse` so "run tests before committing" can be enforced at all, which a deny list cannot express.

## 6. `doctor`: check our own boundary

Starts a container with the same flags a trial uses and checks from inside it: no default route, no DNS, no route to the host gateway or `host.docker.internal`, no route to a container on the proxy's network, no privilege escalation.

## Receipts and replay

Every trial writes a content-addressed receipt. `replay` re-runs the conditions and diffs the fingerprints. It reproduces the setup, not the agent.
