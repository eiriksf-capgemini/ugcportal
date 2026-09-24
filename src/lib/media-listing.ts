import { MEDIA_PUBLIC_SELECT, type PublicMedia } from "@/lib/media-access";
import { prisma } from "@/lib/prisma";

/**
 * The one keyset-paginated Media listing, shared by the owner's own view
 * (GET /api/media) and the public feed (GET /api/public/media).
 *
 * Extracted from the owner route when the public feed became a second caller
 * (ugcportal-r1d). The two differ only in their `where` scope; every other
 * part of the contract — page size clamping, cursor validation, ordering,
 * `hasMore`/`nextCursor` — is identical by construction rather than by two
 * people remembering to keep two copies in step. ugcportal-71y consumes both
 * and is entitled to assume they page the same way.
 *
 * Behaviour is unchanged from the owner route's original implementation; the
 * reasoning that shaped it is preserved in the comments below.
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

/** A listing row, narrowed so `previewKey` is non-nullable for the caller. */
export type MediaListingItem = PublicMedia & { previewKey: string };

export type MediaListingPage = {
  items: MediaListingItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type MediaListingResult =
  | { ok: true; page: MediaListingPage }
  | { ok: false; status: 400; error: string };

export function parseListingLimit(raw: string | null): number {
  // Number(null) and Number("") are both 0, which would silently clamp an
  // absent ?limit down to a single row instead of using the default.
  if (raw === null || raw.trim() === "") return DEFAULT_LISTING_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LISTING_LIMIT;
  return Math.min(MAX_LISTING_LIMIT, Math.max(1, Math.floor(parsed)));
}

/**
 * Reads one page of media matching `scope`.
 *
 * Paginated with an opaque cursor (the last item's id) rather than a bare cap,
 * so nothing becomes permanently unreachable once a caller passes the page
 * size, and `hasMore` tells the caller when the list was truncated. Ordering
 * is (createdAt desc, id desc) because pagination needs a unique tiebreak to
 * be stable across rows sharing a timestamp.
 *
 * The cursor is resolved by hand rather than through Prisma's `cursor`/`skip`,
 * for two reasons. It is a client-supplied id and therefore untrusted: Prisma
 * compiles `cursor` into a subquery that ignores the outer `where`, so a
 * caller could pass the id of a row this listing deliberately excludes (a
 * VIDEO row — an id POST hands them; an unpublished row, on the public feed)
 * and use the resulting window as an ordering oracle over rows they can't see.
 * And it is wrong even when honest: that subquery's comparison is inclusive,
 * so with rows sharing a `createdAt` the `skip: 1` then silently swallows a
 * real row. Resolving the anchor against the same `scope` the listing itself
 * uses and expressing the window as an explicit keyset predicate fixes both —
 * the predicate lives inside the same `where` as the scoping, so it cannot
 * outrun it.
 */
export async function listMedia(
  requestUrl: string,
  scope: MediaListingScope,
): Promise<MediaListingResult> {
  const params = new URL(requestUrl).searchParams;
  const limit = parseListingLimit(params.get("limit"));
  // Treat `?cursor=` as absent rather than as the id "", which would otherwise
  // 400 on a perfectly ordinary first-page request.
  const cursor = params.get("cursor")?.trim() || null;

  let keyset: object | undefined;
  if (cursor !== null) {
    const anchor = await prisma.media.findFirst({
      where: { ...scope, id: cursor },
      select: { id: true, createdAt: true },
    });

    if (!anchor) {
      // Unknown, foreign, since-deleted, or since-unpublished. Answering with
      // an empty page would be a false end-of-list — the caller would stop,
      // believing it had seen everything. Say so instead, and let it restart
      // pagination.
      return { ok: false, status: 400, error: "Invalid or expired cursor" };
    }

    // Strict "after the anchor" in (createdAt desc, id desc) order. No skip
    // needed: the anchor itself can't satisfy either branch.
    keyset = {
      OR: [
        { createdAt: { lt: anchor.createdAt } },
        { createdAt: anchor.createdAt, id: { lt: anchor.id } },
      ],
    };
  }

  const rows = await prisma.media.findMany({
    where: { ...scope, ...keyset },
    select: MEDIA_PUBLIC_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One extra row is a cheap way to know whether another page exists
    // without a second count query.
    take: limit + 1,
  });

  const page = rows.length > limit ? rows.slice(0, limit) : rows;

  // The where-clause already excludes them, but previewKey is still typed
  // `string | null`; narrowing here makes the emitted shape non-nullable and
  // means a future query change can't quietly start emitting preview-less rows.
  const items = page.filter(
    (row): row is MediaListingItem => row.previewKey !== null,
  );

  // Taken from `items`, not `page`: a cursor naming a row the filter dropped
  // is a row the *next* request's where-clause also excludes, which is exactly
  // how a page gets silently skipped. And if the filter emptied the page there
  // is no cursor to give, so we must not claim there is more — a caller that
  // sees hasMore with no cursor either loops forever or stalls.
  const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;

  return {
    ok: true,
    page: { items, hasMore: nextCursor !== null, nextCursor },
  };
}
