import type { MediaModel } from "@/generated/prisma/models";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Two projections, deliberately not one.
 *
 * Both are spelled out as explicit `select`s rather than an `omit`, so a
 * column added later is excluded by default instead of leaking until someone
 * remembers to blocklist it — `key`, the ungated paid original
 * (ugcportal-5d6), is the column that must never appear in either, in any
 * direction. Echoing a row back from a write is just as much an exposure as
 * listing it.
 *
 * They live here rather than in a route because four files now project Media,
 * and a projection copied per route is one that eventually disagrees with
 * itself.
 *
 * The split between them is the audience, and it is load-bearing:
 *
 *   MEDIA_OWNER_SELECT      what an authenticated owner sees about their own
 *                           row (POST, GET /api/media, PATCH, publish).
 *   MEDIA_ANONYMOUS_SELECT  what an unauthenticated visitor sees on the public
 *                           feed. A strict subset of the owner select.
 *
 * Adding a column means answering "which of the two?" rather than defaulting
 * to both — which is how `originalName` reached the anonymous feed in the
 * first draft of ugcportal-r1d.
 */

const MEDIA_SHARED_SELECT = {
  id: true,
  kind: true,
  previewKey: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  // Visibility state (ugcportal-r1d). On the anonymous feed it is always
  // non-null and reads as "public since"; a null is only ever visible to the
  // row's own owner, because that feed filters to non-null rows. The owner's
  // view needs it to render a publish toggle at all, and the publish endpoint
  // needs it to report the new state.
  publishedAt: true,
  // `userId` is absent from both. On the owner's view it would be redundant
  // (every row is theirs); on the anonymous feed it would let anyone group the
  // whole gallery by uploader and enumerate one person's complete published
  // output from an id they never chose to show. If the gallery later wants
  // attribution, that is a display name the uploader opted into
  // (ugcportal-71y's call), not the internal account id.
} as const;

/** Owner-facing: adds the filename, which only its uploader should see. */
export const MEDIA_OWNER_SELECT = {
  ...MEDIA_SHARED_SELECT,
  // `originalName` is uploader-supplied text. It is how an owner recognises
  // their own file in a list, so it belongs here — and nowhere else. See the
  // anonymous select below for why.
  originalName: true,
} as const;

/**
 * Anonymous-facing: the owner select minus `originalName`.
 *
 * Filenames are volunteered, not chosen for publication —
 * `anna-berg-passport-scan.jpg`, `client-acme-draft-v3.png`. Before
 * ugcportal-r1d this column was only ever returned to the row's own owner;
 * shipping the public feed off a shared projection would have made it
 * world-readable for every published row as a side effect, which is exactly
 * the class of leak `userId` was withheld to avoid.
 *
 * The gallery does not need it. It is not alt text either — a filename makes
 * poor alt text, and if ugcportal-71y wants captions or accessible
 * descriptions those should be a field the uploader knowingly fills in, not a
 * string harvested from their local disk.
 */
export const MEDIA_ANONYMOUS_SELECT = MEDIA_SHARED_SELECT;

/**
 * Tied to the selects by construction: widen one and its type widens with it,
 * so toOwnerMedia below stops compiling until it is updated too. That is the
 * point — they can't silently disagree.
 */
export type OwnerMedia = Pick<MediaModel, keyof typeof MEDIA_OWNER_SELECT>;
export type AnonymousMedia = Pick<
  MediaModel,
  keyof typeof MEDIA_ANONYMOUS_SELECT
>;

/**
 * Projects a full row down to the owner-facing shape, for the caller that
 * already holds one (PATCH and the publish routes re-use the row the ownership
 * gate read, rather than paying for a second query just to get a narrower
 * select).
 *
 * There is deliberately no `toAnonymousMedia` counterpart: nothing anonymous
 * ever starts from a full row. The public feed selects MEDIA_ANONYMOUS_SELECT
 * at the database layer, so `originalName` and `key` are never read, let alone
 * mapped away afterwards.
 */
export function toOwnerMedia(media: MediaModel): OwnerMedia {
  return {
    id: media.id,
    kind: media.kind,
    previewKey: media.previewKey,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    originalName: media.originalName,
    createdAt: media.createdAt,
    publishedAt: media.publishedAt,
  };
}

export type MediaAccessResult =
  | { ok: true; userId: string; media: MediaModel }
  | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * The single ownership gate for the per-item media routes (ugcportal-bdh).
 * Mirrors requireAdmin in src/lib/admin.ts: it answers "may this caller
 * touch this row", and leaves building the response to the route.
 *
 * On success it also hands back the row, because both callers need it —
 * PATCH to echo the updated record, DELETE to know which object to remove
 * from storage — so the gate costs one read rather than two.
 *
 * This read is *not* the authoritative check on its own: it is separated
 * from the write that follows by a round trip, so every caller must also
 * scope its write by `{ id, userId }` (see the routes). What this gate buys
 * is the right status code and an early exit before any write is attempted.
 *
 * 403-vs-404: a caller who owns nothing here learns that the id exists.
 * That is a deliberate, narrow trade. Media ids are cuids — not enumerable,
 * so an attacker can't sweep the table for valid ones — and answering 404
 * for "exists but isn't yours" makes every real authorization bug look like
 * a typo to whoever is debugging it. Admin/moderation routes make the other
 * choice (see requireAdmin) because there the existence of the route itself
 * is the secret; here it isn't.
 */
export async function requireOwnedMedia(
  mediaId: string,
): Promise<MediaAccessResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const media = await prisma.media.findUnique({ where: { id: mediaId } });
  if (!media) {
    return { ok: false, status: 404, error: "Not found" };
  }

  if (media.userId !== userId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true, userId, media };
}
