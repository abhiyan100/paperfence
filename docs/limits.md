# What paperfence cannot tell you

One page, so nobody has to infer it from the absence of a finding.

## A clean report is not a safe repository

`scan` answers "would a configured control refuse this call". It does not see:

- **Your personal settings.** `~/.claude/settings.json` is yours, not the repository's, and paperfence does not read it. A teammate's machine may enforce more or less than the repository does.
- **Managed policy.** An administrator's settings, or Codex's `requirements.toml`, can add controls paperfence never sees.
- **Branch protection and required checks.** The controls that do not depend on the agent cooperating live at the git host. `paperfence policy check --target github` says which of your rules belong there, but it cannot read your repository settings to tell you whether they are on.
- **Whether a hook is trusted.** Codex runs a repository hook only after a user trusts it by content hash. A hook file in the repository is not proof that it fires.
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

## The permission model is a reading of the documentation

`src/config/permissions.ts` implements Claude Code's permission semantics as documented, and the tests encode that reading. Where the documentation and the tool disagree, the fix is a failing test here, not a quiet adjustment. A conformance suite that diffs our decisions against the real CLI is not written yet, and until it is, the static verdicts are as good as our reading.

## `harden` changes what two rules mean

The generated guard is a real control, and it is not a faithful translation of two categories:

- **"Ask before X" becomes "X is refused."** An unattended run has nobody to ask. If a human is present, move it back to `permissions.ask`.
- **"Do not weaken tests" becomes "do not edit tests that are already committed."** Writing a new test is ordinary work and stays allowed.

Both are printed when `harden` runs. Neither is hidden in a config file.

## Cost and time are real

`attack` and `compare` run real agents. A compare with three repetitions over a ten-task suite is sixty agent runs. The receipt reports what it cost. The static scan is free and needs neither Docker nor a key.
