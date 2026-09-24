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
  // The opaque public handle for the watermarked preview — safe for anyone.
  // Its storage path, `previewKey`, is owner-only and lives in the owner
  // select below; see the note there and on the Media model.
  previewId: true,
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

/** Owner-facing: adds the two fields only the row's own uploader may see. */
export const MEDIA_OWNER_SELECT = {
  ...MEDIA_SHARED_SELECT,
  // `originalName` is uploader-supplied text. It is how an owner recognises
  // their own file in a list, so it belongs here — and nowhere else. See the
  // anonymous select below for why.
  originalName: true,
  // `previewKey` is a storage path of the form `previews/{userId}/{uuid}`.
  // Returning it to its own owner discloses nothing they do not already know:
  // the embedded id is theirs. Returning it to anyone else discloses whose
  // upload it is, which is why the anonymous select carries `previewId`
  // instead. Never widen this one.
  previewKey: true,
} as const;

/**
 * Anonymous-facing: the owner select minus `originalName` and `previewKey`.
 *
 * Two separate withholdings, for the same underlying reason — an anonymous
 * caller must not be able to attribute a gallery item to an account, or read
 * text its uploader never meant to publish.
 *
 * `originalName`: filenames are volunteered, not chosen for publication —
 * `anna-berg-passport-scan.jpg`, `client-acme-draft-v3.png`. Before
 * ugcportal-r1d this column was only ever returned to the row's own owner;
 * shipping the public feed off a shared projection would have made it
 * world-readable for every published row as a side effect. The gallery does
 * not need it, and it is not alt text either — a filename makes poor alt text,
 * and if ugcportal-71y wants captions those should be a field the uploader
 * knowingly fills in, not a string harvested from their local disk.
 *
 * `previewKey`: the storage path embeds the uploader's id
 * (`previews/{userId}/{uuid}.webp`), so publishing it publishes the very thing
 * withholding `userId` was meant to withhold — page the feed, split each key
 * on "/", and you have an anonymous per-uploader index of the whole gallery.
 * Withholding a value while publishing a derivation of it is not withholding
 * it. `previewId` is exposed instead: an unrelated random id, with no
 * derivation from the key, the user, or the row.
 *
 * Kept as an explicit list rather than a subtraction from the owner select, so
 * a column added to the owner side does not silently arrive here too. Adding a
 * field means choosing an audience.
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
    previewId: media.previewId,
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
