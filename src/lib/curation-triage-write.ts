import type { TriageAnswers } from "@/lib/curation-triage";
import { prisma } from "@/lib/prisma";
import { TRIAGE_FACTS } from "@/lib/resale-rights";

/**
 * THE ONE PLACE MEDIALISTING TRIAGE FACTS ARE WRITTEN (ugcportal-vq3z).
 *
 * Before this bead nothing in `src` wrote a MediaListing triage column at
 * all — the only writer of the table was the price endpoint
 * (src/app/api/admin/curation/[id]/price/route.ts), which writes `priceCents`
 * and `currency` and deliberately nothing else. So these columns, which the
 * sellability gate in src/lib/resale-rights.ts trusts, were readable and
 * unwritable. This function is the writer.
 *
 * IT IS DELIBERATELY A SINGLE CHOKEPOINT, and that shape is what
 * ugcportal-6uxv rides on. That bead has to refuse (or detach) a commercial
 * link when `depictsAlcohol` flips to `true` on an already-published item,
 * and a rule like that is only enforceable if there is exactly one place the
 * flip can happen. The insertion point is marked below, inside the same
 * transaction as the read and the write, between the preview check and the
 * `upsert`: it has the Media row, the previous listing state and the new
 * answers in hand, and it can refuse by returning a refusal of its own
 * without any caller changing. Do not add a second triage writer; widen this
 * one.
 *
 * The server action in src/app/admin/curation/actions.ts is its only
 * non-test caller today (`git grep recordTriageFacts -- src`) and is where
 * the admin-only check lives. This function does NOT
 * re-check the role — it takes `actorUserId` and records it — because the
 * gate re-reads that user's CURRENT role at evaluation time anyway
 * (`listing.triagedBy?.role !== "ADMIN"` in `triageBlocker`), so a write
 * signed by a non-admin is already void rather than dangerous. The place to
 * refuse a non-admin is the public entry point, and that is the action.
 */

/**
 * Why a triage write was refused. A closed set, every member of which has a
 * message in src/app/admin/curation/outcomes.ts — enforced by `tsc` there
 * rather than by memory, so a refusal added here cannot ship rendering
 * nothing.
 */
export const TRIAGE_WRITE_REFUSALS = ["media_not_found", "no_preview"] as const;

export type TriageWriteRefusal = (typeof TRIAGE_WRITE_REFUSALS)[number];

export type TriageWriteOutcome =
  | { kind: "recorded"; listingId: string }
  | { kind: TriageWriteRefusal };

export type RecordTriageFactsInput = {
  /** The ugcportal-8wa Media row being triaged. Never an external id. */
  mediaId: string;
  answers: TriageAnswers;
  /** The acting admin, recorded as `triagedByUserId`. */
  actorUserId: string;
  /** Injectable only so a test can pin `triagedAt`; defaults to now. */
  now?: Date;
};

/**
 * The triage columns to write, rebuilt from the registry.
 *
 * Two jobs, and both are about what can reach Prisma. It refuses an answer
 * set that is missing any registered fact, so the one type assertion in
 * `parseTriageAnswers` cannot let a half-filled triage through to a row
 * stamped with an admin's name. And it reconstructs the object from
 * TRIAGE_FACTS instead of forwarding the caller's, so only registered fields
 * are ever spread into a Prisma write — the same rule the price endpoint
 * states for its own body ("nothing from the body is ever spread into
 * Prisma"), made mechanical rather than promised.
 *
 * Throws rather than returning a refusal: every path that reaches it goes
 * through `parseTriageAnswers`, which has already reported an unanswered
 * question to the admin as an outcome code. Arriving here incomplete means a
 * caller built the object by hand and got it wrong, which is a bug, not a
 * state to render a banner for.
 */
function triageFactColumns(answers: TriageAnswers): TriageAnswers {
  const columns: Partial<Record<keyof TriageAnswers, boolean>> = {};
  for (const fact of TRIAGE_FACTS) {
    const answer = answers[fact.field];
    if (typeof answer !== "boolean") {
      throw new Error(
        `recordTriageFacts: no answer for the triage fact "${fact.field}"`,
      );
    }
    columns[fact.field] = answer;
  }
  // Safe for the reason the loop above establishes: every registered field
  // now has a boolean in `columns`, and TriageAnswers has no other keys.
  return columns as TriageAnswers;
}

/**
 * Record the Part C triage for one upload, attributed to the acting admin.
 *
 * An `upsert` keyed on `mediaId`, because this is both the first and every
 * subsequent triage of a file: before this bead no MediaListing row existed
 * for any upload, so a plain `update` would have had nothing to update, and a
 * plain `create` would refuse the second visit to a screen whose whole job is
 * revising a judgement.
 *
 * `triagedByUserId` and `triagedAt` are rewritten on every pass, not set once
 * on create. They mean "who last completed this triage, and when" — the
 * attribution the gate requires — so leaving a previous admin's name on an
 * answer set someone else has since changed would attribute an assertion
 * about a third party's rights to the wrong person.
 *
 * NO WATERMARKED PREVIEW, NO LISTING (ugcportal-vq3z K4). A Media row with a
 * null or blank `previewKey` is refused before the upsert, so this screen
 * cannot quietly put an unprotected original into the curation flow. Same
 * condition and same reading of "blank is absent" as the publish endpoint's
 * 409 (src/app/api/media/[id]/publish/route.ts): `previewKey` null means
 * there is genuinely no watermarked object — today every VIDEO, since poster
 * frames are ugcportal-pmb — and a blank string is a writer-side bug that
 * must not be mistaken for a working preview. It is `previewKey` and not
 * `previewId` that is checked, for the reason that route documents at length:
 * a row can carry a real `previewKey` with a null `previewId`, so the handle
 * is not a proxy for the object.
 *
 * The read and the write share a transaction. The same honest caveat the
 * price endpoint records applies: `@prisma/adapter-libsql` opens SQLite
 * transactions as `deferred`, so this does not serialise against a
 * concurrent delete of the Media row or a concurrent watermark write. The
 * consequences are small in both directions — a lost race on the delete
 * surfaces as a foreign-key failure on a row that is about to cascade away,
 * and a lost race on the preview check means a triage recorded moments before
 * the preview appeared. Neither can produce a sellable item, because the gate
 * re-evaluates everything at render and at checkout.
 */
export async function recordTriageFacts({
  mediaId,
  answers,
  actorUserId,
  now = new Date(),
}: RecordTriageFactsInput): Promise<TriageWriteOutcome> {
  // Before the transaction: this is a programming error, not a database
  // state, and there is no reason to open a transaction to discover it.
  const facts = triageFactColumns(answers);

  return prisma.$transaction(async (tx): Promise<TriageWriteOutcome> => {
    const media = await tx.media.findUnique({
      where: { id: mediaId },
      // `previewKey` is read to answer one yes/no question and is never
      // returned: it is `previews/{userId}/{uuid}`, so handing it back would
      // put an uploader's account id into whatever renders the result. The
      // caller gets the listing id and nothing else.
      select: { id: true, previewKey: true },
    });
    if (!media) {
      return { kind: "media_not_found" };
    }
    if (media.previewKey === null || media.previewKey.trim() === "") {
      return { kind: "no_preview" };
    }

    /*
      ===================================================================
      CHOKEPOINT FOR ugcportal-6uxv (the alcohol-reclassification guard).
      ===================================================================
      Everything that rule needs is in scope right here and nowhere else:
      `media` identifies the item, `facts.depictsAlcohol` is the incoming
      answer, and the row's previous answers plus its commercial links are one
      `tx` read away. A guard inserted at this line runs inside the same
      transaction as the write it governs, and can refuse by returning a new
      member of TRIAGE_WRITE_REFUSALS — no caller changes, and no other code
      path can get around it, because there is no other triage writer.
      Deliberately NOT implemented here: ugcportal-6uxv owns it.
    */

    const listing = await tx.mediaListing.upsert({
      where: { mediaId },
      // `facts` is the registry-rebuilt object, so the only columns this
      // write can touch are the registered triage facts plus the two
      // attribution columns named here. Nothing from the form reaches
      // Prisma by any other route; in particular `priceCents` and
      // `currency` are not settable from this screen (ugcportal-yzo7 owns
      // price), and neither is any evidence pointer (ugcportal-qfy9 owns
      // the per-layer clearances).
      create: {
        mediaId,
        ...facts,
        triagedByUserId: actorUserId,
        triagedAt: now,
      },
      update: {
        ...facts,
        triagedByUserId: actorUserId,
        triagedAt: now,
      },
      select: { id: true },
    });

    return { kind: "recorded", listingId: listing.id };
  });
}
