import {
  ResaleRightsRoute,
  ResaleRightsStatus,
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
  | "model_release_missing"
  | "third_party_layer_uncleared"
  | "not_owner_supplied_original"
  | "media_not_owned";

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
 * A curated post as the gate sees it. Shaped like the Prisma row plus its
 * account's review, so callers can pass the result of
 * `CURATED_POST_GATE_SELECT` straight in.
 */
export type GatePost = {
  mediaId: string | null;
  /** Who the listing claims owns the file. See `media` below. */
  ownerUserId: string | null;
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
  postClearedByUserId: string | null;
  postClearedAt: Date | null;
  postClearanceReason: string | null;
  instagramAccount: { resaleRightsReview: GateReview | null } | null;
};

/**
 * Prisma `select` matching GatePost exactly. Shared so a caller can't forget
 * to load `reviewedBy.role` and quietly get `reviewer_not_admin` — or, worse,
 * hand-roll a narrower select that omits a field the gate checks.
 */
export const CURATED_POST_GATE_SELECT = {
  mediaId: true,
  ownerUserId: true,
  depictsPeople: true,
  modelReleaseKey: true,
  containsMusic: true,
  thirdPartyCreator: true,
  sponsoredContent: true,
  postClearedByUserId: true,
  postClearedAt: true,
  postClearanceReason: true,
  instagramAccount: {
    select: {
      resaleRightsReview: {
        select: {
          status: true,
          checklistVersion: true,
          reviewedByUserId: true,
          validUntil: true,
          reviewedBy: { select: { role: true } },
        },
      },
    },
  },
} as const;

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
 * True when this post has been explicitly cleared at post level with a
 * recorded human and reason — the escape hatch Part C allows for a layer
 * (music, a third-party creator, sponsorship) that is present but handled.
 * All three fields are required: a clearance with no reason is not a
 * clearance, it is a checkbox.
 */
function hasPostLevelClearance(post: GatePost): boolean {
  return Boolean(
    post.postClearedByUserId &&
      post.postClearedAt &&
      post.postClearanceReason &&
      post.postClearanceReason.trim(),
  );
}

/**
 * A layer that must be absent, or explicitly cleared if present. `null` means
 * nobody has triaged it, which is not the same as `false` and never passes.
 */
function layerIsSettled(value: boolean | null, post: GatePost): boolean {
  if (value === null) return false;
  if (value === false) return true;
  return hasPostLevelClearance(post);
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
  if (
    review.validUntil !== null &&
    review.validUntil.getTime() <= now.getTime()
  ) {
    return "clearance_expired";
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
  if (accountBlocker) {
    return { sellable: false, blocker: accountBlocker };
  }

  // (5) Per-post triage (Part C). Account-level clearance covers the Owner's
  // own copyright only.
  if (post.depictsPeople === null) {
    return { sellable: false, blocker: "triage_incomplete" };
  }
  // Trimmed, like the mediaId and post-clearance checks: a key of spaces is
  // not a model release, and storing one would otherwise wave through the
  // consent requirement for a photograph of a person.
  if (post.depictsPeople && !post.modelReleaseKey?.trim()) {
    return { sellable: false, blocker: "model_release_missing" };
  }
  for (const layer of [
    post.containsMusic,
    post.thirdPartyCreator,
    post.sponsoredContent,
  ]) {
    if (layer === null) {
      return { sellable: false, blocker: "triage_incomplete" };
    }
    if (!layerIsSettled(layer, post)) {
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
  // And it has to resolve to the right person's file. This is the check that
  // stops a listing under a cleared account from offering *someone else's*
  // upload: the clearance covers one party's rights, so the only file it can
  // authorise is that party's. Without it, `mediaId` is an unconstrained
  // pointer at every upload in the system.
  if (!post.ownerUserId || post.media.userId !== post.ownerUserId) {
    return { sellable: false, blocker: "media_not_owned" };
  }

  return { sellable: true };
}

/** Boolean form of {@link evaluateSellability}, for call sites that only branch. */
export function isSellable(post: GatePost, now: Date = new Date()): boolean {
  return evaluateSellability(post, now).sellable;
}

