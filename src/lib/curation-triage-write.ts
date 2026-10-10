import { alcoholReclassificationRefusal } from "@/lib/alcohol-commerce";
import type { TriageAnswers } from "@/lib/curation-triage";
import { prisma } from "@/lib/prisma";
import { TRIAGE_FACTS } from "@/lib/resale-rights";

/**
 * THE ONE PLACE MEDIALISTING TRIAGE FACTS ARE WRITTEN (ugcportal-vq3z).
 *
 * Before this bead nothing in `src` wrote a MediaListing triage column at
 * all — the only writer of the table was the price write path (today
 * `recordPrice` in src/lib/curation-price-write.ts; see that file's own
 * header), which writes `priceCents` and `currency` and deliberately
 * nothing else. So these columns, which the sellability gate in
 * src/lib/resale-rights.ts trusts, were readable and unwritable. This
 * function is the writer.
 *
 * IT IS DELIBERATELY A SINGLE CHOKEPOINT, and ugcportal-6uxv is what now
 * stands on that shape: the §9-2 guard below refuses an incoming
 * `depictsAlcohol: true` while the item carries a live commercial link, and a
 * rule like that is only enforceable because there is exactly one place the
 * flip can happen. Re-confirm before relying on it rather than taking this
 * paragraph's word for it —
 * `git grep -n "mediaListing\.\(update\|upsert\|create\|updateMany\)" -- src`
 * outside tests returns this upsert and `recordPrice`'s own update
 * (src/lib/curation-price-write.ts), which writes `priceCents` and
 * `currency` and no triage column. Do not add a second triage writer;
 * widen this one.
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
export const TRIAGE_WRITE_REFUSALS = [
  "media_not_found",
  "no_preview",
  "alcohol_with_commercial_links",
] as const;

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
 * The read and the write share a transaction, and what that buys is narrower
 * than an earlier version of this paragraph claimed. It said
 * `@prisma/adapter-libsql` opens SQLite transactions as `deferred` so this
 * "does not serialise" against a concurrent write; that was inherited rather
 * than measured, and ugcportal-yzo7 measured it — see `recordPrice`'s own
 * comment in src/lib/curation-price-write.ts for what the probe found, which
 * is that a competing write is blocked or refused rather than interleaved.
 * What is genuinely not serialised is a concurrent DELETE of the Media row
 * (a write that can already be in flight before this transaction reads) and
 * a concurrent watermark write. The consequences are small in both
 * directions — a lost race on the delete surfaces as a foreign-key failure on
 * a row that is about to cascade away, and a lost race on the preview check
 * means a triage recorded moments before the preview appeared.
 *
 * Neither can produce a durably sellable item, and that is now a mechanism
 * rather than an absence: `src/lib/sellable-media.ts` (ugcportal-yzo7 K4)
 * re-evaluates the whole gate at render, over these same facts, on every
 * public request. A triage that should not have been recorded stops being
 * believed the moment it is corrected, with nothing written to the price.
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
      select: {
        id: true,
        previewKey: true,
        // How many commercial links are attached, for the §9-2 guard below
        // (ugcportal-6uxv). A COUNT and not the rows: the gate decides on
        // "any", and the URL and the brand behind each link are a compliance
        // record this function has no business reading, by the same rule the
        // line above states for `previewKey`.
        //
        // READ UNCONDITIONALLY, not behind `if (facts.depictsAlcohol)`,
        // which is the call the publish route already made for its own
        // alcohol lookup and for the reason it gives there: a short-circuit
        // on the caller's side is a SECOND reading of the field the gate
        // itself reads, in a place that cannot see the gate's rule, and the
        // direction that mistake fails in is the gate never running at all.
        // One indexed count on a rare, deliberate admin action is the cheaper
        // side of that trade.
        _count: { select: { commercialLinks: true } },
      },
    });
    if (!media) {
      return { kind: "media_not_found" };
    }
    if (media.previewKey === null || media.previewKey.trim() === "") {
      return { kind: "no_preview" };
    }

    /*
      ===================================================================
      THE ALCOHOL-RECLASSIFICATION GUARD (ugcportal-6uxv K1).
      ===================================================================
      alkoholloven § 9-2 forbids the PAIR — a picture showing alcohol with
      something commercial on it — and says nothing about which half was
      recorded first. The attach route already refuses the one order
      (`benefitAttachmentRefusal`: no link onto an item recorded as showing
      alcohol). This is the other order, and until ugcportal-vq3z created
      this function it was not reachable at all, because nothing in `src`
      could write `depictsAlcohol`. That is the real interim cover, not the
      publish route: `commercialPublishRefusal` returns null outright unless
      `disclosure.benefitReceived === true`, and it only ever runs on a
      publish REQUEST, so it could never have seen a reclassification of an
      item that was already public.

      HERE AND NOT IN THE ACTION, because here the count this gate reads and
      the write it governs are one piece of work rather than two a concurrent
      attach could be slipped between. A shared transaction only excludes a
      competing write once it already holds its own lock — ugcportal-yzo7
      measured what that is worth at c5bf99f, against a real file-backed
      database through the real `@prisma/adapter-libsql`: a competing write
      on a second client fails `SQLITE_BUSY` and does not commit, and one on
      the same client — production's shape, since `prisma` is a singleton —
      blocks until this transaction finishes. The probe is recorded on
      `recordPrice` (src/lib/curation-price-write.ts); this file's own
      docstring above already retracts the "deferred, so this does not
      serialise" claim this paragraph used to repeat. The attach route's own
      gate still matters, but for the OTHER order — a link attached before
      this transaction opens, or after it commits, which its mirror question
      refuses from inside its own transaction — not for one landing inside
      this window, which the lock above already closes.

      THE INCOMING ANSWER IS WHAT IS JUDGED (`facts`, the registry-rebuilt
      object about to be written), not the row's current one. See
      `alcoholReclassificationRefusal` for why that is a decision about the
      state the transaction would leave behind rather than about a transition,
      and why no read of the previous answer is needed.
    */
    if (
      alcoholReclassificationRefusal({
        listing: facts,
        commercialLinks: { commercialLinkCount: media._count.commercialLinks },
      })
    ) {
      // The whole answer set is discarded, not just the alcohol column. A
      // partial write — "we recorded your other six answers" — would leave
      // the row stamped with this admin's name and this timestamp over a
      // triage they did not complete, which is the exact failure
      // `triageFactColumns` throws to prevent one layer up.
      return { kind: "alcohol_with_commercial_links" };
    }

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
