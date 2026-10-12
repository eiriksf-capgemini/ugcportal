# The rights and disclosure subsystem, reviewed as a system (2026-10-12)

**Bead:** `ugcportal-l9qx` (discovered from the v0.7.0 premise audit, `ugcportal-j5fl`, §5.3 G9).
**Reviewed:** `origin/main` at **d23add1** (`git rev-parse --short HEAD` in a fresh worktree of `origin/main`).
**Extends:** `ugcportal-5x8` (security review) and `ugcportal-rma` (architecture review), neither of which named this subsystem before today; see §8.
**Status:** agent-prepared review. Severity on every finding is assigned by the reviewer and stated per finding; nothing here inherits a severity from a tool. This document is not legal advice. Where a legal question is open it says so and names the bead that holds it.

---

## 0. The one-paragraph version

The subsystem is three families of gate over one `Media` row: a *sale* gate, a *publish-rights* gate, and an *advertising / alcohol* gate. The first two are re-evaluated every time the row is read — the sale gate at render (`ugcportal-yzo7`), the rights gate inside the shared anonymous query scope (`ugcportal-nffp`) — so a row that stops qualifying stops being served, with no write to it. The third family is not: none of its refusals runs at read time, and the one that refuses an *unanswered* alcohol question runs on a publish request — the module's own comment calls that "the only place that state is refused". Read as a system, that leaves an ordinary two- or three-request path the per-diff reviews did not see, because each diff was correct on its own: publish a photograph as personal content, then declare the benefit and attach the affiliate link. The attach-time gate permits an unanswered alcohol question by design, citing the publish gate as its backstop; the publish gate has already run. Driven live against the real routes at d23add1: publish 200, declare 200, attach 201, the anonymous feed serves the item with its label and its link, and a re-publish of the identical state is refused 400 with `field: "depictsAlcohol"`. That is **Finding 1** (medium, confirmed). Everything else examined is either fail-closed as written, already owned by a filed bead, or a decision recorded in writing — each is named below with the command that checked it.

---

## 1. Why this is a system review and not a seventh per-diff pass

`bd` memory `who-may-have-an-account-was-never-owned-by-any-bead` records the precedent, in its own words: every auth gate in this repo was individually correct and individually reviewed, and the system still let any Google or Facebook account sign in, upload and publish. No single diff was wrong, by that account. What found it was auditing a bead's premises against the running code. The premise audit of 2026-10-08 (`docs/process/premise-audit-v0.7.0-2026-10-08.md`, §5.3 G9) observed that the rights and disclosure subsystem had reached the same position — reviewed thoroughly per PR, named by no review bead — and this document is that review.

So the method here is deliberately not "re-read each diff". It is: write down the subsystem's gates and *when each one runs*, then look for a state one gate exists to refuse that another gate's design can reach by running in a different order. K3 of the bead names this as the thing that must not be skipped; §5 is where it is done.

---

## 2. Scope, re-derived (K1)

The bead's title says "nine models and six routes" and its notes say "16 models and 7 enums". K1 requires these to be re-derived by command, not copied. Run at d23add1 in `/tmp/wt-l9qx`:

```
$ grep -cE '^model ' prisma/schema.prisma
16
$ grep -cE '^enum ' prisma/schema.prisma
10
$ find src/app -name 'route.ts' | wc -l
15
```

The enum count has grown since the bead was written: 10, not the 7 its notes record (`MediaAuthorship` arrived with `ugcportal-15r` in `d60abd2`, 2026-10-08, #197 — `git log -S'enum MediaAuthorship' -- prisma/schema.prisma`; `RoleChangeSource` and `MediaKind` are outside this subsystem but inside the count).

The **route** count has not grown, and the bead's "14" is not superseded by the 15 above — the two measure different roots. The "14" in `ugcportal-5x8`'s and `ugcportal-rma`'s 2026-10-08 notes — and in the premise audit's `qnq9.5` row (`docs/process/premise-audit-v0.7.0-2026-10-08.md:148`) — is **14 API routes**, and that is still exactly what `src/app/api` holds; the 15 is every `route.ts` under `src/app`. (G9 of the same audit, at `:285`, counts the subsystem's own routes, "Nine models and six API routes" — the 6 this section reproduces below, not the 14.) Both figures are unchanged since the bead's own premise commit `54d88ca` (2026-10-07):

```
$ find src/app/api -name route.ts | wc -l
14
$ git ls-tree -r --name-only 54d88ca -- src/app | grep -c '/route\.ts$'
15
$ git ls-tree -r --name-only 54d88ca -- src/app/api | grep -c '/route\.ts$'
14
$ diff <(git ls-tree -r --name-only 54d88ca -- src/app | grep '/route\.ts$' | sort) \
       <(git ls-tree -r --name-only d23add1 -- src/app | grep '/route\.ts$' | sort)
$ git log --format='%h %ad %s' --date=short -- src/app/llms.txt/route.ts
51a0c72 2026-10-04 feat(seo): add /llms.txt describing the public site (ugcportal-o7l) (#83)
```

The `diff` prints nothing: the `src/app` route set at `54d88ca` and at `d23add1` is the same set of 15 files. `src/app/llms.txt/route.ts` is the file that makes 15 rather than 14, and it is not new — it merged 2026-10-04, three days *before* `54d88ca`. So nothing was superseded here, and nothing grew.

The rights and disclosure half, taken as everything declared after the `// Resale rights (ugcportal-0ss, …)` banner in `prisma/schema.prisma`:

```
$ awk '/^\/\/ Resale rights \(ugcportal-0ss/{f=1} f && /^model /{print $2}' prisma/schema.prisma
ResaleRightsReview
ResaleRightsEvent
MediaListing
MediaRightsClearance
BenefitSource
MediaAdvertisingDisclosure
CommercialLink
MediaAttestation
$ awk '/^\/\/ Resale rights \(ugcportal-0ss/{f=1} f && /^enum /{print $2}' prisma/schema.prisma
ResaleRightsStatus
ResaleRightsRoute
RightsLayer
RightsSubjectKind
BenefitKind
CommercialLinkNetwork
MediaAuthorship
```

**8 models and 7 enums** of the schema's 16 and 10. The bead's "nine" models *is* reproducible, by the grouping that adds `RoleChange` to these 8: `grep -n '^model ' prisma/schema.prisma` puts `model RoleChange` at line 500 and `grep -n 'Resale rights' prisma/schema.prisma` puts the banner at line 516, so `RoleChange` is the model immediately above the banner, and 8 + 1 = 9. That is the grouping the earlier audit used — `ugcportal-rma`'s 2026-10-08 note lists `RoleChange` and `RoleChangeSource` inside its rights-and-disclosure enumeration. This document counts 8 instead, and the difference is a judgement, not a correction: `RoleChange` is an auth-audit table of who changed whose role, and none of the library modules listed below reads it (`grep -rn RoleChange src/lib --include='*.ts' | grep -v '\.test\.'` returns 3 lines, none of them a read of the table: a comment at `sign-in-policy.ts:1278`, and the `RoleChangeActor` type declared at `roles.ts:9` and used at `:46`). The bead's "six routes" needs no correction at all — it is reproduced exactly, below. The route files that implement a gate of this subsystem:

```
$ find src/app/api -name route.ts | grep -E 'rights|disclosure|commercial-links|publish|curation' | sort
src/app/api/admin/curation/[id]/price/route.ts
src/app/api/admin/rights/brands/alcohol/route.ts
src/app/api/admin/rights/decision/route.ts
src/app/api/media/[id]/commercial-links/route.ts
src/app/api/media/[id]/disclosure/route.ts
src/app/api/media/[id]/publish/route.ts
```

**6 of 15 route files**, plus three server actions in `src/app/admin/curation/actions.ts` (`grep -c "^export async function"` → 3: `recordTriage`, `recordClearance`, `setPrice`) and three admin pages (`src/app/admin/curation/page.tsx`, `src/app/admin/settings/rights/page.tsx`, `src/app/admin/settings/rights/brands/page.tsx`). The library modules that hold the rules: `src/lib/resale-rights.ts`, `publishability.ts`, `alcohol-commerce.ts`, `advertising-disclosure.ts`, `commercial-link.ts`, `benefit-source.ts`, `attestation.ts`, `curation-triage.ts`, `curation-triage-write.ts`, `curation-clearance-write.ts`, `curation-price-write.ts`, `resale-rights-review.ts`, `sellable-media.ts`, `public-media.ts`, `gallery-items.ts`.

Chronology of the merges that built it, from `git log --reverse -- prisma/schema.prisma src/lib/resale-rights.ts …` (dates are merge dates):

| Merge | Bead | What it added |
|---|---|---|
| e1d84c0 2026-09-25 | 0ss | per-account resale-rights gate |
| 457323d 2026-09-27 | vsm | gate re-anchored to uploaders and uploads |
| 71b7b29 2026-10-06 | qnq9.1 (#147) | advertising disclosure; publish refuses an unlabelled declared benefit |
| e78be02 2026-10-06 | qn3 (#145) | MINORS as its own triage fact on a registry the gate iterates |
| 0650697, 5acf824 2026-10-06 | qnq9.3 (#157, #168) | ALCOHOL fact no clearance settles; WINE_ACCESSORY; alcohol-linked brand refuses a benefit |
| 806d2d0 2026-10-06 | qnq9.2.1 (#176) | commercial-link record and the brand/alcohol attach gate |
| 0190c6e 2026-10-08 | vq3z (#196) | admin triage screen, the one writer of triage facts |
| d60abd2 2026-10-08 | 15r (#197) | uploader attestation at upload |
| 168ebc9 2026-10-08 | 6uxv (#198) | alcohol reclassification refused while links exist |
| ba9991f 2026-10-08 | qfy9 (#199) | per-layer clearances, the one writer of `MediaRightsClearance` |
| c5bf99f 2026-10-09 | 3ae (#200) | publishing requires attestation and a PEOPLE clearance where people are shown |
| d1dd242 2026-10-09 | yzo7 (#203) | price, with sellability re-evaluated at render |
| a1c6bc8 2026-10-10 | nffp (#208) | a lapsed clearance removes a published item from every public surface |
| d23add1 2026-10-10 | jain (#214) | disclosure withdrawal refused while links attached; publish re-checks the pair |

Both review beads were written 2026-09-15. Every row above postdates them.

---

## 3. The subsystem as a system: three gate families and when each runs

This table is the review's instrument. The right-hand column is the property the rest of the document turns on.

| Family | Question it answers | Decided by | Runs on | Re-evaluated on every anonymous read? |
|---|---|---|---|---|
| **Sale** | may this upload carry a price and an offer | `evaluateSellability` (`src/lib/resale-rights.ts`): uploader review → clearance scope → attestation → listing → every `TRIAGE_FACTS` entry | the price write (`recordPrice`) and every render of an offer (`publicOffer`, `src/lib/sellable-media.ts`) | **yes** — row at a time in TypeScript, by `yzo7` |
| **Publish rights** | may this upload be shown to the public at all | `publishabilityBlocker` and its SQL twin `PUBLIC_MEDIA_RIGHTS_SCOPE` (`src/lib/publishability.ts`) | the publish request, and inside `PUBLIC_MEDIA_SCOPE` | **yes** — as a `where`, by `3ae`/`nffp`; the uploader's standing review is deliberately not in it (publishability.ts, "WHAT A LAPSE AFTER PUBLICATION DOES") |
| **Advertising label** (§ 3.2) | if a benefit is declared, is it labelled; if a link is attached, is the page labelled | `advertisingLabelPublishRefusal`, `commercialLinkDisclosureRefusal`, `disclosureWithdrawalRefusal`, `commercialLinkPublishRefusal` | the disclosure write, the attach, the withdrawal, the publish request | **partly** — the render side serves `[]` links when the label is absent (`toGalleryCommercialLinks`, `listPublicMedia`); the label itself is served whatever else is true of the row |
| **Alcohol commerce** (§ 9-2) | may anything commercial sit on this picture, or come from this brand | `benefitAttachmentRefusal` (attach), `commercialPublishRefusal` (publish), `alcoholReclassificationRefusal` (triage write) | the disclosure write, the attach, the publish request, the triage write | **no** — `grep -n -E "alcoholLinked|depictsAlcohol|benefitReceived"` over `media-access.ts public-media.ts gallery-items.ts media-item.ts portfolio.ts sitemap.ts publishability.ts` returns no code line at d23add1 |

**Round-2 correction.** The row above originally read "uploader review → attestation → listing → every `TRIAGE_FACTS` entry", written before `ugcportal-aqw` (#217) merged into `origin/main`. Re-derived after merging, by reading `evaluateSellability` itself end to end (`sed -n '1185,1278p' src/lib/resale-rights.ts` on the merged tree) rather than trusting the earlier wording: `upload_owner_unknown` (0) → `uploaderClearanceBlocker` (1–4: `no_review` → `status_not_cleared` → `clearance_expired` → `reviewer_not_admin` → `checklist_version_retired`) → `clearanceScopeBlocker` (5, new: `upload_outside_clearance_scope`) → `attestationBlocker` (6) → `not_listed_for_sale` (7, absent listing) → `triageBlocker` (8, every `TRIAGE_FACTS` entry). The table cell is corrected to name the clearance-scope step the earlier wording omitted entirely.

Two consequences follow, and both are visible at this altitude rather than in any one diff:

1. **The § 9-2 family's "backstop" is a backstop for a publish request.** `alcohol-commerce.ts` says of the attach-time gate: "what it may NOT do is become public before the alcohol question is answered, and that is `commercialPublishRefusal`'s job below, which refuses the unanswered state at the one point where the public can see the result." And of the publish gate: "The alcohol half is not redundant at all: the write path permits an unanswered item on purpose, so this is the only place that state is refused." Each sentence is true of the function it sits on. Neither is true of a row that was published before the benefit was declared, because `commercialPublishRefusal` has one non-test caller at d23add1, and that caller runs when someone asks to publish. `grep -rn commercialPublishRefusal src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'` returns **16** lines, which is not the same as 16 callers: 3 are in generated client code under `src/generated/prisma/`, 10 are prose inside comments (`alcohol-commerce.ts:171`, `:316`, `:341`; `advertising-disclosure.ts:383`, `:411`; `publishability.ts:292`; `publish-authority.ts:150`; `curation-triage-write.ts:203`; `admin/settings/rights/brands/page.tsx:50`; and `publish/route.ts:283`), 1 is the definition itself (`src/lib/alcohol-commerce.ts:249`), and the remaining 2 are the single call site — the import at `src/app/api/media/[id]/publish/route.ts:4` and the call at `:310`. Narrowed to code outside the generated client, `… | grep -v 'src/generated' | grep -v ':[0-9]*: *\*' | grep -v ':[0-9]*: *//'` returns 4 lines: that definition, that import, that call, and one comment line in `curation-triage-write.ts:203` the filter cannot drop because it is a continuation line. §5.1 drives the consequence.

2. **The one place in the § 9-2 family that *does* have a written answer for "already public" is the brand flip** (`ugcportal-mqh8`, `src/app/admin/settings/rights/brands/page.tsx`): "An item already published under a brand that is now alcohol-linked is NOT auto-unpublished here … a row already public stays public until an admin acts on it directly", with the affected items listed for the admin on every render. That is a decision, recorded, with a surface. The path in §5.1 has neither a decision nor a surface.

---

## 4. K2: the alcohol gate and the minors flag on `null`, `undefined`, `NaN` and unparseable input

The bead's K2 asks, for each of the two legal-consequence controls, what it refuses, under what input, and what it does when the input is not a readable value. The repo's own reference pattern is the expiry check in `src/lib/resale-rights.ts`:

```ts
if (!(expiresAt > timeOf(now))) {
  return "clearance_expired";
}
```

written so that `NaN` — which every comparison answers `false` to — lands on the blocked side. Each reader below is compared with that.

### 4.1 The alcohol gate

`MediaListing.depictsAlcohol` is `Boolean?`. Readers at d23add1 (`grep -rn depictsAlcohol src --include='*.ts' --include='*.tsx' | grep -v test | grep -v generated`, code lines):

| Reader | What it refuses | On `true` | On `false` | On `null` / `undefined` / `NaN` / `"true"` / anything else | Direction |
|---|---|---|---|---|---|
| **Sale gate**, `triageBlocker` phase 1 (`resale-rights.ts`) — `if (!isTriaged(listing[fact.field])) return "triage_incomplete"`, where `isTriaged` is `typeof value === "boolean"` | an untriaged upload, whole | passes to phase 3 | passes to phase 3 | `triage_incomplete` | **closed** |
| **Sale gate**, `factBlocker` phase 3 — `if (answer === false) return null; if (!isTriaged(answer)) return "triage_incomplete"; … if (fact.settledBy !== "clearance") return fact.blocker;` | `alcohol_depicted`, and no clearance is consulted (`settledBy: "nothing"`) | `alcohol_depicted` | sells, as far as this fact goes | `triage_incomplete` — the skip needs an explicit `false`; the module comment says why `=== false` rather than `!== true` | **closed** |
| **Attach gate**, `benefitAttachmentRefusal` → `alcoholDepiction`: `=== true` → `"depicted"`, `=== false` → `"absent"`, else `"unanswered"`; the gate refuses on `=== "depicted"` | a benefit or a link on a picture *recorded* as showing alcohol | refused, `field: "depictsAlcohol"` | permitted (then the brand check runs) | **permitted** — `"unanswered"` is not `"depicted"`. Deliberate and documented: refusing here "would make the advertising label unrecordable on every item until an admin had triaged it" | **open by design**, relying on the publish gate — see §5.1 for where that reliance breaks |
| **Publish gate**, `commercialPublishRefusal` — `if (alcoholDepiction(item.listing) !== "absent") return {…}` | publishing anything commercial unless alcohol is recorded *absent* | refused | permitted | **refused** — `"unanswered" !== "absent"` | **closed** |
| **Triage-write gate**, `alcoholReclassificationRefusal` — `if (alcoholDepiction(item.listing) !== "depicted") return null; if (item.commercialLinks.commercialLinkCount < 1) return null;` | recording `true` while a link is attached | refused if any link | permitted | permitted (an admin may clear a mis-click) — and `parseTriageAnswers` cannot produce `null` here anyway, see §4.3 | closed on the pair; the count side: `NaN < 1` is `false`, so a `NaN` count **refuses** |
| **Link count**, `carriesCommercialLink` — `return !(links.commercialLinkCount < 1)` | — | — | — | `NaN` → `!(false)` → `true` → "carries a link" | **closed**, same construction as the expiry check; per `ugcportal-jain`'s round-1 notes, a `>= 1` here was found to fail open and was replaced by this |

The brand half, `BenefitSource.alcoholLinked` (`Boolean?`), read by `alcoholLinkedBrandRefusal`: `=== false` passes; `=== true` refuses ("declines the deal"); **anything else** — `null`, a missing row (`undefined`), a string — falls to the final `return` and refuses with "Nobody has recorded whether this brand…". Closed. `effectiveBrandAlcoholAnswer(recorded, submitted)`: `recorded === true || submitted === true` → `true`; else `submitted ?? recorded` — so `(null, undefined)` is `null`, which the refusal above then refuses. Closed, and monotone towards `true`. The write that records a brand's first answer is `updateMany({ where: { id, alcoholLinked: null } })`, so a brand that already carries an answer is not re-answered.

**Summary for the alcohol gate.** Six readers; five fail closed on unreadable input, in the same direction as the expiry pattern. The sixth — the attach-time reading — fails open on unanswered input *on purpose*, and its stated justification is that the publish gate refuses the unanswered state. That justification holds for a row not yet published and does not hold for a row already published, which is §5.1.

### 4.2 The minors flag

Two columns carry it: the admin's `MediaListing.depictsMinors` (`Boolean?`) and the uploader's `MediaAttestation.showsMinors` (`Boolean`, `NOT NULL`).

| Reader | What it refuses | On `true` | On `false` | On `null` / `undefined` / other | Direction |
|---|---|---|---|---|---|
| **Sale gate**, `TRIAGE_FACTS` entry `{ field: "depictsMinors", layer: MINORS, settledBy: "clearance", blocker: "minors_uncleared" }` through the same `triageBlocker`/`factBlocker` as above | selling without a MINORS clearance signed by a current ADMIN with a non-blank reason | `minors_uncleared` unless `layerIsCleared(listing, MINORS)` | passes | `triage_incomplete` (phase 1), and `triage_incomplete` again in `unsettledLayers` which runs no phase 1 | **closed** |
| **Sale gate**, `attestationBlocker` — `for (const { field } of ATTESTATION_QUESTIONS) if (typeof attestation[field] !== "boolean") return "attestation_incomplete"` | an attestation with any non-boolean answer, `showsMinors` included | *not acted on* — the gate deliberately reads none of the six content answers (decided, `ugcportal-9pic`, 2026-10-09: "handled off site") | not acted on | `attestation_incomplete` | **closed** on shape; the *value* of `showsMinors` blocks nothing anywhere |
| **Publish gate**, `publishabilityBlocker` and `PUBLIC_MEDIA_RIGHTS_SCOPE` | — | not consulted | not consulted | not consulted | **not a null question**: the column is not read at all. `grep -n -i minors src/lib/publishability.ts` returns no code line. Owned by **`ugcportal-sbah`** (open, P2), which names both the incoherent states (`depictsMinors` true with `depictsPeople` false; `showsMinors` true with `showsIdentifiablePeople` false) and the coherent one (PEOPLE cleared, MINORS not) |
| **Clearance writer**, `recordLayerClearance` | a MINORS row with a blank reason, a non-ADMIN actor, a non-clearable layer, a duplicate | — | — | `isClearableLayer` is a `typeof value === "string" && CLEARABLE_LAYERS.includes(value)` check, so a non-string layer is refused | **closed** |

What a MINORS clearance *must contain* is a free-text reason. `TRIAGE_FACTS`' MINORS entry carries no `alsoRequires`, and its comment says why: "What that document must say … is ugcportal-ryd, and a half-specified file check here would read as the legal threshold having been met." `ugcportal-ryd` closed on 2026-10-09 as a decision not to engage counsel, and its close note lists the beads that had deferred to it (`cv8`, `jjxt`, `5pik`) — not this entry. That is **Finding 2** (§5.5).

**Summary for the minors flag.** On unreadable input the sale gate fails closed at both the triage and the attestation; the publish gate does not read either column, which is a filed, open defect (`sbah`) rather than a NaN question; and the sale-side MINORS clearance's evidence requirement is deferred to a bead that has since closed without answering it.

### 4.3 The parsers at the edge

Every one of the columns above is written through a parser that admits two tokens and treats everything else as "unanswered", which refuses the write rather than storing a default:

- `parseTriageAnswers` (`src/lib/curation-triage.ts`): `raw === "yes"` → `true`; `raw === "no"` → `false`; else pushed to `unanswered` and the whole triage is refused. `recordTriageFacts` then re-checks `typeof answer !== "boolean"` for every registered fact and throws. At d23add1 the writers of `MediaListing` are that upsert and `recordPrice`'s update of `priceCents`/`currency` (`git grep -n -E "mediaListing\.(update|upsert|create|updateMany|createMany)\(" -- src | grep -v '\.test\.'` → two hits), so through the product `null` is the state of a triage column nobody has written, not a value a form can submit.
- `parseAttestation` (`src/lib/attestation.ts`): `raw !== "yes" && raw !== "no"` → the upload is refused naming the field. A checkbox's presence-or-absence is deliberately not the wire format, for the reason the module gives.
- `validUntil` in `src/app/api/admin/rights/decision/route.ts`: `new Date(value)`; `Number.isNaN(parsed.getTime())` → redirect with `rights_invalid_valid_until`. An unparseable date is refused before the writer sees it. An *absent* field leaves the stored value alone and a *blank* one clears it to `null`, which the gate reads as "no end date" — the forever case, owned by `ugcportal-paa`.

### 4.4 Compared with the reference pattern

The expiry check inverts a `>` so `NaN` blocks. The triage facts use a `typeof` guard so `undefined` blocks (the module records that `=== null` once let `undefined` through). `carriesCommercialLink` inverts a `<` so `NaN` blocks. `alcoholDepiction` and `alcoholLinkedBrandRefusal` enumerate the two permitted literals and send everything else to the refusing branch. These are the same idea written four ways, and in every reader but one the unreadable case lands blocked. The one exception is a documented design choice whose stated backstop is examined next.

---

## 5. K3: the cross-diff interactions examined

### 5.1 Publish → declare → attach: the § 9-2 question is never asked — **Finding 1**

**Diffs involved.** #147 (`qnq9.1`): `PUT /api/media/[id]/disclosure` "neither publishes nor unpublishes an item", and its docstring treats a benefit declared on an already-public item *with* a label as correct — "it now carries the label". #157/#168 (`qnq9.3`): the attach-time alcohol reading is permissive on an unanswered item, with `commercialPublishRefusal` named as the place the unanswered state is refused. #176 (`qnq9.2.1`): `POST /api/media/[id]/commercial-links` uses the same permissive attach gate and also writes no `publishedAt`. #200 (`3ae`): publishing needs an attestation and, where people are shown, a PEOPLE clearance — but no listing, and no disclosure; an item with neither publishes. Each is correct alone. Together:

```
POST /api/media/[id]/publish            (no disclosure row, no listing row)     -> 200
PUT  /api/media/[id]/disclosure          {benefitReceived:true, label, brand: alcoholLinked false} -> 200
POST /api/media/[id]/commercial-links    {url, network, brand}                  -> 201
```

The row is public, carries a permitted label and a live affiliate link, and `MediaListing` does not exist — `depictsAlcohol` is unanswered. `commercialPublishRefusal` would refuse exactly this state; it did not run, because nothing asked to publish after the state arose. Neither write path reads `publishedAt` (`grep -n publishedAt` over the two routes returns comment lines only).

**Driven live, not inferred.** A throwaway vitest file (not committed) seeded an attested, unpublished image with the disclosure route test's own fixtures, then called the three real handlers in that order and read the anonymous feed through `listPublicMedia(publicMediaListingUrl())`. Observed at d23add1: `200`, `200`, `201`; `publishedAt` non-null; `listing` null; the feed item present with `advertisingDisclosure.label === "Advertisement / Reklame"` and `commercialLinks.length === 1`. Control in the same run: a fourth request, `POST …/publish` on that same row, answered `400` with `{ field: "depictsAlcohol" }` — which is what shows the ordering bypassed the gate rather than the gate permitting the state. One test, one pass.

**Why no existing bead owns it.** Checked by `bd show` on each: `ugcportal-rh9q` is the mirror (an owner *withdrawing* a disclosure from a public item); `ugcportal-n0vq` and `ugcportal-6uxv` are the triage write flipping `depictsAlcohol` to `true` behind a price, benefit or link; `ugcportal-mqh8` (closed) is a brand flipped to alcohol-linked after publication, and decided, in writing, not to auto-unpublish; `ugcportal-nffp` (closed) made the *rights* half of the publish gate read-time and its own header says why the uploader review is left out; `ugcportal-qnq9.5` is third-party objections; `ugcportal-jain` (closed) is the label/link pair. The premise audit's G4 ("an already-published row that later becomes non-compliant") was written about a clearance lapsing and a checklist version retiring, and `nffp` discharged that reading. Nothing names the forward direction: a row published as personal content that *becomes an advertisement* by a later disclosure write, with the one gate that refuses the unanswered alcohol state sitting behind a request nobody has to make.

**Severity: medium.** Confirmed. The consequence is the one `alkoholloven § 9-2` attaches an administrative fine to (an advertisement on an image in which alcohol may be visible, with the question never asked), and it is reached by ordinary owner requests with no out-of-API write. It is not high: a real breach additionally needs alcohol to be in the picture, publishing is restricted to two named operators (`ugcportal-55nt`, decided 2026-10-09), and the attach-time permissiveness that enables it is itself a considered trade whose other half — making a legally required label unrecordable until triage — is a worse failure. The fix is a decision as much as a patch: refuse the disclosure or attach write on a *published* row while `depictsAlcohol` is not `false`; or depublish; or move the § 9-2 reading into the read path the way `nffp` moved the rights reading. Filed as **`ugcportal-pgpq`** with the sequence above as its test.

**Fixed, 2026-10-12 (`ugcportal-pgpq`).** The decision was option C — move the § 9-2 reading into the read path. The three requests above still answer `200`/`200`/`201` and `publishedAt` is untouched; the pair is now a third arm of `PUBLIC_MEDIA_RIGHTS_SCOPE` (`PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE`, `src/lib/alcohol-commerce.ts`), so the row leaves every reader of `PUBLIC_MEDIA_SCOPE` until `depictsAlcohol` is answered `false`. The two sentences quoted in §4's item 1 have been corrected in the source; the decision, its two rejected alternatives and the `ugcportal-mqh8` comparison §5.3 asks for are in `docs/legal/alcohol-commerce-public-visibility.md`. The accepted cost — the owner is not told why their item vanished — is `ugcportal-bk57`, which is open. The rest of this document is left as it was written, dated to `d23add1`.

### 5.2 MINORS × the publish gate — owned by `ugcportal-sbah`

#145 (`qn3`) made MINORS a layer of its own, with the schema comment "`true` needs its own MINORS clearance; a PEOPLE clearance does not settle it". #200 (`3ae`) wrote a publish gate that consults the PEOPLE layer and no other, and #208 (`nffp`) mirrored that into the read scope. So a published photograph of a child with a PEOPLE clearance stays public with no MINORS clearance, and an uploader's `showsMinors: true` is acted on by no gate on either side (the sale gate checks its shape and, by the `9pic` decision, not its value). Re-checked at d23add1: `grep -n -i minors src/lib/publishability.ts` → no code line. `ugcportal-sbah` (open, P2, 2026-10-09) states this precisely, including both incoherent attestation/triage states, and its K2 asks the predicate and the scope to agree about MINORS as they do about PEOPLE. Not re-filed. The one thing to add here is a system-level reading: #200 and #208 were each reviewed against *their own* bead's criteria, which named PEOPLE, and neither bead's text mentions the layer #145 had merged three days earlier (2026-10-06 against 2026-10-09).

### 5.3 Brand flipped to alcohol-linked after publication — decided (`ugcportal-mqh8`)

#174 added the admin-only, monotone `recordBrandAlcoholLinked`. An item published under a brand later recorded as alcohol-linked stays public; the publish gate refuses its *next* publish; the brands page lists the affected published items under "Needs attention" and says "Nothing here has unpublished them". That is a written decision with a surface, and the reviewer examined it as the comparison case for §5.1 rather than as a finding. One observation for whoever picks up `ugcportal-pgpq`: this is the shape of answer the § 9-2 family already has for one of its "already public" orderings, and the other ordering should get an answer of at least that explicitness.

### 5.4 Uploader-versus-admin disagreement — decided (`ugcportal-9pic`)

#197 (`15r`) stores six uploader answers the admin triage also asks. #200's publish gate reads `attestation.showsIdentifiablePeople === true || listing.depictsPeople === true` — either party's `yes` counts. The sale gate reads none of the six uploader content answers, by design, so an uploader's "yes, there is music I do not own" beside an admin's `containsMusic: false` sells. `ugcportal-9pic` (closed 2026-10-09): "Do not add feature for disagreement. It will be handled off site." The asymmetry between the two gates is therefore a decided one — the stricter publish reading is additive and the sale gate's admin-only reading is the recorded choice — and `ugcportal-vlnn` (#202) renders the disagreement to the admin. Examined; not filed.

### 5.5 The MINORS clearance's evidence requirement, deferred to a bead that closed — **Finding 2**

`TRIAGE_FACTS`' PEOPLE entry requires a release file (`modelReleaseKey`) on top of the clearance; its MINORS entry requires a clearance and no evidence file, with the comment deferring the content of a guardian-consent document to `ugcportal-ryd`. `ryd` closed on 2026-10-09 as "we do not need counsel", and its close note re-homes three deferred judgements (`cv8`, `jjxt`, `5pik`) — this entry is not among them. So the layer with the strictest consent requirement is settled, for a sale, by a sentence an admin types, and the written reason for that being acceptable points at a bead that closed as a question not to be put. Not a fail-open: the sale is still gated by a current ADMIN's signed clearance, and `ryd`'s own close note records that with only two named operators the counsel questions "change character entirely". **Severity: low.** Plausible as a gap in the record rather than in the gate. Filed as **`ugcportal-fftr`**: decide whether MINORS gets an `alsoRequires` (an evidence key, as PEOPLE has) or a dated statement that a reason suffices, and point the code comment at that decision instead of at `ryd`.

### 5.6 Other interactions examined and found owned or closed

- **`validUntil` null is forever.** `uploaderClearanceBlocker` skips the expiry branch on a falsy `validUntil`; the decision route turns a blank field into `null`. Owned by `ugcportal-paa` (open, P1). Checked: `bd show ugcportal-paa` names `src/lib/resale-rights.ts`'s null branch as its premise.
- **A clearance covering uploads the reviewer never saw.** Merged to `origin/main` as `ugcportal-aqw` (`dbe9e0e`, #217, "time-scope a clearance to material the reviewer could examine"), after this document's first draft described it as being implemented on `feat/ugcportal-aqw-clearance-scope`; that branch no longer exists. `evaluateSellability` now calls `clearanceScopeBlocker` (`coversUploadsBefore`, `coversFutureUploads`, `upload_outside_clearance_scope`) immediately after the uploader's standing clearance and before attestation (§3's Sale row). Reviewed against current `origin/main`, with the gate chain re-derived in §3 above; nothing filed against it.
- **Two checks SQL cannot express** (`attestedByUserId === Media.userId`; a whitespace-only PEOPLE reason). `ugcportal-0epl` (open), asserted as disagreements in `publishability.scope-agreement.test.ts`.
- **The attestation write-path scan and a ternary.** `ugcportal-xqal` (open).
- **A sold item whose clearance lapses.** `ugcportal-dabx` (open, P1); no fulfilment code exists yet.
- **The `SYSTEM` transition path has no caller.** `grep -rn 'source: "SYSTEM"' src | grep -v test` → the type definition in `resale-rights-review.ts` only. `REVOKED`/`EXPIRED` are unreachable from code at d23add1. Not a defect: `uploaderClearanceBlocker`'s comment says "No background job is required for the gate to be correct — EXPIRED as a *status* is bookkeeping, this comparison is the enforcement", and `paa` lists the sweep as out of scope on the same ground. Observation, not filed.
- **A brand's first alcohol answer is written by the beneficiary.** `PUT …/disclosure` records `null → false` on the strength of the owner's own `benefitSourceAlcoholLinked: false`; the admin-only path can later flip it to `true`, and at d23add1 the three non-test writes of the column (`grep -rn "alcoholLinked:" src | grep -v '\.test\.'`, data lines) are that `null → effective` in the disclosure route, `true` in `recordBrandAlcoholLinked`, and a `select` projection on the brands page, which is a read — none writes `false` over a `true`. The module says so plainly ("the only person who ever answers this question is the person who wants the deal to go through"). This is the separation-of-duties shape `ugcportal-uv9` and `ugcportal-jjxt` hold for the rights side, in a product whose publishers are two named operators (`55nt`). Observation; not filed separately — it belongs with `jjxt`'s decision, which should be read as covering the brand answer too.
- **Alcohol as personal content.** A photograph *recorded* as showing alcohol publishes freely when nothing commercial is on it (`commercialPublishRefusal` returns `null` with no benefit and no link). That is the §3.1a "personal content" line `ugcportal-qnq9.8` decided and `qnq9.11` (open) will lay out. Not a finding.

---

## 6. Findings

| # | Finding | Severity | Confidence | Bead |
|---|---|---|---|---|
| 1 | A benefit or a commercial link recorded on an *already-published* item is never asked the § 9-2 alcohol question: the attach-time gate permits "unanswered" by design and names the publish gate as its backstop, and the publish gate runs on a publish request that has already happened. Driven live at d23add1: 200 / 200 / 201, served to the anonymous feed with label and link, and the same state refused 400 on re-publish. | **medium** | **confirmed** (live) | `ugcportal-pgpq` |
| 2 | The MINORS sale-gate clearance requires a free-text reason and no evidence, and the comment justifying that defers to `ugcportal-ryd`, which closed without answering and without re-homing this deferral. | **low** | plausible (a gap in the record; the gate still fails closed) | `ugcportal-fftr` |

Both carry a `discovered-from` edge to `ugcportal-l9qx`, `severity` in metadata, and acceptance criteria written against the sequences above.

---

## 7. What this review did not do, and what to distrust in it

- It did not re-review any individual diff, and it did not run the full suite. One throwaway test was written and run for §5.1 and then deleted; its transcript is quoted, not attached.
- The K2 tables are read from source at d23add1 and cross-checked against the cases `resale-rights.test.ts` and `alcohol-commerce.test.ts` already pin (`null`, `undefined`, `NaN`, a string, a missing relation — see the `it.each` tables in both). Where this document says a reader "fails closed", a test in one of those files exercises that input; where it says "by design", the module's own comment says so and is quoted.
- The legal characterisations (what § 9-2 fines, what a guardian consent must say) are taken from `docs/ugc-research.md` §3.1a and `docs/legal/manual-upload-rights-review.md` §3.5 as the repo already states them. This review adds no legal reading of its own.
- The bead's "nine models" *is* reproducible — 8 subsystem models plus `RoleChange`, the model immediately above the banner, which is the grouping `ugcportal-rma`'s own 2026-10-08 note used. §2 counts 8 and states why it prefers the banner-only grouping; a reader who wants the nine has it there. The bead's "six routes" and the `5x8`/`rma` notes' "14 API routes" both reproduce exactly and were never superseded; only the "7 enums" figure was out of date.

---

## 8. K1 bookkeeping

`ugcportal-5x8` and `ugcportal-rma` each received an appended note (via `bd update --append-notes`, so nothing already in the field was replaced) naming the rights and disclosure subsystem in scope, with the counts in §2 and the commands that produced them, and linking this document. The exact text appended is recorded in each bead's notes and is not duplicated here.
