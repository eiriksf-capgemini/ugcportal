# pr-review-merge reference: step 4, review, and 4.1, the recurring-family sweep

Moved verbatim from `SKILL.md` by ugcportal-j13u. The checklist in `../SKILL.md` is what a round follows; this file holds the rationale, catalogued incidents and worked examples behind it, and where the two differ, this text is the rule. The commands, templates, tables and headings the checklist carries verbatim are not repeated here; an italic line marks where each one stood. "Above", "below" and "this file" in the moved text refer to the original single file: read them as earlier or later in the same step, in the checklist or in this reference.

The reviewer this step used to call, `code-review`, ships as an installed Claude Code plugin, not a file in this repo or a `~/.claude/skills/` override (verified: no `code-review` directory under this repo or `~/.claude/skills`); its only copy on this machine is the marketplace plugin install under `~/.claude/plugins/`, which this repo does not control and which a plugin update can overwrite regardless. So its prompt — including the per-angle finder sub-agents it spawns — cannot be durably edited from here. This step used to invoke it as `Skill(skill: "code-review", args: "<n> --comment")`. **Do not do that — do not invoke `code-review`, forked or otherwise, from this step.** Its finder forks did not stay read-only or scoped to their own resources: they posted inline PR comments — including a stray "write access test" comment — before this skill had reached a verdict; they reported their results to the orchestrator that had spawned the reviewer instead of to the reviewer itself, leaving reviewers idling for hours; they ran redundant builds of their own in a shared scratch worktree, with one wiping that worktree mid-run; one force-removed a worktree it had not created; and one ran `pkill -9 -f "next build"` machine-wide to clear a lock, which can kill another agent's build. The fork tokens this burned ran to the hundreds of thousands against reviewer totals an order of magnitude smaller. All of that is one root cause — forking the reviewer at all — tracked as `ugcportal-cr2h`, `ugcportal-p4jw` and `ugcportal-lasi`; this change subsumes all three.

Review the diff **yourself, in this same agent, inline.** Work through these six finder angles, **in this order, and no others — this list is fixed here, not something to extend per PR:**

1. **Line-by-line diff scan** — read every added, changed and removed line against what it claims to do.
2. **Removed-behaviour audit** — for everything the diff deletes, stops calling, or stops exporting, confirm nothing else still depended on it.
3. **Cross-file tracer** — follow every touched symbol, type, config value and env var to its other definitions and call sites outside the diff.
4. **Reuse / simplification / efficiency** — the `/simplify` angle: duplicated logic, needless complexity, avoidable work.
5. **Altitude** — does each change sit at the right layer, or does a lower-level concern leak upward (or a policy decision leak down)?
6. **Conventions** — does it match this repo's established patterns for naming, error handling, test shape and file placement?

Finish one angle completely — generate its candidates, then **verify every one of them against the actual code before moving to the next angle**, discarding anything you cannot substantiate. **Post nothing to the PR while any angle is still open.** No comment, no review, no write-access probe of any kind goes to GitHub until all six angles are done and you have reached step 5's verdict.

Within every angle, check against `review-standards` section 2's four defect families, and name all four for that angle in your eventual report — this is the same required sweep as before, now run per angle instead of as a separate pass: (1) a comment claims a guarantee the code doesn't make, (2) a check compares the wrong two things, (3) an assertion that cannot fail, (4) sibling-omission. An angle report that doesn't name all four did not do the sweep for that angle.

**Three more rules, taken directly from the incidents above:**
- Never spawn a sub-agent — forked or otherwise — for any part of finding. This agent is the only one that looks at the diff.
- Never kill a process you did not start, for any reason, including clearing a lock.
- Never run a build, or any other write step, inside a worktree you did not create for this run.

None of this produces a severity field on its own — assigning severity is still your job. For **every** finding, classify it against `review-standards` section 3 (medium-or-above = wrong behaviour a user or the data can reach; low = the correctness of the code's *description* rather than of the code), and **state the severity explicitly** in the comment you post and in your step 6 report. The entire round-2+ gate keys on that value. A finding whose severity nobody wrote down is the gate not running — if you cannot classify one, it counts as medium-or-above until someone does.

A false claim that lives only in a review-thread comment (an issue or inline comment that is not a round marker) is not a finding for this step's gate: classify it as such and write nothing yet. Step 5 makes the correction after the verdict, as `review-standards` section 3 ("A false claim in a review-thread comment") defines, which also lists the artefacts that still block.

This repo has four defect families that produced most of its historical review churn, and sweeping for the **class** costs one round while repeatedly replacing several. This section defines the four families; it is not a separate pass that runs after step 4 — step 4 already requires every one of its six finder angles to check against all four and name them in its report ("named per angle" in step 4's own text). Load the definitions once, before starting step 4:

*[A command or template kept verbatim in SKILL.md stood here.]*

Read section 2 of that skill. The four families, applied within each of step 4's angles rather than as a seventh pass of their own:

1. **A comment claims a guarantee the code does not make** — a guard that cannot fire, a type constraint that does not constrain, a measured figure covering one code path of four, a doc line contradicting the table below it.
2. **A check compares the wrong two things** — a request-derived value against configuration, two columns written by the same author, or the NaN variant where a comparison returns `false` for unparseable input and so fails open.
3. **An assertion that cannot fail** — the test is: *for each assertion, what weaker implementation would still pass it, and could the needle ever actually be absent?*
4. **Sibling-omission** — a fix applied to only one of several parallel structures (two audience-specific projections, two directions of a check, two response paths, two fields that must move together), leaving the untouched sibling with the exact bug just removed from its pair. The check: for every field, guard, or response path touched, ask whether the same shape exists elsewhere in the diff or the codebase, and confirm both were checked.

This sweep is **required, not advisory**, on every round, and it is not a substitute for step 4's angles — it runs inside each of them. Anything it finds is a finding like any other and feeds step 5 at its own severity.

**Report having checked each family, by name, in your step 6 report and in any PR comment you post** — including when a family turned up nothing ("Family 3 (assertion that cannot fail): checked, nothing found"). A silent skip is what this requirement exists to make visible: a report that does not name all four did not do the sweep.
