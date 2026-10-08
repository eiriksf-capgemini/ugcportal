# Upload rights attestation

**Attestation version:** `2026-10-08.1`

The questions every uploader answers about every file, at the moment they
upload it. Filed from `docs/legal/manual-upload-rights-review.md` §3.1 and
built as `ugcportal-15r`.

## 0. Why this document exists

Before this, every per-upload rights fact the sellability gate read was an
**administrator's** assertion about a file the administrator did not make —
the `MediaListing` triage flags. An administrator looking at a landscape
cannot know whether the person who uploaded it took it. The only person who
can know was never asked anything.

An attestation is **not proof**, and nothing here should be read as saying it
makes a file safe to sell. A dishonest uploader will tick the box. Its value
is narrower and still worth having:

1. it converts silence into a warranty the operator can rely on and, if
   false, act on;
2. it makes the honest-but-careless uploader stop and think ("did I actually
   take this?");
3. it is the input the administrator's triage needs — triage then *confirms*
   a declaration rather than originating one, and a disagreement between the
   two is a signal somebody can look at.

## 1. The version string

The version above is the identity of **this set of questions, as worded
here**. It is sent by the browser with every upload — not stamped by the
server — because the browser is the only side that knows which text the
uploader actually read. A tab opened before a revision shows the old
questions, and stamping the new version on its answers would record that the
uploader was asked something they never saw.

`src/lib/attestation.ts` holds the matching constants:

| Constant | Meaning |
| --- | --- |
| `CURRENT_ATTESTATION_VERSION` | the version above, stamped on new attestations |
| `ACCEPTED_ATTESTATION_VERSIONS` | every version a *past* attestation may still rely on |

**Bump this string whenever a question is added, removed or narrowed.** A
pure wording fix that leaves every question meaning the same thing does not
need one. Retiring a version — dropping it from
`ACCEPTED_ATTESTATION_VERSIONS` — makes every upload attested under it
unsellable (`attestation_version_retired`) until its uploader answers the new
text. That is the intended blast radius, and the same one
`ACCEPTED_CHECKLIST_VERSIONS` carries on the administrator's side: the
alternative is selling under a declaration that never asked the question the
revision added.

`src/lib/attestation-text.test.ts` asserts that this file and those constants
agree, and that the questions below are exactly the ones the code asks. The
rule "bump the string when the form changes" is otherwise one no code
enforces — which is precisely how the admin-side checklist version drifted
once already.

## 2. The questions

The first is a three-way choice. The other eight are yes/no, with **no
default**: a question nobody answered is not a "no", and the upload is
refused rather than stored with a blank.

### 2.1 On what basis can you grant a licence to this file?

> *Everything else follows from this one. If neither of the first two is
> true, there is nothing for you to grant and the file cannot be offered for
> sale.*

- **I am the author — I made it.** (`AUTHOR`)
- **I hold a written licence from the author.** (`LICENSED_FROM_AUTHOR`)
- **Neither.** (`NEITHER`)

`NEITHER` blocks the sale outright (`attestation_rights_disclaimed`). No
administrator clearance settles it: the fix is a different file, not a
signature.

### 2.2 This file is my own original — I did not save it from a website.

> *Re-uploading someone else's picture is the single most common way a stock
> library ends up selling a licence it never had.*

### 2.3 It shows one or more identifiable people.

> *Åndsverkloven § 104 means a photograph of a person may not be displayed
> publicly without their consent, and GDPR treats their image as personal
> data.*

### 2.4 Someone shown in it is under 18.

> *Consent has to come from a guardian, be specific and written, and name
> online publication. Answer yes if you are not sure of someone's age.*

### 2.5 It contains music I did not create.

> *A recording carries at least two separate rights, and neither of them
> travels with the file.*

### 2.6 Someone other than me contributed creatively — a co-photographer, a stylist, an artwork or mural as the main subject.

> *A co-creator is a co-owner. An artwork that is the main subject of a
> photograph is its own author's work, even where it stands in a public
> place.*

The artwork half comes from §3.4 of the review: åndsverkloven § 24 lets works
permanently placed in public be depicted, but not where the work is clearly
the main motif and the reproduction is exploited commercially — which is
exactly the stock-photo case.

### 2.7 It was made for a brand, or under a sponsorship.

> *A brand agreement usually says who may sell the result, and
> Forbrukertilsynet requires any item a benefit was received for to be
> labelled.*

This is the **resale** question, not the labelling one. Whether an item must
carry an advertising label is `MediaAdvertisingDisclosure`, a separate record
with a separate answer: an item can be perfectly sellable and still need a
label, and an unsellable item is not thereby an advertisement.

### 2.8 It is wholly or partly AI-generated.

> *A wholly generated image very likely has no copyright holder at all, so
> there may be nothing to license — and a buyer paying for a photograph is
> being sold something different.*

§3.6 of the review: åndsverkloven § 2 protects works that are the author's
own intellectual creation and § 23 protects a *fotografisk bilde*, which a
diffusion-model output is not.

### 2.9 I am 18 or older.

> *Under vergemålsloven a licence granted by someone under 18 is at best
> voidable. Nothing here verifies your age; this is your own declaration.*

An explicit "no" blocks the sale (`attestation_uploader_not_adult`).

**NOTHING VERIFIES THIS ANSWER.** `User` has no date of birth, and the OAuth
providers assert no age. §3.2 calls self-declaration the pragmatic floor and
leaves "is it a sufficient floor" as a question for counsel. Whether the
person attesting has the legal **capacity** to grant anything is
`ugcportal-5pik`; identity and age verification beyond self-declaration is
`ugcportal-ryd`.

## 3. What the gate does with the answers

`evaluateSellability` (`src/lib/resale-rights.ts`) refuses an upload when:

| Blocker | When |
| --- | --- |
| `attestation_missing` | no attestation at all — every upload made before this existed, and anything a future second write path creates without one |
| `attestation_incomplete` | a row with an answer missing or of the wrong shape (not reachable through the upload form; a data fault) |
| `attestation_not_by_uploader` | the declaration names somebody other than the file's own owner |
| `attestation_version_retired` | a version no longer in `ACCEPTED_ATTESTATION_VERSIONS` |
| `attestation_rights_disclaimed` | authorship is `NEITHER` |
| `attestation_uploader_not_adult` | the uploader declared they are under 18 |

**The gate deliberately acts on none of the six content answers** (2.3–2.8).
Those are the same questions the administrator's triage asks, and what it
means when the two disagree — uploader says "yes, there is music", triage
says no — is not decided anywhere yet. Taking the stricter of the two would
be a policy nobody chose, written into a function whose every other rule is
written down. The answers are stored and attributed so the disagreement can
be *seen* (`ugcportal-vlnn` renders them side by side); deciding what it
*means* is `ugcportal-9pic`.

## 4. What is stored, and for how long

One `MediaAttestation` row per file: the nine answers, the version above, when
it was given, and who gave it. Every answer column is `NOT NULL` with no
default, so there is no half-attested row — "not asked" is the absence of the
row, which nothing can coerce into a row of "no"s.

Nothing backfills. An upload made before this existed has no attestation and
is therefore not sellable, which is the honest state: nobody asked its
uploader anything, and inventing an answer would be the system warranting
rights on a person's behalf. No code path offers to re-attest an old upload.

The row is deleted with the file and with the account (`onDelete: Cascade` on
both edges — see the delete-cascade runbook in `docs/access-control.md`).
