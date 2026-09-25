import {
  ResaleRightsRoute,
  ResaleRightsStatus,
  RightsLayer,
  type Role,
} from "@/generated/prisma/enums";

/**
 * The sellability gate (ugcportal-0ss), implementing Part E.3 of
 * docs/legal/instagram-resale-rights-checklist.md.
 *
 * Nothing from a connected Instagram account may be offered for sale until a
 * human ADMIN has recorded a clearance against that account. This module is
 * the single place that decides that, so curation (ugcportal-74w), checkout
 * (ugcportal-p3v) and the public catalogue cannot each grow their own
 * slightly different version of the rule.
 *
 * Everything here fails closed: a missing review row, an un-triaged post, an
 * unknown checklist version and a demoted reviewer all mean "not sellable".
 * There is no input that produces `true` by default.
 *
 * The predicate is pure; callers load the row themselves with
 * CURATED_POST_GATE_SELECT below (inside the same transaction as any write
 * they are gating) and pass it in. That keeps the rule in one place without
 * forcing every caller through one query shape.
 */

/**
 * Checklist version currently in force — the string at the top of
 * docs/legal/instagram-resale-rights-checklist.md. New clearances are
 * recorded against this one.
 */
export const CURRENT_CHECKLIST_VERSION = "2026-09-24.1";

/**
 * Versions a *past* clearance may still rely on. Revising the checklist in a
 * way that changes what the reviewer had to check means dropping the old
 * version from this set, which immediately makes every account cleared under
 * it unsellable until someone re-reviews it. That is the intended blast
 * radius: the alternative is selling under a review that never asked the
 * question the revision added.
 */
export const ACCEPTED_CHECKLIST_VERSIONS: ReadonlySet<string> = new Set([
  CURRENT_CHECKLIST_VERSION,
]);

/**
 * The product decision every clearance is currently made under: ugcportal-2eh
 * Option A — the Instagram API is used for DISCOVERY ONLY, and the file sold
 * is always the owner-uploaded original from ugcportal-8wa. Recorded on the
 * review row so a later reader can tell which decision the human was
 * applying.
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

/** Why a post is not sellable. Closed set, safe to render and to log. */
export type SellabilityBlocker =
  | "no_review"
  | "status_not_cleared"
  | "clearance_expired"
  | "checklist_version_retired"
  | "reviewer_not_admin"
  | "triage_incomplete"
  | "triage_not_signed_by_admin"
  | "model_release_missing"
  | "model_release_unverified"
  | "third_party_layer_uncleared"
  | "not_owner_supplied_original"
  | "media_not_owned"
  | "rights_holder_not_recorded";

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
  /** The user whose uploads this clearance covers. See `media` on GatePost. */
  clearedOwnerUserId: string | null;
};

/**
 * One layer's justification, with the clearer's *current* role — re-read for
 * the same reason the account reviewer's is: a demotion has to take effect
 * on the clearances that person signed.
 */
export type GateLayerClearance = {
  layer: RightsLayer;
  reason: string;
  clearedByUserId: string | null;
  clearedBy: { role: Role } | null;
};

/**
 * A curated post as the gate sees it. Shaped like the Prisma row plus its
 * account's review, so callers can pass the result of
 * `CURATED_POST_GATE_SELECT` straight in.
 */
export type GatePost = {
  mediaId: string | null;
  /**
   * The referenced Media row, or null if there isn't one.
   *
   * Loaded separately by the caller (see `loadGateMedia`) because
   * CuratedPost.mediaId has no Prisma relation yet — the Media model belongs
   * to an in-flight branch. It is part of the gate input rather than an
   * afterthought precisely because "does this file exist, and is it the
   * right person's file" is a rights question, not a tidiness one.
   */
  media: { userId: string } | null;
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
  instagramAccount: { resaleRightsReview: GateReview | null } | null;
};

/**
 * Prisma `select` matching GatePost exactly. Shared so a caller can't forget
 * to load `reviewedBy.role` and quietly get `reviewer_not_admin` — or, worse,
 * hand-roll a narrower select that omits a field the gate checks.
 */
export const CURATED_POST_GATE_SELECT = {
  mediaId: true,
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
  instagramAccount: {
    select: {
      resaleRightsReview: {
        select: {
          status: true,
          checklistVersion: true,
          reviewedByUserId: true,
          validUntil: true,
          clearedOwnerUserId: true,
          reviewedBy: { select: { role: true } },
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

/** Just enough of a Media row for the gate; never `key`, never the bytes. */
export const GATE_MEDIA_SELECT = { userId: true } as const;

/**
 * Loads the Media row a curated post points at, for the ownership check.
 *
 * A second query rather than a join because CuratedPost.mediaId has no
 * Prisma relation — the Media model is owned by an in-flight branch
 * (ugcportal-r1d), and ugcportal-vsm will re-anchor all of this to uploads
 * anyway. Collapse it into a single read with an `include` once one of those
 * has landed; the predicate does not care which way the row arrived.
 *
 * Takes the client so a caller can pass a transaction and have the
 * ownership check see the same snapshot as the rest of its work.
 */
export async function loadGateMedia(
  client: {
    media: {
      findUnique: (args: {
        where: { id: string };
        select: typeof GATE_MEDIA_SELECT;
      }) => Promise<{ userId: string } | null>;
    };
  },
  mediaId: string | null,
): Promise<{ userId: string } | null> {
  if (!mediaId || !mediaId.trim()) {
    return null;
  }
  return client.media.findUnique({
    where: { id: mediaId },
    select: GATE_MEDIA_SELECT,
  });
}

/**
 * True when *this specific layer* carries a justification an admin signed.
 *
 * Per layer, not per post. An earlier revision took any post-level clearance
 * as settling all three, so a post cleared with "music licence purchased"
 * became sellable with an untriaged third-party creator and an untriaged
 * sponsorship attached — one answer standing in for three unrelated
 * questions, in a module whose contract is that nothing passes by default.
 *
 * The clearer's role is re-read here rather than trusted from write time,
 * exactly as accountClearanceBlocker does for the account reviewer: a
 * justification signed by someone since demoted is not one this instance
 * stands behind. Without it, a demoted admin's layer clearances quietly
 * survive as long as some *other* admin signed the account.
 */
function layerIsCleared(post: GatePost, layer: RightsLayer): boolean {
  // `?? []` and `?.trim()` for the same reason as everything else in this
  // module: a missing relation or a null column must answer "not cleared",
  // not throw a TypeError that some caller might catch and treat as a
  // transient failure.
  const clearance = (post.layerClearances ?? []).find(
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
  post: GatePost,
  layer: RightsLayer,
): boolean {
  // `value` is a real boolean by the time this is called (see isTriaged at
  // the call site), so absent is not a case here — only "not present" and
  // "present, and therefore needing its own clearance".
  return value === false || layerIsCleared(post, layer);
}

/**
 * Steps 1–4 of Part E.3: is the *account* cleared right now. Returns the
 * blocker, or null when the account-level clearance holds.
 *
 * Split out because the admin screen needs exactly this question — "is this
 * account's clearance currently good?" — and a screen that answered it with
 * its own copy of the rule would eventually disagree with the gate.
 */
export function accountClearanceBlocker(
  review: GateReview | null,
  now: Date = new Date(),
): SellabilityBlocker | null {
  // (1) Fail closed. A missing review row is UNREVIEWED — an account nobody
  // has looked at, which is the state every account starts in.
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

  // (5) A clearance has to say whose rights were cleared, or it authorises
  // nothing in particular. The gate compares the file's owner against this
  // (see evaluateSellability), so without it every ownership check would
  // have nothing to check against.
  if (!review.clearedOwnerUserId) {
    return "rights_holder_not_recorded";
  }

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
  post: GatePost,
  now: Date = new Date(),
): SellabilityResult {
  const review = post.instagramAccount?.resaleRightsReview ?? null;

  const accountBlocker = accountClearanceBlocker(review, now);
  // `!review` is redundant with the blocker above — a null review always
  // produces "no_review" — but it is what narrows the type for the
  // ownership comparison at the end, and a redundant fail-closed check is
  // the right kind of redundant.
  if (accountBlocker || !review) {
    return { sellable: false, blocker: accountBlocker ?? "no_review" };
  }

  // (5) Per-post triage (Part C). Account-level clearance covers the Owner's
  // own copyright only.
  //
  // The triage has to be attributable before any of its answers count. Each
  // flag below is an assertion about a third party's rights, and the
  // dangerous direction is `false`: "this photograph contains no
  // identifiable person" sells the photograph. Read-time role check, like
  // everywhere else here, so a demoted admin's assertions stop counting
  // rather than persisting because someone else signed the account.
  if (!isTriaged(post.depictsPeople)) {
    return { sellable: false, blocker: "triage_incomplete" };
  }
  if (!post.triagedByUserId || post.triagedBy?.role !== "ADMIN") {
    return { sellable: false, blocker: "triage_not_signed_by_admin" };
  }

  // People (Part C.2). The strictest layer, because it is the one with a
  // named individual behind it: it needs the release *file* and an admin
  // who says that file covers this use. A key alone is free text — it can
  // point at a document that licenses something else entirely, or at
  // nothing.
  if (post.depictsPeople) {
    // Trimmed like the other string checks: a key of spaces is not a
    // release.
    if (!post.modelReleaseKey?.trim()) {
      return { sellable: false, blocker: "model_release_missing" };
    }
    if (!layerIsCleared(post, RightsLayer.PEOPLE)) {
      return { sellable: false, blocker: "model_release_unverified" };
    }
  }
  // Each layer answers for itself. Pairing the triage flag with its own
  // RightsLayer is what keeps one justification from covering three
  // unrelated questions.
  const layers: [boolean | null, RightsLayer][] = [
    [post.containsMusic, RightsLayer.MUSIC],
    [post.thirdPartyCreator, RightsLayer.THIRD_PARTY_CREATOR],
    [post.sponsoredContent, RightsLayer.SPONSORED_CONTENT],
  ];
  for (const [value, layer] of layers) {
    if (!isTriaged(value)) {
      return { sellable: false, blocker: "triage_incomplete" };
    }
    if (!layerIsSettled(value, post, layer)) {
      return { sellable: false, blocker: "third_party_layer_uncleared" };
    }
  }

  // (6) The file sold is the owner-uploaded original (ugcportal-8wa), never
  // anything fetched from graph.instagram.com — the ugcportal-2eh Option A
  // boundary. Part E.3 phrases this as "unless productDecisionRef records a
  // different decision"; no such decision exists, and a data-driven bypass of
  // a Platform-Terms boundary is not something this gate offers. If one is
  // ever taken, it belongs in code, in review, not in a database column.
  if (!post.mediaId || !post.mediaId.trim()) {
    return { sellable: false, blocker: "not_owner_supplied_original" };
  }
  // The pointer has to resolve. `mediaId` has no foreign key behind it (the
  // Media model belongs to another branch), so "there is a row with this id"
  // is a question only the loaded row can answer — and an unresolvable
  // pointer is not an owner-supplied original, it is nothing at all.
  if (!post.media) {
    return { sellable: false, blocker: "not_owner_supplied_original" };
  }
  // And it has to be the file of the person the *clearance* names.
  //
  // Compared against the review, not against a second column on this same
  // row. An earlier revision put an `ownerUserId` on CuratedPost and checked
  // the two against each other — but both were written by whoever created
  // the listing, so it only proved a row was self-consistent. Whoever can
  // set `mediaId` can set that too. The clearance is the only party to this
  // that a listing's author does not control, so it is the one that decides
  // whose uploads may be sold.
  // `clearedOwnerUserId` is already known non-empty (the account-level
  // check above), so an absent media owner cannot compare equal to it — but
  // the explicit guard says so rather than relying on that reading.
  if (!post.media.userId || post.media.userId !== review.clearedOwnerUserId) {
    return { sellable: false, blocker: "media_not_owned" };
  }

  return { sellable: true };
}

/** Boolean form of {@link evaluateSellability}, for call sites that only branch. */
export function isSellable(post: GatePost, now: Date = new Date()): boolean {
  return evaluateSellability(post, now).sellable;
}

