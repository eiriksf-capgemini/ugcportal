import type { MediaModel } from "@/generated/prisma/models";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * The only Media columns any HTTP response may carry, shared by POST, GET and
 * PATCH so the three can't drift apart.
 *
 * Spelled out as an explicit `select` rather than an `omit` so a column added
 * later is excluded by default instead of leaking until someone remembers to
 * blocklist it — and `key`, the ungated paid original (ugcportal-5d6), is the
 * column that must never appear here, in any direction. Echoing a row back
 * from a write is just as much an exposure as listing it.
 *
 * Lives here rather than in the route that first needed it because PATCH
 * (ugcportal-bdh) is a third caller in a different file, and a projection
 * copied per route is a projection that eventually disagrees with itself.
 */
export const MEDIA_PUBLIC_SELECT = {
  id: true,
  kind: true,
  previewKey: true,
  mimeType: true,
  sizeBytes: true,
  originalName: true,
  createdAt: true,
} as const;

/**
 * Tied to MEDIA_PUBLIC_SELECT by construction: widen the select and this type
 * widens with it, so toPublicMedia below stops compiling until it is updated
 * too. That is the point — the two can't silently disagree.
 */
export type PublicMedia = Pick<MediaModel, keyof typeof MEDIA_PUBLIC_SELECT>;

/**
 * Projects a full row down to the public shape, for the caller that already
 * holds one (PATCH re-uses the row the ownership gate read, rather than
 * paying for a second query just to get a narrower select).
 */
export function toPublicMedia(media: MediaModel): PublicMedia {
  return {
    id: media.id,
    kind: media.kind,
    previewKey: media.previewKey,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    originalName: media.originalName,
    createdAt: media.createdAt,
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
