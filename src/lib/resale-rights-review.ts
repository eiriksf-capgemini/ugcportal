import type {
  ResaleRightsRoute,
  ResaleRightsStatus,
} from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import {
  CURRENT_CHECKLIST_VERSION,
  PRODUCT_DECISION_REF,
} from "@/lib/resale-rights";

/**
 * The only writer of ResaleRightsReview.status in the codebase
 * (ugcportal-0ss K4, checklist Part E.3). Everything that changes an
 * account's resale-rights position goes through here so that:
 *
 *   - `CLEARED` is unreachable except from an authenticated ADMIN. It is not
 *     merely "not done elsewhere": the SYSTEM branch of the input type cannot
 *     express it, so a sync job or callback that tried would not compile, and
 *     a JS caller that bypassed the types is refused at runtime below.
 *   - every transition leaves a ResaleRightsEvent row behind.
 *
 * Authorization is the caller's job (see requireAdmin in src/lib/admin.ts) —
 * the same split roles.ts uses. What this module does add is a second,
 * database-side check that the actor really is an ADMIN *right now* before
 * writing CLEARED, because a session can outlive the role that created it.
 */

/** Statuses a non-human caller may set. Never CLEARED — that is the point. */
export const SYSTEM_SETTABLE_STATUSES = ["REVOKED", "EXPIRED"] as const;
export type SystemSettableStatus = (typeof SYSTEM_SETTABLE_STATUSES)[number];

export type ResaleRightsTransition =
  | {
      source: "ADMIN";
      actorUserId: string;
      actorEmail?: string | null;
      status: ResaleRightsStatus;
      reason: string;
      route?: ResaleRightsRoute | null;
      validUntil?: Date | null;
      conditions?: string | null;
      evidence?: { key: string; sha256: string } | null;
      /**
       * Re-stamp `checklistVersion` (and `productDecisionRef`) to what is
       * currently in force — an assertion that the reviewer has just worked
       * the account through *today's* checklist, not last year's.
       *
       * Default false, and that matters. Retiring a checklist version is how
       * a revision to the legal process forces re-review: the gate stops
       * accepting clearances granted under the old one. If every admin write
       * re-stamped the version, an admin fixing a typo in the conditions
       * would silently re-validate an account the process had deliberately
       * suspended — the same shape of bug as a form field that resets to its
       * permissive value. A re-stamp has to be asked for.
       *
       * Ignored when no review row exists yet: a first decision is
       * necessarily made against the checklist in force.
       */
      restampChecklist?: boolean;
    }
  | {
      /**
       * Deauthorize callbacks (ugcportal-69p), the validity sweep, and admin
       * disconnect. May only move an account *away* from sellable.
       */
      source: "SYSTEM";
      status: SystemSettableStatus;
      reason: string;
      /**
       * The human who triggered it, where there is one — an admin clicking
       * Disconnect. Recorded on the audit row only, never as
       * `reviewedByUserId`: triggering a revocation is not reviewing an
       * account, and writing them in as the reviewer of record would forge
       * a review that never happened.
       *
       * Null for a genuinely unattended transition (a callback, a sweep).
       */
      triggeredByUserId?: string | null;
      triggeredByEmail?: string | null;
    };

export type SetResaleRightsStatusResult =
  | { outcome: "recorded"; reviewId: string; selfReview: boolean }
  | { outcome: "unchanged"; reviewId: string }
  | { outcome: "account_not_found" }
  | { outcome: "actor_not_admin" }
  | { outcome: "forbidden_system_transition" }
  /** Another decision on the same account landed first — retry on a re-read. */
  | { outcome: "conflict" };

/**
 * Prisma's unique-constraint violation. Matched on the documented error code
 * rather than `instanceof PrismaClientKnownRequestError`, because the driver
 * adapter re-wraps errors and an instanceof check across module instances is
 * a coin flip.
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Record a resale-rights decision for one connected account.
 *
 * Returned outcomes rather than thrown errors, matching setUserRole: "that
 * account is gone" and "you are no longer an admin" are ordinary answers the
 * caller renders, not exceptional conditions.
 *
 * Concurrency, honestly: the read of the current status and the write of the
 * new one share a transaction, but `@prisma/adapter-libsql` opens SQLite
 * transactions as `deferred`, so that does **not** make the read
 * non-stale (this is the known issue recorded on ugcportal-lu7 about
 * src/lib/roles.ts). Two simultaneous transitions can therefore both read the
 * same `fromStatus`, and one of them will either lose the race or fail with
 * SQLITE_BUSY_SNAPSHOT. The consequence here is a possibly misleading
 * `fromStatus` on one audit row — not a lost clearance and not a path to
 * CLEARED, because which *caller* may write CLEARED is decided before the
 * transaction opens, not by what the read returned.
 */
export async function setResaleRightsStatus(
  instagramAccountId: string,
  transition: ResaleRightsTransition,
): Promise<SetResaleRightsStatusResult> {
  // Runtime half of the type-level guarantee above: a plain-JS caller, or a
  // value widened through `as`, still cannot smuggle CLEARED in on the
  // system path.
  if (
    transition.source === "SYSTEM" &&
    !(SYSTEM_SETTABLE_STATUSES as readonly string[]).includes(
      transition.status,
    )
  ) {
    return { outcome: "forbidden_system_transition" };
  }

  const reason = transition.reason.trim();
  if (!reason) {
    // An audit row that doesn't say why is not an audit row.
    throw new Error("A reason is required to change resale-rights status");
  }

  return prisma.$transaction(async (tx) => {
    const account = await tx.instagramAccount.findUnique({
      where: { id: instagramAccountId },
      select: { id: true, username: true, connectedByUserId: true },
    });
    if (!account) {
      return { outcome: "account_not_found" } as const;
    }

    if (transition.source === "ADMIN") {
      const actor = await tx.user.findUnique({
        where: { id: transition.actorUserId },
        select: { role: true },
      });
      if (actor?.role !== "ADMIN") {
        return { outcome: "actor_not_admin" } as const;
      }
    }

    const existing = await tx.resaleRightsReview.findUnique({
      where: { instagramAccountId },
      select: { id: true, status: true },
    });

    // A system transition that changes nothing writes nothing: a deauthorize
    // callback retried five times should not produce five REVOKED rows. An
    // admin re-affirming the same status *is* recorded, because re-clearing
    // with fresh evidence or a new validity window is a real decision.
    if (
      transition.source === "SYSTEM" &&
      existing &&
      existing.status === transition.status
    ) {
      return { outcome: "unchanged", reviewId: existing.id } as const;
    }

    const now = new Date();
    const selfReview =
      transition.source === "ADMIN" &&
      transition.actorUserId === account.connectedByUserId;

    const adminFields =
      transition.source === "ADMIN"
        ? {
            reviewedByUserId: transition.actorUserId,
            reviewedAt: now,
            // Absent (`undefined`) leaves the column as it was; an explicit
            // `null` clears it. Spelled this way so that rejecting or
            // revoking an account doesn't silently wipe the evidence pointer
            // to the contract it was cleared under — that object still
            // exists in the bucket, and losing the key loses the audit.
            route: transition.route,
            validUntil: transition.validUntil,
            conditions: transition.conditions,
            evidenceKey:
              transition.evidence === null ? null : transition.evidence?.key,
            evidenceSha256:
              transition.evidence === null ? null : transition.evidence?.sha256,
            // Both of these say "this clearance was granted under X". They
            // are only written when the reviewer says they have just worked
            // through X — otherwise `undefined` leaves the stored answer
            // alone. Restamping them on every edit would let a typo fix
            // re-validate an account whose checklist version had been
            // retired, or silently re-attribute a clearance to a product
            // decision that was taken after it.
            //
            // On create there is nothing to preserve and the reviewer is
            // looking at the current form, so the caller below supplies the
            // current values instead.
            ...(transition.restampChecklist
              ? {
                  checklistVersion: CURRENT_CHECKLIST_VERSION,
                  productDecisionRef: PRODUCT_DECISION_REF,
                }
              : {}),
          }
        : {};

    // The written row is read back rather than reconstructed, so the audit
    // snapshot below records what the review *actually* says after the write
    // — including fields this transition left alone.
    const snapshot = { id: true, checklistVersion: true, evidenceKey: true, evidenceSha256: true };
    let review;
    if (existing) {
      review = await tx.resaleRightsReview.update({
        where: { id: existing.id },
        data: { status: transition.status, ...adminFields },
        select: snapshot,
      });
    } else {
      try {
        review = await tx.resaleRightsReview.create({
          data: {
            instagramAccountId,
            status: transition.status,
            // First decision on this account: there is no stored version to
            // preserve, and the form the reviewer just used is the current
            // one. (A SYSTEM-created row — a revoke on an account nobody
            // reviewed — gets the same stamp; it is meaningless there, but
            // the column is required and the row is never sellable.)
            checklistVersion: CURRENT_CHECKLIST_VERSION,
            ...(transition.source === "ADMIN"
              ? { productDecisionRef: PRODUCT_DECISION_REF }
              : {}),
            ...adminFields,
          },
          select: snapshot,
        });
      } catch (error) {
        // The read above and this write are not serialised — adapter-libsql
        // opens `deferred` transactions — so two first decisions on the same
        // account can both see no existing row and both try to create one.
        // The unique index on instagramAccountId is what actually prevents
        // two reviews; without this catch the loser would throw P2002 out of
        // a function contracted to return outcomes, and the admin would get
        // an unhandled-error page instead of a message.
        //
        // Reported rather than retried here: the winner may have written a
        // different status, so the right move is to re-read and decide
        // again, which is what the caller's redirect makes the admin do.
        if (isUniqueConstraintError(error)) {
          return { outcome: "conflict" } as const;
        }
        throw error;
      }
    }

    await tx.resaleRightsEvent.create({
      data: {
        reviewId: review.id,
        // Snapshotted, not joined: this row has to still read sensibly after
        // the account is disconnected and both it and the review are gone.
        instagramAccountId,
        instagramUsername: account.username,
        // No row yet means the account was UNREVIEWED by definition, which is
        // what the gate treated it as — so record that, not null.
        fromStatus: existing ? existing.status : "UNREVIEWED",
        toStatus: transition.status,
        // For a system transition this is whoever triggered it, if anyone —
        // an admin clicking Disconnect is named here without being recorded
        // as the account's reviewer.
        actorUserId:
          transition.source === "ADMIN"
            ? transition.actorUserId
            : (transition.triggeredByUserId ?? null),
        actorEmail:
          transition.source === "ADMIN"
            ? (transition.actorEmail ?? null)
            : (transition.triggeredByEmail ?? null),
        reason,
        selfReview,
        checklistVersion: review.checklistVersion,
        evidenceKey: review.evidenceKey,
        evidenceSha256: review.evidenceSha256,
      },
    });

    return { outcome: "recorded", reviewId: review.id, selfReview } as const;
  });
}
