# What a lapsed clearance means for a completed sale

**Bead:** `ugcportal-dabx` (found by the `ugcportal-j5fl` premise audit,
`docs/process/premise-audit-v0.7.0-2026-10-08.md` §5.2 G5)
**Decides:** what fulfilment does with an `Order` whose media item has, since
the sale, stopped passing `evaluateSellability` in `src/lib/resale-rights.ts`
**Code:** none yet. The rule lands in `ugcportal-f3a` (the `Order` row) and
`ugcportal-5d6` (the signed download URL), neither of which is built.
**Date:** 2026-10-12, prepared against `origin/main` `0a9e051`
**Status:** **undecided.** This document prepares the decision for the product
owner; it does not take it. §9 is a recommendation and is labelled as one.
§11 is the blank the decision goes into. This document is not legal advice
and its author is not a lawyer.

---

## 0. The one-paragraph version

A buyer pays for an original. Later, the clearance that made it sellable stops
holding — the uploader's review expires, an admin revokes it, the checklist
version it was signed under is retired, or a triage answer about the file
changes. The buyer comes back for the download. The repo has decided the
adjacent questions — an *offer* that lapses is withdrawn on the next read
(`ugcportal-yzo7`), a *published* item whose publishability lapses leaves every
public surface (`ugcportal-nffp`), an *advertisement* whose § 9-2 question is
unanswered stops being served (`ugcportal-pgpq`) — and in each of them nobody
had paid. A completed sale is different in kind: money has moved and a licence
has been granted. The four candidate answers are **refund and revoke**, **revoke
without refund**, **honour the sale**, and **honour it until the already-issued
URL expires**. They trade a buyer's paid expectation against a rights-holder's
withdrawn permission, and that trade is the product owner's to make, not an
implementer's. What this document adds is: which lapses are actually likely on
this site (§1), what each option costs and which recorded decision it agrees or
conflicts with (§4), what the repo has and has not established legally (§5),
and the criterion text `ugcportal-5d6` needs whichever way the decision goes
(§7), so the decision can be taken in one reading and does not have to be
re-made inside a fulfilment PR.

---

## 1. What "lapse" means at current `main`, and which lapses are likely here

`evaluateSellability` (`src/lib/resale-rights.ts`) answers "may this file be
sold right now" by returning the first blocker in a fixed order. Read end to
end at `0a9e051` the order is: `upload_owner_unknown` → the uploader's standing
clearance (`no_review`, `status_not_cleared`, `clearance_expired`,
`reviewer_not_admin`, `checklist_version_retired`) → the clearance's scope
(`upload_outside_clearance_scope`, added by `ugcportal-aqw` #217) → the
uploader's attestation → `not_listed_for_sale` → every `TRIAGE_FACTS` entry.
A sold file that passed this on the day of sale can later fail it through any
of those branches. They are not all the same kind of event, and the decision
should be read against the kinds rather than against the word "lapse":

| Kind | How it happens | Who decided anything about *this file* | Likely here? |
|---|---|---|---|
| **Calendar / bookkeeping** | `validUntil` passes (`clearance_expired`); `2026-09-27.1` leaves `ACCEPTED_CHECKLIST_VERSIONS` (`checklist_version_retired`); an attestation version is retired; the signing admin or a layer's clearer is demoted (`reviewer_not_admin`, `triage_not_signed_by_admin`) | Nobody. No write touches the file or the sale. | **Yes, and soon.** `ugcportal-fw5` (open, P1) retires `2026-09-27.1` and so fails every clearance signed under it on the day it merges. `ugcportal-paa` (open, P1) makes a null `validUntil` expired and caps clearances at 12 months, so every clearance lapses at least yearly by design (`docs/legal/manual-upload-rights-review.md` §1 Gap 2). |
| **A decision about the uploader** | An admin moves the review to `REVOKED` or `REJECTED` (`status_not_cleared`), or deletes it (`no_review`) | An admin, about the person — not about any one file or sale. | On this site the uploaders who may sell are the two operators (`ugcportal-tfub`, decided 2026-10-09), so this is an operator revoking an operator's standing — rare, and self-directed. |
| **A decision about the file** | Triage flips `depictsPeople`/`depictsMinors`/`depictsAlcohol` to a blocking answer; a layer clearance is removed; the listing is deleted or un-priced | An admin, about this file. | Plausible: an admin learns something about a photograph after it sold (a person in frame did not agree; music turned out to be licensed). |
| **External** | A depicted person withdraws consent or objects; a third party claims the work | Someone outside the system. | Real, but at `0a9e051` there is no system path for it: `docs/legal/manual-upload-rights-review.md` §3.9 "Revocation has no external trigger" and `ugcportal-qnq9.5` (open). It arrives, if at all, as an admin doing one of the two rows above. |

Two consequences for the options in §4:

1. **The most frequent lapse is the one with the least to do with the sale.**
   `fw5` and `paa` make calendar lapses routine. Any rule that acts on a sale
   because the gate now says `checklist_version_retired` would act on every
   past sale the day the checklist is revised, with no human having formed a
   view about any of them.
2. **The lapse that most deserves a reaction is the one the system does not
   hear about.** A depicted person's objection is the case the checklist's
   C.2.7 and B.1.14 write about ("pull a listing and notify Buyers";
   "including notifying Buyers where feasible"), and at `0a9e051` it reaches
   the gate only if an admin acts on it by hand (§3.9, cited in the table).

The scope blocker (`upload_outside_clearance_scope`) is listed for completeness
but is unlikely to appear on a sold file: `coversUploadsBefore` is written on
entry to `CLEARED` and moved only by an explicit extend-scope action
(`ugcportal-aqw` K2), so a later re-clearance moves the cut-off later, not
earlier. The gate does not rule it out, so the criterion in §7 should not
either.

---

## 2. Premise re-check at `origin/main` `0a9e051`

The bead's premise was recorded on 2026-10-08 at `54d88ca`. Thirty-three
commits have landed since (`git log --oneline 54d88ca..origin/main | wc -l`),
including the rights beads `ugcportal-nffp` (#208), `ugcportal-jain` (#214),
`ugcportal-aqw` (#217) and `ugcportal-pgpq` (#221). Re-checked:

| Claim in the premise | Checked by | Holds? |
|---|---|---|
| `ugcportal-5d6`'s stated gate is a valid `Order` record from `f3a` | `bd show ugcportal-5d6`: in scope "access gated on a valid Order record (f3a)"; K1 (window), K2 (buyer identity), K3 (no unsigned read). No criterion names the sellability gate. Last updated 2026-10-06. | **Holds.** |
| Nothing re-evaluates `isSellable()` after the webhook lands | No webhook, `Order` model or Stripe dependency exists: `grep -n "model Order\|stripe" prisma/schema.prisma package.json` returns no model and no dependency; `ugcportal-f3a`'s own premise line says the same. The consumers of the gate at `0a9e051` are the price write (`src/lib/curation-price-write.ts`) and the offer read (`src/lib/sellable-media.ts`, `publicOffer`). | **Holds**, trivially — there is nothing after the webhook yet. |
| `ugcportal-74w` K5 covers render | `ugcportal-yzo7` (closed, #203) shipped it: `publicOffer` re-runs `isSellable` per read. | **Holds.** |
| **`ugcportal-p3v` K3 covers checkout** | `bd show ugcportal-p3v --json`: the `acceptance_criteria` field holds **one** criterion, K1 (440 characters). The text "K3" occurs three times in the bead's *notes* ("2026-09-24: K3 added…", "2026-09-27: K3 rewritten…", "…present as K3 describes") and nowhere in its criteria. The field was last written 2026-10-06T06:39:07Z, the date the backlog review rewrote K1 as "(replace K1)". | **Does not hold as cited.** The checkout-time re-evaluation that this bead, `premise-audit-v0.7.0-2026-10-08.md` G5, `rights-system-review-2026-10-12.md` §4 and `ugcportal-74w`'s notes all call "p3v K3" is, at `0a9e051`, a sentence in p3v's notes. That is the shape `ugcportal-dabx` K3 names as the thing that should never happen. It is reported here and in the PR rather than fixed, because restoring p3v's criterion is a change to a bead this document does not own. |
| `ugcportal-paa` and `ugcportal-aqw` make lapse more likely | `aqw` merged (#217) and adds a blocker; `paa` is open and would cap every clearance at 12 months. | **Holds**, and §1 adds `fw5`, which the premise did not name and which is the nearest certain lapse. |

So the premise holds where it describes `5d6`, and is stale in one place in the
direction that *widens* the gap: at current `main`, neither checkout nor
fulfilment carries the re-evaluation as a criterion. Only render does
(`ugcportal-yzo7` K4, shipped).

---

## 3. What the repo has already decided nearby

These are the recorded decisions a rule for sold items has to agree with or
knowingly depart from. Quoted rather than paraphrased where the wording is the
point.

| Decision | Where | What it says | Direction |
|---|---|---|---|
| **Read-path re-evaluation of an offer** | `ugcportal-74w` K5; `ugcportal-yzo7` K4, `src/lib/sellable-media.ts` | "the presence of a stored price must never by itself be treated as proof of sellability"; re-evaluated at render "because a stored flag proves nothing after the moment it was written" | Re-check on every read. Nobody has paid at this point. |
| **Lapse after publication, rights family** | `ugcportal-nffp` K1; `src/lib/publishability.ts` "WHAT A LAPSE AFTER PUBLICATION DOES" | The uploader's review "moving to REVOKED or EXPIRED, its `validUntil` passing, or its checklist version being retired does NOT depublish anything, and must not: that review answers whether the work may be RESOLD" | A lapse of the *resale* clearance withdraws the **price**, not the photograph. The publishability family (attestation, PEOPLE clearance) does leave every public surface. |
| **A commercial fact arriving on a public item** | `ugcportal-pgpq`, `docs/legal/alcohol-commerce-public-visibility.md` §2 | Option C, read path: "it is the only option robust to orderings nobody has enumerated, since it evaluates whenever the item is served" (close reason) | Re-check on every read. Also records *why not* the write-refusing and depublishing options. |
| **A brand flipped to alcohol-linked after publication** | `ugcportal-mqh8`; `src/app/admin/settings/rights/brands/page.tsx` | "list it for the admin, no auto-unpublish" — because auto-acting "would mean one admin edit silently withdrawing an arbitrary number of other people's published work, with no review of whether the flip was right" (`alcohol-commerce-public-visibility.md` §2) | **Surface it; do not act automatically.** The one recorded precedent *against* an automatic cascade. |
| **Survival of buyer licences** | `docs/legal/instagram-resale-rights-checklist.md` B.1.7, B.1.8, E.3 | B.1.7: the instrument must state "what happens to licences already sold to Buyers if the Owner's licence ends (survival clause)". B.1.8: "that withdrawal stops *new* sales and whether it affects Buyers' existing licences". E.3: "Buyers' already-issued licences are governed by the survival clause (B.1.7), which the Buyer licence text must mirror." | The checklist expects the answer to be *written in the instrument*, and expects "stops new sales" to be the default effect of withdrawal. It does not itself choose whether existing licences survive. |
| **The review's rewrite of E.3 "Revocation cascades"** | `docs/legal/manual-upload-rights-review.md` §2 | Replacement text: "Admin revocation or uploader withdrawal → `REVOKED` → every file of that uploader fails the gate immediately. Public visibility is a separate switch (`ugcportal-3ae`)." | The buyer-licence sentence E.3 carried is **not in the replacement**. The rewrite narrowed the row to the gate and dropped the question this document asks, without deciding it. `ugcportal-fw5` will apply that rewrite. |
| **Evidence retention** | `instagram-resale-rights-checklist.md` E.2 | "keep for the life of any Buyer licence issued under it plus the limitation period for claims" | Assumes a buyer licence has a life that continues after the instrument it was issued under. |
| **Objection handling** | `instagram-resale-rights-checklist.md` C.2.7, B.1.14 | "process exists to pull a listing and notify Buyers if a depicted person objects (arts 17, 21)"; "including notifying Buyers where feasible" | On a *genuine* rights failure, the expected action on existing buyers is **notify**, not revoke or refund. |
| **Per-item licence terms snapshot** | `ugcportal-74w.1` (open) | terms "captured on the order so the terms of a past sale remain knowable after the listing changes" | A sibling bead already wants the sale to carry a snapshot of what was granted — the shape option C needs. |
| **Refunds** | `ugcportal-f3a` | "Out of scope: refund handling (flagged as a gap — not currently covered by any bead)" | No bead owns refunds. Option A would need one. |
| **Who sells** | `ugcportal-tfub`, decided 2026-10-09 | sellers are the two operators | The "rights-holder" whose permission lapses is, in the ordinary case, an operator's own clearance of their own work. |
| **Counsel** | `ugcportal-ryd`, decided 2026-10-09 | "We do not need counsel or engage counsel." | §5's open questions will not be answered by a lawyer; the decision has to be one the operators are comfortable standing behind without one. |

The read-path precedents (`yzo7`, `nffp`, `pgpq`) all concern whether the site
may *act now* — offer, display, serve. `mqh8` is the one that concerns undoing
something already done to other people, and it chose not to automate. A
completed sale sits on `mqh8`'s side of that line, and that is the distinction
a decision for or against re-evaluating at fulfilment has to state in writing,
whichever way it goes — otherwise the next reader sees `yzo7`/`nffp`/`pgpq`
and concludes the read-path rule simply applies.

---

## 4. The four options

For each: what the buyer experiences, what the rights-holder gets, what it
costs to build, and which recorded decision it agrees or conflicts with.
"Rights-holder" below means whoever the lapsed clearance was protecting: the
uploader as copyright holder, or a depicted person whose consent was the
basis for the `PEOPLE` layer.

### A — Refund the buyer and revoke access

**Buyer:** receives their money back and loses the right to download again.
If they already downloaded, they hold a file they have been refunded for and
no longer have a licence to use; the site has to tell them so.
**Rights-holder:** the strongest remedy — the sale is unwound.
**Cost to build:** the most. A refund path (Stripe refund call, an `Order`
status for it, idempotency against the webhook), a per-order revocation flag
the fulfilment gate reads, buyer notification, and bookkeeping in the revenue
dashboard (`ugcportal-aj2`) and the income log (`ugcportal-qnq9.6`), both of
which read `Order` rows. None of that is in any bead: `f3a` excludes refunds.
**Agrees with:** the read-path family's instinct that a lapsed condition
should have an effect.
**Conflicts with:** `mqh8`, if automatic — a calendar lapse (§1) would unwind
every past sale on the day `fw5` merges, with no one having decided anything
about any buyer. Conflicts with B.1.8's default that withdrawal "stops *new*
sales". Moves money automatically on the strength of a gate whose most common
blockers are bookkeeping, in a product whose own `model_why` for this bead is
"money plus a legal-consequence revocation path".
**Is coherent when** it is keyed to the *kind* of lapse (§1) — a human
decision about the file or the uploader — and not to a calendar lapse. That
turns it into "an admin may refund and revoke an order", which is
a manual action with a button, not a rule the gate applies.

### B — Revoke access, no refund

**Buyer:** paid, and the download stops working — on first download if the
lapse fell between the webhook and their click, on re-issue otherwise. They
keep nothing except whatever they already downloaded. No explanation unless
one is built.
**Rights-holder:** no new copies leave the site. Copies already downloaded are
unaffected, and the buyer still believes they hold a licence.
**Cost to build:** the least. `5d6`'s issuance reads `Order` + buyer identity
+ `isSellable(media)` and refuses on a blocker — one call, the same shape
`publicOffer` already uses. The already-minted URL is a separate matter (see
D): a presigned URL is a signature over a key and an expiry, and refusing to
*mint* one does nothing to one already minted.
**Agrees with:** `yzo7`, `nffp`, `pgpq` by the letter — re-evaluate at the
read. The checkout note on `p3v` points the same way for the pre-payment
window.
**Conflicts with:** what the buyer was promised. `/licence` ("Buying an
original", `src/app/licence/content.ts`): "A purchase grants the use described
in those terms; it does not transfer the copyright." Nothing on that page or on
the offer (`src/components/media/purchase-offer.tsx`: "the price for the
original file under the terms on the licence page") says the grant is
conditional on anything after payment. Conflicts with B.1.7/B.1.8's framing of
withdrawal as stopping *new* sales, with E.2's assumption that a buyer licence
has a life of its own, and — on calendar lapses — with `mqh8` in the same way
as A. On the day `fw5` merges, every past buyer loses re-download at once.
**What it protects is small.** The bytes most buyers wanted have already left
with the first download. What B withdraws is the *re-download*, which `5d6`
has not even decided to offer ("re-issuing a new link after expiry … is an
open question, not decided here").

### C — Honour the sale

**Buyer:** what they paid for, on the terms shown at the time, including
re-download for whatever window `5d6` eventually decides. The sale is a
completed contract and the site performs it.
**Rights-holder:** no *new* sales — the offer disappears on the next read
(`yzo7`, already shipped) — but every existing buyer keeps their licence and
their access. If the lapse was a genuine rights failure (the uploader did not
hold the rights; a depicted person did not consent), the site goes on
delivering a file it now knows it should not have sold, until an admin
intervenes by hand.
**Cost to build:** small, and almost all of it is a *snapshot* rather than a
gate. The `Order` row (`f3a`) records the sellability verdict, the review id
and `checklistVersion` it was taken under, and the licence terms shown
(`74w.1` already asks for the last of these). `5d6`'s gate reads
`Order.status`, buyer identity and the snapshot — not the live gate. A
per-order hold flag that an admin can set (for the genuine-failure case) is
the one extra column, and it is also what makes a manual A possible later.
**Agrees with:** B.1.7/B.1.8 (withdrawal stops new sales; existing licences
per the survival clause), E.2 (a buyer licence outlives the instrument), C.2.7
(the expected action on existing buyers is *notify*), `74w.1` (snapshot on the
order), `mqh8` (no automatic cascade onto other people's completed things),
and `/licence`'s promise as written.
**Conflicts with:** the letter of `yzo7`/`nffp`/`pgpq`. The distinction in §3
has to be written down: those re-evaluate whether the site may *act*; a sale
is an act completed. Without that sentence, C reads as an exception nobody
justified. **Second cost:** C has to say what the site tells a buyer when a
genuine failure *is* found — "notify where feasible" needs a buyer e-mail on
the order and a sentence somebody is willing to send.

### D — Honour the sale until the already-issued URL expires

**Buyer:** depends on timing. A buyer who downloaded within the window is
unaffected; one who comes back after it gets nothing, with no refund. Two
buyers of the same item on the same day can end up with opposite outcomes
depending on when they clicked.
**Rights-holder:** the same as B after the window closes.
**Cost to build:** the same as B — in fact it *is* B, described honestly.
Refusing to mint a new URL is the lever `5d6`'s scope gives it; invalidating
a URL already minted means rotating the signing credential or moving the
object, either of which also invalidates every other URL signed the same way. So "honour until the URL expires"
is not a policy anyone chooses; it is what B does whether or not anyone
chooses it.
**Agrees / conflicts:** as B. What it adds is that it names the window, which makes the arbitrariness visible rather than removing it.

### The shape of the choice

B and D collapse into one mechanism. A and C are the two options with a
coherent story for the buyer, and they differ on *who decides*: A unwinds the
sale on the strength of the gate, C keeps it unless a person decides
otherwise. Reading §1 against that: the gate's most common future blockers
(`checklist_version_retired`, `clearance_expired`) carry no decision about any
file, so an automatic A or B triggered by them acts on buyers without anyone
having formed a view — the thing `mqh8` declined to do with far less at
stake.

---

## 5. The legal dimension — what the repo has established, and what it has not

Stated within the author's competence: quoted where the repo has said it,
named as an open question where it has not. The standing decision on counsel
(`ugcportal-ryd`: "We do not need counsel or engage counsel") means these
questions will be answered by the operators, so they are put in a form the
operators can answer.

**What the repo has established, and the decision can lean on:**

- *The licence to the operator must say what happens to buyers.*
  `instagram-resale-rights-checklist.md` B.1.7 and B.1.8 make a survival
  clause and a withdrawal clause mandatory elements of the uploader's
  instrument, and E.3 says the buyer licence "must mirror" the survival
  clause. On this site the uploaders are the two operators (`tfub`), so the
  "instrument" is in practice the operators' own written position — which is
  to say, whatever §11 records.
- *Sublicensing needs express permission.* B.1 cites åvl § 68(1) via Lovdata:
  transferred rights "kan ikke overdras videre uten samtykke fra opphaveren".
  A buyer's licence exists at all only because the uploader's clearance
  expressly allowed resale. That cuts both ways: it is why a lapse *feels*
  like it should reach the buyer, and why the checklist insists the terms of
  survival be written rather than inferred.
- *What the buyer is promised today.* `/licence` says a purchase "grants the
  use described in those terms; it does not transfer the copyright", and
  that per-item terms "will be shown with it before you pay". Neither page
  nor offer mentions revocation, refund, or any condition subsequent. If the
  decision is anything other than C, the promise has to change *before* the
  first sale, and `/licence` is already in draft pending re-sign-off
  (`src/lib/legal/contact.ts`, `LEGAL_SIGN_OFF` still carries the pre-`yzo7`
  digest; `ugcportal-xh4j`, in progress, re-records it).
- *On a depicted person's objection, the expected action is notify.* C.2.7
  and B.1.14, quoted in §3.

**What the repo has not established, so the decision has no footing in the repo for:**

1. **Whether a granted licence can be unilaterally withdrawn by the licensor
   after payment, and on what terms.** Nothing in `docs/legal/` addresses
   it. B.1.7 asks the instrument to answer it; no instrument exists.
   *Operator-answerable:* write the chosen rule into `/licence` and into the
   per-item terms (`74w.1`) so that the buyer agreed to it at purchase. A
   rule the buyer agreed to is on firmer ground than one applied to them
   afterwards, whichever rule it is.
2. **Whether the buyer is a consumer, and what follows if so.** The repo does
   not say who buys; `grep -rni "angrerett\|forbrukerkj" docs src` returns
   no line outside this document. Norwegian consumer-protection rules on distance sales and digital
   content may bear on whether a completed sale can be withdrawn or must be
   refunded, and the answer differs for a business buyer. *Not
   operator-answerable from the repo.* This is the one place the author
   would ordinarily say "ask a lawyer"; given `ryd`, the honest alternative
   is to pick the option with the least exposure in *either* reading — which
   is the one that does not take the buyer's money and withdraw the good
   (i.e. not B/D), and does not move money on an automatic trigger (i.e. not
   an automatic A).
3. **What the operator owes a buyer when the sale turns out to have infringed
   someone's rights.** The checklist covers the uploader's warranty to the
   operator (B.1.9) and the operator's duty to the depicted person (C.2.7).
   The operator's position toward the *buyer* in that case — refund, notice,
   nothing — is not written anywhere. Option C makes this question live;
   options A/B avoid it by unwinding the sale.
4. **Whether "stop new sales, keep existing licences" is an adequate response
   to a GDPR erasure or objection request from a depicted person,** where the
   personal data is now in a buyer's hands. C.2.7 says "notify Buyers"; it
   does not say more. `ugcportal-yck` (deferred) and `ugcportal-qnq9.5`
   (open) own the erasure and objection paths and neither mentions buyers.

None of these blocks the decision. They bound it: a rule that is written into
the buyer-facing terms before the first sale, that does not act on buyers
automatically, and that leaves a human able to unwind a specific sale when a
specific thing is learned, is defensible under every reading above. A rule
that acts automatically on calendar lapses is hard to defend under any.

---

## 6. Cheap now, expensive later

`f3a` and `5d6` are unbuilt. A decision taken now is a line in their
acceptance criteria. A decision taken after they ship is a migration, a
rewritten gate, and — for A — a refund feature retrofitted onto orders that
were not designed to be unwound.

| Option | If decided now | If decided after `f3a`/`5d6` ship |
|---|---|---|
| **A** | `Order.status` gains `REFUNDED`; a refund bead is filed (today none exists); the fulfilment gate reads `status` and a hold flag. The refund mechanism itself can still be deferred; what is needed now is the *columns* and the *criterion*. | A refund bead, a migration adding `status` values and a hold flag, a rewrite of the issuance gate, and reconciliation with `aj2`/`qnq9.6`, which will have been reading `Order` without a refund state. |
| **B / D** | One line in `5d6` K1: issuance also requires `isSellable(media)` at request time. Cheapest criterion to write. | One added call in the issuance route, plus the buyer-facing explanation that did not exist. Technically cheap at any time; the cost is in what it does to buyers on the first calendar lapse, and that cost is paid *by them*, after the fact. |
| **C** | `Order` carries a snapshot (verdict, review id, `checklistVersion`, terms shown — the last already wanted by `74w.1`) and a nullable `fulfilmentHoldReason`. `5d6`'s gate reads `status`, buyer, hold. | A migration backfilling a snapshot nobody recorded. The uploader half of a past verdict is replayable from `ResaleRightsEvent` (the one event model in `prisma/schema.prisma`); the per-file half — triage answers on `MediaListing`, `MediaRightsClearance` rows, which cascade on delete — has no event log, so once it changes the sell-time verdict is a guess. This is the option that is cheap now and not recoverable later. |

Whichever is chosen, the cost of **not** deciding is already visible: `p3v`
carried the checkout re-evaluation as a note for 18 days and it is not a
criterion today (§2). Fulfilment will inherit the same fate unless `5d6`'s
description cites §11 of this document.

---

## 7. The gate condition `ugcportal-5d6` must read (K2)

`dabx` K2 requires that `5d6`'s gate "reads more than the existence of an
Order row" and that `5d6`'s description cite the decision. The criterion text
below is written so it can be pasted into `5d6` once §11 is filled; the
parts in brackets are what the choice selects.

**Common to every option** (and already implied by `5d6` K2):

> K4: Given a request for a download URL, when the handler runs, it refuses
> unless an `Order` row exists for this media item whose `status` is `paid`
> **and** whose `buyerUserId` equals the requesting session's user id **and**
> [the option-specific condition below holds]. Refusal mints no URL.
> Verified by: a route test seeding a paid order plus the lapsed state the
> option names and asserting the chosen behaviour; then mutating the FIXTURE
> — restore the clearance — and asserting the behaviour flips, so the
> assertion is connected to the lapse (the mutation `dabx` K1 specifies).

**Option-specific condition:**

- **A:** `Order.status` is `paid` (not `refunded`) **and** `Order.fulfilmentHoldReason` is null. A lapse of the clearance does not by itself change either; an admin action does, and that action is its own bead.
- **B / D:** `isSellable(media, now)` is true at request time, where `media` is loaded with `MEDIA_GATE_SELECT`. A lapse of any kind refuses issuance from the next request; URLs already issued run to their expiry.
- **C:** `Order.fulfilmentHoldReason` is null. The live gate is **not** consulted; the order's recorded snapshot (`sellabilityVerifiedAt`, `reviewId`, `checklistVersion`, `termsShown`) is what the sale stands on. A lapse of any kind leaves issuance unchanged until an admin sets the hold, which is its own bead and surfaces on the admin rights screen the way `mqh8` surfaces affected items.

**And in `ugcportal-f3a`**, whichever option: the `Order` row records, at
creation, the gate's verdict and the review id and `checklistVersion` it was
taken under. Under C this is the thing fulfilment reads; under A and B it is
the thing that lets anyone later answer "was this sold lawfully at the time",
which `aj2` and a buyer dispute both need and which, for the per-file half,
has no event log to be rebuilt from (§6).

**And in `ugcportal-p3v`**, regardless of this decision: the checkout-time
re-evaluation currently in its notes should be restored as a criterion. It is
not this bead's to write, so it is recorded here as the §2 finding.

---

## 8. Which existing decisions each option would have to amend

Stated so a reader can see the blast radius of each choice in the record, not
only in the code.

| Option | Documents or beads whose recorded wording would need a change |
|---|---|
| **A (automatic)** | `mqh8`'s no-automatic-cascade reasoning (in `alcohol-commerce-public-visibility.md` §2) would need a stated exception for sales; `f3a`'s "refund handling out of scope"; `/licence` "Buying an original"; B.1.8's "stops *new* sales" default. |
| **A (manual, admin-driven)** | `f3a`'s refund exclusion; nothing else in §3 is contradicted by it — it is C plus a button. |
| **B / D** | `/licence` and the offer text (the grant becomes conditional); B.1.7/B.1.8/E.3's survival framing and E.2's retention assumption; `mqh8` on calendar lapses. |
| **C** | `yzo7`/`nffp`/`pgpq` need one sentence distinguishing an act from a completed act (§3); `74w.1` gains the snapshot requirement; `manual-upload-rights-review.md` §2's E.3 replacement text should regain the buyer sentence before `fw5` applies it. |

---

## 9. Recommendation — the author's, not the decision

If the analysis above is right, the option that fits what the repo has
already decided, costs least now and most if deferred, and is defensible
without counsel under every reading in §5 is:

**C as the rule the gate applies, with a manual A available to an admin per
order.** Fulfilment reads the order, the buyer and a hold flag; a lapse of the
clearance stops new sales (already shipped) and otherwise changes nothing
until a person decides it should. When an admin sets the hold — because
something was learned about the file or the uploader — the affected orders
are listed for that admin the way `mqh8` lists affected items, and refunding
is a further action on that screen, not a consequence of the gate.

**The costs of this recommendation, stated rather than discovered later:**

1. **It continues delivery after a genuine rights failure until a human
   acts.** If an uploader never held the rights, or a depicted person did not
   consent, every existing buyer keeps re-downloading until an admin sets the
   hold. On a two-operator site with no external objection path
   (`qnq9.5` open) the human in question may not hear about the failure for
   some time. The mitigation is that the *offer* is already gone (`yzo7`), so
   the exposure is bounded to buyers who already hold the file — but it is
   not zero.
2. **It contradicts the read-path family by the letter** and so needs the §3
   distinction written into `src/lib/sellable-media.ts` or wherever `5d6`'s
   gate lives, or the next reviewer will file it as a defect.
3. **It needs a buyer-notification sentence and an admin surface**, neither
   of which exists or is in a bead. C.2.7's "notify Buyers" is an obligation
   the repo has already written down and this option is the one that makes
   it operative.
4. **It leaves refunds unowned** unless the manual-A bead is filed alongside
   it. "An admin may refund" is cheap to say and not cheap to build
   correctly against a Stripe webhook.
5. **It takes a legal position without counsel** — that a sale completed in
   good faith is performed even when the operator's own permission has since
   lapsed. §5 argues this is the *least* exposed position, not that it is
   free of exposure.

The author considered recommending B on the strength of the three read-path
precedents and rejected it on §1: the lapse that will actually happen first
(`fw5` retiring the checklist version) says nothing about any sale, and a rule
that cuts off every past buyer on that day is one the operators would have to
explain to each of them. If the product owner weighs the rights-holder's
position more heavily than this document does, B is the honest form of that
view and D should not be chosen in its place.

---

## 10. What this deliberately does not decide

- Whether `5d6` offers re-issue at all, and self-serve or support-mediated —
  `5d6`'s own stated open question.
- Refund mechanics — unowned (`f3a`), to be filed if A in any form is chosen.
- The buyer-facing terms text — `/licence` and its sign-off (`ugcportal-xh4j`
  per `74w.1`'s out-of-scope line), and per-item terms (`74w.1`).
- The objection path that would make the external lapse visible —
  `ugcportal-qnq9.5`.
- The pre-payment window between session creation and the webhook — `p3v`'s
  concern, see §2.
- Who may sell — `ugcportal-tfub`, decided.
- An unsold public item whose clearance lapses — `ugcportal-nffp`, decided.

---

## 11. Decision

Blank until the product owner fills it. Once filled, `ugcportal-5d6`'s
description cites this section, `ugcportal-f3a` gains the snapshot criterion
from §7, and the beads §8 names for the chosen option are updated.

| Field | Entry |
|---|---|
| Option chosen (A / A-manual / B / C / D) | |
| Reasons, in the decider's words | |
| What changes in `/licence` before the first sale | |
| Decider (name, role) | |
| Date | |
| Notes | |
