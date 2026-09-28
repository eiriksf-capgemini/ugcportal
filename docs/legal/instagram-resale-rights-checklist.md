# Resale-rights review — per-uploader checklist

**Bead:** `ugcportal-zec` (blocks `ugcportal-74w`, the curation-for-sale UI)
**Checklist version:** `2026-09-27.1` — bump this string whenever the form changes; each completed review records the version it was done against.
**Previous version:** `2026-09-24.1` (per-connected-account). Retired by `ugcportal-vsm` — see E.0. It is **not** in `ACCEPTED_CHECKLIST_VERSIONS`, so any clearance still carrying it is refused by the gate.
**Status of this document:** working instrument, prepared by an agent for the human reviewer. **It is not legal advice**, and nothing in it establishes that any uploader's media may be resold. The sign-off decision is made by a named human, per uploader, by completing Part D below. `ugcportal-zec` itself is that human decision gate and stays open until a human closes it.

> **THE SUBJECT OF THIS CHECKLIST CHANGED ON 2026-09-27 AND THE QUESTIONS HAVE NOT CAUGHT UP.** Version `2026-09-24.1` asked about the content of one connected Instagram account. This version asks about an **uploader** — and a clearance recorded against an uploader authorises their *entire past and future upload history*, which is a materially broader claim than any question below was written to establish. The subject-naming items have been corrected mechanically (§1.1, C.2.1, Part D) so the form is coherent; **whether the set of questions is now sufficient for that wider subject is an open legal question and is filed as `ugcportal-9cs`.** In particular nothing here yet asks on what basis an uploader warrants rights in material they have not uploaded yet. Until that is answered by a human, treat a `CLEARED` decision under this version as covering material the reviewer actually examined, and set `Valid until` accordingly short.
>
> **2026-09-28 — the `ugcportal-9cs` review is written:** `docs/legal/manual-upload-rights-review.md`. It names the items below that are *wrong* for an uploader subject — the §1 terminology; §0.3; A.1, A.4, A.5, A.6, A.7; B.0 Routes 2–3; B.1.1, B.1.2, B.1.10; C.2.1, C.2.5, C.3.1, C.3.2, C.4.1, C.5.2; §4 Q3; and in Part E: E.3 items 1, 2 and 6, the "Separation of duties" and "Revocation cascades" bullets, the "Test that must exist" wording, and the superseded E.1/E.2 proposal — decides the four gaps (scope of future uploads; mandatory expiry; C.2.1; separation of duties), and recommends this document move to `2026-09-28.1` with `2026-09-27.1` retired. **The questions in this file are deliberately unchanged until the process owner ratifies that review** (its §8) — amending them without a bump is the mistake E.0 describes.
>
> **This banner changes no rule of `2026-09-27.1` and gives no procedure for working around one.** The items named above are known to be wrong for an uploader subject; the review's §2 says why, item by item, and its text is a *proposal* for `2026-09-28.1`, not guidance for this version. Do not rely on those items, and do not answer from the review. Two consequences follow from this document's own rules, stated here so nobody discovers them after signing: **(1)** A.1, A.4, A.5 and A.7 are `Required: Yes` and are only answerable **Yes / No / N/A** (§1 step 2); for an uploader with no connected Instagram account none of them can honestly be **Yes**, and A.4 permits **N/A** only "if the connect flow refused", which never happened — so under this version such an uploader **cannot be cleared**. That is the finding, not a defect in the reviewer: escalate to the `ugcportal-zec` process owner and wait for `2026-09-28.1` (`ugcportal-fw5`). **(2)** Part D *recommends* a `Valid until`; the running gate treats a blank as a clearance **with no end date** (`src/lib/resale-rights.ts:356`), not as unsellable. That is a fact about the gate, recorded here so it is known, not a new requirement.

---

## 0. Read this first — findings that constrain the product premise

The research behind this checklist surfaced three things the reviewer should know before evaluating any individual account. They are listed here because they change *what* has to be confirmed, not just *whether*.

### 0.1 Meta's Platform Terms appear to prohibit selling or licensing media obtained through the API

This is the material finding. ugcportal currently connects accounts through the *Instagram API with Instagram Login* (`src/lib/instagram.ts`, scope `instagram_business_basic`) and plans to pull media through `graph.instagram.com` (`ugcportal-ct0`) and then sell it (`ugcportal-74w`, `ugcportal-p3v`).

Verified from the primary source (Meta Platform Terms, https://developers.facebook.com/terms/, page displayed "Last Updated: February 3, 2026" when fetched on 2026-09-24 — re-check the date in a browser):

| Provision | What it says (short quote) | Why it matters here |
|---|---|---|
| §12 Glossary, "Platform Data" | "any information, data, or other content you obtain from us, through Platform or through your App" | Media files, captions, and metadata fetched from `graph.instagram.com` are on the face of this definition *Platform Data*. Media is "content". |
| §3.a.iv Prohibited Practices | "Selling, licensing, or purchasing Platform Data." | Selling a licence to a media file fetched via the API is the product's core transaction. |
| §3.a.viii | Processing Platform Data "for purposes other than the applicable permitted purposes" | The permitted purpose of `instagram_business_basic` (per the Instagram Platform overview) is the professional's own account management. A resale marketplace is not one of the listed use cases. |
| §3.c Sharing | Sharing allowed only with Service Providers, when legally required, with User consent, or (non-Restricted data) to third parties under contractual limits; **no carve-out for paying customers** | A buyer is not a Service Provider. |
| §3.d Retention/Deletion | Delete Platform Data "when a User requests their Platform Data be deleted or no longer has an account with you" | Incompatible with having sold perpetual licences to copies of API-fetched files. |
| §2.c.ii | Developer must "obtain (and represent and warrant that you own or have secured) all rights necessary from all applicable rights holders" | Meta grants **no** licence to Users' content. API access is a technical capability, not a rights grant. |

Also verified, Meta Developer Policies (https://developers.facebook.com/devpolicy/, same displayed date): §6.1 "Comply with any requirements or restrictions imposed on usage of Instagram user photos and videos ('User Content') by their respective owners. You are solely responsible…"; §6.2 "Don't use the Instagram Platform to simply display User Content, import or backup content, or manage Instagram relationships, without our prior permission."

**What this means for the reviewer.** Even a perfect owner licence does not cure a Platform Terms breach: the owner can license *their copyright* to ugcportal, but they cannot waive *Meta's* contractual restriction on what ugcportal does with data fetched through Meta's API. The plausible consequences of breach are app suspension / token revocation (killing `ct0` sync for every account at once) rather than a copyright claim, but it is a product-level exposure.

**Product-shape options this checklist assumes are on the table** (a product decision, filed as its own bead — see §7):

- **Option A — API for discovery, owner-supplied originals for sale.** Use API-synced media only to *show the account owner (admin) their own posts* for selection. The asset actually offered for sale is the original file the owner uploads directly (the `ugcportal-8wa` upload API already exists) under the licence documented in Part B. The sold file, and any public preview derived from it, is then not Platform Data. Listing metadata shown to buyers should also derive from the owner-supplied copy, not the API record.
- **Option B — Ask Meta.** Developer Policies §6.2 contemplates "our prior permission". Written permission from Meta for this use case would resolve the conflict but should be assumed slow and unlikely.
- **Option C — API as identity proof only.** Connect Instagram only to prove the person controls the handle; never store API media.

Until that decision is made, **this checklist treats "sellable asset is obtained outside the Meta API" as a required condition (item A.6)**. The reviewer may strike that item only if the product decision goes another way and is recorded.

### 0.2 The account owner is frequently *not* the only rights-holder in a post

An Instagram post can stack up to five independent rights layers (Part C). An account-level sign-off can settle the owner's own layer; it cannot settle depicted people, third-party creators, or music. The checklist therefore produces an **account-level** clearance (this document) *and* requires a **post-level** triage in the curation UI for the layers that vary per post.

Norway-specific point worth flagging: Norwegian law has **no general work-for-hire rule** (åndsverkloven only has an employer rule for computer programs, § 71). For a *business* account whose photos were taken by employees or freelancers, copyright may still sit with the individual photographer unless it was transferred in writing. "It's our company account" is not, by itself, an ownership warranty.

### 0.3 Platform terms do not create a licence for third parties — courts have said so

Background (US law, not binding in Norway, but the fact pattern is identical): in *Sinclair v. Ziff Davis* (S.D.N.Y. 2020, on reconsideration) the court held the pleadings contained "insufficient evidence to find that Instagram granted Mashable a sublicense" merely because content was public and reachable via the API. In *Agence France Presse v. Morel* (S.D.N.Y., verdict upheld 2014) a wire service and Getty were held liable for USD 1.2M in statutory damages for distributing photos lifted from Twitter, the platform's ToS notwithstanding. Treat "it was public on Instagram" as worth nothing.

---

## 1. How to use this checklist

1. Make one copy per uploader (one `User` row who has uploaded, or may upload, media). Keep the filled copy **outside git** — it will contain names, contract excerpts and possibly personal data — in the evidence store described in Part E. This file in the repo is the blank template only.
2. Work through Parts A–C. Every item is answered **Yes / No / N/A** with a pointer to evidence. Any **No** on a required item means the uploader is not cleared.
3. Part D is the decision. It is signed by a human admin who is not the uploader being cleared, where staffing allows.
4. Part E describes what gets stored and how `ugcportal-74w` reads it. That part is an implementation requirement, not a form.

Terminology: **Owner** = the natural or legal person who controls the connected Instagram account and is licensing to ugcportal. **Operator** = ugcportal. **Buyer** = the person purchasing a licence through checkout.

---

## Part A — Identity, control, and source of the asset

| # | Item | Required | Yes / No / N/A | Evidence (file / URL / hash) |
|---|---|---|---|---|
| A.1 | The connected `instagramUserId` and `username` in the `InstagramAccount` row match the account named in the licence document. | Yes | | |
| A.2 | The Owner has been identified as a specific natural person or registered legal entity (name, address, org.nr where applicable), not just a handle. | Yes | | |
| A.3 | The person signing has authority to bind the Owner (for companies: signatory per Brønnøysundregistrene; for individuals: the person themselves, aged 18+). | Yes | | |
| A.4 | The account is a Business or Creator (professional) account, as the API requires. (Personal accounts cannot connect at all; record N/A only if the connect flow refused.) | Yes | | |
| A.5 | The connection was authorised by the Owner (or someone they authorised), not by an ugcportal admin using credentials shared to them. | Yes | | |
| A.6 | **The sellable file is supplied by the Owner directly (upload), not taken from the Meta API.** See §0.1. If the product decision changes this, record the decision reference here instead. | Yes (until decided otherwise) | | |
| A.7 | Owner's Instagram deauthorisation is wired to revoke this clearance automatically (deauthorize callback → `REVOKED`). If not yet implemented, note the follow-up bead. | Yes | | |

---

## Part B — Rights confirmation from the Owner

The bead names three routes. Exactly one must be selected as the **primary** instrument; the others may be supporting evidence.

### B.0 Route selected

- [ ] **Route 1 — Written licence contract** between Owner and Operator (preferred).
- [ ] **Route 2 — ToS/Creator-terms acceptance**: Owner accepted ugcportal's own creator terms that contain the licence, with a recorded acceptance event. *Note:* this means ugcportal's terms, **not** Instagram's. Instagram's Terms of Use grant a licence to *Instagram* ("We do not claim ownership of your content, but you grant us a license to use it" — non-exclusive, royalty-free, transferable, sub-licensable, worldwide). They grant nothing to ugcportal; an "Instagram ToS excerpt" cannot be the rights basis. (Primary page https://help.instagram.com/581066165581870 would not render through the research tooling; quote taken from a secondary source citing terms revised 2022-01-04 — verify in a browser.)
- [ ] **Route 3 — Explicit owner consent** captured in-product (e.g. a signed consent step during connect, or a countersigned email). Acceptable only if it contains every element in B.1 and is captured with the evidence in B.2.

### B.1 Minimum content of the instrument — all routes

Norwegian law applies two rules that make vagueness fatal here (verified via Lovdata, LOV-2018-06-15-40): the **specialty principle**, § 67(2) — no more is transferred than "det som tydelig følger av avtalen"; and § 68(1) — transferred rights "kan ikke overdras videre uten samtykke fra opphaveren". A licence that does not *expressly* allow ugcportal to sublicense to Buyers does not allow it.

| # | The instrument must expressly state… | Required | Yes / No | Where in the document (clause / page) |
|---|---|---|---|---|
| B.1.1 | **Parties**: Owner (as in A.2) and Operator, with the Instagram handle(s) covered. | Yes | | |
| B.1.2 | **Scope of works**: which media — all posts on the account as of a date, posts the Owner marks in the curation tool, or a listed set. "Everything on the account, forever" should be treated as a red flag for a natural-person Owner. | Yes | | |
| B.1.3 | **Acts licensed**: reproduction, storage, making available to the public (online display/preview), distribution of copies to Buyers, and creating watermarked/resized derivatives (`ugcportal-44q`). Map to åvl § 3 / InfoSoc Directive arts 2–4. | Yes | | |
| B.1.4 | **Right to sublicense / resell**: an explicit grant to Operator to sublicense to Buyers, and the *ceiling* of what a Buyer may receive (e.g. non-exclusive, non-transferable, editorial and/or commercial). Without this, § 68(1) blocks resale. | Yes | | |
| B.1.5 | **Exclusivity**: non-exclusive (Owner keeps posting) or exclusive. If exclusive, confirm the Owner has not licensed the same works elsewhere. | Yes | | |
| B.1.6 | **Territory**: must be at least as wide as where Buyers may be (ugcportal sells online → "worldwide" unless checkout geofences). | Yes | | |
| B.1.7 | **Duration**: term of the licence to Operator, *and* what happens to licences already sold to Buyers if the Owner's licence ends (survival clause). | Yes | | |
| B.1.8 | **Revocation / withdrawal**: how the Owner withdraws works or the whole account; notice period; that withdrawal stops *new* sales and whether it affects Buyers' existing licences. | Yes | | |
| B.1.9 | **Warranty of ownership and authority**: Owner warrants they own or control the copyright in each work licensed (including works shot by employees/freelancers — see §0.2), that the works do not infringe third-party rights, and that any people depicted have consented (see Part C). | Yes | | |
| B.1.10 | **Third-party content**: Owner warrants which posts contain third-party creators' work, music, or trademarks, or agrees to flag them per post. | Yes | | |
| B.1.11 | **Moral rights** (åvl § 5, not waivable in general): attribution requirements passed to Buyers, or an agreement on when attribution may be omitted "i den utstrekning loven tillater"; a prohibition on derogatory use by Buyers. | Yes | | |
| B.1.12 | **Remuneration**: price, revenue share, payment terms. Note åvl § 69 (right to reasonable additional remuneration if revenues become disproportionate) — a fixed one-off fee for open-ended resale is the pattern that provision targets. | Yes | | |
| B.1.13 | **Personal data**: Owner's own personal data processing (GDPR art. 13 information), and allocation of responsibility for depicted persons' data (Part C.2). | Yes | | |
| B.1.14 | **Takedown / erasure cooperation**: Operator and Owner will act on a depicted person's objection or erasure request (GDPR arts 17, 21; åvl § 104), including notifying Buyers where feasible. | Yes | | |
| B.1.15 | **Governing law and venue** (expected: Norwegian law, Norwegian courts). | Yes | | |
| B.1.16 | **Signature / acceptance evidence**: signed (qualified e-signature, wet ink scan, or recorded click-accept with IP/timestamp/user id), dated. | Yes | | |

### B.2 Evidence quality — all routes

| # | Item | Required | Yes / No | Evidence |
|---|---|---|---|---|
| B.2.1 | Full instrument stored in the evidence store (Part E), not just an excerpt. SHA-256 recorded. | Yes | | |
| B.2.2 | The version of ugcportal's own creator terms accepted (Route 2/3) is archived verbatim, with the acceptance event (user id, timestamp, IP, terms version). | Route 2/3 | | |
| B.2.3 | Signatory identity verified (BankID / ID document / company registry lookup) — record method, not the ID copy itself unless necessary. | Yes | | |
| B.2.4 | For a company Owner: confirmation that the individuals who created the works have transferred rights to the company in writing (employment contract clause or freelancer agreement), or that the company is itself the "opphaver" of the specific works. | Company Owners | | |

---

## Part C — Rights layers beyond the Owner's copyright

An account-level clearance covers C.1 only. **C.2–C.5 vary per post and must also be triaged per post inside `ugcportal-74w` before a price can be set.** This part records the *account-level* position and the Owner's undertakings; the per-post fields are specified in Part E.

### C.1 Owner's copyright in the photograph / video

- Norway protects photographs twice: original photos as *works* (åvl § 2) and every photograph, original or not, as a *fotografisk bilde* (§ 23: "Den som lager et fotografisk bilde, har enerett til å fremstille eksemplar av det … og gjøre det tilgjengelig for allmennheten"). So there is no "too trivial to be protected" snapshot.
- Covered by Part B.

### C.2 Depicted people — image rights and GDPR

| # | Item | Yes / No / N/A | Evidence |
|---|---|---|---|
| C.2.1 | Does this uploader's material typically show identifiable people (including the uploader)? If **No** across their uploads, record why (e.g. product-only / landscape work) and skip to C.3. Note this is a statement about their material in general; each individual upload is still triaged separately (Part E.3 item 5), so a **No** here never settles a specific file. | | |
| C.2.2 | **åvl § 104** — "Fotografi som avbilder en person, kan ikke gjengis eller vises offentlig uten samtykke av den avbildede" (quote via secondary source; verify on Lovdata). Protection lasts the person's lifetime + 15 years. The statutory exceptions (current public interest; person of secondary importance; gatherings/events of general interest; photographer's own advertising; investigation/biography) are not designed for commercial resale and should not be relied on. Has the Owner provided **model releases** (or equivalent written consent) for depicted people, or undertaken to supply one per post before that post is listed? | | |
| C.2.3 | Does the model release cover **commercial resale by a third party (the Buyer)**, not just the Owner's own posting? Consent given for one use does not extend to another. | | |
| C.2.4 | **GDPR**: an image of an identifiable person is personal data (art. 4(1)). Operator is a controller for the catalogue. Which **art. 6 lawful basis** is relied on for depicted persons? For commercial resale, consent (art. 6(1)(a), art. 7) is the realistic basis; document if legitimate interest is asserted instead and attach the balancing test. Datatilsynet's guidance (updated 16.09.2025): "Samtykke skal hentes inn før bildet eller filmen deles" for portrait images, and GDPR applies to situation images too if people are identifiable. | | |
| C.2.5 | Are **children** depicted? Datatilsynet: "Det er de foresatte som tar avgjørelsen" — guardian consent required, and Datatilsynet expects specific, written, withdrawable consent that names online publication. Recommend: accounts whose content is predominantly children are **not cleared** for resale. | | |
| C.2.6 | Art. 9 special categories (health, religion, sexuality, ethnicity visible or implied; facial images are not biometric data per Recital 51 unless processed with specific technical means, but *facial recognition by Buyers* is a downstream risk the Buyer licence should prohibit). | | |
| C.2.7 | Erasure / objection handling: process exists to pull a listing and notify Buyers if a depicted person objects (arts 17, 21). | | |

### C.3 Third-party creators (reposts, collaborations, agency shots, UGC the Owner themselves reposted)

| # | Item | Yes / No / N/A | Evidence |
|---|---|---|---|
| C.3.1 | Owner has undertaken to flag posts not created by them (or their employees under B.2.4) and such posts are excluded unless a separate licence from that creator is attached. | | |
| C.3.2 | Instagram "Collab" posts: both collaborators are treated as co-authors and both must license. | | |

### C.4 Music and other embedded works

| # | Item | Yes / No / N/A | Evidence |
|---|---|---|---|
| C.4.1 | Reels/videos with music from Instagram's library: Meta's music licences cover **on-platform, personal/non-commercial** use (Meta Music Guidelines, https://www.facebook.com/legal/music_guidelines — page would not render through the research tooling; characterisation from secondary sources; verify). They do not carry off-platform resale. Such posts are excluded, or delivered muted with the Owner's confirmation that the underlying video is theirs. | | |
| C.4.2 | Other embedded works in frame (artwork, text, fonts, screens showing third-party content): Owner undertakes to flag; exclude or clear per post. | | |

### C.5 Trademarks, products, and personality in advertising

| # | Item | Yes / No / N/A | Evidence |
|---|---|---|---|
| C.5.1 | Brand logos/products prominently in frame: generally a Buyer-side risk (use in advertising implying endorsement) rather than a bar to licensing the photo, but the **Buyer licence must exclude** implying endorsement and require the Buyer to clear trademark use. | | |
| C.5.2 | Sponsored / paid-partnership posts: the sponsoring brand's agreement may restrict reuse of the content. Owner undertakes to flag and exclude. | | |

---

## Part D — Decision (human only)

**This part is completed by a human admin. The system must never set an uploader to `CLEARED` on its own.**

| Field | Entry |
|---|---|
| Uploader (`User.id` / email) | |
| Checklist version applied | `2026-09-27.1` |
| Route selected (B.0) | Contract / Own-ToS acceptance / Explicit consent |
| Any required item answered **No**? | Yes → **not cleared** / No |
| Product-decision reference for A.6 (if the API-sourced-asset question was decided) | bead id / date |
| Conditions attached (e.g. "no posts with identifiable people", "muted video only", "posts before 2025-01-01 only") | |
| Valid until (re-review date; recommend ≤ 12 months, or earlier if the licence term is shorter) | |
| Decision | **CLEARED with conditions** / **REJECTED** / **NEEDS MORE INFORMATION** |
| Reviewer (name, user id, role = ADMIN) | |
| Date | |
| Independent from the uploader being cleared? | Yes / No (explain) — recorded automatically as `selfReview` when the reviewer *is* the uploader |
| Evidence bundle location and SHA-256 | |

Once Part D is complete, the reviewer records the outcome in the system (Part E) **and** appends a one-line note to `ugcportal-zec` (`bd update ugcportal-zec --append-notes="<uploader email> CLEARED/REJECTED on <date> by <name>, evidence <hash>"`). Closing `ugcportal-zec` is reserved for the human who decides the *process* is adopted — not for any single uploader clearance.

---

## Part E — The per-account record, evidence store, and how `ugcportal-74w` enforces it

> **E.0 — AMENDMENT (`ugcportal-vsm`, 2026-09-27): the record hangs off the uploader, not the connected account.**
>
> Everything below was written when the sellable catalogue was expected to come from connected Instagram accounts. Instagram was deferred on 2026-09-24 and the product is built around manually uploaded images and video, so `ResaleRightsReview` is now one row per **uploader** (`User`), and the per-post triage is one row per **upload** (`MediaListing`, 1:1 with `Media`). The gate finds the governing review by following `Media.userId` — the file's own owner — rather than by comparing the file against a rights holder named on the review.
>
> What that changes in E.3, item by item:
>
> - **(1)** reads "`ResaleRightsReview.status == CLEARED` for the **uploader of the file**". `ResaleRightsReview.instagramAccountId` and `clearedOwnerUserId` are both gone; `uploaderUserId` replaces them.
> - **(2)–(5)** are unchanged, including the per-layer clearances added after this section was written (`MediaRightsClearance`, one row per `RightsLayer`) and the requirement that the triage itself name a current ADMIN.
> - **(6)** is now structural rather than a check: the gate starts at a real `Media` row and `MediaListing.mediaId` is a foreign key to it, so there is no unresolved pointer left to validate. An upload with no `MediaListing` is not sellable (`not_listed_for_sale`).
> - **Revocation cascades** now means revoking the **uploader's** clearance, which immediately unsells every file they uploaded. Disconnecting an Instagram account no longer revokes anything, because a connected account no longer confers any right to sell.
> - **Separation of duties (soft)** now warns when `reviewedByUserId == uploaderUserId` — an admin clearing their own uploads for sale.
> - **Evidence store**: the private prefix is `rights-evidence/<uploaderUserId>/…`. Objects written before this amendment sit under a connected account's id; nothing rewrites them, and the key snapshotted on each `ResaleRightsEvent` row is still what finds them.
> - **`ResaleRightsEvent`** carries generic subject columns (`subjectKind`, `subjectId`, `subjectLabel`) so that rows written under the old anchor survive unaltered, marked `INSTAGRAM_ACCOUNT`. The migration carried **no** clearance forward and wrote a transition to `UNREVIEWED` for each one, so nothing is sellable that a human has not decided about under the new anchor.
>
> **THE CHECKLIST VERSION WAS BUMPED TO `2026-09-27.1`, AND AN EARLIER REVISION OF THIS AMENDMENT WAS WRONG TO SAY OTHERWISE.** It claimed the change moved only *where* the answer is recorded, not *what* the reviewer must check. That was a mistake, and it was the material one: moving the subject from "the content of one connected account" to "an uploader" widens what a single `CLEARED` decision authorises to that person's entire past **and future** upload history. That is a different question, asked of a different subject, with a larger blast radius — which is exactly the condition `ACCEPTED_CHECKLIST_VERSIONS` exists to detect.
>
> Both halves were needed and neither alone would do. Amending the questions *without* bumping would have left the string `2026-09-24.1` silently meaning something different from what it meant the day before, which destroys the only property a version string has. Bumping *without* amending would have left a reviewer filling in `Account (instagramUserId / @username)` for an uploader. So: the subject-naming items are corrected, and the old version is retired.
>
> The bump costs nothing today and more every day after: `ugcportal-vsm`'s migration discarded every account-level clearance, so no live record carries `2026-09-24.1` and nothing is being retired in practice. Had this shipped without the bump, the first clearance recorded afterwards would have been stamped with a version whose questions named an Instagram handle.
>
> **What the bump does not fix**, stated plainly because it is the limit of what an agent should decide here: the questions below were written for a narrower subject, and making them *coherent* is not the same as making them *sufficient*. Whether clearing a person for everything they may upload in future needs questions that do not exist yet — a warranty over unseen material, a mandatory re-review interval — is a legal judgment for `ugcportal-zec`'s process owner, and is filed as `ugcportal-9cs`. The authority for the gate's *behaviour* is `src/lib/resale-rights.ts`; the authority for whether these questions are enough is a human.

This section is the implementation requirement that `ugcportal-74w` K2 depends on ("curation UI/API checks per-account rights-confirmation status before allowing price-setting"). It is filed as its own bead (see §7).

### E.1 Data model (proposal)

Add a one-to-one review record rather than columns on `InstagramAccount`, so the history is append-only and the account row stays about OAuth plumbing.

```prisma
enum ResaleRightsStatus {
  UNREVIEWED   // default on connect
  IN_REVIEW
  CLEARED
  REJECTED
  REVOKED      // set automatically on deauthorize/disconnect, or manually on withdrawal
  EXPIRED      // validUntil passed; derived or set by a job
}

enum ResaleRightsRoute {
  CONTRACT
  OWN_TERMS_ACCEPTANCE
  EXPLICIT_CONSENT
}

model ResaleRightsReview {
  id                  String             @id @default(cuid())
  instagramAccountId  String             @unique
  status              ResaleRightsStatus @default(UNREVIEWED)
  route               ResaleRightsRoute?
  checklistVersion    String             // e.g. "2026-09-27.1"
  reviewedByUserId    String?            // must be role ADMIN; never a service principal
  reviewedAt          DateTime?
  validUntil          DateTime?
  conditions          String?            // free text from Part D, shown in the curation UI
  evidenceKey         String?            // object key in the evidence bucket (see E.2)
  evidenceSha256      String?
  productDecisionRef  String?            // bead id for the A.6 question
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt

  instagramAccount InstagramAccount @relation(fields: [instagramAccountId], references: [id], onDelete: Cascade)
  reviewedBy       User?            @relation(fields: [reviewedByUserId], references: [id])
  events           ResaleRightsEvent[]
}

// Append-only audit trail. Every status change writes one row; rows are never updated or deleted.
model ResaleRightsEvent {
  id          String             @id @default(cuid())
  reviewId    String
  fromStatus  ResaleRightsStatus?
  toStatus    ResaleRightsStatus
  actorUserId String?            // null only for system transitions (REVOKED via callback, EXPIRED via job)
  reason      String
  createdAt   DateTime           @default(now())

  review ResaleRightsReview @relation(fields: [reviewId], references: [id], onDelete: Cascade)
  @@index([reviewId, createdAt])
}
```

Per-post fields (in the synced-post model that `ugcportal-ct0` introduces, or a curation record in `ugcportal-74w`) for the layers that vary per post:

```prisma
// on the post / curation record
depictsPeople        Boolean?   // null = not triaged
modelReleaseKey      String?    // required if depictsPeople
containsMusic        Boolean?
thirdPartyCreator    Boolean?
sponsoredContent     Boolean?
postClearedByUserId  String?
postClearedAt        DateTime?
```

### E.2 Evidence store

- Signed instruments, model releases, and the filled checklist are **personal data and contracts**; store them in a **separate, private S3 prefix** (e.g. `rights-evidence/<instagramAccountId>/…`) with server-side encryption, no public read, and access limited to ADMIN. Do not commit them to git. Do not store them in the `Media` table used for sellable assets.
- Record the SHA-256 of each file in `ResaleRightsReview.evidenceSha256` (or a manifest for multiple files) so a later reader can prove the file is the one reviewed.
- Retention: keep for the life of any Buyer licence issued under it plus the limitation period for claims (Norway: general 3 years, foreldelsesloven § 2, but rights claims may run longer — a lawyer should set this). Note this conflicts with Platform Terms §3.d *if* the evidence contains Platform Data; it should not (it is the Owner's contract, not API output).

### E.3 The gate `ugcportal-74w` (and `ugcportal-p3v`) must implement

A post is **sellable** if and only if **all** of the following hold, evaluated server-side at (1) price-setting, (2) catalogue render, and (3) checkout — not only in the UI:

1. `ResaleRightsReview.status == CLEARED` for the post's `InstagramAccount`;
2. `validUntil` is null or in the future;
3. `reviewedByUserId` is set and refers to a user with `role == ADMIN`;
4. `checklistVersion` is in the set of currently accepted versions (so a form revision can force re-review);
5. the post's own triage is complete: `depictsPeople` is not null; if true, `modelReleaseKey` is set; `containsMusic`, `thirdPartyCreator`, `sponsoredContent` are each `false` or the post is explicitly cleared with a reason;
6. the post's sellable file is the Owner-supplied original (A.6), unless `productDecisionRef` records a different decision.

Enforcement properties:

- **Fail closed.** Missing review row → treated as `UNREVIEWED` → not sellable.
- **No system path to `CLEARED`.** Only an authenticated ADMIN action can write `CLEARED`, and it must write a `ResaleRightsEvent` with `actorUserId` set. Sync jobs and callbacks may only move *away* from `CLEARED` (→ `REVOKED`/`EXPIRED`).
- **Revocation cascades.** Instagram deauthorize callback, admin disconnect, or Owner withdrawal → `REVOKED` → all listings from that account are unpublished immediately. Buyers' already-issued licences are governed by the survival clause (B.1.7), which the Buyer licence text must mirror.
- **Separation of duties (soft).** Warn, and record, if `reviewedByUserId == InstagramAccount.connectedByUserId`.
- **Test that must exist** (74w K2): an integration test that creates a synced post for an account with `status` in every non-`CLEARED` state and asserts that price-setting returns 403/422 and the post never appears in the catalogue or checkout.

---

## 2. Legal frame in one page (background — verify with counsel)

The reviewer should know where each checklist item comes from. Marked **[V]** where a primary source was read for this document, **[S]** where a secondary source quoting the primary was used, **[B]** general background not re-verified here.

- **Copyright (Norway).** Lov om opphavsrett til åndsverk mv., LOV-2018-06-15-40. § 3 exclusive rights (reproduction, making available) [S]; § 5 moral rights [S]; § 23 photographs [V]; § 67(2) specialty principle [V]; § 68(1) no further transfer without consent [V]; § 69 reasonable remuneration [V]; § 71 employer rule for software only [B]; § 104 right to one's own image [S]. https://lovdata.no/dokument/NL/lov/2018-06-15-40
- **Copyright (EU/EEA).** Directive 2001/29/EC (InfoSoc) arts 2–4 harmonise reproduction, communication to the public and distribution; Norway implements via åndsverkloven. https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32001L0029 [B]
- **Personal data.** GDPR (Regulation 2016/679), applied in Norway through personopplysningsloven (LOV-2018-06-15-38): arts 4(1), 5, 6, 7, 9, 13, 17, 21; Recital 51 on facial images. https://eur-lex.europa.eu/eli/reg/2016/679/oj [B]. Datatilsynet guidance on images: https://www.datatilsynet.no/personvern-pa-ulike-omrader/internett-og-apper/bilder-pa-nett/ [V, page dated 16.09.2025].
- **Meta contractual layer.** Platform Terms https://developers.facebook.com/terms/ [V]; Developer Policies https://developers.facebook.com/devpolicy/ [V]; Instagram Platform overview https://developers.facebook.com/docs/instagram-platform/overview [V] (states apps must adhere to Platform Terms, Developer Policies, Community Standards and complete App Review for Advanced Access; "Business Verification" required if serving accounts you don't own/manage); Instagram Terms of Use https://help.instagram.com/581066165581870 [S — page did not render; quoted via https://www.copyrightlaws.com/instagram-and-copyright/]; Meta Music Guidelines https://www.facebook.com/legal/music_guidelines [S — did not render].
- **Where jurisdiction changes the answer.**
  - *Image rights*: Norway (§ 104) and Germany (KUG § 22) require consent for essentially any public use; Sweden's lag (1978:800) om namn och bild i reklam bites only on advertising; the US varies by state (right of publicity) and has broad newsworthiness/fair-use defences. Because Buyers may be anywhere, clear to the **strictest** standard (consent) rather than the Operator's home standard.
  - *Ownership by companies*: US work-for-hire vests copyright in the employer automatically; Norway does not (§0.2). B.2.4 exists because of this.
  - *Moral rights*: waivable in the US/UK in practice, not generally in Norway (§ 5). Attribution must flow through to Buyers or be expressly handled.
  - *Damages exposure*: US statutory damages (up to USD 150,000 per work for wilful infringement — *Morel*) far exceed Norwegian norms (åvl § 81: reasonable remuneration, double on gross negligence/intent, plus losses). A US Buyer redistributing an uncleared image is the high-severity scenario.

---

## 3. Sources

**Primary, read for this document (2026-09-24):**
- Meta Platform Terms — https://developers.facebook.com/terms/ (§§ 2.a, 2.b, 2.c.ii, 3.a, 3.c, 3.d, 12)
- Meta Developer Policies — https://developers.facebook.com/devpolicy/ (§§ 1.7, 6.1, 6.2)
- Instagram Platform overview — https://developers.facebook.com/docs/instagram-platform/overview
- Instagram API with Instagram Login — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
- Åndsverkloven, kapittel 4 (§§ 67–69) and § 23 — https://lovdata.no/dokument/NL/lov/2018-06-15-40/KAPITTEL_4 and https://lovdata.no/dokument/NL/lov/2018-06-15-40
- Datatilsynet, "Bilder på nett" — https://www.datatilsynet.no/personvern-pa-ulike-omrader/internett-og-apper/bilder-pa-nett/

**Secondary, used where the primary would not render:**
- Instagram Terms of Use content — https://www.copyrightlaws.com/instagram-and-copyright/ (quotes terms revised 2022-01-04)
- Åndsverkloven § 104 text and exceptions — https://hannemyr.com/faq/legal_dm08.shtml
- Meta Music Guidelines characterisation — https://www.epidemicsound.com/blog/brands-using-music-on-social-media/ ; https://www.facebook.com/legal/music_guidelines_Jan2024/ (dated copy, did not render)
- Business Login deauthorize / data-deletion callback requirement — https://developers.facebook.com/docs/instagram-platform/create-an-instagram-app/ (did not render; requirement confirmed via multiple implementer write-ups)

**Background (case law, US, not re-verified from judgments):**
- *Sinclair v. Ziff Davis, LLC* (S.D.N.Y. 2020; reconsideration) — https://www.finnegan.com/en/insights/blogs/incontestable/sdny-reconsiders-instagram-embedding-by-mashable.html
- *Agence France Presse v. Morel* (S.D.N.Y.; verdict upheld 2014) — https://www.willkie.com/news/2014/08/court-upholds-landmark-jury-verdict

---

## 4. Open questions for the human (not answerable by this document)

1. **Product shape under Meta's Platform Terms (§0.1).** Option A / B / C, or obtain a legal opinion that API-fetched media is not "Platform Data" in this sense. Everything downstream depends on this.
2. **Will ugcportal accept natural-person Owners at all**, or only companies/agencies with their own rights chain? Natural persons dramatically raise the C.2 and § 69 burden.
3. **Who is the reviewer of record** and can we guarantee separation from the connecting admin?
4. **Buyer licence text** (`ugcportal-p3v`): it must mirror B.1.4 ceilings, B.1.7 survival, B.1.11 attribution, C.2.6 no facial recognition, C.5.1 no implied endorsement, and a takedown clause. Not yet drafted.
5. **Retention period for evidence** (E.2) — needs counsel.
6. **Is external counsel review of the template contract (Route 1) required before the first account is cleared?** Recommended: yes.
