# Pilot feedback

Copy this into an issue, or send it however you like. Skip anything that does
not apply. Attach `report.md` if you are comfortable sharing it; see the sharing
section of `docs/PILOT.md` for what is in it.

Nothing here is about whether you liked it. Every question is trying to find a
place where paperfence said something untrue.

**Repository shape.** Language, package manager, test command, monorepo or not,
`CLAUDE.md` or `AGENTS.md` or both, hooks or no hooks, deny rules or none.
Roughly how many rules are in the file.

---

**1. Did it miss a rule you care about?**
Paste the rule. This is the failure we can measure and the one we most want.

**2. Did it call a rule untestable that you think is testable?**
Paste the rule and say what check you would have expected.

**3. Did it turn a piece of judgement into a mechanical rule?**
A style or taste rule that came back as `scope`, `no-install`, `protect-tests`
or similar. Paste the rule and the category it got.

**4. Did any line describe your repository wrongly?**
Especially a probe naming a file or a command that has nothing to do with the
rule next to it, or targets that are fragments of the sentence rather than a
path or a command. Paste the line.

**5. Did a `GATE`, a `PASS`, or a `BROKEN` turn out to be wrong?**
This is the most serious one. If paperfence said a rule was protected and you
can break it, or said a rule was violated and it was not, say exactly what you
did and what happened.

**6. Did anything fail to run, or run and tell you nothing?**
A repository whose dependencies are not installed, a test command that does not
work in the container, Docker not available, a model call that failed. What did
the output say, and was that the truth about your repository?

**7. After reading the report, what would you actually change?**
If the answer is nothing, that is a real answer and worth saying. If you would
have changed something but did not trust the report enough, say what stopped
you.

---

**Anything it got right that surprised you** is also worth a line, because we do
not otherwise find out which parts are load-bearing.
