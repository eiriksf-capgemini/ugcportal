import {
  ResaleRightsRoute,
  ResaleRightsStatus,
  RightsLayer,
  type Role,
} from "@/generated/prisma/enums";

/**
 * The sellability gate (ugcportal-0ss, re-anchored by ugcportal-vsm),
 * implementing Part E.3 of
 * docs/legal/instagram-resale-rights-checklist.md.
 *
 * Nothing may be offered for sale until a human ADMIN has recorded a
 * clearance for the person who uploaded it AND signed off what is in the
 * file itself. This module is the single place that decides that, so
 * curation (ugcportal-74w), checkout (ugcportal-p3v) and the public
 * catalogue cannot each grow their own slightly different version of the
 * rule.
 *
 * The grain is a hybrid, and the two halves answer different questions at
 * different frequencies:
 *
 *   1. PER UPLOADER — ResaleRightsReview. "May this person's own work be
 *      resold at all?" Asked once per person, expires, and stops counting
 *      when the checklist version it was granted under is retired.
 *   2. PER UPLOAD — MediaListing's triage plus a MediaRightsClearance per
 *      rights layer that is actually present. "What is in this file?" An
 *      identifiable person, licensed music, an uncredited collaborator and
 *      undisclosed sponsorship are properties of the file, not of the
 *      uploader, so a cleared uploader does not get to sell whatever they
 *      upload next.
 *
 * WHERE THE REVIEW COMES FROM IS THE SECURITY PROPERTY. The gate starts at
 * a Media row and follows `media.user.resaleRightsReview`. Nobody assembling
 * a listing picks which clearance applies, so there is no second value for
 * the owner check to disagree with — which is why ugcportal-0ss's
 * `clearedOwnerUserId` comparison (and its `media_not_owned` /
 * `rights_holder_not_recorded` blockers) are gone rather than ported. The
 * only relation in MEDIA_GATE_SELECT that reaches a review is the file's own
 * `user`, so a caller using it is reading the uploader's clearance by
 * construction rather than by remembering to.
 *
 * Everything here fails closed: a missing review row, a missing listing, an
 * un-triaged upload, an unknown checklist version and a demoted reviewer all
 * mean "not sellable". There is no input that produces `true` by default.
 *
 * The predicate is pure; callers load the row themselves with
 * MEDIA_GATE_SELECT below (inside the same transaction as any write they are
 * gating) and pass it in. That keeps the rule in one place without forcing
 * every caller through one query shape.
 */

/**
 * Checklist version currently in force — the string at the top of
 * docs/legal/instagram-resale-rights-checklist.md. New clearances are
 * recorded against this one.
 *
 * Bumped from `2026-09-24.1` by ugcportal-vsm. That version asked about the
 * content of one connected Instagram account; this one asks about an
 * uploader, and a clearance against an uploader authorises their entire past
 * and future upload history. A different question about a different subject
 * with a wider blast radius is precisely what retiring a version is for — see
 * E.0 in the checklist. The bump retires nothing in practice, because the
 * migration discarded every account-level clearance, which is exactly why it
 * was cheap to do now and would not have been later.
 */
export const CURRENT_CHECKLIST_VERSION = "2026-09-27.1";

/**
 * Versions a *past* clearance may still rely on. Revising the checklist in a
 * way that changes what the reviewer had to check means dropping the old
 * version from this set, which immediately makes every uploader cleared under
 * it unsellable until someone re-reviews them. That is the intended blast
 * radius: the alternative is selling under a review that never asked the
 * question the revision added.
 */
export const ACCEPTED_CHECKLIST_VERSIONS: ReadonlySet<string> = new Set([
  CURRENT_CHECKLIST_VERSION,
]);

/**
 * The product decision every clearance is currently made under: ugcportal-2eh
 * Option A — the file sold is always the owner-uploaded original from
 * ugcportal-8wa. Recorded on the review row so a later reader can tell which
 * decision the human was applying.
 */
export const PRODUCT_DECISION_REF = "ugcportal-2eh";

/**
 * Every status, derived from the generated enum rather than hand-listed, so
 * adding one to the schema can't leave a form or a test silently covering
 * five of six.
 */
export const RESALE_RIGHTS_STATUSES = Object.values(
  ResaleRightsStatus,
) as readonly ResaleRightsStatus[];

export const RESALE_RIGHTS_ROUTES = Object.values(
  ResaleRightsRoute,
) as readonly ResaleRightsRoute[];

export function isResaleRightsStatus(
  value: unknown,
): value is ResaleRightsStatus {
  return (
    typeof value === "string" &&
    (RESALE_RIGHTS_STATUSES as readonly string[]).includes(value)
  );
}

export function isResaleRightsRoute(value: unknown): value is ResaleRightsRoute {
  return (
    typeof value === "string" &&
    (RESALE_RIGHTS_ROUTES as readonly string[]).includes(value)
  );
}

/** Why an upload is not sellable. Closed set, safe to render and to log. */
export type SellabilityBlocker =
  | "no_review"
  | "status_not_cleared"
  | "clearance_expired"
  | "checklist_version_retired"
  | "reviewer_not_admin"
  | "upload_owner_unknown"
  | "not_listed_for_sale"
  | "triage_incomplete"
  | "triage_not_signed_by_admin"
  | "model_release_missing"
  | "model_release_unverified"
  | "third_party_layer_uncleared";

export type SellabilityResult =
  | { sellable: true }
  | { sellable: false; blocker: SellabilityBlocker };

/** The review columns the gate reads, plus the reviewer's *current* role. */
export type GateReview = {
  status: ResaleRightsStatus;
  checklistVersion: string;
  reviewedByUserId: string | null;
  validUntil: Date | null;
  reviewedBy: { role: Role } | null;
};

/**
 * One layer's justification, with the clearer's *current* role — re-read for
 * the same reason the uploader reviewer's is: a demotion has to take effect
 * on the clearances that person signed.
 */
export type GateLayerClearance = {
  layer: RightsLayer;
  reason: string;
  clearedByUserId: string | null;
  clearedBy: { role: Role } | null;
};

/**
 * The sale record for one upload, as the gate sees it: the Part C triage and
 * the per-layer justifications. Absent (`null` on the upload) means nobody
 * has put this file forward for sale, which is not sellable.
 */
export type GateListing = {
  depictsPeople: boolean | null;
  modelReleaseKey: string | null;
  containsMusic: boolean | null;
  thirdPartyCreator: boolean | null;
  sponsoredContent: boolean | null;
  /**
   * Who signed off the triage flags above, with their *current* role. Every
   * one of those flags is an assertion about someone else's rights — "no
   * identifiable people", "no music" — and an unattributed assertion is not
   * one this gate accepts.
   */
  triagedByUserId: string | null;
  triagedBy: { role: Role } | null;
  /** One justification per layer; see layerIsSettled. */
  layerClearances: GateLayerClearance[];
};

/**
 * An upload as the gate sees it: the Media row, its uploader's standing
 * review, and its sale record.
 *
 * Shaped like the Prisma row so callers can pass the result of
 * MEDIA_GATE_SELECT straight in. Note the direction — the review hangs off
 * `user`, i.e. off the column that says who uploaded the file. That is the
 * anchor, and it is why this type has no "whose rights were cleared" field
 * to compare against.
 */
export type GateUpload = {
  userId: string | null;
  user: { resaleRightsReview: GateReview | null } | null;
  listing: GateListing | null;
};

/**
 * The review columns the gate reads, named separately from the select below
 * so the nesting stays legible — this is the part that hangs off `user`,
 * which is the whole argument of this module.
 */
const REVIEW_GATE_SELECT = {
  status: true,
  checklistVersion: true,
  reviewedByUserId: true,
  validUntil: true,
  reviewedBy: { select: { role: true } },
} as const;

/**
 * Prisma `select` matching GateUpload exactly, rooted at Media. Shared so a
 * caller can't forget to load `reviewedBy.role` and quietly get
 * `reviewer_not_admin` — or, worse, hand-roll a narrower select that omits a
 * field the gate checks.
 *
 * Rooted at Media rather than at the listing on purpose: the path from the
 * file to the clearance that governs it (`user.resaleRightsReview`) is
 * written down here, once, instead of being re-derived by each caller. A
 * caller cannot substitute a different user's review without abandoning this
 * constant, which is a visible act rather than an omission.
 */
export const MEDIA_GATE_SELECT = {
  userId: true,
  user: { select: { resaleRightsReview: { select: REVIEW_GATE_SELECT } } },
  listing: {
    select: {
      depictsPeople: true,
      modelReleaseKey: true,
      containsMusic: true,
      thirdPartyCreator: true,
      sponsoredContent: true,
      triagedByUserId: true,
      triagedBy: { select: { role: true } },
      layerClearances: {
        select: {
          layer: true,
          reason: true,
          clearedByUserId: true,
          clearedBy: { select: { role: true } },
        },
      },
    },
  },
} as const;

/**
 * Milliseconds for a value that is supposed to be a Date, or NaN.
 *
 * NaN is the honest answer for "not a readable instant", and every
 * comparison in this module is written so that NaN lands on the blocked
 * side. Anything that is not a Date — a string that survived a hand-written
 * query, a column a future select forgot to map — gets the same treatment
 * as an Invalid Date rather than throwing or being silently coerced.
 */
function timeOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number.NaN;
}

/**
 * True only for a real boolean. `null` means "not triaged"; so does
 * `undefined`, and so does anything else that turns up in a column typed
 * `Boolean?`. Written as a type check rather than `=== null` because
 * `undefined === null` is false, which used to let an untriaged
 * `depictsPeople` skip the model-release requirement entirely.
 */
function isTriaged(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * True when *this specific layer* carries a justification an admin signed.
 *
 * Per layer, not per upload. An earlier revision took any item-level
 * clearance as settling all three, so an upload cleared with "music licence
 * purchased" became sellable with an untriaged third-party creator and an
 * untriaged sponsorship attached — one answer standing in for three
 * unrelated questions, in a module whose contract is that nothing passes by
 * default.
 *
 * The clearer's role is re-read here rather than trusted from write time,
 * exactly as uploaderClearanceBlocker does for the reviewer: a justification
 * signed by someone since demoted is not one this instance stands behind.
 * Without it, a demoted admin's layer clearances quietly survive as long as
 * some *other* admin signed the uploader.
 */
function layerIsCleared(listing: GateListing, layer: RightsLayer): boolean {
  // `?? []` and `?.trim()` for the same reason as everything else in this
  // module: a missing relation or a null column must answer "not cleared",
  // not throw a TypeError that some caller might catch and treat as a
  // transient failure.
  const clearance = (listing.layerClearances ?? []).find(
    (candidate) => candidate.layer === layer,
  );
  if (!clearance) {
    return false;
  }
  return Boolean(
    clearance.reason?.trim() &&
      clearance.clearedByUserId &&
      clearance.clearedBy?.role === "ADMIN",
  );
}

/**
 * A layer that must be absent, or cleared on its own terms if present.
 * `null` means nobody has triaged it, which is not the same as `false` and
 * never passes.
 */
function layerIsSettled(
  value: boolean,
  listing: GateListing,
  layer: RightsLayer,
): boolean {
  // `value` is a real boolean by the time this is called (see isTriaged at
  // the call site), so absent is not a case here — only "not present" and
  // "present, and therefore needing its own clearance".
  return value === false || layerIsCleared(listing, layer);
}

/**
 * Steps 1–4 of Part E.3: is this *uploader* cleared right now. Returns the
 * blocker, or null when the standing clearance holds.
 *
 * Split out because the admin screen needs exactly this question — "is this
 * uploader's clearance currently good?" — and a screen that answered it with
 * its own copy of the rule would eventually disagree with the gate.
 */
export function uploaderClearanceBlocker(
  review: GateReview | null,
  now: Date = new Date(),
): SellabilityBlocker | null {
  // (1) Fail closed. A missing review row is UNREVIEWED — an uploader nobody
  // has looked at, which is the state everyone starts in.
  if (!review) {
    return "no_review";
  }
  if (review.status !== ResaleRightsStatus.CLEARED) {
    return "status_not_cleared";
  }

  // (2) A clearance with a validity window stops counting the moment it ends.
  // No background job is required for the gate to be correct — EXPIRED as a
  // *status* is bookkeeping, this comparison is the enforcement.
  //
  // Written as `!(expiry > now)` rather than `expiry <= now`, which is not a
  // style choice. An Invalid Date's getTime() is NaN, and every comparison
  // against NaN is false — so `expiry <= now` answered "not expired" for a
  // date nobody can read, and the gate could return sellable. Inverting a
  // `>` makes the unreadable case fall to the blocked side, because `NaN >
  // n` is false and `!false` is true. Same for a caller that hands in a
  // broken `now`.
  //
  // `validUntil` truthiness rather than `!== null` covers `undefined` too: a
  // row assembled by hand, or a future select that omits the column, would
  // otherwise have thrown on `.getTime()`.
  if (review.validUntil) {
    const expiresAt = timeOf(review.validUntil);
    if (!(expiresAt > timeOf(now))) {
      return "clearance_expired";
    }
  }

  // (3) Re-checked here rather than trusted from write time: the reviewer may
  // have been demoted since, and a clearance signed by someone who is no
  // longer an admin is not a clearance this instance stands behind.
  if (!review.reviewedByUserId || review.reviewedBy?.role !== "ADMIN") {
    return "reviewer_not_admin";
  }

  // (4) A retired checklist version forces re-review.
  if (!ACCEPTED_CHECKLIST_VERSIONS.has(review.checklistVersion)) {
    return "checklist_version_retired";
  }

  // There is deliberately no (5) "does the clearance say whose rights it
  // covers". It always does, and it cannot say anything else: the review row
  // hangs off the uploader, so the only way to reach it is through the file's
  // own owner. ugcportal-0ss needed `rights_holder_not_recorded` because its
  // review hung off a connected account and had to name a user separately.
  return null;
}

/**
 * Part E.3, in order. Returns the *first* blocker rather than a list: the
 * admin has to fix them one at a time anyway, and a single code keeps the
 * caller's messaging a closed set.
 *
 * `now` is injectable so the expiry branch is testable without faking the
 * clock globally.
 */
export function evaluateSellability(
  upload: GateUpload,
  now: Date = new Date(),
): SellabilityResult {
  // (0) A file with no owner has no uploader to have been cleared. Under the
  // real schema `Media.userId` is a non-null foreign key, so an ordinary
  // Prisma read is not expected to produce this — the guard is for a
  // hand-assembled input (a fixture, a hand-written query, a future select
  // that maps the column wrong), which is exactly how the
  // `undefined === null` fail-open got in last time. It claims nothing about
  // what the column can hold; it says that if the value is ever not a
  // non-blank string — a number, an object, undefined — the answer is no
  // rather than a TypeError.
  if (typeof upload.userId !== "string" || !upload.userId.trim()) {
    return { sellable: false, blocker: "upload_owner_unknown" };
  }

  // (1–4) The uploader's standing clearance, reached through the file's own
  // owner. `user` being absent is the same answer as the review being
  // absent: nobody has cleared the person who uploaded this.
  const review = upload.user?.resaleRightsReview ?? null;
  const uploaderBlocker = uploaderClearanceBlocker(review, now);
  if (uploaderBlocker) {
    return { sellable: false, blocker: uploaderBlocker };
  }

  // (5) The upload has to have been put forward for sale at all. The
  // clearance above says the *person* may resell their work; it says nothing
  // about this particular file, and an upload nobody has triaged is an
  // upload nobody has looked at.
  const listing = upload.listing;
  if (!listing) {
    return { sellable: false, blocker: "not_listed_for_sale" };
  }

  // (6) Per-upload triage (Part C). The uploader-level clearance covers the
  // owner's own copyright only.
  //
  // The triage has to be attributable before any of its answers count. Each
  // flag below is an assertion about a third party's rights, and the
  // dangerous direction is `false`: "this photograph contains no
  // identifiable person" sells the photograph. Read-time role check, like
  // everywhere else here, so a demoted admin's assertions stop counting
  // rather than persisting because someone else signed the uploader.
  if (!isTriaged(listing.depictsPeople)) {
    return { sellable: false, blocker: "triage_incomplete" };
  }
  if (!listing.triagedByUserId || listing.triagedBy?.role !== "ADMIN") {
    return { sellable: false, blocker: "triage_not_signed_by_admin" };
  }

  // People (Part C.2). The strictest layer, because it is the one with a
  // named individual behind it: it needs the release *file* and an admin
  // who says that file covers this use. A key alone is free text — it can
  // point at a document that licenses something else entirely, or at
  // nothing.
  if (listing.depictsPeople) {
    // Trimmed like the other string checks: a key of spaces is not a
    // release.
    if (!listing.modelReleaseKey?.trim()) {
      return { sellable: false, blocker: "model_release_missing" };
    }
    if (!layerIsCleared(listing, RightsLayer.PEOPLE)) {
      return { sellable: false, blocker: "model_release_unverified" };
    }
  }
  // Each layer answers for itself. Pairing the triage flag with its own
  // RightsLayer is what keeps one justification from covering three
  // unrelated questions.
  const layers: [boolean | null, RightsLayer][] = [
    [listing.containsMusic, RightsLayer.MUSIC],
    [listing.thirdPartyCreator, RightsLayer.THIRD_PARTY_CREATOR],
    [listing.sponsoredContent, RightsLayer.SPONSORED_CONTENT],
  ];
  for (const [value, layer] of layers) {
    if (!isTriaged(value)) {
      return { sellable: false, blocker: "triage_incomplete" };
    }
    if (!layerIsSettled(value, listing, layer)) {
      return { sellable: false, blocker: "third_party_layer_uncleared" };
    }
  }

  // The file sold is the owner-uploaded original (ugcportal-8wa), which is
  // now a structural fact rather than a check: this predicate starts at a
  // Media row, and MediaListing.mediaId is a real foreign key to it. Under
  // ugcportal-0ss the listing carried an unconstrained `mediaId` string and
  // the gate had to prove the pointer resolved and pointed at the right
  // person's file. There is no pointer left to get wrong.
  //
  // Part E.3 phrases the Option A boundary as "unless productDecisionRef
  // records a different decision"; no such decision exists, and a
  // data-driven bypass of a Platform-Terms boundary is not something this
  // gate offers. If one is ever taken, it belongs in code, in review.
  return { sellable: true };
}

/** Boolean form of {@link evaluateSellability}, for call sites that only branch. */
export function isSellable(upload: GateUpload, now: Date = new Date()): boolean {
  return evaluateSellability(upload, now).sellable;
}
