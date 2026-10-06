import type { MediaModel } from "@/generated/prisma/models";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { TAG_PUBLIC_FIELDS, type TagLabel } from "@/lib/tags";

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
 * Every subject tag on a row, as the only two fields any audience gets
 * (ugcportal-jsc).
 *
 * `Tag.id` is deliberately NOT here. It is not secret, but it is also not
 * useful to anybody outside the database: a visitor draws the name, and a
 * later writer addresses a tag by slug. Leaving it out keeps the rule this
 * file is built on — a column reaches an audience because somebody decided it
 * should — true of the relation as well as of the columns.
 *
 * ONE constant for both audiences, unlike the two selects below, and the
 * difference is not an inconsistency. Those two are split because the
 * *audiences* differ; a tag's name is the same public label whoever is
 * looking, and there is no owner-only tag field for a shared base to leak.
 *
 * Ordered by slug so the chips under a tile are in a stable order rather than
 * whatever order the join happened to return — otherwise the same photograph
 * reads "Books Food" on one request and "Food Books" on the next, and every
 * rendering assertion becomes flaky for a reason nobody enjoys finding.
 */
export const MEDIA_TAGS_SELECT = {
  // Composed from TAG_PUBLIC_FIELDS rather than spelled again, so the picker
  // on the upload page and the two audience projections here cannot come to
  // disagree about what a tag discloses. The constant lives in
  // src/lib/tags.ts and is imported in this direction on purpose — see the
  // note there about what importing this module would drag along.
  select: TAG_PUBLIC_FIELDS,
  orderBy: { slug: "asc" },
} as const;

/** A tag as every audience sees it. */
export type MediaTagLabel = TagLabel;

/**
 * The keys a Media projection is allowed to name: a real column, or the one
 * relation that is projected (`tags`).
 *
 * Spelled out so the `satisfies` clauses below reject a typo. Without it a
 * misspelled column would be silently dropped by the `Extract` in
 * `SelectedScalars`, and the resulting type would simply not carry the field
 * the author thought they had added.
 */
type MediaProjectionKey =
  | keyof MediaModel
  | "tags"
  | "advertisingDisclosure"
  | "commercialLinks";

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
  // Accessibility/discoverability text (ugcportal-gwr). In the owner select
  // so POST /api/media's 201 and the publish echo can report what was
  // stored; see the anonymous select below for why these are ALSO there,
  // unlike `originalName` two lines up.
  altText: true,
  caption: true,
  // Subject tags (ugcportal-jsc). In BOTH selects, which is the unusual case
  // in this file and is the point: a tag is a label chosen to be published,
  // so there is no audience it is for and another it is not. The nested
  // projection is the shared MEDIA_TAGS_SELECT above, so the two audiences
  // cannot come to disagree about which tag fields exist.
  tags: MEDIA_TAGS_SELECT,
  // The advertising-disclosure label (ugcportal-e0jv, part B of
  // ugcportal-qnq9.1). NARROWED TO `label` ALONE, deliberately, even here on
  // the OWNER select: `benefitReceived`, `benefitKind`, `marketValueOre` and
  // the brand (`benefitSource`) are a compliance record the owner already
  // manages in full through its own dedicated route
  // (PUT /api/media/[id]/disclosure, DISCLOSURE_SELECT in that route file),
  // and this select is consumed directly by POST /api/media (201) and
  // GET /api/media (the owner's own listing) — see this file's own opening
  // comment on why a select is spelled out in full rather than grown by
  // one person remembering to narrow a new column. Projecting the full
  // record here would duplicate, and could drift from, that route's own
  // shape for no reader that needs it.
  //
  // THIS ENTRY EXISTS SO THE ANONYMOUS SELECT BELOW CAN HAVE THE SAME ONE,
  // narrower still: `satisfies Partial<typeof MEDIA_OWNER_SELECT>` on that
  // select means a key absent here cannot appear there AT ALL (excess-
  // property checking — see this file's own note on `key`/`userId` and
  // MEDIA_PREVIEW_DELIVERY_SELECT for the mechanism), so the public label
  // could not be added below without first existing, at least this
  // narrowly, here.
  advertisingDisclosure: { select: { label: true } },
  // The commercial outbound links on this item (ugcportal-qnq9.2.2). UNLIKE
  // `advertisingDisclosure` just above, this entry is NOT narrower than what
  // the anonymous select needs — it is the exact same value, for a reason
  // worth stating rather than assuming: nothing here is an owner-only
  // compliance field the way `benefitReceived`/`benefitKind`/`benefitSource`
  // are on the disclosure. `url`, `network` and `networkOther` are exactly
  // what K4 permits a public reader to see, so there is no narrower-but-
  // still-useful owner projection to invent — see the anonymous entry below
  // for what is deliberately NOT here (`benefitSourceId`, the brand
  // relation, `alcoholLinked`). It still exists on the owner side at all
  // only so the anonymous entry below can satisfy `satisfies
  // Partial<typeof MEDIA_OWNER_SELECT>` (the same mechanism
  // `advertisingDisclosure`'s own comment names) — GET /api/media does not
  // today read `commercialLinks` off its own result (the attach/detach
  // route, which DOES need the full row, has its own `COMMERCIAL_LINK_SELECT`
  // and does not go through this constant at all).
  commercialLinks: {
    select: { id: true, url: true, network: true, networkOther: true },
    orderBy: { createdAt: "asc" },
  },
  // `userId` and `key` are absent from both selects and must stay that way.
  // `key` is the ungated paid original (ugcportal-5d6). `userId` would be
  // redundant on the owner's own view, and on the anonymous feed it would let
  // anyone group the whole gallery by uploader.
} as const satisfies Partial<Record<MediaProjectionKey, unknown>>;

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
  // Alt text and caption (ugcportal-gwr) — unlike `originalName`, which is
  // withheld below because it is a filename nobody chose for publication,
  // these two are exactly what an uploader DID choose to say about a published
  // photograph: `altText` is required before publishedAt can ever be set (see
  // the publish route), and `caption` is the plain-text description the
  // gallery tile and the lightbox render. Neither carries a storage path, an
  // account id, or anything else this feed goes to length to withhold.
  altText: true,
  caption: true,
  // Subject tags (ugcportal-jsc), and the one field this select has ever
  // gained that was added FOR this audience rather than inherited by one.
  //
  // It is safe to publish for a reason worth stating rather than assuming: a
  // tag carries no storage path, no account id and nothing derived from
  // either. `Tag.slug` is computed from `Tag.name` and from nothing else (see
  // `tagSlug` in src/lib/tags.ts), and `Tag.id` is not projected at all. The
  // rule this whole file exists to keep — that `previewId` is the ONLY handle
  // an anonymous caller is given, and `mediaPreviewPath` the only URL anyone
  // builds — is untouched by it.
  //
  // What a tag DOES publish is the uploader's own description of the subject.
  // That is the intended disclosure: the item is published, and a label
  // saying "Food" is why ugcportal-jsc exists. It is not a channel for
  // anything else, which is what MAX_TAG_NAME_LENGTH and the character
  // denylist in src/lib/tags.ts are for.
  tags: MEDIA_TAGS_SELECT,
  // The advertising label (ugcportal-e0jv, part B of ugcportal-qnq9.1),
  // and ONLY the label — `{ select: { label: true } }`, not a spread of the
  // owner entry above, so a future column added to THAT entry (say,
  // `marketValueOre`) does not reach this feed just because it reached the
  // owner's. Forbrukertilsynet's labelling rule (docs/ugc-research.md §3.2,
  // §5.7) requires this exact string to be visible to every viewer of a
  // labelled item; the rest of the disclosure — whether a benefit was
  // received at all, what kind, its market value, and which brand it came
  // from — is a compliance record about a commercial relationship, not a
  // fact this feed exists to publish, and is deliberately absent:
  // `benefitReceived`, `benefitKind`, `marketValueOre`, `benefitSourceId`
  // and the `benefitSource` relation (the brand's own name) are none of
  // them selected here, so none of them is ever read for an anonymous
  // caller, let alone serialised. See src/lib/gallery-items.ts#toGalleryItem
  // for the read-path re-check that only an exact PERMITTED label is ever
  // actually rendered from whatever this projects (the same "don't trust a
  // row was written through the validator" reasoning
  // src/lib/advertising-disclosure.ts's own `isPermittedAdvertisingLabel`
  // states), and src/app/api/public/media/route.test.ts for the leak test
  // proving the serialised feed carries nothing else from this relation.
  advertisingDisclosure: { select: { label: true } },
  // This item's commercial outbound links (ugcportal-qnq9.2.2 K4): `id`
  // (never rendered — a React/DOM key), `url` (the canonical https
  // destination), `network` and `networkOther` (what the anchor's own
  // visible text and the "marker text" are built from,
  // src/lib/commercial-link-render.ts). DELIBERATELY ABSENT:
  // `benefitSourceId` and the `benefitSource` relation it points at — the
  // brand's real name and its `alcoholLinked` answer are a compliance
  // record about a commercial relationship, the identical reasoning
  // `advertisingDisclosure` just above gives for withholding
  // `benefitSourceId`/`benefitSource` from that relation, not a fact this
  // feed exists to publish. `createdAt`/`updatedAt` are withheld too: this
  // feed already reports the ITEM's own `createdAt`, and a second,
  // per-link timestamp is not something any surface reads.
  //
  // `orderBy: { createdAt: "asc" }` so the links render in the order they
  // were attached — the same "stable order, not whatever the join happened
  // to return" reasoning `MEDIA_TAGS_SELECT`'s own `orderBy` gives, so two
  // requests for the same item do not render its links in different
  // positions.
  //
  // THE RENDER-TIME GATE IS NOT HERE, and cannot be: this select cannot see
  // its own sibling `advertisingDisclosure.label` to condition on. A
  // published item whose disclosure was withdrawn after a link was
  // attached (ugcportal-jain) still has this relation selected — the gate
  // is `toGalleryItem` (src/lib/gallery-items.ts#toGalleryCommercialLinks),
  // which computes `[]` whenever the re-validated label is `null`,
  // regardless of what this query returned. See
  // src/app/api/public/media/route.test.ts for the leak test over this
  // select's own shape, mirroring the disclosure's e0jv K2 test above.
  commercialLinks: {
    select: { id: true, url: true, network: true, networkOther: true },
    orderBy: { createdAt: "asc" },
  },
} as const satisfies Partial<typeof MEDIA_OWNER_SELECT>;

/**
 * A third select, and NOT a third audience — read this before widening it by
 * analogy with the two above.
 *
 * The two selects above answer "what may this audience SEE". This one answers
 * a different question: "what does the preview delivery route
 * (GET /api/media/preview/[previewId], ugcportal-a2l) have to READ in order to
 * serve bytes it will never describe". Nothing selected here is serialised to
 * anybody. That route's response is an image body plus a fixed, hand-written
 * set of headers; no column value reaches either.
 *
 * `previewKey` is in it precisely because it must not come out of it. It is
 * the storage path (`previews/{userId}/{uuid}.webp`), so it is simultaneously
 * the only way to locate the object and the exact string that would re-leak
 * the uploader's account id — the leak `previewId` exists to close. Resolving
 * it has to happen server-side, which is what this select is for.
 *
 * One column, deliberately. Reaching for MEDIA_OWNER_SELECT here would
 * compile and work, and would be wrong in a way that only surfaces later: it
 * reads `originalName` on behalf of anonymous callers, and it wires every
 * future owner-facing column into an anonymous code path — which is the exact
 * drift the two-select split above exists to prevent.
 *
 * The `satisfies Partial<typeof MEDIA_OWNER_SELECT>` is load-bearing rather
 * than decorative, and the mechanism is worth naming because the surrounding
 * file has been burned by a type constraint that did not constrain.
 * `Partial<T>` has no `key` member and no `userId` member, because neither is
 * in the owner select; excess-property checking then rejects this literal
 * outright if either is added. So the paid original (ugcportal-5d6) and the
 * uploader's id are not merely "not selected today" — they cannot be added to
 * this list without a compile error. What it does NOT do is stop a caller
 * passing some other ad-hoc object to the same query; that is why the route
 * imports this constant rather than spelling a select inline.
 */
export const MEDIA_PREVIEW_DELIVERY_SELECT = {
  previewKey: true,
} as const satisfies Partial<typeof MEDIA_OWNER_SELECT>;

/**
 * The COLUMNS a select names, as opposed to the relation it also names.
 *
 * `Pick<MediaModel, keyof S>` was enough while every key was a scalar. It
 * stopped compiling the moment `tags` arrived, because `MediaModel` is the
 * default selection of the Media payload and carries no relation fields —
 * `Pick` over a key that is not in the model is an error, not an omission.
 *
 * `Extract` is what narrows to the keys the model actually has. It is a real
 * weakening and worth naming: a MISSPELLED column would also be extracted
 * away, leaving a type that silently lacks the field its author thought they
 * had added. That is why both selects carry
 * `satisfies Partial<Record<MediaProjectionKey, unknown>>` (directly, or via
 * `Partial<typeof MEDIA_OWNER_SELECT>`) — the typo is rejected there, so by
 * the time it reaches here there is nothing left to drop but a relation:
 * `tags`, and now `advertisingDisclosure`.
 */
type SelectedScalars<TSelect> = Pick<
  MediaModel,
  Extract<keyof TSelect, keyof MediaModel>
>;

/**
 * Tied to the selects by construction: widen one and its type widens with it,
 * so toOwnerMedia below stops compiling until it is updated too. That is the
 * point — they can't silently disagree.
 *
 * Both audiences get `tags`, because both selects ask for it; see
 * MEDIA_TAGS_SELECT for why that is one decision rather than two.
 */
export type OwnerMedia = SelectedScalars<typeof MEDIA_OWNER_SELECT> & {
  tags: MediaTagLabel[];
};
/**
 * `advertisingDisclosure` is added HERE and not on `OwnerMedia` above, even
 * though `MEDIA_OWNER_SELECT` now carries the same relation. Not an
 * oversight: `OwnerMedia` is the return type of `toOwnerMedia` below, which
 * builds its result field-by-field from `OwnedMediaRow` (the ownership
 * gate's own full-row read, `include: { tags }`, not `MEDIA_OWNER_SELECT`)
 * — adding a required field here would demand `toOwnerMedia` supply it from
 * a row that never carries it, for a type nothing in the codebase
 * currently consumes (`OwnerMedia` has no reader of `advertisingDisclosure`
 * to be honest for). `AnonymousMedia` is different: `toGalleryItem`
 * (src/lib/gallery-items.ts) is a REAL reader of a row shaped like this one,
 * and leaving the relation off this type while the select actually returns
 * it is exactly the "type lie" src/lib/media-listing.ts's own
 * `TagProjection` comment warns about for the identical reason `tags` was.
 */
export type AnonymousMedia = SelectedScalars<typeof MEDIA_ANONYMOUS_SELECT> & {
  tags: MediaTagLabel[];
  advertisingDisclosure: { label: string | null } | null;
  /**
   * The commercial-link relation exactly as MEDIA_ANONYMOUS_SELECT's own
   * `commercialLinks` entry projects it (ugcportal-qnq9.2.2) — present here
   * for the same "no type lie" reason `advertisingDisclosure` is: this
   * select really does return it, so a type that omitted it would be
   * honest about neither.
   */
  commercialLinks: {
    id: string;
    url: string;
    network: string;
    networkOther: string | null;
  }[];
};

/**
 * A whole Media row as the ownership gate reads it: every column, plus the
 * tags.
 *
 * The gate loads the relation because both of its echoing callers need it —
 * PATCH and publish project the row they were handed through `toOwnerMedia`
 * rather than paying for a second query — and because a gate that returned
 * "the row" while quietly meaning "the row minus one field" is the kind of
 * half-truth that only surfaces as an `undefined` in a response body.
 */
export type OwnedMediaRow = MediaModel & { tags: MediaTagLabel[] };

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
export function toOwnerMedia(media: OwnedMediaRow): OwnerMedia {
  return {
    id: media.id,
    kind: media.kind,
    previewKey: media.previewKey,
    previewId: media.previewId,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    originalName: media.originalName,
    altText: media.altText,
    caption: media.caption,
    createdAt: media.createdAt,
    publishedAt: media.publishedAt,
    // Copied rather than aliased, so a caller spreading a change over the
    // gate's row cannot hand the same array to two responses and have one
    // mutate the other's. Cheap: six entries at most.
    tags: media.tags.map((tag) => ({ slug: tag.slug, name: tag.name })),
  };
}

export type MediaAccessResult =
  | { ok: true; userId: string; media: OwnedMediaRow }
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

  // `include` rather than a bare findUnique: the tags come back alongside
  // every column, which is what `OwnedMediaRow` promises and what lets PATCH
  // and publish echo the row they already hold instead of re-reading it.
  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    include: { tags: MEDIA_TAGS_SELECT },
  });
  if (!media) {
    return { ok: false, status: 404, error: "Not found" };
  }

  if (media.userId !== userId) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true, userId, media };
}
