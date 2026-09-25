import { createHash } from "node:crypto";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
// Both from @/lib/media, deliberately, even though @/lib/watermark re-exports
// PREVIEW_CONTENT_TYPE and reads as the more natural home for it. Importing it
// from there pulls sharp, libvips and a native binary into this route's module
// graph — measured at 86 extra files in the Next build trace — to read a
// ten-character string. This route forwards bytes somebody else encoded and is
// the hot path; it has no business loading an image-processing library.
import { PREVIEW_CONTENT_TYPE, PREVIEW_KEY_PREFIX } from "@/lib/media";
import { MEDIA_PREVIEW_DELIVERY_SELECT } from "@/lib/media-access";
import { prisma } from "@/lib/prisma";
import { getBucketName, getS3Client } from "@/lib/s3";

/**
 * GET /api/media/preview/[previewId] — the watermarked preview's bytes
 * (ugcportal-a2l).
 *
 * This is the only route in the app that serves media bytes, and the only
 * thing it will ever serve is the watermarked preview. The paid original
 * (`Media.key`) belongs to ugcportal-5d6, gated on purchase, and is not
 * reachable from here by any input — see the prefix guard below, which is
 * that claim's enforcement rather than its restatement.
 *
 * THE BYTES ARE PROXIED, NOT REDIRECTED TO, AND THAT IS THE WHOLE DESIGN.
 *
 * The obvious implementation — presign the object and 302 to it — is
 * specifically wrong here, and wrong in a way that is invisible in a passing
 * test. A presigned URL contains the object key, and the key is
 * `previews/{userId}/{uuid}.webp`, so the uploader's account id would land in
 * the visitor's address bar, their network tab, the `Referer` of anything the
 * page loads next, and every access log between here and the bucket. That is
 * the precise capability `previewId` was introduced to remove: the public feed
 * withholds `previewKey` so that nobody can split it on "/" and build a
 * per-uploader index of the gallery (ugcportal-r1d, three review rounds). A
 * redirect would hand back in one line what that bought.
 *
 * The cost of proxying is real and is accepted rather than hidden: every
 * preview byte the product displays passes through this Node process, so image
 * traffic is app-server traffic, and no CDN can offload it while the key looks
 * like this. That is a known gap, filed as ugcportal-5j4 rather than left in a
 * PR description — along with its fix, which is a storage layout carrying no
 * account id (key the object on `previewId`), a data migration with its own
 * blast radius that is deliberately not bundled here.
 *
 * Authorisation is expressed as a WHERE clause, never as a comparison after
 * the read — see previewScope below for why that is not a stylistic choice.
 */

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ previewId: string }> };

/**
 * The one 404 this route can produce, as one function, because K3 is a claim
 * about *sameness*.
 *
 * Every miss funnels through here: an id that does not exist, an unpublished
 * row belonging to somebody else, a row whose `previewKey` is unusable, and a
 * stored object that has gone missing. They must be indistinguishable to an
 * anonymous caller, and the cheapest way to guarantee that is to leave no
 * second place where a 404 can be spelled slightly differently — no variant
 * message, no extra header, no `reason` field added later "just for
 * debugging".
 *
 * `no-store` because the answer is a function of publish state, which changes:
 * a cached 404 would keep an item invisible after its owner published it, the
 * mirror of the staleness the success path guards against.
 *
 * On timing: the "no such id" and the "unpublished, not yours" cases run
 * exactly the same code — one `auth()`, one indexed `findFirst`, this
 * response — and neither reaches object storage. That removes the large,
 * obvious signal, which would be a bucket round trip on one path and not the
 * other. It is not a constant-time claim, and none is made: SQLite's index
 * lookup for a missing key and for a filtered-out row are not provably
 * identical, and this route does not attempt to equalise them.
 */
function previewNotFound(): NextResponse {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Something is wrong on this side, not with the request.
 *
 * The body is a fixed string on purpose. Whatever the S3 client threw almost
 * certainly names the bucket and the key in its message, and the key is the
 * one value this route exists to keep out of responses — so the error is
 * logged and a constant is returned. Never interpolate the cause here.
 */
function previewUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "Failed to load preview" },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

/**
 * The scope for an anonymous caller: published previews, and nothing else.
 *
 * `publishedAt: { not: null }` is required by the type, and `userId` and `OR`
 * are `?: never`, for the same reason MediaAnonymousScope in
 * src/lib/media-listing.ts is shaped that way — so that "anonymous lookup with
 * the publish filter dropped" is not a spelling that compiles.
 */
type AnonymousPreviewScope = {
  previewId: string;
  previewKey: { not: null };
  publishedAt: { not: null };
  userId?: never;
  OR?: never;
};

/**
 * The scope for a signed-in caller: published previews, plus their own
 * whatever its state.
 *
 * The owner branch is `{ userId: string }`, not an optional and not
 * `string | undefined`, and that is the important line in this file.
 *
 * Prisma DROPS a filter whose value is `undefined`. So
 * `{ OR: [{ publishedAt: { not: null } }, { userId: undefined }] }` does not
 * mean "or nothing"; it means `{ OR: [{...}, {}] }`, and an empty branch
 * matches every row. One unauthenticated request would then be served any
 * unpublished preview in the database by id — the entire failure this bead
 * exists to prevent, arriving from a value that is `undefined` rather than
 * from any visible mistake. Requiring a `string` here, and normalising the
 * session exactly once in the handler, is what makes that unexpressible.
 */
type OwnerPreviewScope = {
  previewId: string;
  previewKey: { not: null };
  OR: [{ publishedAt: { not: null } }, { userId: string }];
  publishedAt?: never;
  userId?: never;
};

type PreviewScope = AnonymousPreviewScope | OwnerPreviewScope;

/**
 * Builds the WHERE clause, which IS the authorisation.
 *
 * Deliberately not "read the row, then compare `row.userId` to the session".
 * Two reasons, and the second is the one that decides it:
 *
 *  1. Reading `userId` to compare it means selecting `userId`, which puts the
 *     column this feature spends its whole budget withholding into a variable
 *     inside an anonymous request's handler. Not selecting it at all is a
 *     stronger statement than selecting it and being careful with it.
 *  2. A post-read comparison has two outcomes and therefore two code paths,
 *     and K3 requires the unauthorised one to be indistinguishable from "no
 *     such row". Folding the rule into the query collapses both into a single
 *     `null` result reached by a single path — the sameness becomes structural
 *     instead of maintained by hand.
 *
 * `previewKey: { not: null }` is in both arms because a row with no stored
 * object has nothing to serve; the runtime narrow in the handler re-checks it
 * for the null the column's type still permits.
 */
function previewScope(previewId: string, viewerId: string | null): PreviewScope {
  if (viewerId === null) {
    return { previewId, previewKey: { not: null }, publishedAt: { not: null } };
  }
  return {
    previewId,
    previewKey: { not: null },
    OR: [{ publishedAt: { not: null } }, { userId: viewerId }],
  };
}

/**
 * Caching, decided rather than defaulted.
 *
 * `private` — no shared cache may store this, ever. That is the directive
 * doing the security work. The bytes are immutable, which makes them look like
 * an ideal CDN candidate, but *entitlement* to them is not immutable: an owner
 * can unpublish, and a proxy holding the image would keep handing it to
 * strangers afterwards. A visibility control a cache can outlive is not a
 * visibility control — the same argument GET /api/public/media makes for
 * `no-store` on its JSON.
 *
 * `no-cache` — the visitor's own browser MAY keep the bytes, but must
 * revalidate before reusing them. This is where this route deliberately
 * diverges from the listing's `no-store`, because the two are not the same
 * trade: the listing is one cheap query, and an image is a bucket round trip
 * plus a full body over this process's socket for every scroll of the gallery.
 * `no-cache` keeps the correctness that matters — every request re-runs
 * `auth()` and the scoped query, so an unpublish takes effect on the very next
 * request with no window at all — while letting the revalidation answer 304
 * and skip both the object fetch and the body.
 *
 * `Vary: Cookie` — the response depends on the session, because an owner may
 * fetch their own unpublished preview at the same URL that 404s for everyone
 * else. `private` already confines storage to one browser profile and the
 * mandatory revalidation is what actually enforces the rule, so this is
 * belt-and-braces for intermediaries rather than the load-bearing part.
 *
 * What is NOT here: `max-age` and `immutable`. They are the right answer for
 * these bytes and the wrong answer for this route — they would buy a cache
 * window measured in exactly the thing an unpublish has to be able to
 * interrupt. If a CDN is ever put in front of this, it needs an invalidation
 * path driven by publish AND unpublish before any of these directives loosens.
 */
function previewCacheHeaders(etag: string): Record<string, string> {
  return {
    "cache-control": "private, no-cache",
    vary: "Cookie",
    etag,
  };
}

/**
 * A strong validator for the preview's bytes.
 *
 * Sound because the representation at a given `previewId` never changes:
 * `previewKey` is write-once (nothing in the codebase updates the column, and
 * POST /api/media mints a fresh `randomUUID()` key per upload, so no object is
 * ever overwritten in place), and `previewId` is unique and 1:1 with it.
 *
 * What it does rest on, stated plainly rather than buried: the validator is
 * computed from the row alone and never looks at the object, so it cannot
 * notice anything done to the bucket out of band. Two cases, both accepted:
 *
 *   Replaced — a client holding the old bytes keeps them, because the tag it
 *   presents still matches.
 *
 *   Deleted — worse-looking, and still accepted. A client holding a validator
 *   goes on being answered 304 while a fresh client gets 404 (the
 *   `isMissingObject` path below), so the same URL is simultaneously cached
 *   and gone. See the short-circuit below for why the check stays where it
 *   is; tracked as ugcportal-817.
 *
 * Neither is reachable through the product. The only delete path,
 * DELETE /api/media/[id], removes the ROW first and the objects second, so
 * after it there is no row for the query to find and no 304 to be had —
 * reaching either case needs a bucket-level action nothing in the app
 * performs.
 *
 * Hashed rather than used verbatim. Not for secrecy — `previewId` is in the
 * request URL, so there is nothing to hide — but because a hash is
 * unconditionally a valid HTTP field value, whatever ends up in the column.
 * The alternative is an "is this id header-safe?" branch, which is one more
 * thing to keep in step with whatever mints ids next; this needs nothing kept
 * in step.
 */
function previewEtag(previewId: string): string {
  return `"${createHash("sha256").update(previewId).digest("base64url")}"`;
}

/**
 * RFC 9110 If-None-Match: a comma-separated list, or `*`, compared with the
 * WEAK comparison function — so a client echoing `W/"x"` matches our strong
 * `"x"`, and stripping the prefix before comparing is required rather than
 * lenient.
 *
 * What is being compared is worth stating, because "request value against
 * server value" is the shape that usually hides a fail-open: the right-hand
 * side is computed from the row the query just authorised, and this function
 * is only ever called after that query succeeded. A forged If-None-Match can
 * therefore turn a 200 the caller was already entitled to into a 304. It
 * cannot produce a 304 for a row the caller may not see, because on that path
 * the handler has already returned 404 and never reaches here.
 */
function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((raw) => {
    const candidate = raw.trim();
    if (candidate === "*") return true;
    return (
      (candidate.startsWith("W/") ? candidate.slice(2) : candidate) === etag
    );
  });
}

/**
 * True when the key points inside the preview shelf.
 *
 * This is K4's enforcement: originals live under `media/` (see POST
 * /api/media) and previews under `previews/`, so refusing anything without the
 * preview prefix means no input to this route can make it issue a GetObject
 * for a paid original.
 *
 * It is a check on DATA, not on caller input — `previewKey` is never supplied
 * by the request, it is read from the row. So what it actually catches is a
 * writer putting the wrong string in the column: nothing in the schema stops
 * `previewKey` being set to the same value as `key`, `mediaPreviewColumns`
 * deliberately validates blankness and not shape, and a second writer is
 * already on the roadmap (ugcportal-ct0's Instagram sync). Without this, such
 * a row would make this route serve the unwatermarked original to anyone, with
 * a 200 and no sign of trouble.
 *
 * The `..` segment check is not decoration on top of the prefix check, it
 * covers a case the prefix check alone lets through: `previews/../media/x.png`
 * starts with the prefix and still names the originals' shelf. Object storage
 * itself treats a key as an opaque string and would simply miss — but this
 * deployment addresses the bucket path-style (S3_FORCE_PATH_STYLE, see
 * env.example), so the key becomes path segments in the request line, and
 * plenty of things between here and the bucket (nginx, HAProxy, a CDN) collapse
 * `..` in a path before forwarding it. Rejecting the segment costs one line and
 * does not depend on knowing which intermediary is in front of the bucket
 * today.
 */
function isPreviewObjectKey(key: string): boolean {
  if (!key.startsWith(PREVIEW_KEY_PREFIX)) return false;
  return !key.split("/").includes("..");
}

/**
 * True for the S3 error meaning "this row points at an object that is gone".
 *
 * Matched on specific error codes and NOT on `$metadata.httpStatusCode === 404`,
 * which is what this shipped with for one review round — worth spelling out so
 * it does not come back.
 *
 * `NoSuchBucket` is also a 404. So a wrong, renamed or deleted
 * `S3_BUCKET_NAME` would have matched, and every preview in the product would
 * have answered a calm `404 {"error":"Not found"}`: no 5xx, nothing in any
 * error-rate alert, a gallery that looks empty rather than broken. A
 * misconfiguration that produces no error signal is worse than one that
 * crashes, because nothing ever goes looking for it.
 *
 * The asymmetry is the point, and it runs the opposite way to what the comment
 * here used to claim. Failing to recognise a genuinely-absent object costs a
 * 500 where a 404 would have read better — noisy, harmless, and it cannot
 * widen what is served. Recognising too much converts whole classes of
 * infrastructure failure into silence. So this list stays exhaustive by name:
 * add a code only when it means *this specific object* is absent.
 *
 * Both spellings are kept because S3-compatible servers disagree — GetObject
 * answers `NoSuchKey` on S3 and MinIO, while some gateways normalise to
 * `NotFound`. Neither is the bucket-level error, which is `NoSuchBucket` and
 * must keep reaching the 500 path.
 */
function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name } = error as { name?: unknown };
  return name === "NoSuchKey" || name === "NotFound";
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { previewId } = await context.params;

  // Purely an early-out, not a security check: `/api/media/preview/%20`
  // decodes to a blank segment, and the query below would miss it anyway and
  // return the identical 404. Skipping the round trip is the only difference.
  //
  // Note what is deliberately absent — any check on the SHAPE of the id. A
  // UUID test would be the obvious addition and would be a bug: ugcportal-r1d's
  // backfill migration goes out of its way to mint ids in the same v4 format
  // as new uploads *because* this route was expected to do that, and pinning
  // the format here would turn any future change of id generator into a
  // delivery outage. The unique-index lookup already rejects every id that is
  // not a real handle, which is the only rejection that matters.
  if (previewId.trim() === "") {
    return previewNotFound();
  }

  const session = await auth();
  const sessionUserId = session?.user?.id;
  // Normalised to `string | null` here, once, and never read from the session
  // again. `undefined` is the value that must not reach previewScope — see
  // OwnerPreviewScope above for what Prisma does with it. An empty string is
  // folded into the same "no viewer" answer: it matches no row, so it would
  // fail closed regardless, but leaving two spellings of "not signed in" in
  // play is how one of them eventually gets handled differently.
  const viewerId =
    typeof sessionUserId === "string" && sessionUserId !== ""
      ? sessionUserId
      : null;

  const row = await prisma.media.findFirst({
    where: previewScope(previewId, viewerId),
    select: MEDIA_PREVIEW_DELIVERY_SELECT,
  });

  // `previewKey` is filtered non-null by the scope, but the column's type says
  // otherwise and the narrow has to happen somewhere. Blank is folded in with
  // null for the same reason POST /api/media/[id]/publish folds it in: `""`
  // satisfies every `not: null` filter in the codebase while pointing at
  // nothing, so treating it as "no preview" here keeps this route agreeing
  // with the one that decides such a row cannot be published at all.
  if (!row || row.previewKey === null || row.previewKey.trim() === "") {
    return previewNotFound();
  }

  const previewKey = row.previewKey;

  if (!isPreviewObjectKey(previewKey)) {
    // Loud, because this is a broken invariant rather than a bad request: some
    // writer has put a non-preview path in `previewKey`. No key in the log line
    // and no key in the response — the point of the whole feature is that this
    // string does not travel.
    console.error(
      "[media] previewKey is outside the preview prefix; refusing to serve",
    );
    return previewNotFound();
  }

  const etag = previewEtag(previewId);

  // After the authorisation query, never before. A 304 is a statement that the
  // caller's cached copy is still current, which is only true for a caller who
  // may have it at all.
  //
  // Also BEFORE the GetObject, and that placement is the trade rather than an
  // oversight. It means an object deleted out of band keeps being revalidated
  // as 304 for clients holding a validator, while a fresh client gets 404 —
  // the same URL cached and gone at once (ugcportal-817, pinned by a test so
  // the behaviour cannot change unnoticed).
  //
  // Moving the check after the fetch would close that, and would also delete
  // the entire reason this route says `no-cache` instead of `no-store`: the
  // point of the conditional request is to skip the bucket round trip and the
  // body. A 304 that costs a full GetObject is a 200 with the bytes thrown
  // away. The authorisation re-check — the part that actually matters, and the
  // reason `no-cache` is safe at all — has already happened above, against the
  // database, which is the source of truth for whether this caller may see
  // anything. Storage is the source of truth for whether the bytes are still
  // there, and that question is worth one round trip per delivery, not one per
  // revalidation.
  if (ifNoneMatchSatisfied(request.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: previewCacheHeaders(etag),
    });
  }

  let object;
  try {
    object = await getS3Client().send(
      new GetObjectCommand({ Bucket: getBucketName(), Key: previewKey }),
    );
  } catch (error) {
    if (isMissingObject(error)) {
      // The row says there is a preview and storage disagrees. Answering 404
      // through the same helper as every other miss keeps this from becoming a
      // way to tell "real id, object gone" apart from "no such id".
      console.error("[media] preview object missing from storage");
      return previewNotFound();
    }
    console.error("[media] failed to fetch preview object", error);
    return previewUnavailable();
  }

  const body = object.Body;
  if (!body) {
    console.error("[media] preview object fetch returned no body");
    return previewUnavailable();
  }

  return new Response(body.transformToWebStream(), {
    status: 200,
    headers: {
      ...previewCacheHeaders(etag),
      // The constant the watermark service writes with, not the ContentType
      // echoed back by storage. Every object under this prefix is produced by
      // one code path (src/lib/watermark.ts) that emits exactly this type, so
      // the constant is the more trustworthy of the two — and it means a bucket
      // whose object metadata has been edited cannot change how a browser
      // interprets bytes served from this app's own origin.
      "content-type": PREVIEW_CONTENT_TYPE,
      // With the type asserted rather than sniffed, a mislabelled object cannot
      // be re-interpreted as something scriptable on this origin. Cheap, and
      // this is the one route that returns user-derived bytes.
      "x-content-type-options": "nosniff",
      // Deliberately no `content-length`: it would have to come from the
      // GetObject response and be attached to a stream this handler does not
      // itself measure, and a value that disagrees with the body by even one
      // byte is a truncated or hanging response. Chunked framing costs a little
      // and cannot be wrong.
    },
  });
}
