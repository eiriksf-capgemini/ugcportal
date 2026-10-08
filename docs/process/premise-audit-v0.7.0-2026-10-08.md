# Premise audit of the v0.7.0 line-up (2026-10-08)

Bead: `ugcportal-j5fl`. Audited against `main` at **54d88ca** (the v0.6.0 release
plus two process-doc commits).

This is the gate the line-up sits behind: *"Re-verify the premise of every bead in
the v0.7.0 line-up against current main before any of it is picked up."*

## 1. Why this runs at all

The method is load-bearing, not hygiene. `bd` memory
`who-may-have-an-account-was-never-owned-by-any-bead` records that every auth gate
in this repo was individually correct and individually reviewed, and the system
still allowed any Google or Facebook account on the internet to sign in, upload and
publish to the public gallery. No bead owned the question *who may have an account
at all*. That defect is invisible in any single diff, so no amount of per-PR review
depth could have found it. What found it was auditing a bead's premises against the
running code.

So this audit asks two questions of every bead, not one:

1. **Is its premise still true at 54d88ca?** — the staleness question.
2. **What does it assume someone else has already answered?** — the ownership
   question, which is the one per-PR review structurally cannot ask.

### Staleness is measured, not assumed

Before this audit, of the 136 non-closed beads only 68 (50%) carried a
`Premise verified:` line at all, and every one of those was verified against `main`
at `1c022bc` during the 2026-10-06 backlog review. `git rev-list --count 1c022bc..HEAD`
is 80 — so each was up to 80 commits stale, across a release that shipped 85 beads.

### The failure mode this audit must not reproduce

`ugcportal-ytai` was filed on 2026-10-08 from a `bd` memory *without* checking the
current skill file, and had to be closed immediately as already-solved: PR #155 had
already landed the fix. K3 of `j5fl` encodes the lesson — a premise recorded on the
strength of reading the bead, trusting another agent's report, or reading a stale
document is a failed check. Every verdict below names a command that was run or a
file and line that was read.

## 2. Scope

58 beads: everything labelled `v0.7.0` and not closed, excluding `j5fl` itself.
Two labelled beads (`ugcportal-7dtn`, `ugcportal-ytai`) are already closed and are
out of scope.

| Priority | Beads |
|---|---|
| P1 | 12 |
| P2 | 22 |
| P3 | 14 |
| P4 | 10 |
| **Total** | **58** |

Audited by nine read-only agents batched by domain, each forbidden from mutating the
shared checkout, running the suite, or touching a bead outside its batch. Rights,
commerce and security batches ran on Opus; theme, process and tooling batches on
Sonnet.

Coverage check: only four open or in-progress P1–P2 beads sit outside the line-up —
`ugcportal-mbq`, `ugcportal-ncp` and `ugcportal-ybv` (all in-progress platform-gitops
infrastructure, tracked elsewhere) and `ugcportal-p7x7`. See §4.

## 3. Line-up integrity: the dependency graph

Checked independently of the per-bead premises, over all 364 beads, counting only
hard `blocks`/`depends-on` edges and ignoring `discovered-from` and `parent-child`.

**There are no dependency cycles.**

### 3.1 Seven beads are gated behind deferred work

Of the 58 beads, **51 are buildable within the line-up** and **7 are blocked by beads
that are not in the line-up**. Every one of those external blockers is itself
`deferred` — except `ugcportal-mbq`, which is in progress on the infrastructure
track. Deferred work is not scheduled, so as the graph stands these seven cannot
ship in v0.7.0:

| Blocked bead | | Blocked by (all deferred unless noted) |
|---|---|---|
| `ugcportal-5x8` | P2 Security review of the application | `5ce` Instagram OAuth, `p3v` Stripe checkout, `yck` GDPR retention, `aj2` revenue dashboard, `5d6` fulfilment |
| `ugcportal-rma` | P2 Architecture review of the application | `aj2` revenue dashboard, `9w0` Umami, `ct0` Instagram sync, plus `74w` (in line-up) |
| `ugcportal-qnq9.5` | P2 Notice-and-action objection route | `9w5` rate limiting, plus `ryd` (in line-up) |
| `ugcportal-smk` | P2 In-flight upload queue hidden on navigate | `2u9` POST /api/media aborts and idempotency |
| `ugcportal-ilp` | P3 Re-home GDPR erasure ownership | `yck` GDPR retention |
| `ugcportal-xbdd` | P3 Deploy procedure for index-rebuilding migrations | `2v5` VPS provisioning, `mbq` (in progress) |
| `ugcportal-0tg` | P4 Reproduce or retract watermark concurrency claims | `68r` production image / sharp musl |

The two umbrella review beads are the sharpest case. `5x8` ("Security review of the
application") waits on five deferred beads including Instagram OAuth — a surface the
project deliberately pivoted away from. A security review of what exists today does
not depend on a feature nobody intends to build. The same reading applies to `rma`.
These are candidates for having their dependencies cut rather than their scope
deferred; that is a decision for Eirik, recorded in §6, not something this audit
changes.

### 3.2 The buildable 51, in dependency order

Three waves. Wave 1 can start immediately and in parallel; each later wave needs its
predecessors merged.

**Wave 1 — 40 beads, no in-line-up blockers.**
P1: `321`, `74w`, `aqw`, `fuv2`, `nr72`, `uo15`, `yzmp`.
P2: `3epy`, `5gii`, `62b6`, `6uxv`, `8h3y`, `a9no`, `bc04`, `hx2`, `i2q`, `jain`,
`pc7s`, `qnq9.11`, `ryd`, `uv9`.
P3: `0dh5`, `577s`, `co9g`, `gdi0`, `i40s`, `i7lr`, `mftd`, `qnq9.13`, `uwh1`, `zo8n`.
P4: `7ajb`, `gdn3`, `hhjq`, `n9rc`, `ocbo`, `pvjn`, `rj7y`, `ry6w`, `vl32`.

**Wave 2 — 7 beads.**
`15r` (needs `74w`), `6uc2` (needs `uo15`), `fw5` (needs `i2q`), `cv8` (needs `ryd`),
`gq5b` (needs `nr72`), `1j4j` (needs `pc7s`, `gdi0`, `fuv2`), `q8ic` (needs `rj7y`).

**Wave 3 — 4 beads.**
`3ae` (needs `15r`), `paa` (needs `fw5`), `a3hj` (needs `6uc2`, `uo15`),
`dmne` (needs `6uc2`).

Two critical paths run three deep and both are P1 rights work:
`74w -> 15r -> 3ae` and `i2q -> fw5 -> paa`. Neither can be compressed by adding
agents, so both should start in wave 1 rather than being scheduled by priority
number alongside the P4s.

## 4. Verdicts

`HOLDS` = premise still true. `CHANGED` = no longer true; bead labelled
`review-required`, description left for its owner to correct per K2.
`UNVERIFIABLE` = the premise is about something outside the repo; the code-side
half, where there is one, was still checked.

Three beads (`321`, `3ae`, `i2q`) already carried `review-required` from the
2026-10-06 backlog review. This audit newly applied it to six: `qnq9.11`, `hhjq`,
`n9rc`, `pc7s`, `5x8`, `rma`.

### 4.1 Rights and clearance

| Bead | Verdict | Evidence |
|---|---|---|
| `15r` | HOLDS | `grep -rni attestation src prisma` → zero code/schema hits; no `MediaAttestation` model; `api/media/route.ts:668-690` writes nothing rights-related |
| `3ae` | **CHANGED** | Gap intact (`publish/route.ts:29-37` "a visibility switch and nothing else"), but `PUBLIC_MEDIA_SCOPE` has **five** readers, not the three K3 names: `public-media.ts:176`, `portfolio.ts:150`, `sitemap.ts:103`, `media-item.ts:54` |
| `paa` | HOLDS | `resale-rights.ts:733` `if (review.validUntil) {` — null skips expiry; `REVIEW_GATE_SELECT:222-228` has no evidence or `clearedAt` column; no `MAX_CLEARANCE_DAYS` |
| `aqw` | HOLDS | `grep -n createdAt src/lib/resale-rights.ts` → **zero hits in the whole module**; no `coversUploadsBefore` in schema |
| `fw5` | HOLDS | `manual-upload-rights-review.md:245-259` §8 every row unanswered; `resale-rights.ts:68` still `CURRENT_CHECKLIST_VERSION = "2026-09-27.1"` |
| `i2q` | HOLDS | `docs/legal/instagram-resale-rights-checklist.md:12` names A.1/A.4/A.5/A.7 as `Required: Yes` and concludes such an uploader "cannot be cleared"; `docs/legal/manual-upload-rights-review.md:117` cites `src/app/api/media/[id]/publish/route.ts:53-140` in a 426-line file whose write is at `:312-326` |
| `cv8` | HOLDS | No `TermsAcceptance` model; `OWN_TERMS_ACCEPTANCE` is rendered as a bare `<option>` at `decision-form.tsx:132-134` but appears in no gate — selectable, gates nothing |
| `hx2` | HOLDS | `MediaRightsClearance.reason` is free text, no `basis`; zero `ffmpeg`/`transcode` anywhere; sold object still the raw upload (`api/media/route.ts:517` → `:622`) |
| `uv9` | HOLDS | `selfReview` exists only at `resale-rights-review.ts:249` and `page.tsx:322`; `triagedByUserId:628` and `clearedByUserId:330` are read for **role only**, never compared to `Media.userId` |
| `ryd` | UNVERIFIABLE | `docs/legal/` holds only the two agent-prepared files; Q1–Q8 at `:230-243` have no answer, date or counsel named. Owner: Eirik |
| `qnq9.5` | HOLDS | 14 API routes, none an objection path; DELETE writes `publishedAt: null` with no event row, reason or acting admin |
| `ilp` | HOLDS | `schema.prisma:486` cites `ugcportal-x1a` → `bd show` returns not found; `:741` cites `ugcportal-69p` → DEFERRED to 2027-03-01 |

### 4.2 Curation, commerce and disclosure

| Bead | Verdict | Evidence |
|---|---|---|
| `74w` | HOLDS | All 7 `mediaListing.create\|upsert` hits are `.test.ts`; `mediaRightsClearance.` has no non-test writer; sole `MediaListing` writer is `price/route.ts:162` |
| `jain` | HOLDS | Withdrawal calls `upsertDisclosure(... label: null)`; the string `commercialLink` does not occur in `disclosure/route.ts`; publish selects no links relation |
| `6uxv` | HOLDS | Every non-test `depictsAlcohol` hit is a `select` or read predicate — there is no write path to guard yet |
| `qnq9.11` | **CHANGED** | Recorded as "no `depictsAlcohol` column, no commercial marker"; both now exist (`schema.prisma:813`, `gallery-items.ts:186,480`) and qnq9.1/.2/.3 are closed. The display gap itself persists (`gallery.tsx:493` one flat `<ul>`) |
| `qnq9.13` | UNVERIFIABLE | No `Order` model, no threshold constants. The decision is Eirik's own tax call |
| `smk` | HOLDS | `drainQueue`'s `.finally()` resets refs only; exactly two `useEffect`s, neither a teardown; no `beforeunload`/`sessionStorage` in `src/app/upload` |

### 4.3 Security and dependencies

| Bead | Verdict | Evidence |
|---|---|---|
| `fuv2` | HOLDS | `next` critical, `fixAvailable {16.4.0, isSemVerMajor: false}`; `sharp@0.35.4` high, latest 0.35.5 |
| `5gii` | HOLDS | `live-session.ts` returns the session unchanged when permitted; only `refusedSession` narrows. Its own comment: *"the whole `Session` row the Prisma adapter read, `sessionToken` included"* |
| `pc7s` | **CHANGED** | **False premise.** `globals.css:125` is `@import "shadcn/tailwind.css";` — resolving to a real 16041-byte stylesheet that `app-shell.test.tsx` compiles. Removal as scoped fails the build *and* the suite |
| `gdi0` | HOLDS | `vitest@3.2.7`; `fixAvailable {5.0.3, isSemVerMajor: true}`; tinypool critical (prototype-pollution gadget to RCE). jsdom deferral still correct: `ci.yml:115` is Node 20 |
| `1j4j` | HOLDS | `grep -rn audit .github/workflows/` → zero matches; `npm audit` exits 1 with 19 advisories |
| `5x8` | **CHANGED** | Five of nine dependencies deferred to 2027-03-01; no Stripe in the repo at all; yet `sign-in-policy.ts` and `live-session.ts` — added after the bead — are in neither its scope nor `rma`'s |
| `rma` | **CHANGED** | Its stated gate is unreachable (deps deferred); `prisma/schema.prisma` has 19 commits since 2026-09-15 and now carries 16 models and 7 enums, the whole rights half postdating the bead |

**Advisory snapshot at 54d88ca** — `npm audit`, exit 1: 19 vulnerabilities
(3 critical, 15 high, 1 moderate). Criticals are `next`, `tinypool`, `vitest`;
the single moderate is `@vitest/mocker`.

### 4.4 Theme and accessibility

| Bead | Verdict | Evidence |
|---|---|---|
| `uo15` | HOLDS | `globals.css:247` `--petrol-200: #9fc5c8;` vs `:318` `--color-petrol-200: oklch(0.9 0.045 205);` |
| `6uc2` | HOLDS | `:494` comment "until fase 2 … is approved"; `--border`/`--input`/`--card`/`--muted` still on the near-black scale |
| `a3hj` | UNVERIFIABLE (code-side holds) | `hero.tsx:146` still `h-28 w-28 sm:h-40 sm:w-40`; `:87` `HERO_VISUAL_FALLBACK_CLASS = "bg-petrol-200"`. The "reads as broken" claim needs a render |
| `dmne` | HOLDS | `grep -rn terracotta src/` → four definitions at `globals.css:249-252` and one test comment. Zero consumers |
| `0dh5` | UNVERIFIABLE (precondition holds) | No custom not-found page exists; `rights/page.tsx:1` calls `notFound()`. The axe re-run needs e2e |
| `i7lr` | HOLDS | `site-header.tsx:152` `<nav aria-label="Main navigation">` plus `upload-nav-link.tsx:61` `<nav aria-label="Primary">` wrapping only the Upload link |

### 4.5 Deferred review lows (P4)

| Bead | Verdict | Evidence |
|---|---|---|
| `7ajb` | HOLDS | `page.tsx:173` `rounded-md` vs `containment.ts:87` `GALLERY_RADIUS_CLASS = "rounded-lg"` |
| `gdn3` | HOLDS | `button.tsx:331` caps `sm` at `rounded-[min(var(--radius-md),12px)]`; `:337` `header-sm` is uncapped |
| `hhjq` | **CHANGED** | `size="header-sm"` now has **four** call sites, not one: `auth-status.tsx:97` and `sign-in-menu.tsx:59,78,83`. `sign-in-menu.tsx` arrived in PR #171, after the bead was filed |
| `n9rc` | **CHANGED — already fixed** | PR #170 (`99e264b`, ugcportal-oavb) moved the disclosure into `button.tsx:143-169`; both call sites now read "No override needed here any more" |
| `ocbo` | HOLDS | `hero.tsx:321` `buttonVariants({ variant: "default-tint", size: "lg" })` with no `w-fit` anywhere |
| `pvjn` | HOLDS | `button.tsx:85` `PETROL_OUTLINE_STYLE` carries `border-primary` and `hover:underline`; `empty-state.tsx:113-134` never mentions either |
| `rj7y` | HOLDS | The existing script is self-described as a narrow "rerunnable stand-in" keyed to `group-hover` and `scale` |
| `ry6w` | UNVERIFIABLE | `min-w-12 shrink-[999]` and `min-w-0 truncate` are present; no 390px assertion exists anywhere |

### 4.6 Process and review

| Bead | Verdict | Evidence |
|---|---|---|
| `nr72` | HOLDS | `pr-review-merge/SKILL.md:654-665` — the `bd create` body is `Severity:/Found by:/In scope:/Out of scope:`, with no K-numbers, no Verified-by, no model metadata |
| `yzmp` | HOLDS | Repo-wide grep for `concurren`, `cap.*agent`, `ListAgents` → zero hits anywhere |
| `3epy` | HOLDS | No `shape budget` or `tokens_qa_r1` logic in the skill or `release-cost-report.mjs` |
| `62b6` | UNVERIFIABLE | `pr-review-merge/SKILL.md:250,260` unchanged. Needs Eirik to create a bot account |
| `8h3y` | HOLDS | `pr-review-merge/SKILL.md` contains no model-tier spawn language at all |
| `a9no` | HOLDS | `:607-612` is prose only; the template has no `Severity:` field. `release-cost-report.mjs:958-984` lumps unstated severities into one "Data gaps" bullet |
| `bc04` | HOLDS | No `tokens_impl_passes` or `B2` logic in any skill file |
| `gq5b` | HOLDS | All 12 named beads still open; its dependency `nr72` unimplemented |
| `mftd` | HOLDS | `git grep "brief"` across `.claude/skills/` and `CLAUDE.md` → no real hits |
| `co9g` | HOLDS | `pr-review-merge/SKILL.md:91-102` sensitive-path list omits `docs/process` |
| `vl32` | HOLDS | `retro_source` appears 0 times in `CLAUDE.md`; the key is live on three beads and documented only in `cut-release/SKILL.md` |

## 5. Ownership gaps

This is the half of the audit that per-PR review structurally cannot produce. Each
item below is a question that **no bead owns**, found by asking of every bead: what
does this assume someone else has already answered?

None of these are filed as beads by this audit — that is a dispatch decision for
Eirik (§6).

### 5.1 The egp pattern, reproduced three times over

`bd` memory `who-may-have-an-account-was-never-owned-by-any-bead` names the shape:
three beads each correctly gated their own surface, and nobody owned *who may have
an account at all*. The same shape is present now in three places.

**G1. Who may *publish* at all.** `3ae` gates publishing on attestation plus a
PEOPLE clearance. `15r`, `paa` and `aqw` all supply conditions. Not one of them
states the prior decision: given that publishing makes ugcportal *"the first and
only publisher, and the controller"*, is self-service publish by any signed-in
account the right model, or does publication need an admin release step? Four beads
assume this was decided. Nothing records a decision.

**G2. Who is allowed to *sell* at all.** The sellability gate is keyed per-uploader
to a `ResaleRightsReview`. `p3v` is explicitly single-seller. So any signed-in
uploader granted a clearance becomes a seller, and no bead asks whether that is
intended. `cv8` (creator terms) and `15r` (per-upload attestation) each own a piece
of the mechanism; neither owns the question.

**G3. Who may validly *grant* the licence.** `cv8` builds an acceptance record,
`15r` an attestation — neither owns whether the person clicking has the legal
capacity to grant anything. The `User` model has no date of birth, and the rights
review says plainly *"nothing verifies it and nothing stores it."* `ryd` Q1 asks
counsel; `ryd` is `stalled-on-human`.

### 5.2 Nothing owns the state *after* the gate passes

**G4. An already-published row that later becomes non-compliant.** A clearance
expires or a checklist version retires — and the row stays public on all five
`PUBLIC_MEDIA_SCOPE` surfaces, because that scope never consults the gate at read
time. `3ae`'s K3 covers rows published *before* it lands; `qnq9.5` covers
third-party objections. The gate-side lapse case is unowned.

**G5. An already-*sold* item whose clearance later lapses.** `74w` K5 covers render;
`p3v` K3 covers checkout; `5d6`'s only stated gate is a valid Order row, and it
never re-evaluates `isSellable()`. After the webhook lands, a revoked or expired
clearance has no effect on an issued or re-issued download URL. `p3v`'s own notes
see the risk and state it as prose, not as a criterion on any bead. `paa` and `aqw`
both make lapse *more likely* without saying what a lapse does to a completed sale.

**G6. Owner-initiated disclosure withdrawal.** `jain` owns the data pair. The
question *"an item lawfully published as advertising stops being one — does it stay
public?"* is deflected by the disclosure route to `qnq9.5`, which is scoped to
third-party objections, not the owner's own withdrawal.

### 5.3 The review beads do not cover what shipped

**G7. The control added in response to egp is itself unreviewed.**
`src/lib/sign-in-policy.ts` and `src/lib/live-session.ts` — the allowlist and
per-request revocation added at `5db5626` precisely because of ugcportal-egp —
appear in neither `5x8`'s scope nor `rma`'s. The one control the memory says went
unowned is still not owned by the beads nominally covering security and
architecture.

**G8. The anonymous public surface has no review owner.** `/api/public/media` and
`/media/[previewId]` serve unauthenticated visitors. `5x8`'s scope is entirely
authenticated paths, while `fuv2`'s SSRF rationale leans on that surface existing.

**G9. The whole rights and disclosure system has no review owner.** Nine models and
six API routes shipped across v0.4.0–v0.6.0. Both review beads predate all of it.
The alcohol gate and the minors flag are legal-consequence controls with no review
owner.

### 5.4 Process gaps

**G10. Is a deferred bead a live owner?** `ilp`'s K2 requires exactly one *live*
bead to own evidence purge, and points at `yck` — which is itself DEFERRED. Closing
`ilp` as written re-creates the very defect it exists to remove, one hop further
out.

**G11. Nobody owns noticing that a gate became unreachable.** `5x8` and `rma` are
gated on beads deferred to 2027-03-01, so neither can ever reach `bd ready`. No bead
owns detecting that.

**G12. `yzmp`'s own rule does not catch this repo's real collisions.** It forbids two
implementers on the same `cc_scope`. But `74w` (`curation`), `jain` (`rights`) and
`6uxv` (`disclosure`) are three *different* scopes all writing
`src/lib/alcohol-commerce.ts` and `src/lib/resale-rights.ts`. The rule as specified
would wave these through. It also assumes an enforcement mechanism — a script that
counts running agents and groups candidates by scope — that does not exist anywhere
in the repo, so K1/K2 can today only be satisfied by prose an orchestrator may skip.

**G13. Who decides a dependency may stay vulnerable?** `1j4j` assumes the sibling
beads drive the count to zero. Nothing owns the standing decision for an advisory
whose only fix is a downgrade. `pc7s`'s deferral register is scoped to majors, not
to accepted advisories.

**G14. No orchestrator or dispatch skill file exists.** `bc04`, `mftd` and `co9g` all
specify behaviour "where the dispatch step reads it". The repo has only
`cut-release`, `harness-cost-controls`, `pr-review-merge`, `pre-review` and
`review-standards`. Whoever implements these is choosing a location, not recording a
decision.

**G15. A published commitment with nobody behind it.** `/licence` already promises
*"An item can be taken out of the public gallery by its uploader at once while the
question is looked at."* `qnq9.5` builds intake and an audit row but no bead owns who
answers, within what time, or to what SLA.

**G16. Separation of duties in a one-person operation.** `uv9`'s K2 second-admin
branch is fixture-only — `src/config/users.ts` grants no roles — so `uv9` would ship
a test that cannot fail against the real deployment. `ryd` Q8 asks counsel the same
question and is stalled.

**G17. No single source of truth for a colour token.** `uo15` fixes one collision;
nothing files a standing guard. Confirm `uo15`'s K3 guard is generic
(`--color-X-Y` vs `--X-Y` for any token) rather than petrol-specific, or the next
pair collides silently. Relatedly, nothing owns the list of surfaces to re-check
when the scale changes.

**G18. What else serialises a Prisma row straight to a client?** `5gii` narrows the
session callback. `MEDIA_ANONYMOUS_SELECT` is a named allowlist for media, with no
equivalent discipline anywhere else.

### 4.7 Tooling, CI and ops

| Bead | Verdict | Evidence |
|---|---|---|
| `321` | UNVERIFIABLE | MinIO is up (`ugcportal-minio-1`, 28h), but `/upload` needs real OAuth: `grep storageState` is empty in both Playwright configs and there is no seed script. Needs a human run |
| `577s` | HOLDS | `release-cost-report.mjs:697` `/sensitive path/i.test(cr)` with no negation — tested live against PR #121's real body ("no sensitive paths touched") and it matched |
| `zo8n` | HOLDS | `classifySeverity()` on PR #121's real body returns `{medium: 121}`; the culprit is the substring `` `121 high --comment` `` — code-review CLI args — matching the summary regex |
| `i40s` | HOLDS | `dev`/`dev:inspect` call `check-migrations.mjs`; `build`/`start` do not. `e2e/production/playwright.config.ts:75` hand-rolls `npx prisma migrate deploy` |
| `uwh1` | HOLDS (config half) | `playwright.config.ts:31` `fullyParallel: true` with no `workers:` key, `webServer.command: "npm run dev"`, against `provider = "sqlite"` |
| `xbdd` | HOLDS | The partial-index migration's only safeguard is a comment; no runbook in `docs/`; deps `2v5` DEFERRED and `mbq` in progress |
| `q8ic` | **CHANGED** | Count nearly doubled: the bead says ~481 occurrences, `grep -rnoE 'round.[0-9]' src/ \| wc -l` → **971** today. Its baseline commit `b634c76` is **not an ancestor of main** |
| `0tg` | **CHANGED** | Claims still verbatim in `watermark.ts`, but the bead's own blocker is gone: `docker info`/`docker ps` now succeed (Docker Desktop 29.8.0), contradicting its "docker info fails (no daemon)" note |

## 6. What this changes for the dispatch

### 6.1 Headline: the audit paid for itself on one bead

`pc7s` would have been dispatched as a tidy dependency removal and would have
failed the build and the test suite, because its central claim — shadcn is unused —
is false. The same false claim was also sitting in persistent memory as standing
advice; it has been corrected there (`npm-audit-fix-force-downgrades-prisma-and-shadcn`),
which is the more valuable half, since memory is read by every future session.

The near-miss is instructive: the original check looked at `globals.css:124`
(`tw-animate-css`) and concluded the neighbourhood was clear. The shadcn import is
line 125. **Checking the neighbouring line is not checking the line.**

### 6.2 Nine beads need their description corrected before anyone builds them

All are labelled `review-required`; per K2 this audit did not rewrite them.

| Bead | What changed | Consequence if dispatched as-is |
|---|---|---|
| `pc7s` | shadcn *is* imported at `globals.css:125` | Breaks the build and the suite |
| `3ae` | `PUBLIC_MEDIA_SCOPE` has 5 readers, K3 names 3 | **Ships an uncleared row's URL to search engines** via `sitemap.ts` |
| `q8ic` | 481 → 971 occurrences; baseline commit not on main | Scope is double; the "195 files" figure needs re-checking too |
| `5x8` | Gate unreachable; scope predates the whole rights half | A security review that never starts, and would miss what shipped |
| `rma` | Same, plus 19 schema commits since it was written | As above |
| `hhjq` | `header-sm` now has 4 call sites, not 1 | Its "one-class override at its single call site" fix no longer fits |
| `n9rc` | **Already fixed** by PR #170 | Wasted build. Candidate to close, not to build |
| `qnq9.11` | Both columns it says are missing now exist | Unblocked and nobody noticed; K2–K4 still assume an option its own description warns against |
| `0tg` | Docker is now available | Its stated blocker is gone; it is startable |

### 6.3 Three beads will stall an implementer on round one

Not premise failures — specification failures, found while reading them closely.

- **`hx2`**: a requested 2026-10-06 revision was never applied. The description
  still reads "EITHER (a) … OR (b)", and K2 is unconstructible under option (a).
- **`cv8`**: its requested re-acceptance criterion (new terms version → re-accept)
  was likewise never added to K1–K3.
- **`jain`**: K2 names `commercialPublishRefusal({ disclosure, listing })` as the
  chokepoint, but that function takes no `commercialLinks` parameter and the publish
  route selects none. **A fix that only mutates the predicate will pass a test that
  cannot fail** — this repo's third recurring defect family, pre-visible in the bead.

`i2q` is a fourth of a different kind: scoped as "two unverifiable lines", it is
really a 32-citation sweep. Of 11 citations spot-checked, exactly one resolves.

### 6.4 Throughput: the line-up cannot be parallelised the way it is sized

Roughly a dozen beads — `3ae`, `paa`, `aqw`, `i2q`, `15r`, `74w`, `uv9`, `hx2`,
`cv8` and more — all converge on `prisma/schema.prisma`, `src/lib/resale-rights.ts`
and `src/app/admin/settings/rights/`, and all are `cc_scope: rights`. Under
`yzmp`'s own rule they must run **serially**. Two specific hazards:

- **`paa` and `aqw` will collide**: both add a nullable column to
  `ResaleRightsReview`, both extend the same two gate selects, both touch
  `decision-form.tsx` and `outcomes.ts`. They need an ordered migration.
- **`74w` / `jain` / `6uxv` will collide and `yzmp` will not catch it**: three
  different `cc_scope` values, same two library files (G12).

`fuv2`, `pc7s` and `gdi0` likewise all edit `package.json`; `1j4j` depends on all
three and `pc7s` now needs re-scoping first, so `1j4j`'s "first green run" is no
longer assured.

### 6.5 Suggested dispatch order

1. **Correct the nine `review-required` descriptions first** (§6.2), and apply the
   never-applied revisions to `hx2` and `cv8` (§6.3). This is cheap and prevents
   round-one stalls.
2. **Decide `n9rc`** — close it rather than build it, if a human confirms PR #170.
3. **Start the two three-deep P1 rights chains immediately**, serialised:
   `74w → 15r → 3ae` and `i2q → fw5 → paa`. They cannot be compressed by adding
   agents, so they set the release's length. Note `fw5` should not ship without
   pulling `c0om` back from v0.8.0, or it ratifies a checklist enumerating four
   triage columns while the gate reads five.
4. **Run the independent clusters in parallel** alongside those chains: the
   dependency cluster (`fuv2` → `gdi0` → re-scoped `pc7s` → `1j4j`), the
   `release-cost-report.mjs` pair (`577s`, `zo8n` — separate functions, one shared
   fixture), and the P4 UI beads batched by file (`button.tsx`: `gdn3`+`hhjq`;
   `hero.tsx`/`empty-state.tsx`: `ocbo`+`pvjn`).
5. **Re-line-up or cut the seven deferred-gated beads** (§3.1) — in particular
   decide whether `5x8` and `rma` keep dependencies on Instagram work the project
   pivoted away from.

### 6.6 For Eirik specifically

These cannot be done by an agent:

- `62b6` needs a second GitHub account or App created and its token handed over.
- `vl32` and `co9g` both terminate in a `CLAUDE.md` edit — agent-edit-denied and
  CI-guarded against bundling. An implementer can only draft exact wording.
- `ryd` needs counsel engaged. Four rights beads assume this sign-off path; §8 of
  the review has an empty "Process owner (name, role)" cell.
- `qnq9.13` is a tax decision, not a code question.
- `321` needs a human to run the upload flow against live MinIO — there is no
  `storageState` and no seed script, so it cannot be automated as scoped.
- The 18 ownership gaps in §5 are dispatch decisions: which become beads, and who
  owns the three egp-shaped questions (G1, G2, G3).

## 7. Method, and what to distrust in this document

- Nine read-only agents, batched by domain, forbidden from mutating the shared
  checkout or running the suite. Rights, commerce and security on Opus; theme,
  process and tooling on Sonnet.
- **K1 is satisfied: 58 of 58 beads carry a `Premise verified 2026-10-08` line**
  naming a command run or a file and line read. **K2: all nine CHANGED beads carry
  `review-required`.** (`321` and `i2q` carried it already from 2026-10-06.)
- **K4 is satisfied vacuously**: no agent ran the suite, so no test figure in this
  document comes from a possibly-under-collected run. No test counts are quoted.
- Two claims were escalated and re-verified by the orchestrator directly rather than
  relayed: the shadcn import (§6.1) and the concurrent merge below.
- **The baseline moved during the audit.** `origin/main` is now `a532388` — PR #189
  (`p7x7`) merged mid-run from another session, touching only
  `.claude/skills/cut-release/SKILL.md`. It flips no verdict here. That bead is
  still `OPEN` and needs its close protocol run by whoever owns it.
- **One agent incident.** Unescaped backticks in a `bd --append-notes` argument were
  interpreted by the shell and executed `npm run build`; `next start` then failed on
  an already-held port. Verified contained: `git status` clean, no orphaned process,
  only gitignored `.next/` written, and a corrective note appended to the bead.
  Lesson: quote shell arguments in `bd` note strings.
- **Not independently recomputed**: `577s`'s "66 of 77" and `zo8n`'s "151 vs 30"
  figures. The underlying code defects were confirmed live against PR #121's real
  body; the aggregate counts were not re-run.
- **Line numbers in this document will drift.** Beads in this backlog have had their
  citations go stale twice in two days — `ilp`'s own "corrected" locations from
  2026-10-06 were already wrong by 2026-10-08. Cite constructs, not line numbers.
