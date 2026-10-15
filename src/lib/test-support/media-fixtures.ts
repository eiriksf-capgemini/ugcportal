import { MediaAuthorship } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import type { prisma as PrismaSingleton } from "@/lib/prisma";

/**
 * Test-only helper — asserted, not asserted-in-prose: "nothing in the
 * application imports test-support" in src/lib/attestation-write-paths.test.ts
 * walks `src` and fails on any non-test file outside this directory that
 * imports from it. One Media row,
 * shaped the way the public feed and the portfolio selection both need it —
 * previewKey/previewId present (or deliberately withheld), altText,
 * optional caption, optional tags by slug.
 *
 * ONE COPY, used by src/lib/portfolio.test.ts and
 * src/app/portfolio/page.test.tsx (round-1 review: each of those files used
 * to carry its own near-identical `seedMedia`, which is exactly the
 * "sibling-omission" shape review-standards' family 4 names — a fixture
 * shared by two test files that can quietly drift apart about what a
 * published, tagged, previewed row looks like). `import type` only for the
 * Prisma client, so this module cannot initialise one against the wrong
 * `DATABASE_URL` before a test's `createTemporaryDatabase()` has set one.
 * Its two runtime imports (`@/generated/prisma/enums` and
 * `@/lib/attestation`, both added by ugcportal-3ae) hold that invariant: the
 * generated enums file is plain string constants with no imports of its own,
 * and `src/lib/attestation.ts` is documented and asserted as
 * dependency-free, so neither reaches the Prisma client.
 */
export type SeedMediaOptions = {
  id: string;
  userId: string;
  createdAt: Date;
  kind?: "IMAGE" | "VIDEO";
  tags?: string[];
  published?: boolean;
  withPreview?: boolean;
  caption?: string;
  altText?: string;
  /**
   * Write the uploader's rights attestation alongside the row
   * (ugcportal-3ae). DEFAULTS TO TRUE, because from that bead on a row with
   * no attestation is not on any anonymous surface (`PUBLIC_MEDIA_SCOPE`)
   * unless its uploader is a configured user (ugcportal-ho7j), so for the
   * ordinary uploader a fixture without one is not
   * "an ordinary published photograph" — it is the fail-closed case, and
   * every test here that is about something else would be exercising this
   * instead.
   *
   * `false` is how a test asks for the pre-ugcportal-3ae row deliberately:
   * published, visible before, and refused now — provided the caller's
   * user row has no `configuredHandle` (this module does not create users).
   */
  attested?: boolean;
  /**
   * The uploader's own answer to "it shows identifiable people"
   * (`MediaAttestation.showsIdentifiablePeople`). Defaults to `false` — a
   * photograph with nobody in it, which is what the gallery, portfolio and
   * sitemap fixtures elsewhere are about. A `true` here needs a cleared
   * PEOPLE layer before the row is public; see
   * src/lib/publishability.scope-agreement.test.ts, which seeds one.
   */
  showsIdentifiablePeople?: boolean;
};

export async function seedMedia(
  client: Pick<typeof PrismaSingleton, "media" | "mediaAttestation">,
  {
    id,
    userId,
    createdAt,
    kind = "IMAGE",
    tags = [],
    published = true,
    withPreview = true,
    caption,
    altText,
    attested = true,
    showsIdentifiablePeople = false,
  }: SeedMediaOptions,
): Promise<void> {
  await client.media.create({
    data: {
      id,
      userId,
      kind,
      key: `media/${userId}/${id}-original.jpg`,
      previewKey: withPreview ? `previews/${userId}/${id}.webp` : null,
      previewId: withPreview ? `pv-${id}` : null,
      mimeType: kind === "VIDEO" ? "video/mp4" : "image/jpeg",
      sizeBytes: 4096,
      originalName: `${id}.jpg`,
      altText: altText ?? `Alt text for ${id}`,
      caption,
      createdAt,
      publishedAt: published ? new Date("2026-03-04T10:00:00.000Z") : null,
      tags: { connect: tags.map((slug) => ({ slug })) },
    },
  });

  if (!attested) return;

  /*
    THE ONE ATTESTATION WRITE OUTSIDE POST /api/media, and it is allowlisted
    BY NAME in src/lib/attestation-write-paths.test.ts rather than written in
    a shape that scan cannot see (ugcportal-3ae). The allowance is narrow on
    purpose: this module is test-only by construction, and the same file now
    also asserts that no application file imports anything under
    `@/lib/test-support/`, so it cannot become a second way a real upload
    acquires a declaration its uploader never gave.

    A SEPARATE STATEMENT rather than a nested `attestation: { create: … }`
    inside the `media.create` above, and the reason is the scan rather than
    style: the only way to make that nested form conditional on `attested` is
    a ternary in the property's initialiser, and the scanner's nested matcher
    requires an object literal there — so the conditional version would have
    slipped past the guard entirely instead of being allowlisted in the open.
    That matcher gap is real and is ugcportal-xqal; this file does not rely on
    it.

    Writing it here rather than in each test file is the point. Seven test
    files import `seedMedia` from this module to seed published media — not
    nine: a bare count here would be a figure nobody could check without
    retyping it, so re-derive it instead of trusting it. List every test
    file under `src` whose own `import` or dynamic `import()` names this
    module, the way `importSpecifiersIn` in
    src/lib/attestation-write-paths.test.ts resolves specifiers, rather than
    grepping the path as a bare string — a plain grep for the path
    overcounts, catching a comment in route.test.ts that only mentions this
    file and the path string literals inside
    attestation-write-paths.test.ts's own scanner fixtures, neither of which
    imports or calls `seedMedia`. The other seeders in this tree (that
    file's `row()`, for one) build the row themselves rather than going
    through here. All seven of the real importers need a declaration now
    that the public scope requires one; seven copies of these eleven columns
    is precisely the sibling-omission shape this file's own header says it
    exists to prevent.
  */
  await client.mediaAttestation.create({
    data: {
      mediaId: id,
      // The uploader's own declaration, by the uploader. A fixture that
      // attributed it to anybody else would be refused by the publish gate
      // as `attestation_not_by_uploader`, which is a state this helper has
      // no business producing by default.
      attestedByUserId: userId,
      attestationVersion: CURRENT_ATTESTATION_VERSION,
      authorship: MediaAuthorship.AUTHOR,
      ownOriginalNotFromWeb: true,
      showsIdentifiablePeople,
      showsMinors: false,
      containsMusicNotOwned: false,
      otherCreativeContributor: false,
      brandOrSponsorship: false,
      aiGenerated: false,
      uploaderIsAdult: true,
    },
  });
}

/**
 * An admin triage whose only load-bearing answer is "this picture shows no
 * alcohol" (ugcportal-pgpq).
 *
 * WHY ANY FIXTURE NEEDS THIS. Since that bead, `PUBLIC_MEDIA_SCOPE` carries
 * alkoholloven § 9-2's commercial pair: an item that declares a benefit or
 * carries a commercial link is served only while `MediaListing.depictsAlcohol`
 * is a recorded `false` (and, since ugcportal-qnq9.11, an item recorded
 * `true` is served on no surface at all). A fixture that attaches a label or a link to a row
 * with no listing is therefore no longer "an ordinary published advertisement"
 * — it is the fail-closed case, and a test about something else (a leak, a
 * rendered marker, a projection) would be exercising this instead and would
 * simply find no item.
 *
 * ONE COPY, for the same reason `seedMedia` above is one copy: 6 call sites
 * across three test files (src/app/page.test.tsx ×2,
 * src/lib/media-item.test.ts ×2, src/app/media/[previewId]/page.test.tsx
 * ×2) need the identical answer beside their labelled disclosure, and 6
 * copies of it is the sibling-omission shape this module exists to
 * prevent. The other triage answers are filled in so this is a completed
 * triage rather than a half-answered row a later reader has to interpret;
 * only `depictsAlcohol` is read by the scope.
 */
export async function seedAlcoholAnsweredListing(
  client: Pick<typeof PrismaSingleton, "mediaListing">,
  mediaId: string,
): Promise<void> {
  await client.mediaListing.create({
    data: {
      mediaId,
      depictsPeople: false,
      depictsMinors: false,
      containsMusic: false,
      thirdPartyCreator: false,
      sponsoredContent: false,
      depictsAlcohol: false,
      wineAccessory: true,
    },
  });
}
