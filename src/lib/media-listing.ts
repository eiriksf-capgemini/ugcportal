import type { MediaModel } from "@/generated/prisma/models";
import {
  MEDIA_ANONYMOUS_SELECT,
  MEDIA_OWNER_SELECT,
  type MediaTagLabel,
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
 * The owner's own library.
 *
 * `userId` is required — this arm exists to be scoped to one account — and
 * `publishedAt` is deliberately optional, because an owner must keep seeing
 * their unpublished uploads.
 *
 * `previewKey` is the only preview column filtered on, and the omission of
 * `previewId` is the point. Both arms used to require both, which reads as
 * consistent and is not: `previewId` is the handle the ANONYMOUS feed hands
 * out, and it buys this audience nothing, because the owner projection returns
 * `previewKey` and the owner can resolve their own. Requiring it here meant a
 * row with a preview object but no public handle — the second-writer case
 * mediaPreviewColumns (src/lib/media.ts) exists to anticipate, or old code
 * writing against an already-migrated database — disappeared from its own
 * uploader's library, with no error and no way to get it back.
 *
 * Fail-closed is the right instinct on the anonymous feed, where the cost of
 * showing the wrong thing is a leak. It is the wrong instinct here, where the
 * cost is someone's own work vanishing from their own account. Each arm now
 * filters on what its own projection actually needs.
 */
export type MediaOwnerScope = {
  userId: string;
  publishedAt?: { not: null };
  previewKey: { not: null };
};

/**
 * An anonymous feed. `publishedAt: { not: null }` is REQUIRED, and that is the
 * single most important line in this file.
 *
 * It used to be optional and shared with the owner arm, which meant this
 * compiled clean:
 *
 *   listMedia(url, { previewKey: …, previewId: … }, MEDIA_ANONYMOUS_SELECT)
 *
 * — an anonymous listing with no publish filter, serving every private upload
 * in the database to anyone who asked. A future anonymous feed (ugcportal-71y,
 * or tag/search browsing) that copied the public route and dropped one line
 * would have type-checked, passed CI, and shipped exactly the failure this
 * whole bead was created to prevent. The preview columns were already
 * structurally required; visibility, which matters more, was not.
 *
 * `userId?: never` because an anonymous feed scoped to a single account is a
 * different product decision (it would let anyone enumerate one person's
 * portfolio by id) and must not be reachable by accident from here.
 *
 * Adding a filter to an anonymous feed means editing this type, in this file,
 * next to this comment. That is the point: the decision belongs beside the
 * rule, not in whichever route copied it.
 */
export type MediaAnonymousScope = {
  publishedAt: { not: null };
  userId?: never;
  // Both preview columns, unlike the owner arm above. `previewId` because it
  // is what this feed exposes, and `previewKey` because it is what proves the
  // watermarked object exists: a handle that resolves to nothing is worse than
  // an absent row. Here, fail-closed is correct — the cost of being wrong is a
  // leak, not a disappearance.
  previewKey: { not: null };
  previewId: { not: null };
};

export type MediaListingScope = MediaOwnerScope | MediaAnonymousScope;

/**
 * Columns no listing may project, whatever its audience.
 *
 * `key` is the ungated paid original (ugcportal-5d6); `userId` is the
 * attribution the anonymous feed goes to some length to withhold. Spelled as
 * optional-never rather than trusted to the union below, because the union
 * alone does not actually stop them: excess-property checking only applies to
 * *fresh* object literals, so
 *
 *   const adhoc = { ...MEDIA_OWNER_SELECT, key: true } as const;
 *   listMedia(url, scope, adhoc);
 *
 * type-checked, and `items[].key` resolved — Prisma would have selected and
 * serialised the original. A comment here previously claimed the union
 * prevented that. It did not. `key?: never` does.
 */
type NeverProjected = {
  key?: never;
  userId?: never;
};

/**
 * Additionally withheld from anonymous callers: the preview's storage path
 * (embeds the uploader's id), the uploader's filename, and the original's type
 * and size (which describe a file this feed cannot serve). See
 * src/lib/media-access.ts for the reasoning on each.
 */
type OwnerOnlyProjection = {
  previewKey?: never;
  originalName?: never;
  mimeType?: never;
  sizeBytes?: never;
};

/** The owner projection, and nothing smuggled alongside it. */
export type MediaOwnerListingSelect = typeof MEDIA_OWNER_SELECT &
  NeverProjected;

/** The anonymous projection, and nothing smuggled alongside it. */
export type MediaAnonymousListingSelect = typeof MEDIA_ANONYMOUS_SELECT &
  NeverProjected &
  OwnerOnlyProjection;

/**
 * The projections a listing may serve. Two audiences, two selects — see
 * src/lib/media-access.ts for why they are not one.
 */
export type MediaListingSelect =
  | MediaOwnerListingSelect
  | MediaAnonymousListingSelect;

/**
 * The columns listMedia reads for itself whatever the audience: `id` and
 * `createdAt`, to build a cursor.
 *
 * Each overload additionally requires the column its own guard re-checks —
 * `previewKey` on the owner arm, `previewId` on the anonymous one — so a
 * projection that dropped it would fail at the call site rather than leave the
 * narrowing reading `undefined`. Since `undefined !== null`, that would pass
 * every row through a filter that still looked like a filter: the precise
 * shape of the bug this listing already shipped once.
 */
export type MediaListingRequiredColumns = {
  id: true;
  createdAt: true;
};

/**
 * The columns a projection actually selects: those whose value is literally
 * `true`.
 *
 * `keyof TSelect` is NOT that set, which is the trap this type exists to avoid.
 * An optional-never property still contributes its key, so
 * `keyof (typeof MEDIA_ANONYMOUS_SELECT & NeverProjected)` includes `key` and
 * `userId` — and `Pick<MediaModel, …>` over that happily pulls both back out
 * with their real types. The row type then promised `item.key: string` and
 * `item.originalName: string` on the anonymous feed, for fields Prisma never
 * selected and that are `undefined` at runtime.
 *
 * That is the failure mode worth naming, because runtime was never at risk:
 * a type lie like this ships green. ugcportal-71y writes `item.originalName`
 * as a caption, it type-checks, and every card renders `undefined` — or
 * someone builds a download URL out of `item.key`. Filtering on `extends true`
 * makes the emitted type match what was actually queried.
 *
 * Note this is a different job from `NeverProjected`, not a replacement for
 * it: that one stops a bad select being *passed in*, this one stops a
 * withheld column being *typed on the way out*. Both are needed; neither
 * covers the other.
 */
type SelectedColumnKeys<TSelect> = {
  // No `-?` here, deliberately. It would collapse `key?: never` to `never`,
  // and `never extends true` is *true*, so the modifier meant to tidy this up
  // would put every blocked column straight back in. Left optional, the value
  // is `undefined`, which does not extend `true`.
  [K in keyof TSelect]: TSelect[K] extends true ? K : never;
}[keyof TSelect] &
  keyof MediaModel;

/**
 * The tag relation, when — and only when — the projection asked for it.
 *
 * A RELATION, NOT A COLUMN, which is why it cannot ride along in
 * `SelectedColumnKeys` above. Two things follow from that and both are load
 * bearing. Its value in a select is `{ select: …, orderBy: … }` rather than
 * `true`, so the `extends true` filter excludes it — correctly, since
 * `Pick<MediaModel, "tags">` is an error: `MediaModel` is the model's default
 * selection and carries no relation fields at all. And because it is excluded
 * there, the row type has to gain it here or a caller would receive `tags` at
 * runtime with no type saying so — the exact "a type lie like this ships
 * green" failure the comment on `SelectedColumnKeys` is about, pointing the
 * other way.
 *
 * `unknown` rather than `{}` on the false branch: intersecting with `unknown`
 * is the identity, and `{}` would make `null` and `undefined` assignable to
 * the whole row type.
 */
type TagProjection<TSelect> = "tags" extends keyof TSelect
  ? { tags: MediaTagLabel[] }
  : unknown;

/**
 * A row exactly as the query returns it — `previewId` still nullable, because
 * the column is.
 *
 * The second Pick is not redundant with the first. `SelectedColumnKeys` is
 * deferred while TSelect is generic, so the first Pick cannot be indexed
 * inside this module at all; naming the three columns the module itself
 * touches makes them resolvable here without widening what the caller
 * receives.
 */
type MediaListingRow<TSelect extends MediaListingSelect> = Pick<
  MediaModel,
  SelectedColumnKeys<TSelect>
> &
  Pick<MediaModel, "id" | "createdAt" | "previewId"> &
  TagProjection<TSelect>;

/**
 * The preview column this arm guarantees, narrowed to non-null.
 *
 * Deliberately one column, not both, and which one depends on the audience —
 * because that is what the scope and the guard actually promise. The owner arm
 * filters and re-checks `previewKey`, so that is what is narrowed; `previewId`
 * stays nullable there, which is honest, since an owner row is allowed to have
 * no public handle. The anonymous arm is the mirror: it exposes `previewId`,
 * so that is narrowed, and `previewKey` is not in its projection at all.
 *
 * Claiming both on the owner arm would be the type lying about the very row
 * this listing now goes out of its way to keep showing.
 */
type NarrowedPreview<TSelect> = "previewKey" extends SelectedColumnKeys<TSelect>
  ? { previewKey: string }
  : { previewId: string };

/** A listing row, narrowed so the preview columns are non-nullable. */
export type MediaListingItem<TSelect extends MediaListingSelect> =
  MediaListingRow<TSelect> & NarrowedPreview<TSelect>;

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

/**
 * How many consecutive entirely-withheld pages the scan below will step over
 * before giving up. Only reachable when the query's where-clause and the
 * defensive filter disagree; in normal operation the scan runs once.
 */
const MAX_WITHHELD_PAGE_SCANS = 5;

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
/*
 * Precision assumption, stated because it is invisible until it breaks.
 *
 * The position is serialised with toISOString(), i.e. to the millisecond, and
 * keysetAfter compares `createdAt` against exactly that value. On SQLite —
 * what this app runs, see prisma/schema.prisma — DateTime is stored as Unix
 * milliseconds, so the round trip is lossless and the comparison is exact.
 *
 * It would not be on a provider with finer resolution. The schema header still
 * advertises `create-db`, so this is worth naming: on Postgres, `timestamp`
 * keeps microseconds, a row at .123456Z would encode as .123Z, and every row
 * in (.123000, .123456] would satisfy neither keyset branch — `createdAt` is
 * not strictly less than .123Z, and it is not equal to it either. Those rows
 * would vanish from the feed with no error and `hasMore` behaving normally,
 * which is the worst shape a pagination bug can take.
 *
 * Deliberately not built for: the provider has not changed, and guessing at
 * one adds a format to maintain for no current benefit. If it ever does
 * change, this is the function to revisit — encode the raw epoch value, or
 * compare on a column whose precision the cursor can represent.
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
 * Re-checks exactly the preview columns this scope claimed to filter on, as
 * far as the projection lets us see them.
 *
 * Driven by the scope rather than by a fixed column list, because the two arms
 * legitimately require different things: the owner arm filters on `previewKey`
 * alone (a row may lack a public handle and still be its uploader's work), the
 * anonymous arm on both. A guard hardcoded to one column is a guard that is
 * either a no-op for one audience or an over-reach for the other — this
 * listing has now shipped each of those once.
 *
 * Deliberately tolerant of a column being ABSENT and intolerant of it being
 * present and null. Those are the two cases a bare `!== null` conflates, and
 * the conflation is what made earlier versions silently vacuous: the anonymous
 * projection has no `previewKey` at all, so reading it yields `undefined`, and
 * `undefined !== null` passes everything.
 */
function hasCompletePreview(
  row: { previewId?: string | null; previewKey?: string | null },
  scope: MediaListingScope,
): boolean {
  if ("previewKey" in scope && "previewKey" in row && row.previewKey === null) {
    return false;
  }
  if ("previewId" in scope && "previewId" in row && row.previewId === null) {
    return false;
  }
  return true;
}

/**
 * Strictly "after this position" in (createdAt desc, id desc) order. No skip
 * needed: the position itself cannot satisfy either branch.
 */
function keysetAfter(position: MediaCursor) {
  return {
    OR: [
      { createdAt: { lt: position.createdAt } },
      { createdAt: position.createdAt, id: { lt: position.id } },
    ],
  };
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
export async function listMedia(
  requestUrl: string,
  scope: MediaOwnerScope,
  select: MediaOwnerListingSelect &
    MediaListingRequiredColumns & { previewKey: true },
): Promise<MediaListingResult<MediaOwnerListingSelect>>;
/**
 * The anonymous arm. Its scope type requires the publish filter, so there is
 * no spelling of this call that serves unpublished rows to an anonymous
 * caller — not by copying a route, not by deleting a line.
 */
export async function listMedia(
  requestUrl: string,
  scope: MediaAnonymousScope,
  select: MediaAnonymousListingSelect &
    MediaListingRequiredColumns & { previewId: true },
): Promise<MediaListingResult<MediaAnonymousListingSelect>>;
export async function listMedia<
  TSelect extends MediaListingSelect & MediaListingRequiredColumns,
>(
  requestUrl: string,
  scope: MediaListingScope,
  select: TSelect,
): Promise<MediaListingResult<TSelect>> {
  const params = new URL(requestUrl).searchParams;
  const limit = parseListingLimit(params.get("limit"));
  // Treat `?cursor=` as absent rather than as a cursor, which would otherwise
  // 400 on a perfectly ordinary first-page request.
  const rawCursor = params.get("cursor")?.trim() || null;

  let keyset: ReturnType<typeof keysetAfter> | undefined;
  if (rawCursor !== null) {
    const position = decodeMediaCursor(rawCursor);
    if (!position) {
      // Malformed, truncated or hand-written. Answering with an empty page
      // would be a false end-of-list — the caller would stop, believing it had
      // seen everything. Say so instead, and let it restart pagination.
      return { ok: false, status: 400, error: "Invalid cursor" };
    }

    keyset = keysetAfter(position);
  }

  // Scan forward until this page has something to emit, or the feed runs out.
  //
  // Every cursor handed back is built from a row that was actually emitted.
  // That is a privacy requirement, not a tidiness one: encodeMediaCursor's
  // justification for being readable is that it contains only what the caller
  // was just given, and a position taken from a row the defensive filter
  // dropped would break exactly that — handing an anonymous caller the cuid and
  // creation time of a row deliberately withheld from them.
  //
  // The obvious alternatives are both wrong, and the shape of this loop is the
  // reason. Taking the position from the last *emitted* row and stopping there
  // reports hasMore: false whenever a page is entirely filtered out — a silent
  // end-of-list, in precisely the case the filter exists to cover. Taking it
  // from the last row *read* fixes that but leaks the withheld row. So the
  // advance past withheld rows happens here, server-side, where the position
  // never leaves the process.
  //
  // Bounded rather than open: a run this long means the query's where-clause
  // and the filter below disagree across hundreds of rows, which is a broken
  // invariant that should be noticed, not smoothed over. In normal operation
  // the two agree and this runs exactly once.
  let scanned: MediaListingRow<TSelect>[] = [];
  let page: MediaListingRow<TSelect>[] = [];
  let items: MediaListingItem<TSelect>[] = [];

  for (let attempt = 0; attempt < MAX_WITHHELD_PAGE_SCANS; attempt += 1) {
    scanned = (await prisma.media.findMany({
      where: { ...scope, ...keyset },
      select,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // One extra row is a cheap way to know whether another page exists
      // without a second count query.
      take: limit + 1,
      // Prisma infers a union of both projections from the union-typed
      // `select`, which it cannot narrow back to the caller's concrete
      // TSelect. The narrow is safe because TSelect *is* the select the query
      // just ran with; the `where`/`select` above are the only things that
      // decide what comes back.
      //
      // Cast to the *row* type, not the item type: `previewId` stays
      // `string | null` here, which is what keeps the filter below a real
      // runtime check rather than one the compiler has already decided can
      // never be false.
    })) as MediaListingRow<TSelect>[];

    page = scanned.length > limit ? scanned.slice(0, limit) : scanned;

    // The where-clause already excludes them, but the preview columns are
    // still typed nullable because the columns are; narrowing here makes the
    // emitted shape non-nullable and means a future query change can't quietly
    // start emitting preview-less rows.
    //
    // What gets checked is decided by the SCOPE, not by a fixed list — see
    // hasCompletePreview. The two arms legitimately require different things:
    // the owner arm filters on `previewKey` alone, because a row may lack the
    // public handle and still be its uploader's work; the anonymous arm
    // requires both. An earlier version checked a hardcoded column and was
    // therefore a no-op for one audience or an over-reach for the other,
    // depending on which column it named — this listing has shipped each of
    // those once.
    items = page.filter((row): row is MediaListingItem<TSelect> =>
      hasCompletePreview(row, scope),
    );

    // Something to emit, or nothing left to look at.
    if (items.length > 0 || scanned.length <= limit) {
      break;
    }

    // Everything on this page was withheld and more rows exist. Step past the
    // last row read — internally. This position is never encoded for the
    // caller; it only moves the next query's window.
    const withheld = page.at(-1);
    if (!withheld) {
      break;
    }
    keyset = keysetAfter(withheld);

    if (attempt === MAX_WITHHELD_PAGE_SCANS - 1) {
      console.error("[media] listing filter withheld every scanned row", {
        scans: MAX_WITHHELD_PAGE_SCANS,
        limit,
        // No row identifiers: this log is about a broken invariant, not about
        // the rows, and it is reachable from an anonymous request.
      });
    }
  }

  // From an emitted row, always. When the extra row says more exist but this
  // page emitted nothing, there is no position that is both truthful and safe
  // to disclose — the loop above exists so that case is reached only when the
  // database is inconsistent with its own query, and it is reported as the end
  // of the list rather than by disclosing a withheld row.
  const last = scanned.length > limit ? items.at(-1) : undefined;
  const nextCursor = last ? encodeMediaCursor(last) : null;

  return {
    ok: true,
    page: { items, hasMore: nextCursor !== null, nextCursor },
  };
}
