import type {
  ResaleRightsRoute,
  ResaleRightsStatus,
} from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import {
  PRISMA_FOREIGN_KEY_VIOLATION,
  PRISMA_RECORD_NOT_FOUND,
  PRISMA_UNIQUE_VIOLATION,
  prismaErrorCode,
} from "@/lib/prisma-errors";
import {
  CURRENT_CHECKLIST_VERSION,
  PRODUCT_DECISION_REF,
} from "@/lib/resale-rights";

/**
 * The only writer of ResaleRightsReview.status in the codebase
 * (ugcportal-0ss K4, checklist Part E.3). Everything that changes an
 * uploader's resale-rights position goes through here so that:
 *
 *   - `CLEARED` is unreachable except from an authenticated ADMIN. It is not
 *     merely "not done elsewhere": the SYSTEM branch of the input type cannot
 *     express it, so a sweep or callback that tried would not compile, and a
 *     JS caller that bypassed the types is refused at runtime below.
 *   - every transition leaves a ResaleRightsEvent row behind.
 *
 * The subject is the uploader (ugcportal-vsm), not a connected Instagram
 * account. The audit rows written here are stamped `UPLOADER`; rows written
 * before the re-anchoring are stamped `INSTAGRAM_ACCOUNT` and are still
 * there, which is the point of a table with no foreign keys.
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
       * the uploader through *today's* checklist, not last year's.
       *
       * Default false, and that matters. Retiring a checklist version is how
       * a revision to the legal process forces re-review: the gate stops
       * accepting clearances granted under the old one. If every admin write
       * re-stamped the version, an admin fixing a typo in the conditions
       * would silently re-validate an uploader the process had deliberately
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
       * The validity sweep, and any future unattended path. May only move an
       * uploader *away* from sellable.
       */
      source: "SYSTEM";
      status: SystemSettableStatus;
      reason: string;
      /**
       * The human who triggered it, where there is one. Recorded on the audit
       * row only, never as `reviewedByUserId`: triggering a revocation is not
       * reviewing an uploader, and writing them in as the reviewer of record
       * would forge a review that never happened.
       *
       * Null for a genuinely unattended transition (a sweep, a callback).
       */
      triggeredByUserId?: string | null;
      triggeredByEmail?: string | null;
    };

export type SetResaleRightsStatusResult =
  | { outcome: "recorded"; reviewId: string; selfReview: boolean }
  | { outcome: "unchanged"; reviewId: string }
  | { outcome: "uploader_not_found" }
  | { outcome: "actor_not_admin" }
  | { outcome: "forbidden_system_transition" }
  /** Another decision on the same uploader landed first — retry on a re-read. */
  | { outcome: "conflict" }
  /** A user this decision points at (the uploader, the reviewer) is gone. */
  | { outcome: "missing_reference" };

/**
 * Database errors this function answers with an outcome rather than a throw,
 * because each is a race a user can legitimately lose rather than a fault:
 *
 *   P2002 unique violation   — two first decisions on one uploader
 *   P2003 foreign key        — a row this decision names was deleted
 *                              mid-form; which one decides the outcome, see
 *                              foreignKeyOutcome below
 *   P2025 record not found   — the review row vanished between read and write
 *
 * Matched on the documented error codes rather than
 * `instanceof PrismaClientKnownRequestError`, because the driver adapter
 * re-wraps errors and an instanceof check across module instances is a coin
 * flip.
 *
 * Deliberately an allow-list, and deliberately re-examined: P2002 was mapped
 * first, then P2003 turned out to be reachable too (libsql does enforce
 * foreign keys). The temptation after a second surprise is to catch
 * everything — but "disk I/O error" answered with a tidy message is a fault
 * that never gets looked at. The list is short and each entry names the race
 * it stands for; anything else is a real failure and stays loud.
 */
type RaceOutcome = "conflict" | "missing_reference" | "uploader_not_found";

const RACE_OUTCOMES: Record<string, RaceOutcome> = {
  [PRISMA_UNIQUE_VIOLATION]: "conflict",
  [PRISMA_FOREIGN_KEY_VIOLATION]: "missing_reference",
  [PRISMA_RECORD_NOT_FOUND]: "conflict",
};

/**
 * Which foreign key a P2003 was about, if the driver said.
 *
 * Two FKs on this row can raise it — the uploader and the reviewer — and
 * they need different answers. Reporting both as "the reviewer no longer
 * exists" is advice that cannot work when the uploader is what vanished, and
 * points the admin at the wrong record.
 *
 * The field name is matched loosely because its shape differs by connector:
 * SQLite reports something like
 * `ResaleRightsReview_uploaderUserId_fkey (index)`, Postgres the bare
 * column. When it cannot be attributed, the fallback is a message that names
 * both possibilities rather than guessing one.
 */
function foreignKeyOutcome(error: unknown): RaceOutcome {
  const field = (error as { meta?: { field_name?: unknown } })?.meta
    ?.field_name;
  return typeof field === "string" && field.includes("uploaderUserId")
    ? "uploader_not_found"
    : "missing_reference";
}

function raceOutcome(error: unknown): RaceOutcome | undefined {
  const code = prismaErrorCode(error);
  if (code === undefined) {
    return undefined;
  }
  if (code === PRISMA_FOREIGN_KEY_VIOLATION) {
    return foreignKeyOutcome(error);
  }
  return RACE_OUTCOMES[code];
}

/**
 * Record a resale-rights decision for one uploader.
 *
 * Returned outcomes rather than thrown errors, matching setUserRole: "that
 * user is gone" and "you are no longer an admin" are ordinary answers the
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
  uploaderUserId: string,
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

  // `?? ""` rather than trusting the type: a JS caller passing no reason
  // should get the explained refusal below, not a TypeError from .trim().
  const reason = (transition.reason ?? "").trim();
  if (!reason) {
    // An audit row that doesn't say why is not an audit row.
    throw new Error("A reason is required to change resale-rights status");
  }

  return prisma.$transaction(async (tx) => {
    const uploader = await tx.user.findUnique({
      where: { id: uploaderUserId },
      select: { id: true, email: true },
    });
    if (!uploader) {
      return { outcome: "uploader_not_found" } as const;
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
      where: { uploaderUserId },
      select: { id: true, status: true },
    });

    // A system transition that changes nothing writes nothing: a sweep run
    // five times should not produce five REVOKED rows. An admin re-affirming
    // the same status *is* recorded, because re-clearing with fresh evidence
    // or a new validity window is a real decision.
    if (
      transition.source === "SYSTEM" &&
      existing &&
      existing.status === transition.status
    ) {
      return { outcome: "unchanged", reviewId: existing.id } as const;
    }

    const now = new Date();
    // Separation of duties, re-anchored (ugcportal-vsm): the conflict of
    // interest is now an admin clearing their OWN uploads for sale, which is
    // the same shape of conflict as ugcportal-0ss's "reviewed by the admin
    // who connected the account" and a more direct one.
    const selfReview =
      transition.source === "ADMIN" &&
      transition.actorUserId === uploaderUserId;

    const adminFields =
      transition.source === "ADMIN"
        ? {
            reviewedByUserId: transition.actorUserId,
            reviewedAt: now,
            // Absent (`undefined`) leaves the column as it was; an explicit
            // `null` clears it. Spelled this way so that rejecting or
            // revoking an uploader doesn't silently wipe the evidence
            // pointer to the contract it was cleared under — that object
            // still exists in the bucket, and losing the key loses the audit.
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
            // re-validate an uploader whose checklist version had been
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
    const snapshot = {
      id: true,
      checklistVersion: true,
      evidenceKey: true,
      evidenceSha256: true,
    };
    let review;
    try {
      review = existing
        ? await tx.resaleRightsReview.update({
            where: { id: existing.id },
            data: { status: transition.status, ...adminFields },
            select: snapshot,
          })
        : await tx.resaleRightsReview.create({
            data: {
              uploaderUserId,
              status: transition.status,
              // First decision on this uploader: there is no stored version
              // to preserve, and the form the reviewer just used is the
              // current one. (A SYSTEM-created row — a revoke on an uploader
              // nobody reviewed — gets the same stamp; it is meaningless
              // there, but the column is required and the row is never
              // sellable.)
              checklistVersion: CURRENT_CHECKLIST_VERSION,
              ...(transition.source === "ADMIN"
                ? { productDecisionRef: PRODUCT_DECISION_REF }
                : {}),
              ...adminFields,
            },
            select: snapshot,
          });
    } catch (error) {
      // Both paths, not just the create. Nothing here is serialised —
      // adapter-libsql opens `deferred` transactions — so every row this
      // write depends on can move underneath it:
      //
      //   * two first decisions on one uploader both see no existing row and
      //     both create one; the unique index picks a winner (P2002)
      //   * the uploader or the reviewer is deleted between render and
      //     submit; the foreign key refuses the write (P2003 — libsql does
      //     enforce foreign keys)
      //   * the review row is deleted between the read above and the update
      //     (P2025)
      //
      // Reported rather than retried: the state that lost the race may say
      // something different now, so the right move is to re-read and decide
      // again, which is what the caller's redirect makes the admin do.
      const outcome = raceOutcome(error);
      if (outcome) {
        return { outcome } as const;
      }
      throw error;
    }

    await tx.resaleRightsEvent.create({
      data: {
        reviewId: review.id,
        // Snapshotted, not joined: this row has to still read sensibly after
        // the uploader is deleted and both they and the review are gone.
        subjectKind: "UPLOADER",
        subjectId: uploaderUserId,
        subjectLabel: uploader.email,
        // No row yet means the uploader was UNREVIEWED by definition, which
        // is what the gate treated them as — so record that, not null.
        fromStatus: existing ? existing.status : "UNREVIEWED",
        toStatus: transition.status,
        // For a system transition this is whoever triggered it, if anyone —
        // named here without being recorded as the reviewer of record.
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
