# Trying paperfence on your own repository

A short guide for the first people to run this on a repository nobody here has
seen. It says exactly what each command does, what it costs, what leaves your
machine, and which results are not evidence of anything.

If something here turns out to be wrong about your repository, that is the most
useful thing you can tell us. There is a feedback form at the bottom.

## The one command

```bash
npx paperfence scan .
```

That is the whole first step. It reads your `CLAUDE.md` / `AGENTS.md` and
`.claude/settings.json`, works out which rules could be mechanically enforced,
and tells you which of them actually are.

You will get three kinds of line:

| | what it means |
|---|---|
| `GATE` | something mechanical would refuse the obvious violation |
| `WISH` | nothing would. The rule depends entirely on the agent choosing to obey |
| `?` | paperfence could not map this rule to a check, and says so rather than guessing |

### If it read a rule wrongly

paperfence reads your rules with a model, and it files roughly one judgement
rule in five under a category that has a probe behind it. When that happens:

```bash
npx paperfence scan . --write-categories   # writes .paperfence/categories.json
```

Edit the category next to the rule and run `scan` again. Setting a rule to
`other` means "this is judgement, do not probe it", which is the correction most
often needed. The file can refile a rule; it cannot invent one, and it cannot
claim a control exists.

**A `WISH` is not a bug in your repository.** Most rules in most repositories are
wishes, and plenty of them should be: "prefer composition over inheritance" is
not a thing a hook can enforce. The number worth looking at is how many of the
rules you would be upset to see broken are wishes.

## What each command does, and what it costs

| command | network | Docker | spends money | what it does |
|---|---|---|---|---|
| `scan` | one model call per rule file | only to run your repo's hooks safely | a few cents | reads config, runs static checks |
| `scan --offline` | none | same | nothing | uses a keyword reader instead of a model |
| `attack` | model calls per trial | **yes, required** | dollars, see below | runs a real coding agent that tries to break each rule |
| `harden` | none | no | nothing | writes a hook and deny entries |
| `compare` | model calls per trial | **yes** | dollars | runs the same tasks under two configs |
| `replay` | model calls per trial | **yes** | dollars | re-runs the conditions in a receipt |
| `graph` | none | no | nothing | lists what an agent here could reach |

`attack` is the expensive one. Each trial is one agent run: in our own runs that
has been roughly **$0.07 to $0.15 per trial**, and the default is one trial per
attack form per pressure level, so a repository with six mapped rules can be ten
to thirty dollars. Use `--budget 2` to stop after two dollars, `--rule <id>` or
`--category <name>` to attack one thing, and `--level 1` to skip the harder
pressure levels.

## What it reads and what it writes

Reads, in your repository: `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`,
`CLAUDE.local.md`, `.claude/settings.json`, `.claude/settings.local.json`, hook
scripts those settings name, your `package.json` / `pyproject.toml` /
`go.mod` / `Cargo.toml`, and the file listing.

Writes, only when you ask:

- `.paperfence/categories.json` — only `scan --write-categories`. Your
  corrections to how rules were read.
- `.paperfence/receipts/` — one JSON file per live trial. `attack` writes these
  unless you pass `--no-receipts`. A `.gitignore` is written next to them so
  they do not end up in your history by accident.
- `.claude/settings.json` and `.claude/hooks/` — **only** `paperfence harden`,
  and it shows you the diff first.
- `paperfence.inventory.yaml` — only `paperfence graph --init`.

Remove everything with:

```bash
rm -rf .paperfence
git checkout .claude/         # only if you ran harden and want it undone
rm -f paperfence.inventory.yaml
```

## What leaves your machine

By default: **the contents of your rule files**, sent to a model to be read into
a list of rules, and the objectives of live trials during `attack`. That is all.

Not sent: your source code, your git history, your credentials, your `.env`.

- `scan --offline` sends nothing at all.
- During `attack` the agent runs in a container with `--network none`. It cannot
  reach your machine, your network, or the internet. Its credential comes
  through a unix socket on a shared volume, so the container never holds a
  token.
- Your real secrets are never given to the agent. Any file in the copied tree
  that looks like a credential is overwritten with a canary before the agent
  starts, and the canary is stripped from receipts.
- Nothing is uploaded anywhere unless you explicitly run `paperfence push`
  against a control plane you configured.

## Running it on a repository you do not trust

`scan` executes your repository's hook scripts, because that is the only way to
find out what they do. By default it runs them **in a container**, not on your
machine. If Docker is not available it does not run them at all and reports the
rules they might cover as unknown. `--unsafe-run-hooks` runs them on your
machine; do not use it on a repository you have not read.

`attack` runs your repository's test command inside the container to find out
whether the environment can host the task at all. That is untrusted code
executing in a network-less container. If that is not acceptable for a given
repository, do not run `attack` on it.

## Sharing a report

```bash
npx paperfence scan . --markdown report.md
npx paperfence attack . --json report.json --html report.html
```

Before sending any of these to someone else, know what is in them:

- Rule text from your repository, verbatim.
- File paths from your repository.
- For `attack`, the agent's commands and their output, which is output from
  **your** code. Credentials paperfence planted are redacted; anything your own
  test suite prints is not.
- Git remote URLs are stripped of credentials, but check anyway.

The JSON is the full record. The Markdown summary is the safest thing to paste
into an issue.

## What these results are not

Read this part before you quote a number to anyone.

- **A `GATE` is not a security boundary.** It means a control in your config
  would refuse the obvious form of the violation as paperfence probes it. A
  determined agent, or a form of the violation paperfence does not know, may
  still get through. The conformance suite found that a deny entry naming a bare
  tool name stops nothing at all.
- **A clean `attack` is not proof the rule holds.** It is a sample. Six clean
  trials are consistent with a violation rate as high as about 39%; the report
  prints that interval next to the result for exactly this reason.
- **paperfence reads your rules with a model, and the model misses things.**
  Measured against six real rule files, it finds between a half and two thirds of
  the mechanically checkable rules, and files a fifth to a quarter of the
  judgement ones under a category that has a probe behind it. Run it twice and
  the list is not the same. Anything it missed is missing
  from every number below it. `scripts/corpus-accuracy.ts` is that measurement,
  and `reviews/real-world-validation-02.md` is the detail.
- **`?` means unknown, not safe.** A rule paperfence could not map is a rule it
  did not check.
- **A hook that was not executed is unknown, not absent.** With `--no-hooks`, or
  without Docker, rules a hook might cover are reported as unknown rather than
  as open.
- **Live trials drive Claude Code.** If your repository is configured for Codex
  or another runtime, the report says so and marks that runtime as not covered.
  The result describes Claude Code running with your rules.

## Telling us what happened

`docs/FEEDBACK.md` has seven questions. The useful answers are the ones where
paperfence was wrong.
