import type { MediaModel } from "@/generated/prisma/models";
import {
  MEDIA_ANONYMOUS_SELECT,
  MEDIA_OWNER_SELECT,
} from "@/lib/media-access";
import { prisma } from "@/lib/prisma";

/**
 * The one keyset-paginated Media listing, shared by the owner's own view
 * (GET /api/media) and the public feed (GET /api/public/media).
 *
 * Extracted from the owner route when the public feed became a second caller
 * (ugcportal-r1d). The two differ in their `where` scope and in which
 * projection they hand over; every other part of the contract — page size
 * clamping, cursor encoding and validation, ordering, `hasMore`/`nextCursor` —
 * is identical by construction rather than by two people remembering to keep
 * two copies in step. ugcportal-71y consumes both and is entitled to assume
 * they page the same way.
 */

const DEFAULT_LISTING_LIMIT = 50;
const MAX_LISTING_LIMIT = 100;

/**
 * What a listing is allowed to filter by.
 *
 * `previewKey` is not optional: every listing must exclude rows that have no
 * watermarked representation, so the only object any feed can ever name is the
 * preview and never `key`, the paid original (ugcportal-5d6). Making it a
 * required property means a future third caller cannot forget it — it will not
 * compile.
 *
 * `publishedAt` is how the public feed opts in to visible-only rows; the
 * owner's own view leaves it off precisely because an owner must keep seeing
 * their unpublished uploads.
 */
export type MediaListingScope = {
  userId?: string;
  publishedAt?: { not: null };
  previewKey: { not: null };
};

/**
 * The projections a listing may serve. Two audiences, two selects — see
 * src/lib/media-access.ts for why they are not one.
 */
export type MediaListingSelect =
  | typeof MEDIA_OWNER_SELECT
  | typeof MEDIA_ANONYMOUS_SELECT;

/** A listing row, narrowed so `previewKey` is non-nullable for the caller. */
export type MediaListingItem<TSelect extends MediaListingSelect> = Pick<
  MediaModel,
  keyof TSelect & keyof MediaModel
> & { previewKey: string };

export type MediaListingPage<TSelect extends MediaListingSelect> = {
  items: MediaListingItem<TSelect>[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type MediaListingResult<TSelect extends MediaListingSelect> =
  | { ok: true; page: MediaListingPage<TSelect> }
  | { ok: false; status: 400; error: string };

function parseListingLimit(raw: string | null): number {
  // Number(null) and Number("") are both 0, which would silently clamp an
  // absent ?limit down to a single row instead of using the default.
  if (raw === null || raw.trim() === "") return DEFAULT_LISTING_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LISTING_LIMIT;
  return Math.min(MAX_LISTING_LIMIT, Math.max(1, Math.floor(parsed)));
}

const CURSOR_SEPARATOR = "|";

export type MediaCursor = { createdAt: Date; id: string };

/**
 * Encodes the position a page ended at — the sort key itself, not a row
 * reference.
 *
 * The first version of this carried a bare row id and resolved it back to a
 * row on every request, 400-ing when that row could no longer be found. That
 * is defensible on a single-tenant feed, where the only person who can delete
 * the anchor is the person paging past it. It stops being defensible on the
 * public feed: there, an *unrelated* owner unpublishing or deleting whichever
 * row a visitor's cursor happens to name turns that visitor's next scroll into
 * a hard 400 and a restart from the top, for something they did not do and
 * cannot see.
 *
 * Carrying (createdAt, id) removes the lookup and that failure mode together.
 * A position does not stop existing when the row that produced it does — the
 * next page is simply everything ordered after that point.
 *
 * base64url is encoding, not secrecy, and is not claimed as such: it makes the
 * value opaque enough that clients do not start parsing it, and URL-safe. The
 * data inside is a `createdAt` and an `id` the caller was just handed in the
 * same response, so there is nothing here it did not already have.
 */
export function encodeMediaCursor(position: MediaCursor): string {
  return Buffer.from(
    `${position.createdAt.toISOString()}${CURSOR_SEPARATOR}${position.id}`,
    "utf8",
  ).toString("base64url");
}

/**
 * Parses a client-supplied cursor, or returns null if it is not one.
 *
 * The cursor stays fully untrusted — dropping the anchor lookup removed a
 * round trip, not the validation. Note that `Buffer.from(…, "base64url")` is
 * lenient: it silently discards characters outside the alphabet rather than
 * throwing, so it cannot itself reject anything. The checks that do the work
 * are the strict ISO round-trip (`new Date("2026")` parses happily, so
 * accepting whatever `Date` tolerates would let a truncated cursor mean a
 * different instant than the row it came from) and the non-empty id.
 *
 * Internal: exercised through the handlers rather than directly, so there is
 * no second definition of "valid cursor" for the routes to drift from.
 *
 * A forged-but-well-formed cursor is harmless by construction: it only ever
 * reaches the query as a comparison inside the same `where` as the scope, so
 * it can move the window but never widen it past what the caller may see.
 */
function decodeMediaCursor(raw: string): MediaCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");

  const separator = decoded.indexOf(CURSOR_SEPARATOR);
  if (separator === -1) return null;

  const iso = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (id === "") return null;

  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) return null;
  if (createdAt.toISOString() !== iso) return null;

  return { createdAt, id };
}

/**
 * Reads one page of media matching `scope`, projected through `select`.
 *
 * Ordering is (createdAt desc, id desc) because pagination needs a unique
 * tiebreak to be stable across rows sharing a timestamp, and the cursor
 * carries exactly that pair.
 *
 * The window is an explicit keyset predicate rather than Prisma's
 * `cursor`/`skip`. Prisma compiles `cursor` into a subquery that ignores the
 * outer `where`, so a caller could name a row this listing deliberately
 * excludes — a VIDEO row, an id POST hands them; an unpublished row, on the
 * public feed — and use the resulting window as an ordering oracle over rows
 * it cannot see. It is also wrong even when honest: that subquery's comparison
 * is inclusive, so with rows sharing a `createdAt` the `skip: 1` then silently
 * swallows a real row. Writing the predicate by hand puts it inside the same
 * `where` as the scoping, so it cannot outrun it.
 */
export async function listMedia<TSelect extends MediaListingSelect>(
  requestUrl: string,
  scope: MediaListingScope,
  select: TSelect,
): Promise<MediaListingResult<TSelect>> {
  const params = new URL(requestUrl).searchParams;
  const limit = parseListingLimit(params.get("limit"));
  // Treat `?cursor=` as absent rather than as a cursor, which would otherwise
  // 400 on a perfectly ordinary first-page request.
  const rawCursor = params.get("cursor")?.trim() || null;

  let keyset: object | undefined;
  if (rawCursor !== null) {
    const position = decodeMediaCursor(rawCursor);
    if (!position) {
      // Malformed, truncated or hand-written. Answering with an empty page
      // would be a false end-of-list — the caller would stop, believing it had
      // seen everything. Say so instead, and let it restart pagination.
      return { ok: false, status: 400, error: "Invalid cursor" };
    }

    // Strict "after this position" in (createdAt desc, id desc) order. No skip
    // needed: the position itself can't satisfy either branch.
    keyset = {
      OR: [
        { createdAt: { lt: position.createdAt } },
        { createdAt: position.createdAt, id: { lt: position.id } },
      ],
    };
  }

  const rows = (await prisma.media.findMany({
    where: { ...scope, ...keyset },
    select,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row is a cheap way to know whether another page exists
    // without a second count query.
    take: limit + 1,
    // Prisma infers a union of both projections from the union-typed `select`,
    // which it cannot narrow back to the caller's concrete TSelect. The narrow
    // is safe because TSelect *is* the select the query just ran with; the
    // `where`/`select` above are the only things that decide what comes back.
  })) as (MediaListingItem<TSelect> & { previewKey: string | null })[];

  const page = rows.length > limit ? rows.slice(0, limit) : rows;

  // The where-clause already excludes them, but previewKey is still typed
  // `string | null`; narrowing here makes the emitted shape non-nullable and
  // means a future query change can't quietly start emitting preview-less rows.
  const items = page.filter(
    (row): row is MediaListingItem<TSelect> => row.previewKey !== null,
  );

  // Built from `items`, not `page`: a cursor taken from a row the filter
  // dropped would still be a valid position, but reporting a row the caller
  // never received as "where you got to" is how a page gets silently skipped.
  // And if the filter emptied the page there is no position to give, so we
  // must not claim there is more — a caller that sees hasMore with no cursor
  // either loops forever or stalls.
  const last = rows.length > limit ? items.at(-1) : undefined;
  const nextCursor = last ? encodeMediaCursor(last) : null;

  return {
    ok: true,
    page: { items, hasMore: nextCursor !== null, nextCursor },
  };
}
