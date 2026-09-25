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

/**
 * Owner-facing: everything about the row its own uploader may see.
 *
 * Written out in full, with no shared base spread in. See the anonymous select
 * below for why that duplication is deliberate.
 */
export const MEDIA_OWNER_SELECT = {
  id: true,
  // Which sort of artefact this is. True of the original and of anything
  // derived from it, so it reads the same to either audience.
  kind: true,
  // The opaque public handle for the watermarked preview. Its storage path,
  // `previewKey`, is a separate column below.
  previewId: true,
  createdAt: true,
  // Visibility state (ugcportal-r1d). The owner's view needs it to render a
  // publish toggle at all, and the publish endpoint needs it to report the
  // new state.
  publishedAt: true,
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
  // `mimeType` and `sizeBytes` describe the ORIGINAL — the file as uploaded,
  // not the watermarked preview. For an owner that is the useful number and
  // the correct one: their library, their upload, "photo.png, image/png,
  // 1.4 MB" (ugcportal-n3c's upload UI wants exactly this). For anyone else
  // it would be a fact about a file they can neither see nor fetch; see the
  // anonymous select for why that is worse than useless.
  mimeType: true,
  sizeBytes: true,
  // `userId` and `key` are absent from both selects and must stay that way.
  // `key` is the ungated paid original (ugcportal-5d6). `userId` would be
  // redundant on the owner's own view, and on the anonymous feed it would let
  // anyone group the whole gallery by uploader.
} as const;

/**
 * Anonymous-facing: what an unauthenticated visitor may see.
 *
 * WRITTEN OUT IN FULL, ON PURPOSE. This used to be `= MEDIA_SHARED_SELECT`,
 * a base the owner select also spread — which made it, structurally, a
 * subtraction dressed up as a list. The consequence is the one that matters:
 * a column added to the shared base became world-readable on
 * GET /api/public/media with no diff in the public route, no test touching
 * the anonymous payload, and nobody ever asked which audience it was for.
 *
 * That is not hypothetical. It is how `publishedAt` arrived in this feed, and
 * how `mimeType`/`sizeBytes` sat here for three review rounds before anyone
 * noticed they describe a file the feed cannot serve. Both were fine or fixable;
 * the next one might not be.
 *
 * So the five common columns are duplicated rather than shared. The
 * duplication IS the forcing function: adding a column to the owner select
 * does nothing here until someone opens this list and decides. The
 * `satisfies` clause keeps the relationship honest in the other direction —
 * this must remain a subset of the owner select, so a column can never appear
 * to an anonymous caller that the row's own uploader cannot see.
 *
 * What is deliberately NOT here, and why:
 *
 * `originalName`: filenames are volunteered, not chosen for publication —
 * `anna-berg-passport-scan.jpg`, `client-acme-draft-v3.png`. Before
 * ugcportal-r1d this column was only ever returned to the row's own owner.
 * The gallery does not need it, and it is not alt text either — a filename
 * makes poor alt text, and if ugcportal-71y wants captions those should be a
 * field the uploader knowingly fills in, not a string harvested from their
 * local disk.
 *
 * `previewKey`: the storage path embeds the uploader's id
 * (`previews/{userId}/{uuid}.webp`), so publishing it publishes the very thing
 * withholding `userId` was meant to withhold — page the feed, split each key
 * on "/", and you have an anonymous per-uploader index of the whole gallery.
 * Withholding a value while publishing a derivation of it is not withholding
 * it. `previewId` is exposed instead: an unrelated random id, with no
 * derivation from the key, the user, or the row.
 *
 * `mimeType` and `sizeBytes`: both describe the original upload, and the
 * original is the one thing this feed can never hand over. The only asset it
 * can represent is the watermarked preview — a different format and a
 * different size. Reporting `image/png` and 1.4 MB next to a webp thumbnail is
 * not a small inaccuracy: a consumer using `mimeType` for a `<source type>` or
 * a download extension is wrong on every row, one showing the size beside the
 * thumbnail is wrong on every row, and the byte count is an exact fingerprint
 * of a file the caller is not entitled to.
 *
 * Nothing is substituted, because there is nothing true to substitute. Media
 * stores no metadata about the preview: its content type is a constant of the
 * watermark service (PREVIEW_CONTENT_TYPE in src/lib/watermark.ts, the same
 * for every row, so not per-row data a feed should repeat), and its byte size
 * is not recorded at all. Publishing a right-shaped wrong number is worse than
 * publishing none — the wrong one gets used. If the gallery (ugcportal-71y)
 * turns out to need the preview's size, that is a new column written at
 * upload time and a deliberate decision, not a reinterpretation of this one.
 */
export const MEDIA_ANONYMOUS_SELECT = {
  id: true,
  kind: true,
  // The opaque public handle for the watermarked preview — safe for anyone,
  // because it is derived from nothing about the row or its uploader.
  previewId: true,
  createdAt: true,
  // Always non-null here (the feed filters on it) and reads as "public since".
  publishedAt: true,
} as const satisfies Partial<typeof MEDIA_OWNER_SELECT>;

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
