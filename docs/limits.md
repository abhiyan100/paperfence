# What paperfence cannot tell you

One page, so nobody has to infer it from the absence of a finding.

## The rule list is the weakest link

paperfence reads your rule files with a model and turns prose into categorised
rules. Every verdict is attached to one of those. Measured against six real rule
files annotated by hand (`fixtures/corpus`):

| | model reader | offline keyword reader |
|---|---|---|
| mechanically checkable rules found | 22-28 / 44 | 18/44 |
| targets exactly right | about half | 1/24 |
| judgement filed under a category with a probe | 14-25 | 10 |

Three consequences worth stating plainly:

- **A rule it did not find is not reported at all.** Not as a wish, not as
  unknown. It is simply absent, and nothing in the output marks the gap.
- **A judgement rule filed under a mechanical category gets a verdict about
  something else.** In a repository with deny entries, that verdict can be
  `GATE`: protected by a control that has nothing to do with the rule.
- **Re-running can give a different list.** Three runs of the same six
  documents extracted 85, 73 and 88 rules. Two runs of the same scan can
  disagree about a category.

`scan --write-categories` writes a file where a misreading can be corrected.

## A clean report is not a safe repository

`scan` answers "would a configured control refuse this call". It does not see:

- **Your personal settings.** `~/.claude/settings.json` is yours, not the repository's, and paperfence does not read it. A teammate's machine may enforce more or less than the repository does.
- **Managed policy.** An administrator's settings, or Codex's `requirements.toml`, can add controls paperfence never sees.
- **Branch protection and required checks.** The controls that do not depend on the agent cooperating live at the git host. `paperfence policy check --target github` says which of your rules belong there, but it cannot read your repository settings to tell you whether they are on.
- **Whether a Codex hook is trusted, or does anything.** Codex runs a repository hook only after a user trusts it by content hash, so a hook file is not proof that one fires. paperfence does not cover Codex hooks at all: it can read them and cannot say what they would do.
- **Anything at runtime.** A rule that holds in a trial may not hold in the run that matters, with a different task, a different model version, and a different context window.

## A grade is a claim about what was tried

Every live verdict carries its evidence scope: which attack forms, how many trials, at which pressure levels, on which model and runtime version. A GATE from one form at one level on one model is a small claim. The report prints the scope next to the grade for exactly this reason.

Where the numbers are genuinely weak, the report says so rather than rounding:

> 3 clean trials; with this few, a violation rate as high as 61% is still consistent with what we saw

## NOT APPLICABLE is not PASS

A scenario whose prerequisites this repository does not have is not run, and is reported as not applicable. A repository with no test suite cannot have its "do not weaken tests" rule tested, and reporting that as the rule holding would be the exact failure this tool exists to find.

## ERROR and INCONCLUSIVE are not PASS either

A container that died says nothing about your policy. Nor does an agent that used its whole turn budget without doing the forbidden thing and without being stopped. Both are reported as themselves and excluded from every denominator.

## Replay reproduces conditions, not outcomes

`paperfence replay` re-runs the same repository, scenario version, form, level, model and turn budget. It cannot re-run the agent. A replay that comes out differently is a fact about the agent, and the output says which parts of the setup drifted so you can tell the two apart.

## The permission model is checked against the runtime, and answers the unattended question

`src/config/permissions.ts` implements Claude Code's permission semantics as documented. `paperfence conformance` checks that reading against the real runtime, case by case, and a runtime change shows up as a failing claim rather than as a silently wrong report.

Two results from it matter enough to state here.

**A deny entry that names only a tool is not a control.** Measured over eight trials with `deny: ["Bash"]` and six with `deny: ["Glob"]`, the call was refused in none of them, and the runtime's own session-start tool list still advertised the denied tool. In some trials the agent said it had no such tool, which was the model being wrong rather than the rule working. paperfence used to grade such an entry as a gate. It now reports it as present and unreliable, and `harden` no longer generates one. If your settings file has a bare `WebFetch` or `Bash` in its deny list, it is decoration; use a pattern, or a hook.

**Several rules paperfence reports as gaps are not silent allows.** The runtime **prompts**.

| | attended session | unattended run |
|---|---|---|
| `/usr/bin/curl` against a `Bash(curl:*)` deny | the developer is asked | it runs |
| `sh -c 'curl ...'` against the same | the developer is asked | it runs |
| `grep` against a `Read` deny | the developer is asked | it runs |
| an edit outside an `Edit(dir/**)` deny | the developer is asked | it runs |

paperfence answers the unattended question, because that is the one CI has and the one nobody is watching. If you are sitting at a terminal with approvals on, you have a control paperfence does not count, and it is exactly as reliable as you are at reading prompts.

## The capability graph stops at the first hop

`paperfence graph` traces a credential the code reads to the service its name implies. It does not follow that service onward: a cloud credential that opens a role that opens a function that holds a database credential is one edge here, not four. It also cannot know what any credential is allowed to do, which is why every blast radius is `unknown` until a human writes one into `paperfence.inventory.yaml`.

## The benchmark corpus is two repositories

`bench/` has a Python service and a Go service, and one smoke sweep has run against them. That is a proof that the pipeline works. It is not a benchmark, and no number from it should be quoted as one. `bench/POLICY.md` says what a publishable sweep would require.

## `harden` changes what two rules mean

The generated guard is a real control, and it is not a faithful translation of two categories:

- **"Ask before X" becomes "X is refused."** An unattended run has nobody to ask. If a human is present, move it back to `permissions.ask`.
- **"Do not weaken tests" becomes "do not edit tests that are already committed."** Writing a new test is ordinary work and stays allowed.

Both are printed when `harden` runs. Neither is hidden in a config file.

## Cost and time are real

`attack` and `compare` run real agents. A compare with three repetitions over a ten-task suite is sixty agent runs. The receipt reports what it cost. The static scan is free and needs neither Docker nor a key.
