import { MediaAuthorship, RightsLayer, Role } from "@/generated/prisma/enums";
import {
  PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE,
  type MediaAlcoholCommerceScope,
} from "@/lib/alcohol-commerce";
import { ACCEPTED_ATTESTATION_VERSIONS } from "@/lib/attestation";
import {
  ATTESTATION_BLOCKERS,
  MEDIA_GATE_SELECT,
  attestationBlocker,
  layerIsCleared,
  type AttestationBlocker,
  type GateAttestation,
  type GateLayerClearance,
} from "@/lib/resale-rights";
import { CURRENT_CONFIGURED_HANDLES } from "@/lib/sign-in-policy";

/**
 * THE PUBLISHABILITY GATE (ugcportal-3ae).
 *
 * The failure this exists to prevent, stated once: an uncleared photograph
 * of an identifiable person served on the public site — and, through
 * `src/app/sitemap.ts`, handed to search engines, which is the surface
 * nobody gets to withdraw from after the fact.
 *
 * SEPARATE FROM `evaluateSellability`, NOT A FLAG ON IT. Publishing is not
 * selling, and the two gates answer different questions about the same row.
 * Selling needs the uploader's standing resale-rights review, a complete
 * admin triage of every registered layer, and a signature on each one;
 * publishing needs the uploader to have said whose work this is (unless the
 * uploader is a configured user who was not asked — ugcportal-ho7j; a
 * declaration that IS present is judged in full whoever made it) and, where
 * a person is in the frame, an admin to have cleared that one layer. An item
 * can be perfectly publishable and unsellable, which is the ordinary case
 * for everything on this site today. Folding them together would mean
 * showing nothing until an admin had priced it.
 *
 * TWO EXPRESSIONS OF ONE RULE, AND BOTH LIVE HERE. `publishabilityBlocker`
 * below is the TypeScript predicate run on one row whenever something is
 * published — by the shared publish gates (src/lib/publish-gates.ts), which
 * both POST /api/media/[id]/publish and, for a configured uploader's
 * auto-publish, POST /api/media call (ugcportal-ho7j);
 * `PUBLIC_MEDIA_RIGHTS_SCOPE` is the same rule as a Prisma `where`, spread
 * into `PUBLIC_MEDIA_SCOPE` (src/lib/public-media.ts) so that every
 * anonymous reader — the paginated feed, the server-rendered home page, the
 * portfolio, the sitemap, the per-item page, its price block and the
 * preview bytes — inherits it from the scope constant rather than from
 * remembering to ask. (That list is prose and goes stale; the enumeration
 * that does not is the scan in src/lib/public-media.consumers.test.ts.)
 *
 * Writing a rule twice in two languages is a real cost and it is paid
 * deliberately: a row-at-a-time
 * predicate cannot filter a keyset-paginated query, and a `where` clause
 * cannot produce the message a refused publish has to show. They are kept
 * honest against each other by a cross-check that runs BOTH over the same
 * fixture rows in a real database and compares the answers
 * (src/lib/publishability.scope-agreement.test.ts), with the two
 * disagreements SQL cannot avoid enumerated there rather than hidden.
 *
 * `PUBLIC_MEDIA_RIGHTS_SCOPE` IS NO LONGER ONLY THIS MODULE'S RULE. Since
 * ugcportal-pgpq it carries a third arm belonging to a different statute —
 * alkoholloven § 9-2's commercial pair, widened at ugcportal-qnq9.11 by a
 * recorded `depictsAlcohol = true` (the complement of
 * `isWithheldFromPublicRead`), defined in
 * src/lib/alcohol-commerce.ts and cross-checked against ITS own predicate in
 * src/lib/alcohol-commerce.scope-agreement.test.ts. It is assembled here
 * because this is the constant every anonymous reader already spreads, not
 * because it is part of publishability. See that arm's comment at the
 * constant below.
 *
 * WHAT THIS DELIBERATELY DOES NOT DECIDE. Whether self-service
 * publish-by-default is the right model at all is ugcportal-55nt's question.
 * ugcportal-ho7j answered it for the CONFIGURED users only, on the
 * operator's instruction: their uploads publish on upload, through the same
 * gates, and a missing declaration is not a condition for them. For
 * everybody else it is still open and nothing here answers it; for them
 * this module only adds conditions to publishing, which is strictly the
 * safer direction under either answer.
 * What a clearance lapsing AFTER publication does to a row that is already
 * public is ugcportal-nffp. Per-layer clearance WRITES are ugcportal-qfy9,
 * which merged as `ba9991f` while this was under review: the admin curation
 * screen now writes `MediaRightsClearance` rows, so the permitting half of
 * K2 has a product surface behind it. The tests here still seed clearances
 * DIRECTLY rather than driving that screen — this gate is a unit of
 * src/lib, and an end-to-end admin-flow-then-publish case belongs to
 * neither bead's suite — so what they prove is the gate's behaviour given a
 * clearance row, not that the admin flow produces one. qfy9's own tests
 * prove that half.
 */

/**
 * Why a publish was refused. A closed set, safe to render and to log, and
 * every member has a sentence in {@link PUBLISH_BLOCKER_MESSAGES} — enforced
 * by `tsc` through the `Record` below rather than by memory, the same
 * construction `TRIAGE_WRITE_REFUSALS` and
 * src/app/admin/curation/outcomes.ts use for the curation side.
 */
export const PUBLISH_BLOCKERS = [
  "upload_owner_unknown",
  "attestation_missing",
  "attestation_incomplete",
  "attestation_not_by_uploader",
  "attestation_version_retired",
  "attestation_rights_disclaimed",
  "people_uncleared",
] as const;

export type PublishBlocker = (typeof PUBLISH_BLOCKERS)[number];

/**
 * What each attestation blocker means for a PUBLISH, decided once per code.
 *
 * A FULL `Record` over `AttestationBlocker`, which is the point: the
 * sellability gate's attestation codes are a closed set
 * (`ATTESTATION_BLOCKERS`, src/lib/resale-rights.ts), and a seventh one
 * added there fails `tsc` here until somebody decides whether it blocks
 * publishing too. The alternative — forwarding whatever
 * `attestationBlocker` returns — would make every future attestation rule
 * silently also a publishing rule, and the alternative to THAT — a
 * hand-written list of the five that do block — would silently permit the
 * seventh.
 *
 * `null` means "does not block a publish", and today exactly one code holds
 * it. `attestation_uploader_not_adult` is §3.2's rule, and §3.2 is about
 * CAPACITY TO GRANT A LICENCE: under vergemålsloven a resale licence
 * granted by someone under 18 is at best voidable. Publishing grants no
 * licence to anybody, so that reasoning does not reach it — and reading it
 * across anyway would mean a seventeen-year-old could never show their own
 * photograph on their own site, which is a product decision nobody has
 * taken and which is not this bead's to take. The upload stays unsellable
 * exactly as before; `evaluateSellability` is untouched.
 *
 * SAFE TO CONTINUE PAST, and this is the one ordering dependency in this
 * module. `attestationBlocker` returns the FIRST blocker it finds and checks
 * the adult declaration LAST, so a run that returns that code has already
 * passed presence, completeness, authorship-by-the-uploader, version and
 * rights-disclaimed. Pinned by "checks the adult declaration last" in
 * resale-rights.test.ts, which fails if that check is moved earlier.
 */
const PUBLISH_ATTESTATION_BLOCKERS: Record<
  AttestationBlocker,
  PublishBlocker | null
> = {
  attestation_missing: "attestation_missing",
  attestation_incomplete: "attestation_incomplete",
  attestation_not_by_uploader: "attestation_not_by_uploader",
  attestation_version_retired: "attestation_version_retired",
  attestation_rights_disclaimed: "attestation_rights_disclaimed",
  attestation_uploader_not_adult: null,
};

/**
 * The sentence the owner is shown for each refusal.
 *
 * Typed as a full `Record<PublishBlocker, string>`, so a blocker added above
 * with no message fails `tsc` — not review, and not a test.
 *
 * WHERE THEY ARE SHOWN: in the manual publish route's 422 body, and — since
 * ugcportal-ho7j — in POST /api/media's 201 `publishRefusal` for a
 * configured uploader's upload that was stored but not published, which the
 * upload page's queue row renders. There is still no owner-facing publish
 * control to put them beside. Evidence for that, and the
 * command to re-check it rather than a count that rots:
 * `grep -rn "api/media/.*publish" src` — outside the route's own directory
 * every hit is a comment or a test, and none of them is a `fetch`, a form
 * or a server action. Rendering these beside a publish button is
 * ugcportal-bk57.
 */
export const PUBLISH_BLOCKER_MESSAGES: Record<PublishBlocker, string> = {
  upload_owner_unknown:
    "This item has no recorded uploader, so there is nobody whose declaration could cover it. Nothing was published.",
  attestation_missing:
    "Nobody has declared where this file came from, so it cannot be made public. Upload it again through the current upload form, which asks the rights questions.",
  attestation_incomplete:
    "The rights declaration stored for this file is incomplete, so it cannot be made public. Upload it again through the current upload form.",
  attestation_not_by_uploader:
    "The rights declaration stored for this file was not made by the person who uploaded it, so it cannot be made public. Only the uploader can declare what they made.",
  attestation_version_retired:
    "The rights questions have been revised since this file was uploaded, so its declaration no longer covers what is being asked. Upload it again through the current upload form.",
  attestation_rights_disclaimed:
    "The uploader declared that they neither made this file nor hold a licence for it, so this site has no basis to publish it. There is nothing to add to the record — a different file is the only fix.",
  people_uncleared:
    "This item shows an identifiable person and nobody has cleared that yet, so it cannot be made public (åndsverkloven § 104, GDPR art 9). An administrator has to record a PEOPLE clearance for it first.",
};

/**
 * The refusal body the publish gates answer with — the manual route's 422
 * body, and POST /api/media's `publishRefusal` (ugcportal-ho7j).
 */
export type PublishRefusal = {
  readonly error: string;
  readonly blocker: PublishBlocker;
};

/**
 * The listing columns the publish gate reads — two of them, not the whole
 * triage.
 *
 * `depictsPeople` is the ADMIN's answer to the people question, and it is
 * read alongside the uploader's own because the two can disagree and the
 * dangerous direction is a `no`. Either one saying `yes` means a person is
 * in the frame; it takes both to mean nobody is — or, when there is no
 * declaration at all (a configured uploader's, ugcportal-ho7j), the listing
 * alone. Note what that does NOT do:
 * it does not require the admin to have answered. A null here is "nobody has
 * triaged this", which is the state of every upload on this site, and
 * demanding an admin answer before an owner may publish their own photograph
 * would turn publishing into an admin-gated act — ugcportal-55nt's question,
 * not this one's.
 */
export type PublishabilityListing = {
  depictsPeople: boolean | null;
  layerClearances: GateLayerClearance[];
};

/** One upload, as the publish gate sees it. */
export type PublishabilityUpload = {
  /**
   * `Media.userId`. Typed nullable for the same reason `GateUpload.userId`
   * is: the column is a non-null foreign key, so an ordinary Prisma read
   * cannot produce null, and the guard is for a hand-assembled input.
   */
  userId: string | null;
  /**
   * `null` means NOBODY ASKED THE UPLOADER ANYTHING — every upload made
   * before ugcportal-15r, every upload by a configured user who was not
   * asked (ugcportal-ho7j), and anything a future second write path creates
   * without one. It is never "the uploader said no". It refuses a publish
   * for everybody except a configured uploader (`uploaderConfigured`).
   */
  attestation: GateAttestation | null;
  listing: PublishabilityListing | null;
  /**
   * Whether the uploader is a CONFIGURED user — `User.configuredHandle` is
   * one of the handles of the people in `CONFIGURED_USERS`
   * (src/config/users.ts) today, linked by src/lib/configured-user-link.ts
   * (ugcportal-ho7j) and decided by `isConfiguredUser`
   * (src/lib/publish-gates.ts, ugcportal-lskg).
   *
   * It changes exactly ONE thing below: a MISSING attestation stops being a
   * refusal, because those people are not asked the rights questions at
   * upload. A PRESENT attestation is judged in full whoever made it — a
   * configured uploader who does answer, and answers that they hold no
   * rights, is refused exactly as anyone else is.
   *
   * Required rather than optional, so every caller has to say where its
   * answer came from: an optional flag defaulting to `false` would be
   * fail-closed, but would also let a new caller forget the question and
   * quietly refuse the operators' own uploads. Read it from the database
   * (the `User` row), never from anything a client sent.
   */
  uploaderConfigured: boolean;
};

/**
 * Prisma `select` for {@link PublishabilityUpload}'s attestation, reused from
 * `MEDIA_GATE_SELECT` rather than re-spelled.
 *
 * One copy, so a tenth attestation question cannot be added to the gate's
 * select and left out of the publish gates' — which would read as
 * `undefined` on the row and be refused as `attestation_incomplete` on every
 * publish, a site-wide outage rather than a leak, but still a silent
 * divergence between two selects that are meant to be the same question.
 */
export const PUBLISH_ATTESTATION_SELECT = MEDIA_GATE_SELECT.attestation.select;

/** Prisma `select` for {@link PublishabilityListing}, same reuse, same reason. */
export const PUBLISH_LISTING_SELECT = {
  depictsPeople: MEDIA_GATE_SELECT.listing.select.depictsPeople,
  layerClearances: MEDIA_GATE_SELECT.listing.select.layerClearances,
} as const;

/**
 * Is an identifiable person in this frame?
 *
 * `=== true` on both sides rather than truthiness, matching `isTriaged` next
 * door: `null` is "not answered", and an unanswered admin triage must not
 * read as a `no` that cancels the uploader's `yes`.
 *
 * With NO attestation — a configured uploader's ordinary upload
 * (ugcportal-ho7j) — the first half is false and the listing alone decides:
 * `depictsPeople === true` means a person is shown; `false`, `null` or no
 * listing at all means nobody is.
 */
function showsIdentifiablePeople(upload: PublishabilityUpload): boolean {
  return (
    upload.attestation?.showsIdentifiablePeople === true ||
    upload.listing?.depictsPeople === true
  );
}

/**
 * The gate. Returns the first blocker, or null when the upload may be made
 * public.
 *
 * ONE CODE RATHER THAN A LIST, the same call `evaluateSellability` makes:
 * the owner fixes them one at a time anyway, and a single code keeps the
 * caller's messaging a closed set.
 */
export function publishabilityBlocker(
  upload: PublishabilityUpload,
): PublishBlocker | null {
  // (0) A file with no owner has no uploader whose declaration could cover
  // it. Unreachable through an ordinary Prisma read — the column is a
  // non-null foreign key — and here for the hand-assembled input, exactly as
  // `evaluateSellability` explains at its own step 0.
  if (typeof upload.userId !== "string" || !upload.userId.trim()) {
    return "upload_owner_unknown";
  }

  // (1) The uploader's own declaration about this file, judged by the same
  // function the sale gate uses, then translated per code above.
  //
  // SKIPPED ONLY WHEN THERE IS NO DECLARATION AND THE UPLOADER IS CONFIGURED
  // (ugcportal-ho7j): the configured people are not asked at upload, so for
  // them "nobody declared anything" is the ordinary state rather than a gap.
  // `=== true` so a hand-assembled input that left the flag out is judged
  // as a non-configured upload. Nothing here reaches `evaluateSellability`:
  // the sale gate still answers `attestation_missing` for the same row.
  const exemptFromDeclaration =
    upload.uploaderConfigured === true && (upload.attestation ?? null) === null;
  if (!exemptFromDeclaration) {
    const attestation = attestationBlocker(
      upload.attestation ?? null,
      upload.userId,
    );
    if (attestation) {
      const refusesPublish = PUBLISH_ATTESTATION_BLOCKERS[attestation];
      if (refusesPublish) {
        return refusesPublish;
      }
    }
  }

  // (2) A person in the frame needs the PEOPLE layer cleared, by somebody
  // who is an ADMIN right now (`layerIsCleared` re-reads the role, so a
  // demotion takes effect on the clearances that person signed).
  //
  // NO LISTING MEANS NO CLEARANCE, which is the whole of the fail-closed
  // half: a `MediaRightsClearance` row hangs off `MediaListing`, so an
  // upload nobody has put into the curation flow cannot have one, and an
  // upload showing a person therefore stays private until somebody does.
  //
  // THE MODEL-RELEASE FILE IS NOT ASKED FOR HERE, and that is a boundary
  // rather than an omission. `TRIAGE_FACTS`' PEOPLE entry requires
  // `modelReleaseKey` ON TOP OF the clearance before an item may be SOLD,
  // because a licence sold on a stranger's face is the expensive failure
  // there. This gate asks the question publication asks — has somebody with
  // authority looked at this and said the depicted person is covered — and
  // the sale gate still asks its own, unchanged.
  if (
    showsIdentifiablePeople(upload) &&
    !layerIsCleared(upload.listing, RightsLayer.PEOPLE)
  ) {
    return "people_uncleared";
  }

  return null;
}

/**
 * The publish route's refusal, in the shape its two neighbours already use
 * (`advertisingLabelPublishRefusal`, `commercialPublishRefusal`): null when
 * the upload may go public, otherwise the body to answer with.
 *
 * `blocker` rather than `field`, which is the one departure from those two.
 * Theirs name a form field the operator can go and change; none of these is
 * a field on any form — the fix is a re-upload, or an administrator
 * recording a clearance — so the machine-readable half is the closed-set
 * code itself.
 */
export function publishRightsRefusal(
  upload: PublishabilityUpload,
): PublishRefusal | null {
  const blocker = publishabilityBlocker(upload);
  if (!blocker) return null;
  return { error: PUBLISH_BLOCKER_MESSAGES[blocker], blocker };
}

/**
 * ---------------------------------------------------------------------------
 * THE SAME RULE, AS A QUERY FILTER (ugcportal-3ae K3)
 * ---------------------------------------------------------------------------
 *
 * K3 is the load-bearing criterion of this bead and this is the part that
 * carries it. The predicate above runs when a row is published (a manual
 * publish request, or a configured uploader's auto-publish), so it governs
 * rows that cross the line from now on and nothing else. Every row published
 * before it existed — and every row whose clearance situation changed since —
 * is still sitting in the table, and every anonymous surface reads it —
 * six query sites as of ugcportal-nffp, enumerated by the scan in
 * src/lib/public-media.consumers.test.ts rather than counted here.
 *
 * So the rule is also a `where`, and it is spread into `PUBLIC_MEDIA_SCOPE`
 * ITSELF rather than repeated at each of those surfaces. That is the half
 * that covers the reader somebody adds next year: a new anonymous query
 * that reaches for the scope constant inherits this with nothing to
 * remember.
 *
 * A QUERY THAT DOES NOT REACH FOR IT IS NOT COVERED, here or anywhere else
 * (ugcportal-3ae review round 1, findings 2 and 3; an earlier draft of this
 * paragraph claimed such a query fails the consumers guard, which it does
 * not). src/lib/public-media.consumers.test.ts catches a reader that NAMES
 * the constant, by named import or by namespace import; its header sets out
 * what it is blind to, with the fixtures for both. The hand-written-`where`
 * shape is ugcportal-7egi. The four readers there are at ba9991f spread the
 * scope; another that did not was found at ugcportal-nffp — GET
 * /api/media/preview/[previewId], the route that serves the bytes — and it
 * does now.
 *
 * WHAT A LAPSE AFTER PUBLICATION DOES, which the header above left open as
 * ugcportal-nffp's question. Answered, and the answer splits in two:
 *
 *   - Everything the PREDICATE ABOVE consults is also in this `where`, so
 *     it is re-evaluated on every read and a clearance that stops holding
 *     takes the row off every public surface on the next request, with no
 *     write to the row. src/lib/public-media.lapse.test.ts proves that by
 *     mutating a live, currently-served row and putting it back.
 *   - The uploader's standing `ResaleRightsReview` moving to REVOKED or
 *     EXPIRED, its `validUntil` passing, or its checklist version being
 *     retired does NOT depublish anything, and must not: that review
 *     answers whether the work may be RESOLD, and folding it in here would
 *     empty every public surface of everything unpriced — the same
 *     argument this module's own header makes, and the one
 *     src/lib/sellable-media.ts makes for keeping sellability beside this
 *     scope rather than inside it (ugcportal-yzo7). The legal review
 *     reaches the same conclusion from its own side, dated 2026-09-28:
 *     docs/legal/manual-upload-rights-review.md §2, the "E.3 Revocation
 *     cascades" row — "a REVOKED uploader's files are unsellable (status
 *     check), but nothing unpublishes them … Public visibility is a
 *     separate switch (ugcportal-3ae)." Cited as a second author agreeing,
 *     not as a ruling: that document's status header makes every decision
 *     in it a RECOMMENDATION until ugcportal-zec's process owner ratifies
 *     it, and its §8 table is blank. The first reason above does not
 *     depend on it.
 */

/**
 * The attestation a public row must carry when it carries one at all, as a
 * Prisma relation filter. A row with NO attestation is public only through
 * `CONFIGURED_UPLOADER_UNDECLARED` below (ugcportal-ho7j); a row WITH one is
 * public only if it passes this, configured uploader or not.
 */
const PUBLISHABLE_ATTESTATION: {
  attestationVersion: { in: string[] };
  authorship: { not: MediaAuthorship };
} = {
  // `attestationBlocker` step (d), as a query. Spread from the live set, so
  // retiring a version withdraws every row attested under it from the public
  // site on the next request — the same blast radius the set's own comment
  // describes for sellability, now also for visibility.
  attestationVersion: { in: [...ACCEPTED_ATTESTATION_VERSIONS] },
  // Step (e). The uploader said they neither made it nor hold a licence.
  authorship: { not: MediaAuthorship.NEITHER },
};

/**
 * The PEOPLE layer, cleared, by a current admin — `layerIsCleared`'s four
 * conditions as a query, minus the one SQL cannot express.
 *
 * `reason: { not: "" }` is `reason?.trim()` with the trim missing: Prisma has
 * no trimming filter, so a clearance whose justification is nothing but
 * spaces is refused by the predicate and accepted by this filter. That is
 * one of the two enumerated disagreements in
 * publishability.scope-agreement.test.ts; the other is
 * `attestedByUserId === Media.userId`, which is a comparison between columns
 * in two different tables and which Prisma's field references cannot cross.
 * Both are states nothing in the product can write, and both are refused at
 * the publish chokepoint, so neither is reachable without a hand-written
 * statement against the database — but both are asserted there rather than
 * left to this paragraph.
 */
const PEOPLE_LAYER_CLEARED = {
  listing: {
    is: {
      layerClearances: {
        some: {
          layer: RightsLayer.PEOPLE,
          reason: { not: "" },
          clearedByUserId: { not: null },
          clearedBy: { is: { role: Role.ADMIN } },
        },
      },
    },
  },
};

/**
 * Nobody identifiable in the frame: the uploader said so (or made no
 * declaration at all), and no admin triage contradicts them.
 *
 * THE ADMIN'S THREE STATES ARE ENUMERATED POSITIVELY — no listing, `false`,
 * `null` — rather than written as one negation of `true`, and that is not a
 * stylistic preference. `NOT: { listing: { is: { depictsPeople: true } } }`
 * was the first version of this, and it was WRONG for a listing that exists
 * with the people question unanswered: SQL's three-valued logic makes
 * `depictsPeople = 1` evaluate to NULL rather than false on a NULL column,
 * and `NOT NULL` is NULL, which is not true, so the arm failed and the row
 * vanished from the public site. That is a fail-closed direction, so no leak
 * — but it would have quietly hidden every published, triage-started upload
 * on the site, and nothing in the predicate next door would have noticed.
 *
 * It was found by publishability.scope-agreement.test.ts, which runs the
 * predicate and this filter over the same rows: the `listing-untriaged` case
 * disagreed. That is what the cross-check is for, and why it enumerates the
 * states a column can be in rather than only the ones a reviewer thinks of.
 */
const NOBODY_IDENTIFIABLE_SHOWN = {
  AND: [
    {
      OR: [
        { attestation: { is: { showsIdentifiablePeople: false } } },
        // NO DECLARATION AT ALL (ugcportal-ho7j): `showsIdentifiablePeople`
        // in the predicate reads `attestation?.showsIdentifiablePeople ===
        // true`, which is false for a missing row, so the listing alone
        // decides. Safe to admit here because this arm is ANDed with the
        // first arm of the scope, which admits a missing declaration only
        // for a configured uploader — for anyone else the row is already
        // out before this arm is consulted.
        { attestation: { is: null } },
      ],
    },
    {
      OR: [
        // Every upload on this site today: nobody has opened the curation
        // flow on it, so there is no triage row at all.
        { listing: { is: null } },
        { listing: { is: { depictsPeople: false } } },
        { listing: { is: { depictsPeople: null } } },
      ],
    },
  ],
};

/**
 * A row with NO declaration whose uploader is CONFIGURED (ugcportal-ho7j) —
 * the query form of the `exemptFromDeclaration` skip in
 * `publishabilityBlocker` above.
 *
 * `user` is a RELATION filter like every other key in this scope, so it is
 * re-evaluated on every read: clearing a person's `configuredHandle` takes
 * their undeclared uploads off every public surface on the next request,
 * with no write to any `Media` row.
 *
 * `in` the handles the CHECKED array derives TODAY, not `not: null`
 * (ugcportal-lskg): the column is written at sign-in and nothing clears it, so
 * a person removed from `CONFIGURED_USERS`, or dropped by its boot check,
 * keeps a non-null handle. Asking
 * the same list `isConfiguredUser` (src/lib/publish-gates.ts) asks is what
 * takes their undeclared uploads off the public site once the deploy that
 * removes them is live. Copied into a fresh array because Prisma's `in`
 * takes a mutable one and the shared list is frozen. An empty list matches
 * no row (asserted in src/lib/publishability.scope-agreement.test.ts).
 *
 * `attestation: { is: null }` and not merely "or configured": a configured
 * uploader who DID declare is judged by the declaration, in the arm beside
 * this one, and a disclaiming declaration keeps the row out.
 */
const CONFIGURED_UPLOADER_UNDECLARED = {
  attestation: { is: null },
  user: { is: { configuredHandle: { in: [...CURRENT_CONFIGURED_HANDLES] } } },
};

/**
 * The rights half of `PUBLIC_MEDIA_SCOPE`.
 *
 * THREE ARMS, FROM TWO RULES, SINCE ugcportal-pgpq. The first two are this
 * module's own publishability rule (the attestation, and the PEOPLE layer);
 * the third is alkoholloven § 9-2's commercial pair plus, since
 * ugcportal-qnq9.11, a recorded `depictsAlcohol = true` (the complement of
 * `isWithheldFromPublicRead`), which lives in
 * src/lib/alcohol-commerce.ts beside its own TypeScript predicate and is
 * only assembled here, because this is the constant every anonymous reader
 * already spreads. That means this constant is no longer the query form of
 * `publishabilityBlocker` alone — see the third arm's own comment below, and
 * docs/legal/alcohol-commerce-public-visibility.md for why the § 9-2 pair is
 * judged at read time at all.
 *
 * EVERYTHING UNDER ONE `AND` KEY, which is not cosmetic. `listMedia`
 * (src/lib/media-listing.ts) merges the scope with its keyset predicate as
 * `{ ...scope, ...keyset }`, and the keyset is `{ OR: [...] }` — so a scope
 * with its own top-level `OR` would have it silently overwritten from page
 * two onwards, dropping this filter for every paginated request while page
 * one looked correct. Nesting the disjunction inside `AND` makes the two
 * objects share no key. Asserted directly, not just here, by "keeps no
 * top-level OR" in src/lib/public-media.consumers.test.ts.
 */
export type MediaPublicRightsScope = {
  AND: [
    {
      OR: [
        { attestation: { is: typeof PUBLISHABLE_ATTESTATION } },
        typeof CONFIGURED_UPLOADER_UNDECLARED,
      ];
    },
    { OR: [typeof NOBODY_IDENTIFIABLE_SHOWN, typeof PEOPLE_LAYER_CLEARED] },
    MediaAlcoholCommerceScope,
  ];
};

export const PUBLIC_MEDIA_RIGHTS_SCOPE: MediaPublicRightsScope = {
  AND: [
    // K1, as a query: a declaration exists, at a version still in force, and
    // does not disclaim the rights — or there is no declaration and the
    // uploader is a configured user (ugcportal-ho7j).
    {
      OR: [
        { attestation: { is: PUBLISHABLE_ATTESTATION } },
        CONFIGURED_UPLOADER_UNDECLARED,
      ],
    },
    // K2, as a query: nobody identifiable is shown, or the PEOPLE layer is
    // cleared.
    { OR: [NOBODY_IDENTIFIABLE_SHOWN, PEOPLE_LAYER_CLEARED] },
    /*
     * A THIRD ARM, FROM A DIFFERENT STATUTE (ugcportal-pgpq): alkoholloven
     * § 9-2's commercial pair, widened at ugcportal-qnq9.11 by a recorded
     * `depictsAlcohol = true` (so it is the complement of
     * `isWithheldFromPublicRead`), defined beside its own predicate in
     * src/lib/alcohol-commerce.ts and only assembled here.
     *
     * WHY IT IS HERE AND NOT IN A CONSTANT OF ITS OWN BESIDE
     * `PUBLIC_MEDIA_SCOPE`. Two reasons, both load-bearing. The scope's own
     * key set is asserted to be exactly the column half plus this constant
     * (src/lib/public-media.consumers.test.ts,
     * src/lib/media-public-feed-index-migration.test.ts) and
     * `PUBLIC_MEDIA_SCOPE.AND` is asserted to BE this array
     * (src/lib/public-media.lapse.test.ts), so a fourth top-level key would
     * be a new thing to remember at every call site rather than one the
     * scope carries. And the arm is a conjunction that CONTAINS a
     * disjunction (`{ AND: [not-recorded, { OR: [...] }] }`): hoisting its
     * members to the scope's top level would put an `OR` there, and a
     * top-level `OR` on the scope is silently overwritten by `listMedia`'s
     * keyset predicate from page two onwards — see this type's own comment
     * above — so nesting it inside this `AND` is the only placement that
     * survives pagination.
     *
     * It is a RELATION FILTER ONLY (`listing`, `advertisingDisclosure`,
     * `commercialLinks`), which is what makes it re-evaluated on every read
     * rather than snapshotted at publish time; that property is asserted,
     * not just described, by "is RELATION FILTERS ONLY" in
     * src/lib/public-media.lapse.test.ts.
     */
    PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE,
  ],
};

/**
 * The attestation codes this module has an opinion about, exported so a test
 * can assert the `Record` above covers `ATTESTATION_BLOCKERS` exactly at
 * runtime as well as at compile time — `tsc` proves no key is missing, and
 * this proves none was added that the sale gate does not produce.
 */
export const PUBLISH_ATTESTATION_BLOCKER_CODES = Object.keys(
  PUBLISH_ATTESTATION_BLOCKERS,
).sort();

/** The sale-gate codes, sorted, for the same assertion's other side. */
export const SALE_ATTESTATION_BLOCKER_CODES = [...ATTESTATION_BLOCKERS].sort();

/**
 * Which attestation codes do NOT stop a publish. Exported so the decision is
 * assertable rather than only readable — a future edit that quietly maps a
 * blocking code to `null` changes this array, and
 * publishability.test.ts fails.
 */
export const PUBLISH_PERMITTED_ATTESTATION_BLOCKERS = ATTESTATION_BLOCKERS.filter(
  (code) => PUBLISH_ATTESTATION_BLOCKERS[code] === null,
);
