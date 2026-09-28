# Rights review: the resale-rights checklist against a manual-upload product

**Bead:** `ugcportal-9cs` (revisits the process adopted under `ugcportal-zec`; follows `ugcportal-vsm`, which re-anchored the gate to uploaders)
**Reviews:** `docs/legal/instagram-resale-rights-checklist.md` at version `2026-09-27.1`, `src/lib/resale-rights.ts`, `src/lib/resale-rights-review.ts`, `prisma/schema.prisma`, `src/app/upload/`, `src/app/api/media/route.ts`
**Date:** 2026-09-28
**Status:** agent-prepared review for the `ugcportal-zec` process owner. Every "Decision" below is a *recommended* decision; it becomes the process's decision when the process owner ratifies it (see §8). This document is not legal advice and its author is not a lawyer. Where the law is genuinely uncertain, §7 says so and says what counsel needs to be asked; the rest of the document does not repeat that caveat.

---

## 0. The one-paragraph version

The checklist was written for a world where a file arrived because somebody had already published it to their own Instagram account. That gave three things for free: a weak but real signal of authorship (people mostly post their own photos), a written warranty by the poster to *someone* (Instagram's Terms), and a public record the reviewer could look at. Manual upload gives none of them. A signed-in user can drag any JPEG on the internet into `/upload`; the page asks nothing (`src/app/upload/page.tsx:55-58` — "Add images and video to your library"), the API records nothing about rights (`src/app/api/media/route.ts:408-425` writes `userId, kind, key, previewKey, previewId, mimeType, sizeBytes, originalName`), and the clearance that later makes the file sellable is recorded against the *person*, once, covering everything they have uploaded and everything they will upload. The code is fail-closed and well built; the problem is that several of the questions it enforces answer a premise that no longer exists, and the questions that *would* discriminate an honest uploader from a dishonest one are asked of the wrong party (the admin, who cannot know) or not asked at all.

Nothing is sellable today — no code path writes a `MediaListing` except the price endpoint, and `ugcportal-74w` has not shipped — so every gap below can still be closed before the first clearance is recorded. That is the window this review is written for.

---

## 1. The four gaps named in the bead, decided

The bead lists four concrete gaps and asks for an explicit decision on each: amend, add, or accept-as-is with a reason.

### Gap 1 — nothing asks on what basis an uploader warrants rights in material they have not uploaded yet

**Decision: AMEND B.1.2 and ADD a scope field to the record and the gate.** A clearance covers, by default, only uploads that existed at the moment the reviewer signed — because those are the only ones the reviewer could have looked at and the only ones an instrument that lists or dates its works can cover. A clearance may cover future uploads only if (a) the instrument is expressly a framework licence over future works, which under åvl § 67(2) (the specialty principle — nothing transfers beyond what "tydelig følger av avtalen") has to be written as such, and (b) the reviewer positively records that reading on the row. Either way the per-upload triage (Part E.3 item 5) still runs.

Why not accept-as-is with "set `Valid until` short": because the code cannot tell the two cases apart. `evaluateSellability` loads `userId`, `user.resaleRightsReview` and `listing` (`src/lib/resale-rights.ts:222-244`) and never reads `Media.createdAt`. A clearance signed on 1 March covers a file uploaded on 30 November identically to one uploaded on 28 February. The reviewer's only tool is the free-text `conditions` column (see §5), which nothing enforces. The bead's own K2 says a clearance must never authorise material the reviewer could not have examined "without a human having decided that is acceptable and on what basis" — today the human cannot record that decision anywhere the gate reads.

Trap for whoever implements it: `reviewedAt` is overwritten on *every* admin transition, including an edit to `conditions` (`src/lib/resale-rights-review.ts:256-257` sets `reviewedAt: now` unconditionally in `adminFields`). Anchoring the scope to `reviewedAt` would let a typo fix silently widen the covered window to include every upload since — the same shape of bug `restampChecklist` exists to prevent (lines 54-70). The cut-off must be its own column, set deliberately.

Filed as `ugcportal-aqw`.

### Gap 2 — no re-review interval; `validUntil` is optional and a blank means forever

**Decision: ADD a mandatory maximum, enforced in code, at 12 months.** The checklist already recommends "≤ 12 months" (Part D, `Valid until`). The code honours a null forever (`src/lib/resale-rights.ts:356` — the expiry branch is skipped entirely when `validUntil` is falsy), the form labels the field optional (`src/app/admin/settings/rights/decision-form.tsx:134-135`), and the error copy actively recommends the perpetual option: *"Leave it blank for a clearance with no end date"* (`src/app/admin/settings/rights/outcomes.ts:12`).

Why 12 months is the right order of magnitude rather than "whatever the contract says": the things that invalidate a clearance are mostly not visible to the operator. A depicted person withdraws GDPR consent to the uploader, not to us. A freelance photographer's agreement with a company uploader lapses. The uploader stops being the person who controls the login. § 69 åvl (reasonable additional remuneration when revenues become disproportionate) is a live risk precisely on long-running open-ended licences. None of these produce an event the system sees; a forced re-review is the only mechanism that catches them.

Enforce it in both places, not one: the single writer (`setResaleRightsStatus`) refuses `CLEARED` without a `validUntil`, or with one more than 366 days after the decision; and the gate treats a null `validUntil` on a `CLEARED` row as expired, so a row written by a migration, a fixture or a future second writer cannot pass. The cost today is zero — nothing is sellable and no clearance can be relied on until `74w` ships.

Filed as `ugcportal-paa`.

### Gap 3 — C.2.1 asks whether an uploader's material "typically" shows identifiable people

**Decision: DELETE C.2.1 as a gate question and REPLACE it with an undertaking question.** Under the old subject, "does this account's feed show people" was a statement the reviewer could verify by scrolling. Under the new subject it is a forecast about a stranger's future photography, and a **No** produces exactly the false comfort the bead worries about: the reviewer ticks it, the uploader's clearance looks people-safe, and the per-upload triage becomes the only control — which it already was. The question buys nothing and costs a misleading record.

What should stand in its place is a question about *capability*, not content: has the uploader undertaken in the instrument (B.1.9 / B.1.10) to declare, per upload, whether identifiable people appear and to supply a release covering third-party commercial resale before that upload is listed; and does the operator actually have a path to receive and store that release per upload? Today it does not — `putRightsEvidence` writes under `rights-evidence/<uploaderUserId>/` and is reachable only from the *uploader-level* decision route (`src/app/api/admin/rights/decision/route.ts`); `MediaListing.modelReleaseKey` is a free-text column nothing populates. `74w` owns that surface and should read this.

### Gap 4 — Part D's separation of duties changed from "independent of the connecting admin" to "independent of the uploader"

**Decision: ACCEPT the new reading, with two amendments.** "Independent of the uploader" is the right control and a stronger one: the conflict of interest in a manual-upload product is an admin putting their own photographs up for sale and clearing themselves, and that is exactly what `selfReview` now detects (`src/lib/resale-rights-review.ts:249-251`).

Amendment one: the detection stops at the uploader-level review. The per-upload triage (`MediaListing.triagedByUserId`) and every per-layer clearance (`MediaRightsClearance.clearedByUserId`) have no self-check at all — the gate never compares either against `Media.userId` (`src/lib/resale-rights.ts:435-472`). So a single admin can upload a photograph of a person, triage it as `depictsPeople = false`, and nothing records that the person asserting "no identifiable people" is the person who took the picture and stands to be paid for it. The `PEOPLE` flag is the one whose `false` sells a photograph of a human being; it is the one that most needs a second pair of eyes. Filed as `ugcportal-uv9`.

Amendment two: state the single-admin policy in Part D rather than leaving "where staffing allows". Recommended wording: a self-reviewed clearance is permitted only with the evidence file attached (which the previous decision makes mandatory anyway) and is *disclosed* — the `selfReview` flag already reaches the admin screen (`src/app/admin/settings/rights/page.tsx`, `selfReviewed`), and it should also reach whatever audit export a future counsel or buyer dispute needs.

---

## 2. Which checklist questions are now wrong, not merely incomplete

A question that silently assumes Instagram provenance returns a confident answer about a premise that no longer holds. These are the ones, individually. "Wrong" here means the item, as worded, either cannot be answered for an uploader or — worse — is answered **Yes** by habit while the risk it stood in for goes unexamined.

| Item | Current wording (short) | Why it is wrong now | What should replace it |
|---|---|---|---|
| §1 Terminology | "Owner = the natural or legal person who controls the connected Instagram account" | There is no connected account in the gate. The gate's subject is `Media.userId`, a `User` row. The document never defines the relationship between that row and the rights holder. | Define three parties: **Rights holder** (who owns the copyright), **Uploader** (the `User` row that uploaded), **Operator**. Part A's job becomes proving Uploader = Rights holder, or Uploader acts for Rights holder under A.3. |
| A.1 | `instagramUserId` / `username` in the `InstagramAccount` row match the licence | No such row is reachable from a review; `ResaleRightsReview.instagramAccountId` is gone (schema, `ResaleRightsReview`). A reviewer will either skip it or tick it. | The `User.id` and login identity (provider + verified email) of the uploader match the party named in the instrument. |
| A.4 | The account is a Business/Creator account "as the API requires" | Meaningless without an account; structurally **N/A** for every uploader, which trains the reviewer to tick through Part A. | Delete. |
| A.5 | The connection was authorised by the Owner, not by an admin using shared credentials | There is no connection. But the risk it guarded — the login being operated by someone other than the rights holder — is *more* live under manual upload, where an admin can create an account for a photographer and upload on their behalf. | The login that uploads is controlled by the rights holder or their authorised signatory (A.3); credentials are not shared with operator staff. |
| A.6 | "The sellable file is supplied by the Owner directly (upload), not taken from the Meta API" | Now true of **every** file by construction (`evaluateSellability` starts at a `Media` row; see the closing comment in `src/lib/resale-rights.ts:474-485`). It is a tautology that returns **Yes** for a file the uploader saved from somebody else's Instagram post — which is "supplied by the Owner directly (upload)". The Platform-Terms question it answered is closed by `ugcportal-2eh`; the question it *hid* — is this the uploader's own original capture or export, not a re-download — is unasked. | "The uploaded file is the rights holder's own original (camera/phone export or master edit), not a copy saved from a website or social platform. Evidence: original resolution, capture metadata, or the uploader's attestation (see §3.1)." |
| A.7 | Instagram deauthorisation revokes the clearance automatically | E.0 says the opposite — disconnecting an account revokes nothing. Nothing external revokes an uploader's clearance; only an admin does. A reviewer following the form will look for a callback that is intentionally absent. | "The events that revoke this clearance are: the uploader asking to withdraw; the instrument terminating; a depicted person's objection; an admin decision. Record who is responsible for acting on each and how they learn of it." |
| B.0 Route 2 / Route 3 | Own-terms acceptance "with a recorded acceptance event"; explicit consent "captured in-product (e.g. a signed consent step during connect)" | Neither flow exists. No creator terms are in the codebase; there is no connect step. Yet the form offers `OWN_TERMS_ACCEPTANCE` and `EXPLICIT_CONSENT` as recordable routes (`RESALE_RIGHTS_ROUTES`, `decision-form.tsx:120-131`). A reviewer can record a route whose instrument cannot exist. | Keep the routes as future options but mark Routes 2 and 3 **unavailable until the acceptance flow ships**; only `CONTRACT` is selectable in practice today. |
| B.1.1 | Parties "with the Instagram handle(s) covered" | Handles identify nothing in this system. | The uploader's account identity (email / provider id) and, for a company, org.nr. |
| B.1.2 | Scope of works: "all posts on the account as of a date, posts the Owner marks in the curation tool, or a listed set" | "Posts" do not exist; "marks in the curation tool" is an admin act, not the rights holder's. Under an uploader subject the *only* honest scopes are: listed files, files uploaded before a date, or an express framework licence over future works. The item does not say which, and the record cannot hold the answer (Gap 1). | Rewrite around the three scopes and require the reviewer to record which one, with the cut-off date where applicable. |
| B.1.10 | "which posts contain third-party creators' work…" | Mechanical: uploads, not posts. And the source of the flag changed — Instagram surfaced collaborators and paid-partnership labels; now only the uploader can tell us. | "…undertakes to declare, per upload, before it is listed." |
| C.2.1 | Uploader's material "typically" shows identifiable people | Gap 3 above. | Undertaking question; see Gap 3. |
| C.2.5 | "accounts whose content is predominantly children are not cleared" | An account-level heuristic with no account. Per upload, the record has no way to say "minor" — `depictsPeople` is a boolean and the `PEOPLE` clearance is free text. | Per-upload: a minor depicted requires guardian consent naming online commercial publication; recommendation stays "do not sell". Needs a field (§3.5). |
| C.3.2 | "Instagram 'Collab' posts: both collaborators are co-authors" | No collab posts. But joint authorship did not go away: a second shooter, a retoucher who made creative choices, a videographer and editor — åvl § 8 fellesverk requires every co-author's consent to license. | Generalise to joint works; ask the uploader to declare anyone else who contributed creatively. |
| C.4.1 | Reels with music from Instagram's library: Meta's licence covers on-platform use only; "excluded, or delivered muted" | Wrong in the direction that matters. Under Instagram, *some* licence existed for the music; under manual upload **none** does — an MP4 with a commercial track has no licence at all. And "delivered muted" is not implementable: the sold file is `Media.key`, the raw original (`src/app/api/media/route.ts:286, 385-394`); there is no transcoding step. A `MUSIC` clearance with the reason "deliver muted" sells the original with the audio in it. | "Any audible music requires a sync and master licence expressly covering resale to third parties, attached as evidence; otherwise the upload is not sellable. 'Muted' is not an acceptable clearance until a transcoded deliverable exists." |
| C.5.2 | Sponsored / paid-partnership posts | The signal (Instagram's label) is gone; the risk is not. | Ask the uploader to declare, per upload. |
| §0.3 | "Treat 'it was public on Instagram' as worth nothing" | Still true; too narrow. The relevant belief now is "it was public on the internet" — and the uploader is the one likely to hold it. | Generalise; move into the uploader-facing attestation text. |
| Part D "Product-decision reference for A.6" | | Stamped automatically as `ugcportal-2eh` (`PRODUCT_DECISION_REF`); harmless. | Keep. |
| §4 Q3 | "separation from the connecting admin" | Gap 4. | "from the uploader". |
| E.3 item 1 | "`ResaleRightsReview.status == CLEARED` for the post's `InstagramAccount`" | Post/account wording; E.0 patches it in a note rather than in the item. The code reads the file's own uploader (`src/lib/resale-rights.ts:411`). | "…for the **uploader** of the file (`Media.userId → User.resaleRightsReview`)." |
| E.3 item 2 | "`validUntil` is null or in the future" | **The one item whose current text contradicts a decision in this review.** Gap 2 decides a null `validUntil` on a `CLEARED` row is *expired*. A revision that rewords Parts A–D and leaves this sentence in place ships an enforcement spec that specifies the opposite of the gate it mandates. | "`validUntil` is set, in the future, and no more than 12 months after the decision; null is not sellable." Plus the new items from §4: evidence present (5), scope cut-off (6), attestation (7). |
| E.3 item 6 | "the post's sellable file is the Owner-supplied original (A.6), unless `productDecisionRef` records a different decision" | Structural now (the gate starts at a `Media` row; `src/lib/resale-rights.ts:474-485`) and the code deliberately offers no `productDecisionRef` bypass. As a checklist item it invites the reviewer to "verify" something that cannot be false. | Move out of the numbered checks into the "Enforcement properties" list as a structural fact, and drop the bypass clause. |
| E.3 "Separation of duties (soft)" | "Warn, and record, if `reviewedByUserId == InstagramAccount.connectedByUserId`" | Contradicted by Gap 4 and by the code, which compares against `uploaderUserId` (`src/lib/resale-rights-review.ts:249-251`). | "…if `reviewedByUserId == uploaderUserId`; and (once `ugcportal-uv9` lands) if `triagedByUserId` or any `clearedByUserId` equals `Media.userId`." |
| E.3 "Revocation cascades" | "Instagram deauthorize callback, admin disconnect, or Owner withdrawal → `REVOKED` → all listings from that account are unpublished immediately" | Contradicted by this document's own A.7 row and by E.0: disconnecting revokes nothing. Also over-claims — a `REVOKED` uploader's files are *unsellable* (status check), but nothing *unpublishes* them (`publishedAt` is untouched; §3.3). | "Admin revocation or uploader withdrawal → `REVOKED` → every file of that uploader fails the gate immediately. Public visibility is a separate switch (`ugcportal-3ae`)." |
| E.3 "Test that must exist" | "creates a synced post for an account with `status` in every non-`CLEARED` state" | Post/account wording. The test exists, against uploads (`ugcportal-vsm` K1). | "creates an upload whose uploader has `status` in every non-`CLEARED` state…" |
| E.1 model, E.2 store | `instagramAccountId`, `rights-evidence/<instagramAccountId>/…`, "set automatically on deauthorize/disconnect" | The proposal has been superseded by the schema as shipped; E.0 says so in a note above it. Keeping the stale proposal under a live heading is what let item 2 survive `ugcportal-vsm`'s bump. | Replace the proposal with a pointer to `prisma/schema.prisma` and keep only what the schema does not say (retention, evidence handling). |

Items not listed are either still correct under the new subject (most of B.1, C.1, C.2.2–C.2.4, C.2.6–C.2.7, C.3.1, C.5.1) or purely mechanical wording. **Part E is not on that list.** E.0's amendment note makes the section readable, but a note above a list does not change what the list says, and the list is what `ugcportal-fw5` will be revising from; the rows above are its Part E scope, and §4 is the target text for E.3.

---

## 3. What the manual-upload path introduces that the Instagram path did not

### 3.1 The uploader may not hold copyright, and nobody asks them

This is the central change and everything else follows from it. Under Instagram the poster had at least (a) warranted to Instagram that they had the rights (Instagram Terms of Use, "you must own or have obtained the rights"), and (b) publicly associated the work with their identity, which is weak evidence but is evidence. Manual upload has neither. The upload page asks for nothing but files; `POST /api/media` accepts a `file` part and nothing else (`UPLOAD_FIELD_NAME`, `src/app/api/media/route.ts:57`). There is no creator-terms acceptance anywhere in the codebase (searched for "terms", "warrant", "I own", "consent" in `src/`; none).

The consequence is structural, not just a missing checkbox. Every per-upload rights fact the gate reads — `depictsPeople`, `containsMusic`, `thirdPartyCreator`, `sponsoredContent` — is **asserted by an admin about a file the admin did not make** (`MediaListing` triage, `prisma/schema.prisma:484-501`). An admin looking at a landscape cannot know whether the uploader took it; only the uploader can say, and the system never asks them to. The checklist compounds this by asking the admin (C.3.1: "Owner has undertaken to flag posts not created by them") — an undertaking that exists nowhere the uploader can give it.

What is needed is an **uploader attestation, per upload, versioned, stored, and read by the gate**: I am the author / I hold a written licence from the author (attach) / neither; the file is my own original, not saved from a website; it shows identifiable people (yes/no); anyone shown is under 18 (yes/no); it contains music I did not create; someone else contributed creatively; it was made for a brand or under a sponsorship; it is wholly or partly AI-generated; I am 18 or older. Admin triage then *confirms* the uploader's declaration against the file rather than originating it, and a disagreement between the two is a red flag the admin sees. Filed as `ugcportal-15r`.

An attestation is not proof. A dishonest uploader will tick the box. Its value is (1) it converts silence into a warranty the operator can rely on and, if false, act on; (2) it makes the honest-but-careless uploader stop and think ("did I take this?"); (3) it is the input the admin's triage needs. Nothing in this review should be read as saying an attestation makes a file safe to sell.

### 3.2 No platform terms sit above the file — and that removes an age gate too

Instagram's Terms required users to be 13+ and, for the professional accounts the API served, effectively adults running a business. ugcportal's `User` has no date of birth, no age gate, and its OAuth providers (Google, Facebook) do not assert age. A.3 says the signatory must be "aged 18+"; nothing verifies it and nothing stores it. Under Norwegian law a person under 18 has limited capacity to contract (vergemålsloven); a resale licence granted by a 16-year-old uploader is at best voidable, and the operator would have been selling licences it could not rely on. Self-declaration in the attestation (§3.1) is the pragmatic floor; whether it is a sufficient floor is a counsel question (§7).

### 3.3 Identifiable people: the trigger is public display, not sale — and display is ungated

This is the finding most likely to bite first, because it does not need a sale to happen. Åvl § 104 prohibits a photograph of a person being "gjengis eller vises offentlig" without consent; GDPR treats an image of an identifiable person as personal data from the moment it is stored. The rights gate is at *sale*. Public display is decided by the owner alone: `POST /api/media/[id]/publish` sets `publishedAt` with no reference to the rights review or the triage, and says so (`src/app/api/media/[id]/publish/route.ts:29-31` — "Sellability is decided independently … neither reads" the other), and the anonymous feed (`GET /api/public/media`) serves every published row with a preview.

So, today: an uploader uploads a photograph of a recognisable person, clicks publish, and a watermarked preview of that person is on an anonymous public gallery operated from Norway with **zero** triage, zero consent recorded, and no attestation — the rights gate never ran because nothing was for sale. Under Instagram this was a lesser problem: the poster had already published the person on their own account, by their own act. Under manual upload ugcportal is the **first and only publisher**, and the controller.

Lawful basis (Art. 6) for the depicted person's data: for storage and internal triage, legitimate interest (Art. 6(1)(f)) with a balancing test is arguable; for public display and for sale to third parties, the checklist's own C.2.4 concludes that consent (Art. 6(1)(a)) is the realistic basis, and Datatilsynet's guidance says consent should be obtained *before* a portrait is shared. That means publish, not just price, needs at minimum the uploader's attestation and — where people are shown — the `PEOPLE` layer cleared. Filed as `ugcportal-3ae`.

Art. 9: a photograph can reveal special-category data — religious dress, a visible disability, a medical setting, an event that implies political opinion or sexual orientation. The CJEU in *OT* (C-184/20, 2022) read Art. 9 to cover data from which a special category can be *inferred*, not only data stating it. Whether an ordinary portrait falls in is uncertain and jurisdiction-sensitive (§7); the practical mitigation is that the `PEOPLE` clearance reason should say whether anything of that kind is visible, and the buyer licence should prohibit facial recognition and profiling (already in C.2.6 and §4 Q4).

Transfers: a buyer outside the EEA who receives a photograph of an identifiable person receives personal data. That is a Chapter V transfer with no mechanism named anywhere in the checklist or the code. Counsel question (§7).

### 3.4 Trademarks, property, and works in the frame

Unchanged in principle from C.5, with one loss and one addition. The loss: Instagram's "paid partnership" label was the only automatic signal of sponsored content; now the uploader must declare it (§3.1). The addition: buildings and artworks. Åvl § 24 lets works permanently placed in public be depicted, but (as this author reads it — verify on Lovdata) not where the work is clearly the main motif and the reproduction is exploited commercially, which is exactly the stock-photo case: a photograph *of* a sculpture, sold. A per-upload declaration of "an artwork, mural or design is the main subject" belongs in the attestation, and the `THIRD_PARTY_CREATOR` layer should be understood to cover it.

### 3.5 Minors — depicted, and uploading

Two separate problems that share a word. **Depicted minors**: Datatilsynet's position is that guardians decide, that the consent must be specific and written and name online publication, and that older children have a say of their own. The record cannot express "a minor is shown": `depictsPeople` is a boolean and the `PEOPLE` clearance is a free-text reason. The checklist's own recommendation — do not clear content that is predominantly children — is right, and needs a field so it can be enforced rather than remembered. **Minor uploaders**: §3.2. Filed together as `ugcportal-qn3`.

### 3.6 AI-generated content

Under either path the question existed; manual upload removes the last cue (a person posting an image on their own feed is at least claiming it). Three distinct problems:

1. **Nothing to license.** Åvl § 2 protects works that are the author's own intellectual creation; § 23 protects a *fotografisk bilde*, which a diffusion-model output is not (nothing was photographed). A wholly AI-generated image very likely has **no copyright holder** in Norway or the EU. The uploader cannot license what nobody owns; the operator would be selling a "licence" that grants the buyer nothing they did not already have — which is a consumer/marketing-law problem with the *buyer*, not an infringement problem with the uploader. A prompt-plus-heavy-editing workflow may cross into protected territory; where the line sits is a counsel question (§7).
2. **Third-party rights inside the output.** Models reproduce training data, trademarks and — especially — real people. An AI image of an identifiable person is still that person's image for § 104 and GDPR purposes; the checklist's Part C applies to synthetic people exactly as to photographed ones.
3. **Disclosure.** The EU AI Act's Art. 50 transparency duties (deepfake labelling) are being phased in and Norway's EEA incorporation timing is uncertain (§7). Regardless of the legal minimum, a buyer paying for a photograph is being sold something materially different if it is synthetic.

The record has no `aiGenerated` fact. It should be an attestation question and a triage flag whose `true` is *not sellable as a photograph licence* unless a human-authorship case is documented in a clearance reason. Filed with §3.5.

### 3.7 Metadata travelling with the file

The original bytes go to the bucket untouched: `Body: buffer` with the client's `ContentType` (`src/app/api/media/route.ts:385-394`). The watermarked preview is clean — sharp never calls `withMetadata()` (`src/lib/watermark.ts:1239-1240`) — but the preview is not what is sold. `Media.key` is (`ugcportal-5d6`). Video receives no processing at all; MP4/MOV files from a phone carry a location atom, creation time and device model.

Three separate consequences, pulling in different directions:

- **Privacy of the uploader and of depicted people.** EXIF GPS in a JPEG shot at home is a home address; a camera body serial number is a persistent identifier across every photo that body ever took. Both leave the platform inside every sold original. Under GDPR that is personal data the operator is disclosing to a buyer without anyone having decided to.
- **Evidence the admin is not shown.** EXIF `Artist` and `Copyright`, IPTC creator fields, XMP rights fields and C2PA/Content Credentials manifests are the nearest thing to provenance a file carries. A file whose embedded `Artist` is a name other than the uploader's is a red flag; a file with a C2PA manifest naming a different signer is a stronger one. Today no code reads any of it, so the admin triaging "third-party creator?" is denied the one piece of evidence sitting in the bytes. Ignoring available evidence of non-ownership is hard to defend after the fact.
- **Rights-management information must not be stripped.** InfoSoc Directive Art. 7 (implemented in åndsverkloven — verify the section) prohibits removing electronic rights-management information. So "strip all metadata from the sold file" is the wrong fix: strip location and device identifiers, *preserve* authorship and copyright fields. The two must be handled separately.

Also: `originalName` is client-controlled and stored verbatim after sanitisation (`route.ts:422`); `IMG_kari_nordmann_wedding.jpg` is personal data about Kari. It is owner-only today (`MEDIA_ANONYMOUS_SELECT` omits it), which is the right default; it must stay out of anything buyer-facing.

Filed as `ugcportal-2m4`.

### 3.8 The same file, two uploaders

Under Instagram a post existed once, on one account. Under manual upload two users can upload byte-identical files and both be cleared. Nothing detects it: `Media.key` is unique only because it embeds a UUID, and no content hash is stored. An exact-hash collision across two uploaders is the cheapest possible "one of these two is not the author" detector and the system does not have it. Filed as `ugcportal-e5x`. P2 — it catches the careless, not the determined (one re-encode defeats it), but it is nearly free.

### 3.9 Revocation has no external trigger

Under the account model, disconnecting the account was a revocation event with a callback (`ugcportal-69p`). Under the uploader model, A.7's replacement (§2) lists the events that should revoke — uploader withdrawal, instrument expiry, depicted person's objection — and **none of them produces a signal the system receives**. There is no uploader-facing "withdraw my work from sale" control, no objection intake, and evidence purge after a user is deleted is still assigned to `69p`, a *deferred Instagram* bead. `prisma/schema.prisma:236` also hands GDPR erasure to `ugcportal-x1a`, a bead that does not exist (`bd show ugcportal-x1a` → not found); the live owner is `ugcportal-yck`. Filed as `ugcportal-ilp`.

---

## 4. What must be true before any item is offered for sale — the re-evaluation, restated for manual upload

`ugcportal-74w` K5 and `ugcportal-p3v` K3 already require `evaluateSellability()` to run at render and at checkout, because `$transaction` does not serialise under `@prisma/adapter-libsql` and a stored price proves nothing. That mechanism is right and this review does not touch it. What follows is what the predicate must *check* once the gaps above are closed — the target contract for `src/lib/resale-rights.ts`, in gate order. Items marked **(today)** are already enforced; items marked **(new)** are not.

For the **uploader** (`Media.userId → User.resaleRightsReview`):

1. **(today)** A review row exists and `status == CLEARED`.
2. **(new)** `validUntil` is non-null, in the future, and no more than the maximum interval after the decision. A null is expired, not perpetual.
3. **(today)** `reviewedByUserId` names a user whose *current* role is `ADMIN`.
4. **(today)** `checklistVersion` is in `ACCEPTED_CHECKLIST_VERSIONS`.
5. **(new)** `evidenceKey` and `evidenceSha256` are set. A clearance with no instrument behind it is an opinion.
6. **(new)** The upload falls within the clearance's scope: `Media.createdAt` is before the clearance's recorded cut-off, **or** the row carries the reviewer's explicit "covers future uploads under a framework instrument" mark. The cut-off is its own column, not `reviewedAt`.

For the **upload** (`Media → MediaListing`, `MediaRightsClearance[]`):

7. **(new)** An uploader attestation exists for this file, at an accepted attestation version, made by `Media.userId` (not by an admin on their behalf).
8. **(today)** A `MediaListing` exists; all four triage flags are real booleans; `triagedByUserId` is a current `ADMIN`.
9. **(today)** `depictsPeople == true` ⇒ `modelReleaseKey` set **and** a `PEOPLE` clearance signed by a current admin. **(new)** If the attestation or triage says a minor is shown, the `PEOPLE` clearance must be a guardian consent, and the default policy is *not sellable*.
10. **(today)** Each of `MUSIC`, `THIRD_PARTY_CREATOR`, `SPONSORED_CONTENT` is `false` or carries its own admin-signed clearance. **(new)** A `MUSIC` clearance whose reason is "deliver muted" is not acceptable while the deliverable is the raw original.
11. **(new)** `aiGenerated == false`, or a clearance documents the human-authorship basis on which a licence can be granted at all.
12. **(new, recorded not blocking)** `triagedByUserId == Media.userId` or any `clearedByUserId == Media.userId` is recorded as self-review and surfaced with the listing, so a buyer dispute can see it.

Anything not listed is either structural (the Option A boundary — the file sold is the uploaded original, by construction) or belongs to the buyer licence (`p3v` §4 Q4), which does not exist yet and which this gate cannot check.

The **publish** path (`/api/media/[id]/publish`) should require items 7 and, where the attestation says people are shown, 9 — not the whole gate, because publishing is not selling, but § 104 and GDPR bite at display.

---

## 5. The gap between what the code enforces and what the checklist asks

A checklist question whose answer is never stored, or stores an answer nothing reads, is a question the process *believes* it is asking. File and line for each.

| Checklist item | Stored? | Read by the gate? | Notes |
|---|---|---|---|
| A.1–A.3, B.2.3 identity and signatory verification | **No.** `User` has `name`, `email`, `image`, `role` (`prisma/schema.prisma:29-37`). No identity-verification fields exist. | No | The only place this can live is the evidence file. Fine, if the evidence file is mandatory (it is not — next row). |
| B.2.1 "Full instrument stored… SHA-256 recorded. **Required: Yes**" | Yes, optionally: `evidenceKey`, `evidenceSha256` nullable (`schema.prisma:375-376`) | **No.** `REVIEW_GATE_SELECT` omits both (`src/lib/resale-rights.ts:202-208`). | The form says "Evidence file (**optional**…)" (`decision-form.tsx:173`). The checklist's floor is above the code's ceiling. A `CLEARED` with no evidence at all is sellable. |
| B.0 route selected | Yes: `route` nullable (`schema.prisma:359`); form default "not recorded" (`decision-form.tsx:125`) | No | Two of the three enum values name flows that do not exist (§2). |
| B.1.2 scope of works | **No.** Nothing relates `Media.createdAt` (`schema.prisma:139`) to any review field. | No | Gap 1. |
| B.1.7 duration / Part D `Valid until` | Yes, nullable (`schema.prisma:370`) | Yes, but null passes (`resale-rights.ts:356`) | Gap 2; UI copy recommends blank (`outcomes.ts:12`). |
| Part D "Conditions attached" | Yes: `conditions` free text (`schema.prisma:371`) | **No.** Rendered on the admin screen only (`page.tsx:276-279`). | Every example condition in Part D — "no posts with identifiable people", "muted video only", "posts before 2025-01-01 only" — is one the gate could never apply. The first is what per-upload triage does anyway; the second is unimplementable (§2, C.4.1); the third is Gap 1. Conditions that restrict *buyer* use belong in the buyer licence, which does not exist. |
| Part D "Independent from the uploader" | Yes: `ResaleRightsEvent.selfReview` (`schema.prisma:438`), written at `resale-rights-review.ts:249-251, 371` | No (recorded and shown; by design soft) | No analogue for `triagedByUserId` / `clearedByUserId` (Gap 4). |
| C.2.5 minors | **No** field | No | §3.5. |
| C.3.1 uploader's undertaking to flag others' work | **No** — no uploader-facing input exists anywhere | No | §3.1. The admin's `thirdPartyCreator` flag is the admin's guess. |
| C.4.1 "delivered muted" | Not representable; deliverable is `Media.key` raw (`route.ts:286`) | No | A `MUSIC` clearance reason is free text; "muted" would pass and the audio ships. |
| C.5.1 buyer licence excludes endorsement / facial recognition | No buyer licence exists (`p3v` open, §4 Q4 open) | n/a | Not this bead's gap, but every "the Buyer licence must…" in Part C currently points at nothing. |
| E.1 `EXPIRED` "set by a job" | Status exists and the **write path already exists with no caller**: `SYSTEM_SETTABLE_STATUSES = ["REVOKED", "EXPIRED"]` (`src/lib/resale-rights-review.ts:40`, enforced at `:191-198`) lets a `source: "SYSTEM"` transition move a row to `EXPIRED` today. Nothing invokes it. | Gate is correct without it — the `validUntil` comparison is the enforcement (`resale-rights.ts:341-361`) | Not a bookkeeping nicety for `ugcportal-paa`: that bead adds *validation* to the writer (no `CLEARED` without a bounded `validUntil`), and the SYSTEM branch is a door in the same writer that skips `adminFields` entirely (`:253-288`). It can only move a row *away* from `CLEARED`, so it cannot fail open — but whoever builds the sweep is adding a caller to an existing door, and the new gate rule (null `validUntil` ⇒ expired) means a sweep is redundant for correctness and useful only for the admin screen. |
| E.2 retention and purge of evidence | No retention field; purge assigned to deferred `69p`; erasure to non-existent `x1a` (`schema.prisma:236`) | n/a | §3.9. |
| E.3 (7) — upload attestation | Does not exist | No | §3.1. The largest single gap. |

Two things the code enforces that the checklist does **not** ask, for completeness: the read-time re-check of every signer's *current* role (reviewer, triager, each layer clearer), and the retirement of checklist versions. Both are stronger than the document requires and should be written into Part E so the document stops under-describing its own gate.

---

## 6. Version: bump to `2026-09-28.1` and retire `2026-09-27.1`

The amendments in §1 and §2 change what a reviewer must check (Gap 1's scope question, Gap 2's mandatory expiry, Gap 3's replacement of C.2.1, the A.6 and C.4.1 rewrites). By the rule `ugcportal-vsm` established, that is a bump and a retirement, not an edit in place. Retiring `2026-09-27.1` costs nothing today: no upload is sellable until `74w` ships, so no clearance under it is being relied on. It will cost more every day after the first clearance is recorded.

The bump is **not** made in this PR, deliberately. `src/lib/checklist-version.test.ts` requires `CURRENT_CHECKLIST_VERSION` and the document header to agree, and `ACCEPTED_CHECKLIST_VERSIONS` to exclude every retired version; the document change and the constant change must land in the same commit, and that commit needs the process owner's ratification of §1's decisions first. The follow-up bead (§9, "Revise the checklist to 2026-09-28.1") carries the exact text. Until it lands, the banner at the top of the checklist points here, and the guidance stands: a `CLEARED` under `2026-09-27.1` covers what the reviewer examined, with a short `Valid until`.

---

## 7. Questions for counsel

Things this review could not settle, stated as questions a lawyer can answer. The rest of the document does not depend on their answers, but the beads that implement §4 items 9 and 11 do.

1. **Minor uploaders.** Is a self-declared "I am 18 or older" at attestation time an adequate basis for relying on the resale licence, or does the operator need actual age verification before accepting a licence from a natural person? What is the operator's exposure if a 16-year-old's licence is later avoided after sales have completed?
2. **Art. 9 and photographs.** After *OT* (C-184/20), does an ordinary portrait from which religion, health or ethnicity can be inferred constitute special-category data for the operator's processing (storage, display, sale), and if so which Art. 9(2) condition is available for a commercial marketplace?
3. **Transfers to non-EEA buyers.** Delivering a photograph of an identifiable EEA resident to a buyer in the US is a Chapter V transfer. Which mechanism applies (Art. 49(1)(a) explicit consent from the depicted person? SCCs with every buyer?), and what must the model release say to support it?
4. **Rights-management information.** Which section of åndsverkloven implements InfoSoc Art. 7, and does stripping EXIF GPS and device serial from a sold original — while preserving `Artist`/`Copyright`/IPTC/XMP rights fields — stay clear of it?
5. **AI-generated works.** Where does Norwegian/EU law currently place the threshold at which a prompt-and-edit workflow yields a protectable work, and what should the operator tell a buyer about a wholly synthetic image sold under a "photograph licence"? What are the Art. 50 AI Act transparency duties for the operator as a deployer, and when do they bind in Norway?
6. **Panorama exception.** Confirm the reading of åvl § 24 in §3.4 — that a commercially exploited reproduction with the artwork as main motif falls outside it.
7. **Retention.** How long must the evidence bundle (instrument, releases, attestation) be kept after the last licence sold under it — three years under foreldelsesloven § 2, or longer for rights claims? (Carried over from the checklist's §4 Q5, still open.)
8. **Self-clearance.** In a single-admin operation, is a disclosed self-review of one's own uploads an acceptable control, or does the operator need a second signatory for the `PEOPLE` layer as a matter of law rather than hygiene?

---

## 8. Ratification

| Field | Entry |
|---|---|
| Decisions in §1 (Gap 1 amend+add, Gap 2 add, Gap 3 delete+replace, Gap 4 accept with two amendments) | ratified / amended / rejected: |
| §2 rewordings adopted into version `2026-09-28.1` | yes / with changes: |
| Process owner (name, role) | |
| Date | |
| Notes | |

Once ratified, append a one-line note to `ugcportal-9cs` and to `ugcportal-zec` (`bd update ugcportal-zec --append-notes="9cs review ratified <date> by <name>; checklist to 2026-09-28.1"`), and the follow-up bead in §9 that revises the checklist becomes ready.

---

## 9. Follow-up beads filed from this review

All filed with `discovered-from: ugcportal-9cs`. Priorities follow the brief: something that would let an item be sold without the rights to sell it is P1; a disclosure or hygiene item is P2/P3. All thirteen were created on 2026-09-28.

| Bead | Title | Priority | Why |
|---|---|---|---|
| `ugcportal-15r` | Per-upload rights attestation by the uploader, stored and read by the gate | P1 | §3.1 — the largest gap; every per-upload fact is currently an admin's guess |
| `ugcportal-aqw` | Time-scope a clearance to material the reviewer could examine | P1 | Gap 1 / K2 |
| `ugcportal-paa` | CLEARED requires evidence, a route, and a bounded validUntil | P1 | Gap 2 and §5 B.2.1 |
| `ugcportal-3ae` | Publishing requires the uploader attestation and a people triage | P1 | §3.3 — § 104 / GDPR bite at display, which is ungated |
| `ugcportal-fw5` | Revise the checklist to 2026-09-28.1 and retire 2026-09-27.1 | P1 | §6; needs ratification first |
| `ugcportal-qn3` | Minors and AI-generated content as first-class triage facts | P2 | §3.5, §3.6 |
| `ugcportal-2m4` | Read and separate file metadata at upload (evidence in, identifiers out of the deliverable) | P2 | §3.7 |
| `ugcportal-uv9` | Self-review detection across triage and layer clearances | P2 | Gap 4 amendment one |
| `ugcportal-hx2` | MUSIC layer: "deliver muted" is not a clearance while the deliverable is the raw original | P2 | §2 C.4.1 |
| `ugcportal-e5x` | Content hash on Media and a cross-uploader duplicate flag | P2 | §3.8 |
| `ugcportal-cv8` | Creator terms acceptance flow with a recorded event (Route 2) | P2 | §2 B.0 — two of three routes currently name nothing |
| `ugcportal-ryd` | Counsel questions from the manual-upload rights review | P2 | §7 |
| `ugcportal-ilp` | Re-home erasure and evidence-purge ownership off deferred and non-existent beads | P3 | §3.9 |

---

## 10. Sources consulted for this review

Primary, re-read for this document on 2026-09-28 unless marked otherwise:

- The codebase at `main` (`981f965`): files cited inline by path and line.
- `docs/legal/instagram-resale-rights-checklist.md` at `2026-09-27.1`, and its cited sources, which are not re-verified here — this review inherits the checklist's [V]/[S]/[B] markings for åndsverkloven §§ 2, 5, 8, 23, 24, 67–69, 104; GDPR arts 4, 6, 7, 9, 17, 21 and Chapter V; Datatilsynet "Bilder på nett".
- Beads `ugcportal-zec`, `-2eh`, `-0ss`, `-vsm`, `-n3c`, `-74w`, `-p3v`, `-ct0`, `-yck`, `-alg`, `-69p` via `bd show`.
- *OT v Vyriausioji tarnybinės etikos komisija*, C-184/20 (CJEU, 1 Aug 2022) — cited from memory of the judgment's holding on inferred special-category data; **verify before relying on it**.
- Regulation (EU) 2024/1689 (AI Act) Art. 50 — cited for the existence of the duty, not its precise commencement in Norway; **verify**.

Nothing in this document was checked against a live legal database. Items marked "verify" and every question in §7 are exactly that.
