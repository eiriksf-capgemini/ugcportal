import { MediaAuthorship, RightsLayer, Role } from "@/generated/prisma/enums";
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
 * publishing needs the uploader to have said whose work this is and, where a
 * person is in the frame, an admin to have cleared that one layer. An item
 * can be perfectly publishable and unsellable, which is the ordinary case
 * for everything on this site today. Folding them together would mean
 * showing nothing until an admin had priced it.
 *
 * TWO EXPRESSIONS OF ONE RULE, AND BOTH LIVE HERE. `publishabilityBlocker`
 * below is the TypeScript predicate the publish route calls on one row;
 * `PUBLIC_MEDIA_RIGHTS_SCOPE` is the same rule as a Prisma `where`, spread
 * into `PUBLIC_MEDIA_SCOPE` (src/lib/public-media.ts) so that every
 * anonymous reader — the paginated feed, the server-rendered home page, the
 * portfolio, the sitemap and the per-item page — inherits it from the scope
 * constant rather than from remembering to ask. Writing a rule twice in two
 * languages is a real cost and it is paid deliberately: a row-at-a-time
 * predicate cannot filter a keyset-paginated query, and a `where` clause
 * cannot produce the message a refused publish has to show. They are kept
 * honest against each other by a cross-check that runs BOTH over the same
 * fixture rows in a real database and compares the answers
 * (src/lib/publishability.scope-agreement.test.ts), with the two
 * disagreements SQL cannot avoid enumerated there rather than hidden.
 *
 * WHAT THIS DELIBERATELY DOES NOT DECIDE. Whether self-service
 * publish-by-default is the right model at all is ugcportal-55nt's question
 * and is still open; nothing here answers it. This adds conditions to
 * publishing, which is strictly the safer direction under either answer.
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
 * WHERE THEY ARE SHOWN, as of ba9991f: in the 422 body. There is no
 * owner-facing publish control to put them beside yet. Evidence, and the
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

/** The refusal body the publish route answers with. */
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
 * in the frame; it takes both to mean nobody is. Note what that does NOT do:
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
   * before ugcportal-15r, and anything a future second write path creates
   * without one. It is never "the uploader said no".
   */
  attestation: GateAttestation | null;
  listing: PublishabilityListing | null;
};

/**
 * Prisma `select` for {@link PublishabilityUpload}'s attestation, reused from
 * `MEDIA_GATE_SELECT` rather than re-spelled.
 *
 * One copy, so a tenth attestation question cannot be added to the gate's
 * select and left out of the publish route's — which would read as
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
 * carries it. The predicate above runs on a publish REQUEST, so it governs
 * rows that cross the line from now on and nothing else. Every row published
 * before it existed — and every row whose clearance situation changed since —
 * is still sitting in the table, and five anonymous surfaces read it.
 *
 * So the rule is also a `where`, and it is spread into `PUBLIC_MEDIA_SCOPE`
 * ITSELF rather than repeated at each of those surfaces. That is the half
 * that covers the SIXTH reader, the one somebody adds next year: a new
 * anonymous query that reaches for the scope constant inherits this with
 * nothing to remember.
 *
 * A QUERY THAT DOES NOT REACH FOR IT IS NOT COVERED, here or anywhere else
 * (ugcportal-3ae review round 1, findings 2 and 3; an earlier draft of this
 * paragraph claimed such a query fails the consumers guard, which it does
 * not). src/lib/public-media.consumers.test.ts catches a reader that NAMES
 * the constant, by named import or by namespace import; its header sets out
 * what it is blind to, with the fixtures for both. The hand-written-`where`
 * shape is ugcportal-7egi. The four readers there are at ba9991f spread the
 * scope.
 */

/** The attestation a public row must carry, as a Prisma relation filter. */
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
 * Nobody identifiable in the frame: the uploader said so, and no admin
 * triage contradicts them.
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
  attestation: { is: { showsIdentifiablePeople: false } },
  OR: [
    // Every upload on this site today: nobody has opened the curation flow
    // on it, so there is no triage row at all.
    { listing: { is: null } },
    { listing: { is: { depictsPeople: false } } },
    { listing: { is: { depictsPeople: null } } },
  ],
};

/**
 * The rights half of `PUBLIC_MEDIA_SCOPE`.
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
    { attestation: { is: typeof PUBLISHABLE_ATTESTATION } },
    { OR: [typeof NOBODY_IDENTIFIABLE_SHOWN, typeof PEOPLE_LAYER_CLEARED] },
  ];
};

export const PUBLIC_MEDIA_RIGHTS_SCOPE: MediaPublicRightsScope = {
  AND: [
    // K1, as a query: a declaration exists, at a version still in force, and
    // does not disclaim the rights.
    { attestation: { is: PUBLISHABLE_ATTESTATION } },
    // K2, as a query: nobody identifiable is shown, or the PEOPLE layer is
    // cleared.
    { OR: [NOBODY_IDENTIFIABLE_SHOWN, PEOPLE_LAYER_CLEARED] },
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
