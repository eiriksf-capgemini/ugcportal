import { NextResponse } from "next/server";

import { type AttestationParseResult, parseAttestation } from "@/lib/attestation";
import { requireOwnedMedia } from "@/lib/media-access";
import { isSameOriginRequest } from "@/lib/origin";
import { prisma } from "@/lib/prisma";
import { PRISMA_UNIQUE_VIOLATION, prismaErrorCode } from "@/lib/prisma-errors";
import { readJsonBody } from "@/lib/request-body";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/media/[id]/attestation (ugcportal-gkax): the uploader answers the
 * nine rights questions for a file they ALREADY uploaded without answering
 * them. Owner only.
 *
 * WHY IT EXISTS. A configured uploader is not asked the questions at upload
 * (ugcportal-ho7j), so their upload is stored with no MediaAttestation row,
 * and the sale gate (`evaluateSellability`, src/lib/resale-rights.ts) refuses
 * such a file as `attestation_missing` forever. The gate also refuses an
 * attestation made by anybody but the file's uploader
 * (`attestation_not_by_uploader`; docs/legal/manual-upload-rights-review.md
 * §4 item 7), so "an admin records one later" is not a way out either. Before
 * this route the only writer of the row was POST /api/media, at upload time.
 *
 * THE RULE IS "THE SESSION USER OWNS THE FILE AND IT HAS NO ROW", and nothing
 * else. It is deliberately NOT keyed on whether the uploader is configured:
 * a configured user's upload is the one POST /api/media stores without a
 * row since ugcportal-ho7j, but any file without one — a file published
 * before ugcportal-3ae, say — is one its uploader may answer for, and
 * nobody else may.
 *
 * WHAT IT REFUSES, and the status each refusal gets:
 *  - not signed in: 401; a file that is not the caller's: 403; no such file:
 *    404 — the shared ownership gate `requireOwnedMedia`
 *    (src/lib/media-access.ts), answered exactly as every sibling item route
 *    answers it. AN ADMIN IS NOT AN EXCEPTION: that gate has no role branch,
 *    so an admin attesting somebody else's upload is the same 403 as anybody
 *    else — which is §4 item 7's rule, not an accident of the gate.
 *  - a file that already has a row: 409. One row per file, created once.
 *    Re-attesting, or editing an attestation, is not this route.
 *  - an incomplete or stale set of answers: 400, by `parseAttestation`
 *    (src/lib/attestation.ts) — the same parser, the same field names and the
 *    same version check POST /api/media applies at upload.
 *
 * WHAT IT DOES NOT TOUCH: the Media row. No column of it is written — not
 * `publishedAt`, not anything else — so attesting neither publishes nor
 * unpublishes a file by writing to it. The public surfaces DO read the
 * attestation, though (`PUBLIC_MEDIA_RIGHTS_SCOPE`, src/lib/publishability.ts):
 * an answer that the file shows an identifiable person with no PEOPLE
 * clearance, or that the uploader holds no rights to it, takes a published
 * file off them, exactly as the same answer given at upload would have kept
 * it off. In the other direction, a clean answer for a published file that
 * was off them only for want of one (a non-configured uploader's file
 * published before ugcportal-3ae) puts it back. Both are the scope reading a
 * declaration, not this route acting on one; route.test.ts pins all three.
 */

/**
 * The body is a flat JSON object of short fixed strings: the version and
 * the nine answers, each a `yes`/`no` token or an authorship enum name.
 * Far above any body the client sends, far below anything that is not that
 * shape. Not derived from anything; see the disclosure route's cap for why
 * a byte count is not restated as arithmetic over field lengths.
 */
const MAX_ATTESTATION_BODY_BYTES = 2048;

/** What the 201 echoes back: what was recorded, and when. Not the actor —
 * it is the caller, by construction — and not the row id, which the caller
 * has no use for. */
const ATTESTATION_ECHO_SELECT = {
  mediaId: true,
  attestationVersion: true,
  attestedAt: true,
  authorship: true,
  ownOriginalNotFromWeb: true,
  showsIdentifiablePeople: true,
  showsMinors: true,
  containsMusicNotOwned: true,
  otherCreativeContributor: true,
  brandOrSponsorship: true,
  aiGenerated: true,
  uploaderIsAdult: true,
} as const;

const ALREADY_ATTESTED =
  "This file already has rights answers on record. They cannot be changed here.";

function alreadyAttested() {
  return NextResponse.json({ error: ALREADY_ATTESTED }, { status: 409 });
}

/**
 * The ONE place the parsed request body is read, and all it is read for:
 * the version and the nine answers, through the SAME parser POST /api/media
 * uses, over the same field names (`attestation.version`,
 * `attestation.authorship`, ...), so the browser builds this body with the
 * same `attestationFormParts` it builds the upload's multipart parts with.
 * `Object.hasOwn`, so a key inherited from `Object.prototype` is never read
 * as an answer. `null` when the body is not a JSON object at all.
 *
 * WHY A SEPARATE FUNCTION. The raw object is a local of this function and
 * of nothing else, so all `POST` takes from the body is what
 * `parseAttestation` returned (and `readJsonBody`'s own failure fields).
 * Anything else in the body (an `attestedByUserId`, a `mediaId`, a
 * `publishedAt`, a key nobody has thought of yet) is out of reach of the
 * write below, which is what makes the actor and the target the session's
 * user and the URL's file rather than whatever a client sends.
 * src/lib/attestation-write-paths.test.ts holds this file to that shape:
 * `POST` reads `body.value` only as this function's argument and `request`
 * only through `readJsonBody`, and in here the object is read only inside
 * the reader handed to `parseAttestation`.
 */
function attestationFromBody(value: unknown): AttestationParseResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  return parseAttestation((name) =>
    Object.hasOwn(fields, name) ? fields[name] : undefined,
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  // Second lock, after the auth gate so an anonymous caller still gets 401:
  // the session cookie is SameSite=Lax and that is the only thing between a
  // cross-site request and this write today. See src/lib/origin.ts and
  // ugcportal-qf9v. Route handlers get no framework Origin check.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  /*
   * THE ACTOR. `session.user.id`, as `requireOwnedMedia` read it from the one
   * `auth()` call that also decided ownership — and from nothing in the
   * request. `src/lib/attestation-write-paths.test.ts` holds this file to
   * that, in two ways. It checks that every declaration named `userId` here,
   * in any shape (plain, destructured or a parameter), is this one, that
   * every declaration named `access` comes from `requireOwnedMedia`, and that
   * the write below names `userId`. And it checks that the body is read only
   * through `attestationFromBody` above, so no natural read of a body key
   * other than the ten `parseAttestation` reads can reach the write
   * (deliberately obfuscated reads are outside what that check sees). The
   * route test's K2 case adds a behavioural check for the actor keys it
   * lists.
   */
  const userId = access.userId;

  // Already answered: refused before the body is read at all. The
  // transaction below re-checks, because this read and the write are a round
  // trip apart; this one only saves parsing a body that cannot be used.
  if (
    (await prisma.mediaAttestation.findUnique({
      where: { mediaId: id },
      select: { id: true },
    })) !== null
  ) {
    return alreadyAttested();
  }

  const body = await readJsonBody(request, MAX_ATTESTATION_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const parsed = attestationFromBody(body.value);
  if (parsed === null) {
    return NextResponse.json(
      { error: "Expected a JSON object body" },
      { status: 400 },
    );
  }
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.message, field: parsed.field },
      { status: 400 },
    );
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      /*
       * Ownership and "no row yet" re-checked INSIDE the transaction, scoped
       * by `{ id, userId }`, for the reason the sibling item routes give: the
       * gate above read the row in a separate statement, and only a predicate
       * on the write path itself rules out a file deleted or re-owned in
       * between.
       */
      const owned = await tx.media.findFirst({
        where: { id, userId },
        select: { attestation: { select: { id: true } } },
      });
      if (owned === null) return { kind: "gone" as const };
      if (owned.attestation !== null) return { kind: "exists" as const };

      /*
       * THE SECOND OF THE TWO PLACES AN ATTESTATION IS WRITTEN (POST
       * /api/media is the first), and listed by name in
       * src/lib/attestation-write-paths.test.ts. A plain
       * `tx.mediaAttestation.create`, not a nested write on a Media update —
       * which would also be a write to the Media row K3 says must not change,
       * and is the shape that scan's nested matcher cannot see behind a
       * conditional (ugcportal-xqal).
       */
      const created = await tx.mediaAttestation.create({
        data: {
          mediaId: id,
          attestedByUserId: userId,
          attestationVersion: parsed.version,
          ...parsed.answers,
        },
        select: ATTESTATION_ECHO_SELECT,
      });
      return { kind: "created" as const, created };
    });

    if (outcome.kind === "gone") {
      // Lost the race with a delete or a re-ownership — the same answer the
      // sibling handlers give when they lose it.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (outcome.kind === "exists") return alreadyAttested();
    return NextResponse.json(outcome.created, { status: 201 });
  } catch (error: unknown) {
    // Two of these at once: both passed the in-transaction check, and the
    // `@unique` on `MediaAttestation.mediaId` refused the second insert.
    // One row per file is the database's rule as well as this route's.
    if (prismaErrorCode(error) === PRISMA_UNIQUE_VIOLATION) {
      return alreadyAttested();
    }
    throw error;
  }
}
