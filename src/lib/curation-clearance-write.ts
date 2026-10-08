import type { RightsLayer } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { isClearableLayer } from "@/lib/resale-rights";

/**
 * THE ONE PLACE A MediaRightsClearance ROW IS WRITTEN (ugcportal-qfy9).
 *
 * Before this bead nothing in `src` wrote one at all — `git grep
 * "mediaRightsClearance\." -- src` excluding tests returned nothing — so the
 * per-layer justifications the sellability gate reads in
 * src/lib/resale-rights.ts were readable and unwritable, and no upload with
 * any rights layer present could ever be sold. This function is the writer,
 * and `src/lib/curation-clearance-write-paths.test.ts` asserts against the
 * whole tree that it is the only one.
 *
 * ONE ROW SETTLES ONE LAYER, AND NOTHING ELSE. That is the whole bead, and
 * it is a legal invariant rather than a tidiness preference: a purchased
 * music licence is not an answer about an identifiable person, and a model
 * release is not an answer about undisclosed sponsorship. The row carries
 * exactly one `layer`, the gate consults it only through
 * `layerIsCleared(listing, fact.layer)`, and the unique index on
 * `(listingId, layer)` means a layer cannot end up with two answers for the
 * gate to choose between. Nothing in this module can write more than one
 * layer per call.
 *
 * A SINGLE CHOKEPOINT, like `recordTriageFacts` next door and for the same
 * reason. ugcportal-paa has to decide what a clearance must CONTAIN to count
 * as cleared (evidence, a route, a bounded `validUntil`), ugcportal-aqw has
 * to time-scope it to the material the reviewer actually saw, and
 * ugcportal-uv9 has to record self-review. Each of those is a rule about
 * what may be written, and a rule like that is only enforceable if there is
 * exactly one place the write can happen. Do not add a second writer; widen
 * this one.
 */

/**
 * Why a clearance write was refused. A closed set, every member of which has
 * a message in src/app/admin/curation/outcomes.ts — enforced by `tsc` there
 * rather than by memory, so a refusal added here cannot ship rendering
 * nothing.
 *
 * Prefixed `clearance_` because these codes share one `?error=` namespace
 * with the triage write's own refusals on the same screen, and two different
 * refusals answering to one code would render the wrong sentence.
 */
export const CLEARANCE_WRITE_REFUSALS = [
  "clearance_actor_not_admin",
  "clearance_layer_not_clearable",
  "clearance_reason_blank",
  "clearance_listing_not_found",
  "clearance_already_recorded",
] as const;

export type ClearanceWriteRefusal = (typeof CLEARANCE_WRITE_REFUSALS)[number];

export type ClearanceWriteOutcome =
  | { kind: "recorded"; clearanceId: string; listingId: string }
  | { kind: ClearanceWriteRefusal };

export type RecordLayerClearanceInput = {
  /** The ugcportal-8wa Media row whose listing is being cleared. */
  mediaId: string;
  /**
   * The ONE layer this clearance settles. Typed as `RightsLayer`, and
   * re-checked at runtime against the registry below: a type is not a
   * guarantee about a value that arrived as a form field.
   */
  layer: RightsLayer;
  /** The admin's justification for this layer. Stored trimmed. */
  reason: string;
  /** The acting admin, recorded as `clearedByUserId`. */
  actorUserId: string;
  /** Injectable only so a test can pin `clearedAt`; defaults to now. */
  now?: Date;
};

/**
 * True for Prisma's unique-constraint error, by its stable `code` rather
 * than by an `instanceof` or a message match.
 *
 * `instanceof PrismaClientKnownRequestError` would mean importing a runtime
 * class out of the generated client purely to narrow an error; the message
 * is English and is not a contract. `code` is the documented one.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Record one admin's justification for one rights layer on one upload.
 *
 * THE ACTOR'S ROLE IS CHECKED HERE, which is the one place this function
 * deliberately differs from `recordTriageFacts` (ugcportal-qfy9 K3).
 * `recordTriageFacts` documents why it does not: a triage column signed by a
 * non-admin is void at read time, because the gate re-reads
 * `listing.triagedBy?.role`, so the public entry point is the right place to
 * refuse. The gate re-reads `clearance.clearedBy?.role` in exactly the same
 * way — but a clearance row is not a column, it is a RECORD THAT SAYS A
 * LAYER HAS BEEN SETTLED, and it is read by humans and by the audit long
 * before anything asks the gate. Writing "MUSIC cleared by Jo" when Jo was never an
 * admin is a false statement in the register even though it sells nothing,
 * and K3 names the write itself as the thing that must refuse. The server
 * action checks the session as well; this is not that check restated, it is
 * a check of the actor's CURRENT role against the database, which a session
 * cannot answer.
 *
 * A `create`, NEVER AN UPSERT, and that is the difference K2 turns on. An
 * `upsert` here would silently replace an existing justification — the
 * second caller's reason and the second caller's name over the first
 * admin's, with no trace and no refusal — and the unique index on
 * `(listingId, layer)` would never fire, so the guardrail the schema carries
 * would be a no-op that still looked green. A second clearance for a layer
 * that already has one is refused and nothing is written. Revising a
 * clearance is not in this bead; when it arrives it has to be an explicit
 * act with its own audit, not a quiet overwrite.
 *
 * The duplicate is caught BOTH ways on purpose. The explicit read gives the
 * admin a sentence to read; the index is what actually makes the state
 * impossible. `@prisma/adapter-libsql` opens SQLite transactions as
 * `deferred` (the same caveat `recordTriageFacts` and the price endpoint
 * both record), so two concurrent calls can both pass the read — and then
 * the `create` violates the index, which is reported as the same refusal
 * rather than as a crash. Remove the read and the behaviour is unchanged;
 * remove the index and the read alone would let the race through.
 */
export async function recordLayerClearance({
  mediaId,
  layer,
  reason,
  actorUserId,
  now = new Date(),
}: RecordLayerClearanceInput): Promise<ClearanceWriteOutcome> {
  // Both checks before the transaction: neither depends on database state,
  // and there is no reason to open one to discover them.
  //
  // A layer no clearance settles (ALCOHOL, WINE_ACCESSORY) is refused rather
  // than stored. The table would accept the row and `factBlocker` would
  // never look at it, so what would be recorded is an inert sentence that
  // reads, to anyone reviewing the register, exactly like the sentence that
  // does settle a layer. "It was grape juice" is not a clearance for
  // alcohol; §3.1a's standard is what the picture looks like, and the fix
  // for that answer is a different photograph, not a signature.
  if (!isClearableLayer(layer)) {
    return { kind: "clearance_layer_not_clearable" };
  }
  // The gate requires `clearance.reason?.trim()` to be non-empty before it
  // treats a layer as cleared, so a blank reason produces a row that looks
  // like a clearance in the register and settles nothing in the gate. Refuse
  // it here rather than let the two disagree.
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    return { kind: "clearance_reason_blank" };
  }

  return prisma.$transaction(async (tx): Promise<ClearanceWriteOutcome> => {
    // The CURRENT role, read from the database inside the same transaction
    // as the write it governs — not the role the session was minted with.
    const actor = await tx.user.findUnique({
      where: { id: actorUserId },
      select: { role: true },
    });
    if (actor?.role !== "ADMIN") {
      return { kind: "clearance_actor_not_admin" };
    }

    // The clearance hangs off the MediaListing, so an upload nobody has
    // triaged has nothing to clear. Not an error state: it is the ordinary
    // order of work (triage first, then the layers a `yes` needs), and the
    // screen says so.
    const listing = await tx.mediaListing.findUnique({
      where: { mediaId },
      select: { id: true },
    });
    if (!listing) {
      return { kind: "clearance_listing_not_found" };
    }

    const existing = await tx.mediaRightsClearance.findUnique({
      where: { listingId_layer: { listingId: listing.id, layer } },
      select: { id: true },
    });
    if (existing) {
      return { kind: "clearance_already_recorded" };
    }

    let clearanceId: string;
    try {
      const clearance = await tx.mediaRightsClearance.create({
        data: {
          listingId: listing.id,
          layer,
          reason: trimmedReason,
          clearedByUserId: actorUserId,
          clearedAt: now,
        },
        select: { id: true },
      });
      clearanceId = clearance.id;
    } catch (error: unknown) {
      // P2002 is Prisma's unique-constraint violation, which on this table
      // can only be `(listingId, layer)` — the one unique index it carries.
      // Narrowed by code rather than caught broadly, so a foreign-key
      // failure or a driver error still propagates instead of being
      // reported to an admin as "already recorded".
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      return { kind: "clearance_already_recorded" };
    }

    return {
      kind: "recorded",
      clearanceId,
      listingId: listing.id,
    };
  });
}
