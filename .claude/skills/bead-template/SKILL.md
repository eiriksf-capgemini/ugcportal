---
name: bead-template
description: Create or audit a bd (beads) issue against this repo's required requirements template — a user-story description, K-numbered Given/When/Then acceptance criteria plus a "following should never happen" guardrail criterion, each with a concrete Verified-by clause, and cc_type/cc_scope metadata. Use whenever creating a new bead, reviewing one for quality, or auditing the backlog for beads that drifted from this form.
---

# Bead Requirements Template (ugcportal)

This is the **required form** for every bd issue in this repo, whether written by a human or an agent. It's not a style suggestion — beads missing pieces of it should be fixed, not left as-is. This template predates most of this repo's history (nearly every bead already followed the description/acceptance-criteria shape below); this skill formalizes it and adds the `cc_type`/`cc_scope` layer from CLAUDE.md's Conventional Commits policy.

## The template

**Description** — a user story: `As a <role>, I want <capability>, so that <benefit>.`

**Acceptance criteria** — numbered `K1`, `K2`, ... Every bead needs **at least one positive criterion and at least one negative/guardrail criterion**:

- Positive: `K<n>: Given <precondition>, when <action>, <observable outcome>.` followed on the next line by `Verified by: <concrete, checkable method>` — a test, a manual check, a command, a linked review doc. Never leave this vague ("verified by review") when a concrete check is possible.
- Negative/guardrail: `K<n>: Following should never happen: <bad outcome>.` followed by its own `Verified by: <concrete method>`.

**Metadata** (`bd update <id> --set-metadata key=value`), set at creation time:
- `cc_type` — one of `feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert` (see CLAUDE.md > "Conventional Commits & Release Notes" for the full type→semver mapping — this skill doesn't repeat that table, it's the source of truth).
- `cc_scope` — short kebab-case area of the codebase (`auth`, `gallery`, `storage`, `ci`, ...).

Set later, as they happen (not required at creation):
- `prs` — comma-separated `gh-N` tokens for every PR that ships this bead (can grow over time — a bead can have more than one).
- `released_in` — set by the `cut-release` skill once included in a release; never set this by hand.

## Worked example

```
Description:
As an admin, I want a revenue dashboard showing income broken down by
image/account, so that I can track platform earnings.

Acceptance criteria:
K1: Given completed orders exist (f3a), when an admin views the dashboard,
income totals are shown correctly broken down by media item and by
connected account.
Verified by: test comparing dashboard totals against seeded order data.

K2: Following should never happen: a non-admin user accessing the revenue
dashboard.
Verified by: test asserting 403 for non-admin session.

Metadata: cc_type=feat, cc_scope=revenue
```

## Creating a new bead

```bash
bd create --title="..." \
  --description="As a <role>, I want <capability>, so that <benefit>." \
  --type=<bug|feature|task|epic|chore|...> --priority=<0-4> \
  --acceptance="K1: Given ..., when ..., <outcome>.
Verified by: <method>.

K2: Following should never happen: <bad outcome>.
Verified by: <method>."

bd update <new-id> --set-metadata cc_type=<type> --set-metadata cc_scope=<scope>
```

If a bead is genuinely not a code change (a pure review/decision gate, e.g. a security or architecture review), the criteria still apply — the "outcome" is the review being documented and its findings resolved, and "Verified by" points at the review doc/notes/`--external-ref`, not a test. See `ugcportal-5x8` or `ugcportal-rma` for real examples of this shape applied to review work.

## Auditing existing beads

Run this whenever you suspect drift (a bead created outside this skill, an old bead predating the policy, or after a bulk import). `bd lint` only checks that an "Acceptance Criteria" *section* exists — it does not check for the negative criterion, the Verified-by clauses, or the metadata, so it is not sufficient on its own:

```bash
for s in open in_progress blocked deferred closed; do bd list --status=$s --json; done | python3 -c "
import json, sys
buf = sys.stdin.read()
objs, depth, start = [], 0, None
for i, c in enumerate(buf):
    if c == '[' and depth == 0: start = i; depth = 1
    elif c == '[': depth += 1
    elif c == ']':
        depth -= 1
        if depth == 0: objs.append(json.loads(buf[start:i+1]))
seen, all_issues = set(), []
for o in objs:
    for d in o:
        if d['id'] not in seen: seen.add(d['id']); all_issues.append(d)

no_verified, no_negative, missing_meta = [], [], []
for d in all_issues:
    ac = d.get('acceptance_criteria') or ''
    if 'Verified by' not in ac or not ac.strip(): no_verified.append(d['id'])
    if 'should never happen' not in ac: no_negative.append(d['id'])
    m = d.get('metadata', {})
    if not m.get('cc_type') or not m.get('cc_scope'): missing_meta.append(d['id'])

print('total:', len(all_issues))
print('missing Verified-by:', no_verified)
print('missing negative criterion:', no_negative)
print('missing cc_type/cc_scope:', missing_meta)
"
```

For anything the audit flags: fix the bead directly with `bd update <id> --acceptance="..."` / `--set-metadata ...` rather than opening a separate cleanup bead — this is metadata/documentation hygiene, not a code change, so it doesn't need its own PR.

## Report back

After creating or auditing, state plainly what's now compliant and what (if anything) still needs a human call — e.g. a review-type bead where you can't write the "Verified by" yourself because the review hasn't happened yet.
