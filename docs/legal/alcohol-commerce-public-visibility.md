# When a commercial fact arrives on an item that is already public (alkoholloven § 9-2)

**Bead:** `ugcportal-pgpq` (found by the `ugcportal-l9qx` system review, §5.1)
**Decides:** what happens when a benefit declaration or a commercial link is
recorded against a `Media` row whose `publishedAt` is non-null while its
`MediaListing.depictsAlcohol` is anything other than a recorded `false`
**Code:** `src/lib/alcohol-commerce.ts`
(`isAlcoholUnclearedAdvertisement`, `PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE`),
spread into `PUBLIC_MEDIA_RIGHTS_SCOPE` in `src/lib/publishability.ts`
**Date:** 2026-10-12
**Status:** **decided** by the product owner and implemented. Revisable, which
is why the rejected options and their reasons are written down rather than
only the one that won. This document is not legal advice.

---

## 0. The one-paragraph version

Alkoholloven § 9-2 forbids advertising alcoholic drink, and since 13 September
2024 it is administratively finable. This product's reading of it
(`docs/ugc-research.md` §3.1a) is that nothing commercial — a price, a
recorded benefit, an advertising label, an affiliate link — may sit on a
picture in which alcohol is visible or clearly evoked. The question "does this
picture show alcohol?" is answered by an admin triage, and most uploads have
never been triaged at all. The product therefore has to decide what to do when
the *commercial* half of that forbidden pair arrives on an item that is
already public and whose alcohol question nobody has answered. **It serves the
item no longer.** The write succeeds, `publishedAt` is untouched, and the
public feed stops returning the row until the question is answered `false`.

---

## 1. The defect this answers

Driven live at `origin/main` `d23add1` and again at `b592ba0` with the real
route handlers, in this order:

| # | request | status |
|---|---------|--------|
| 1 | `POST /api/media/[id]/publish` — attested, no listing, no disclosure | `200` |
| 2 | `PUT /api/media/[id]/disclosure` — `benefitReceived: true`, a permitted label, a brand recorded `alcoholLinked: false` | `200` |
| 3 | `POST /api/media/[id]/commercial-links` | `201` |
| 4 | *control:* `POST /api/media/[id]/publish` again, on that same state | `400 { field: "depictsAlcohol" }` |

After step 3 the row was public, `MediaListing` did not exist, and
`listPublicMedia` served the item with `advertisingDisclosure.label` set and
one live affiliate link. Step 4 shows the product refusing the exact state
step 3 had just produced.

Every individual diff was correct. `benefitAttachmentRefusal` reads the
alcohol answer permissively **on purpose** — refusing an unanswered item at
the write would make the advertising label unrecordable until an admin got
round to the photograph, and the label is itself a legal requirement
(Forbrukertilsynet, §3.2), so being stricter there produces the worse breach
of an undisclosed advertisement. The disclosure and commercial-link routes
write no `publishedAt` and read none. And `commercialPublishRefusal`, the
backstop that refuses the pair, had exactly one non-test caller — the publish
route — so it only ran on a publish *request*. Three correct parts, one order
nobody had gated.

## 2. The three options, and why C

**A — refuse the write.** Answer `409`/`400` to the disclosure and the attach
when the row is already public and the alcohol question is unanswered.

**B — depublish in the same transaction.** Accept the write and clear
`publishedAt` alongside it.

**C — judge the pair on the read path.** Accept the write, leave
`publishedAt` alone, and stop serving the row until the question is answered
`false`.

**The decision is C.** Four reasons, recorded so the decision is auditable:

1. **It matches two precedents already in this repo rather than inventing a
   third policy.** `ugcportal-nffp` moved the rights reading to the read path
   for exactly this shape of problem — a condition that stops holding with no
   write to the row. `ugcportal-74w` K5 and `ugcportal-yzo7` re-evaluate
   sellability at render for the same reason: a stored flag proves nothing
   after the moment it was written.
2. **It is the only one of the three robust to orderings nobody has
   enumerated.** A and B each catch one write path. C evaluates the pair
   whenever the item is served, so a future route that sets a benefit or
   attaches a link is covered without being told about this bead.
3. **It avoids A's recorded contradiction.** `benefitAttachmentRefusal` reads
   alcohol permissively on purpose, and `depictsAlcohol` is only ever answered
   by an admin triage — so A strands an owner behind somebody else's queue for
   a label the law may require them to display.
4. **It avoids B's contradiction with `ugcportal-mqh8`,** which decided the
   adjacent brand-flip case as *list it for the admin, no auto-unpublish*.
   Clearing `publishedAt` from under an owner is the thing that decision
   refused; doing it here would overturn it from the other side.

### The comparison point: `ugcportal-mqh8`

That bead asked the same shape of question about a different fact — a brand
recorded as alcohol-linked *after* items from it were published — and answered
it differently: the admin brand screen lists the affected published items and
**nothing is unpublished**
(`src/app/admin/settings/rights/brands/page.tsx`, "K2'S NEEDING ATTENTION IS
READ, NOT WRITTEN").

The two answers are consistent, and the difference is which half of § 9-2 is
in question:

- **The depiction half** (this document) is a fact about the photograph that
  nobody has established. The honest state is "we do not know", and the
  fail-closed answer to "may we show an advertisement we have not checked?" is
  no.
- **The brand half** (`mqh8`) is a fact about a third party that an admin has
  just *changed their mind about*. Auto-unpublishing on it would mean one
  admin edit silently withdrawing an arbitrary number of other people's
  published work, with no review of whether the flip was right.

So the read-side filter this bead adds covers the depiction half **only**.
The brand half stays where `mqh8` put it: refused at the write paths, refused
at the next publish request, surfaced on the admin screen, and *not* filtered
at read. That split is not left to this paragraph — it is enumerated as two
deliberate predicate/filter disagreements in
`src/lib/alcohol-commerce.scope-agreement.test.ts`, so reversing it in either
direction is a test failure rather than a discovery.

## 3. What this costs, stated rather than discovered later

**Under option C the item becomes publicly invisible without the owner being
told why.** They published something, declared a gift honestly, and the item
quietly left the gallery. That gap is `ugcportal-bk57` — an owner library
screen showing why an upload cannot be published — which already exists as a
bead and is **not** in this one's scope. Recording the dependency here means
the silence is a known, owned cost rather than an oversight.

The route out exists and is short: an admin answers the alcohol question
`false`, and the item reappears on every public surface on the next request,
with its label and its links. That reappearance is asserted, not assumed —
`src/lib/alcohol-commerce.read-path.test.ts` drives the three real requests,
watches the item leave all six readers, records the answer, and watches it
come back.

## 4. Two expressions, pinned — and why that was the hard part

`ugcportal-0epl` records the standing hazard here: the publishability rule is
already expressed twice, as a TypeScript predicate and as a Prisma `where`,
and **two of its checks are not expressible as a Prisma filter at all**, which
leaves the SQL side looser than the predicate in exactly those two ways.
Adding a third silently-divergent expression of a legal-consequence rule is
the failure mode that bead is about.

**Is the § 9-2 pair expressible as a Prisma filter? Yes, completely.** The
condition for *serving* a row is

```
depictsAlcohol = false   OR   (no declared benefit AND no commercial link)
```

and every part of it is a relation filter Prisma can write. The three-state
column is enumerated positively — a missing disclosure row, `false`, `null` —
rather than negated, following the lesson already recorded on
`NOBODY_IDENTIFIABLE_SHOWN` in `src/lib/publishability.ts`: SQL's three-valued
logic makes `NOT (col = 1)` evaluate to `NULL` on a `NULL` column, which is
not true, so a negated arm fails and takes the row with it.

So the pair is expressed in **both** places and pinned to agree:

- one TypeScript predicate, `isAlcoholUnclearedAdvertisement`, extracted from
  `commercialPublishRefusal` so the publish gate and this document's rule are
  the same function rather than two readings of the same sentence;
- one Prisma `where`, `PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE`, a third arm of
  `PUBLIC_MEDIA_RIGHTS_SCOPE` and so of `PUBLIC_MEDIA_SCOPE`, which every
  anonymous reader already spreads;
- `src/lib/alcohol-commerce.scope-agreement.test.ts` runs both over one row
  per state on a real database and compares them row by row, with the two
  deliberate `mqh8` disagreements enumerated rather than excluded.

**Fail-closed is the direction, and it is proved rather than asserted.** Only
a literal `false` counts as an answer, on both sides. A listing that does not
exist, a `null` column, an `undefined` relation and a value that is not a
boolean at all each leave the item unserved;
`src/lib/alcohol-commerce.read-path.test.ts` asserts all four, writing the
non-boolean with raw SQL because no write path in the product can produce it.
This is the same direction `src/lib/resale-rights.ts` takes with
`!(expiresAt > timeOf(now))`, and for the same reason.

## 5. What this deliberately does not decide

- A brand flipped to alcohol-linked after publication — `ugcportal-mqh8`,
  decided, see §2.
- An owner withdrawing a disclosure from a public item — `ugcportal-rh9q`.
- An admin triage flipping `depictsAlcohol` to `true` behind a price or a
  recorded benefit — `ugcportal-n0vq`, `ugcportal-6uxv`.
- Telling the owner why their item vanished — `ugcportal-bk57`, see §3.
- The two checks `PUBLIC_MEDIA_SCOPE` cannot express — `ugcportal-0epl`. This
  bead accounts for that constraint (§4); it does not close it.
- Third-party objections — `ugcportal-qnq9.5`.
- Whether self-service publish-by-default is the right model at all —
  `ugcportal-55nt`.
