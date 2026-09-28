import { NextResponse } from "next/server";

import { MEDIA_OWNER_SELECT, requireOwnedMedia } from "@/lib/media-access";
import { prisma } from "@/lib/prisma";
import { PRISMA_RECORD_NOT_FOUND, prismaErrorCode } from "@/lib/prisma-errors";
import { readJsonBody } from "@/lib/request-body";
import { parseTagNames, resolveTagRows } from "@/lib/tags";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

/**
 * The tags on one media item (ugcportal-jsc). Owner only.
 *
 * ITS OWN SUB-ROUTE, next to publish, for the reason publish gives for being
 * one: PATCH /api/media/[id]'s contract is "originalName is the only editable
 * column", one request body and one thing it can change. Folding a second
 * field into it would make `originalName` optional there, which turns an
 * empty body from a 400 into a silent success.
 *
 * It reuses the SAME ownership gate PATCH and DELETE use —
 * `requireOwnedMedia` (ugcportal-bdh) — rather than adding a second check.
 * That is the whole reason the gate exists as a function: 401 for no session,
 * 403 for someone else's row, 404 for a row that is not there, decided in one
 * place and answered identically by every handler on this resource.
 *
 * Tags are NOT a visibility control and not a sale control. Setting them
 * writes no `publishedAt`, no price and no licence state, so a tagged item
 * that is private stays private and an untagged item that is published stays
 * published. The only thing tags change is what a visitor reads under a tile
 * that was already going to be there.
 */

/**
 * The body is `{ "tags": ["Food", "Books"] }` and nothing else.
 *
 * Six names at MAX_TAG_NAME_LENGTH, JSON-escaped to the worst case, is under
 * 1.5 kB; 4096 leaves room to be wrong about that and still refuses anything
 * that is not a short list of labels. App Router puts no default cap on a
 * request body, so without this the length checks in parseTagNames would only
 * run after the server had buffered whatever arrived.
 */
const MAX_TAGS_BODY_BYTES = 4096;

/**
 * Replaces the item's whole tag set.
 *
 * PUT rather than PATCH because it is a replacement: the list sent is the
 * list that ends up on the row, so removing a tag is sending the set without
 * it, and `{"tags": []}` removes them all. There is no add-one/remove-one
 * verb, and there does not need to be — the caller is an editor holding the
 * complete set, not a queue applying deltas.
 */
export async function PUT(request: Request, { params }: RouteContext) {
  const { id } = await params;

  const access = await requireOwnedMedia(id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await readJsonBody(request, MAX_TAGS_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value)
  ) {
    return NextResponse.json(
      { error: "Expected a JSON object body" },
      { status: 400 },
    );
  }

  /*
   * A MISSING `tags` IS A 400, NOT AN EMPTY SET. The two would be one line
   * apart and they mean opposite things: `{"tags": []}` is "remove every tag
   * from this item", and `{}` is a caller who spelled the field wrong or sent
   * the wrong body. Treating the second as the first quietly deletes
   * somebody's labels in answer to a typo, and answers 200 while doing it.
   */
  const { tags } = body.value as { tags?: unknown };
  if (tags === undefined) {
    return NextResponse.json(
      { error: "Field 'tags' is required (send [] to remove every tag)" },
      { status: 400 },
    );
  }

  const parsed = parseTagNames(tags);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.message }, { status: 400 });
  }

  try {
    /*
     * `update` with `userId` IN THE WHERE CLAUSE, which is the same rule the
     * sibling handlers state for `updateMany`: the gate above read the row in
     * a separate statement, so only a predicate on the write itself rules out
     * a row deleted or re-owned in between. The gate decides the status code;
     * this decides what changes.
     *
     * `update` rather than `updateMany` here, and that is forced rather than
     * chosen: `updateMany` takes scalar data only, so it cannot write a
     * relation at all. Prisma's unique-where accepts additional non-unique
     * filters, so the scoping survives the switch — and a where that matches
     * nothing throws P2025 instead of reporting `count: 0`, which is why the
     * miss is handled in a catch rather than an if.
     *
     * `set` replaces the whole relation in one statement: no read-then-diff,
     * so two concurrent edits cannot interleave into a union of both.
     *
     * IN ONE TRANSACTION WITH `resolveTagRows`, for the reason POST
     * /api/media gives at length: the tag rows have to exist before `set`
     * can name them, and if the update then fails — a concurrent delete
     * making the where-clause match nothing is the ordinary case — any tag
     * row just minted would survive as vocabulary for an edit that never
     * happened. Nothing in this product deletes a tag, so "survive" means
     * permanently.
     */
    const updated = await prisma.$transaction(async (tx) => {
      const refs = await resolveTagRows(parsed.value, tx);

      return tx.media.update({
        where: { id, userId: access.userId },
        data: { tags: { set: refs } },
        // Re-read through the owner projection rather than echoing the row
        // the gate held: that row's tags are the OLD ones, and it carries
        // `key`, the ungated original (ugcportal-5d6), which no response may
        // return.
        select: MEDIA_OWNER_SELECT,
      });
    });

    return NextResponse.json(updated);
  } catch (error: unknown) {
    if (prismaErrorCode(error) === PRISMA_RECORD_NOT_FOUND) {
      // Lost the race with a concurrent delete — the row the caller was
      // authorized for no longer exists. The same answer PATCH and DELETE
      // give when they lose the same race.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }
}
