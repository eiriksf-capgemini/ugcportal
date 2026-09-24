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
    }
  | {
      /**
       * Deauthorize callbacks (ugcportal-69p) and the validity sweep. May
       * only move an account *away* from sellable.
       */
      source: "SYSTEM";
      status: SystemSettableStatus;
      reason: string;
    };

export type SetResaleRightsStatusResult =
  | { outcome: "recorded"; reviewId: string; selfReview: boolean }
  | { outcome: "unchanged"; reviewId: string }
  | { outcome: "account_not_found" }
  | { outcome: "actor_not_admin" }
  | { outcome: "forbidden_system_transition" };

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
            // Which product decision the human was applying (Option A).
            productDecisionRef: PRODUCT_DECISION_REF,
            // Always the version in force at decision time; a clearance can
            // never be recorded against a checklist the reviewer didn't read.
            checklistVersion: CURRENT_CHECKLIST_VERSION,
          }
        : {};

    // The written row is read back rather than reconstructed, so the audit
    // snapshot below records what the review *actually* says after the write
    // — including fields this transition left alone.
    const snapshot = { id: true, checklistVersion: true, evidenceKey: true, evidenceSha256: true };
    const review = existing
      ? await tx.resaleRightsReview.update({
          where: { id: existing.id },
          data: { status: transition.status, ...adminFields },
          select: snapshot,
        })
      : await tx.resaleRightsReview.create({
          data: {
            instagramAccountId,
            status: transition.status,
            checklistVersion: CURRENT_CHECKLIST_VERSION,
            ...adminFields,
          },
          select: snapshot,
        });

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
        actorUserId:
          transition.source === "ADMIN" ? transition.actorUserId : null,
        actorEmail:
          transition.source === "ADMIN" ? (transition.actorEmail ?? null) : null,
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
