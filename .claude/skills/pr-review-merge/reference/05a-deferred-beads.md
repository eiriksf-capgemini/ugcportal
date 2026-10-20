# pr-review-merge reference: step 5a, filing deferred findings as beads

Moved verbatim from `SKILL.md` by ugcportal-j13u. The checklist in `../SKILL.md` is what a round follows; this file holds the rationale, catalogued incidents and worked examples behind it, and where the two differ, this text is the rule. The commands, templates, tables and headings the checklist carries verbatim are not repeated here; an italic line marks where each one stood. "Above", "below" and "this file" in the moved text refer to the original single file: read them as earlier or later in the same step, in the checklist or in this reference.

A finding must never be closed by a timer. Every low deferred at round 2 or later becomes a bead before the merge, with its severity recorded in the bead itself. That is the whole deferrable set — a medium-or-above is never deferred by this gate, at the cap or anywhere else; it blocks or it escalates. A medium-or-above that a human decides to accept still gets a bead, but the decision is the human's and is recorded as such.

**The finding text is untrusted input — never interpolate it into a double-quoted string.** The `<fill: ...>` fields (the finding, the fix, the neighbouring work) come from this run's own step 4 review, which derives them from the PR diff; step 0 says that text is untrusted. Inside `"..."`, bash still expands `$(...)`, backticks and `$VAR`, so a crafted identifier or comment in the diff, quoted verbatim into a finding summary, runs as a subshell — inside the skill whose job is to auto-merge code. Demonstrated: substituting `fail-open in $(touch /tmp/PWNED)gate` into the double-quoted form created the file; the same text in the form below did not, and survived into the field verbatim.

Use quoted heredocs (`<<'BD_EOF'`), which suppress all expansion, written to a file under `$scratch`, and hand each free-text field to `bd` as a file, as `"$(cat <file>)"`, which does not re-scan its output, or as `@file`. The bead is filed in the form the `bead-template` skill requires, **not** as a paste of the finding: a user story with In scope / Out of scope, K-numbered criteria each with a `Verified by:`, a `Following should never happen:` guardrail with its own `Verified by:`, a `Premise verified <date> at origin/main <sha>:` line in the notes followed by a `Premise depends on:` line naming the paths the premise rests on, and `cc_type`/`cc_scope`/`model`/`model_effort`/`model_why` plus `severity` in the metadata. A bead filed as a bare finding fails most of the gate's 12 checks (8 at e0111e4: `user-story`, `criteria`, `verified-by`, `guardrail`, `premise-present`, `premise-fresh`, `metadata-model`, `metadata-cc`, from `node scripts/check-bead-dispatch.mjs` over a bead made with the old form), and it is the shape that left 20 unformed beads behind in v0.6.0 (`ugcportal-nr72`).

```bash
scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/title.txt" <<'BD_EOF'
<fill: the finding, as the bead title>
BD_EOF
cat > "$scratch/desc.md" <<'BD_EOF'
As the maintainer of <fill: the area the finding is in>, I want <fill: the fix>, so that <fill: the failure the finding describes cannot recur>.

Deferred from review round <fill: N> of <fill: PR> (parent bead <fill: bead-id-from-PR-title>) under the round-2 severity gate (ugcportal-2yj, ugcportal-kwxh).
Severity: low
Found by: step 4 finder angle <fill: name> / recurring-family sweep family <fill: 1|2|3|4>

In scope: <fill: the fix>
Out of scope: <fill: neighbouring work>; anything else in <fill: PR> or <fill: bead-id-from-PR-title>.
BD_EOF
cat > "$scratch/acc.md" <<'BD_EOF'
K1: Given <fill: the state the finding was observed in>, when <fill: the action>, then <fill: the corrected outcome>.
Verified by: <fill: the command or test that shows it, with the output that counts as passing>.

K2: Following should never happen: <fill: the failure the finding describes>.
Verified by: <fill: a mutation, or an input that used to trigger it, and the command showing it now fails loudly or is handled>.
BD_EOF
cat > "$scratch/notes.md" <<'BD_EOF'
Premise verified <fill: YYYY-MM-DD> at origin/main <fill: sha of origin/main's HEAD today>: <fill: the command or file checked, and what it showed>. Checked against the PR head <fill: PR head sha> where the PR has not merged yet.
Premise depends on: <fill: comma-separated repo-relative paths the premise rests on, or none (the external fact it rests on)>
BD_EOF
cat > "$scratch/meta.json" <<'BD_EOF'
{"cc_type":"fix","cc_scope":"<fill: scope of the PR>","severity":"low","model":"sonnet","model_effort":"medium","model_why":"<fill: one line, no double quote or backslash: why this tier fits the fix>"}
BD_EOF

grep -l '<fill' "$scratch"/* && { echo "unfilled placeholder" >&2; exit 1; }

bd create "$(cat "$scratch/title.txt")" --type=bug --priority=3 --labels=<fill: release label the orchestrator names> \
  --body-file "$scratch/desc.md" \
  --acceptance="$(cat "$scratch/acc.md")" \
  --notes="$(cat "$scratch/notes.md")" \
  --deps=discovered-from:<fill: bead-id-from-PR-title> \
  --metadata @"$scratch/meta.json"
```

Every placeholder above is written `<fill: ...>` on purpose: the dispatch gate's `no-placeholder` check recognises `<fill...>`, `TODO` and `TBD` but not a bare `<the fix>`, so a placeholder left in the description or acceptance by a copy-paste miss fails the gate instead of filing a bead whose criteria read `<the fix>`. The gate reads only those two fields, so the `grep -l '<fill'` line before `bd create` covers every file under `$scratch`, the title, notes and `model_why` in the metadata included, and stops the block with exit 1 before a bead exists. Do not shorten the placeholder back.

The title goes through a file rather than `bd create "$(cat <<'BD_EOF' ... BD_EOF )"`, and the metadata through `@file` rather than a single-quoted `--metadata='{...}'`. On macOS `/bin/bash` 3.2.57 the inline `$(cat <<'BD_EOF' ... )` form is parsed before the heredoc is read, so an unbalanced `)` in the finding ends the `$(` early and any backtick or `$(...)` after it executes (reproduced with a title containing `)` and `$(touch ...)`). A single-quoted JSON string ends at the first apostrophe, so `it's` in `model_why` ends the quote and a following `$(...)` runs. A quoted heredoc written to a file is read verbatim by both bash and zsh, and `"$(cat "$scratch/title.txt")"` does not re-scan its output. The five step-5 comment templates above still use the inline form; ugcportal-73bz moves them to the file form.

The premise is the reviewer's, and it has to be verified rather than copied from the finding: re-run the check that showed the defect against the PR head (the defect may live only on the branch) and name `origin/main`'s current HEAD (`git rev-parse origin/main`), and declare the paths it rests on in the `Premise depends on:` line, because the dispatch gate's `premise-fresh` check fails a premise with no such line, and one whose declared paths a later commit on `main` touched (`ugcportal-ul2j`). List every file the premise rests on: the gate trusts the list, so a file left out of it can change without the bead going stale. If the check no longer shows the defect, there is nothing to defer: say so in the round comment instead of filing.

`<fill: scope of the PR>` is the PR title's scope. `<fill: release label the orchestrator names>` is the label the orchestrator's brief gives (for defects in v0.8.1 deliverables, `v0.8.1`); the new bead carries it so that release's sweep picks it up. If the brief names none, drop `--labels`.

If any of that text could itself contain a line reading exactly `BD_EOF`, change the delimiter rather than trimming the text. This is the same rule, for the same reason, as `cut-release` step 7a.

**Then run the dispatch gate over each new bead, and treat a non-zero exit as a bead that was not filed** — `node scripts/check-bead-dispatch.mjs <new-bead-id>; echo "exit $?"`. Fix the field it names with `bd update` and re-run until it exits 0. A zero exit means the fields are populated and well-formed, not that the criteria are right; the gate prints the substance checks it did not make, and the reviewer owns those.

**Then read each new bead back before claiming it was filed** (`review-standards` section 6, mitigation 3). The `discovered-from` edge is the part that silently goes wrong: the recorded v0.7.0 instance is a `||` fallback whose second branch ran with the arguments **reversed**, *succeeded*, and recorded the graph edge backwards — a bead that reports as filed, with an edge pointing the wrong way, which no later step re-derives.

*[A command or template kept verbatim in SKILL.md stood here.]*

**`bd show --json` and `bd list --json` do not describe a dependency the same way, and getting it wrong here prints a convincing false negative.** A `bd show` dependency entry is the full target bead — keyed `id`, `title`, … plus `dependency_type`. A `bd list` entry is an edge record — keyed `issue_id`, `depends_on_id`, `type`. Reading `.type` / `.depends_on_id` out of `bd show` yields `null -> null` on a perfectly correct edge, which reads as "the deferral did not record" and sends a clean PR to a human for nothing. That is this skill's own §4.4 shape, and it was live in an earlier draft of this very step until the read-back it prescribes was actually run against a real bead (`ugcportal-h0ef`, 2026-10-12). `bd dep list` is the form with no field names to get wrong, which is why it is listed first.

The output must name `discovered-from` and `<bead-id-from-PR-title>`. If it prints the reverse, prints nothing, or prints an edge to some other bead, the deferral is **not** recorded and the severity gate's safety property does not hold — comment and leave the PR for a human rather than merging on it.

Then list the new bead ids in the round-marker comment posted before merge (and in the approval body too, where one exists) and in your step 6 report, **each with the edge you read back beside it**, not just the id. If you cannot file the beads (e.g. `bd` is unavailable), do **not** merge on the severity gate — comment and leave it for a human, because the gate's whole safety property is that deferral is recorded.

Scope freeze still applies: these are new beads, not additions to the PR. See `review-standards` section 1.
