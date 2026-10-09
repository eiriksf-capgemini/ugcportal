import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedMedia } from "@/lib/test-support/media-fixtures";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { siteOrigin } from "@/lib/origin";
import { PURCHASE_OFFER_ID } from "@/components/media/purchase-offer";
import { CURRENT_CHECKLIST_VERSION } from "@/lib/resale-rights";
import { LICENCE_PATH, mediaItemPath, mediaPreviewPath } from "@/lib/routes";

/**
 * /media/[previewId] (ugcportal-qnq9.12, K1/K2), against a real database.
 *
 * `next/navigation` is mocked so `notFound()` throws a recognisable error
 * instead of doing nothing — same precedent as
 * src/app/admin/settings/rights/page.test.tsx: a stand-in that returned
 * would let the page keep rendering for a row this route must refuse.
 *
 * `@/lib/auth` is mocked for the same reason src/lib/portfolio.test.ts and
 * src/lib/media-item.test.ts mock it: this page never calls `auth()` itself
 * (PUBLIC_MEDIA_SCOPE is anonymous by construction), but importing
 * MEDIA_ANONYMOUS_SELECT pulls in @/lib/auth's module graph regardless.
 */
const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the item page must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const {
  default: MediaItemPage,
  generateMetadata,
} = await import("@/app/media/[previewId]/page");

const UPLOADER = "uploader-qnq9-12-page";

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  notFoundMock.mockClear();
  await prisma.media.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({
    data: { id: UPLOADER, email: "uploader-qnq9-12-page@example.com", role: "USER" },
  });
});

function params(previewId: string) {
  return { params: Promise.resolve({ previewId }) };
}

describe("K1: a published item's page", () => {
  beforeEach(async () => {
    await seedMedia(prisma, {
      id: "page-item-ok",
      userId: UPLOADER,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      altText: "A bowl of mushroom risotto on a wooden table",
      caption: "Simple mushroom risotto for weeknights.",
    });
  });

  it("renders (200) with a descriptive title and the body text, and does not call notFound", async () => {
    const element = await MediaItemPage(params("pv-page-item-ok"));
    const html = renderToStaticMarkup(element);

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(html).toContain("A bowl of mushroom risotto on a wooden table");
    expect(html).toContain("Simple mushroom risotto for weeknights.");
  });

  it("generateMetadata returns a title and description built from alt text/caption", async () => {
    const metadata = await generateMetadata(params("pv-page-item-ok"));
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(metadata.title).toBe("A bowl of mushroom risotto on a wooden table");
    expect(metadata.description).toBe("Simple mushroom risotto for weeknights.");
  });

  // K1's second clause: never titled with the filename or a bare index.
  // seedMedia's originalName is "page-item-ok.jpg" — this asserts the title
  // is not that, and is not the filename ugcportal-gwr otherwise withholds
  // from anonymous callers in the first place (MEDIA_ANONYMOUS_SELECT has no
  // originalName at all).
  it("does not title the page with originalName or a bare index", async () => {
    const metadata = await generateMetadata(params("pv-page-item-ok"));
    expect(metadata.title).not.toBe("page-item-ok.jpg");
    expect(metadata.title).not.toMatch(/^\d+$/);
  });

  /**
   * Review round 1, finding 1 (MEDIUM, CONFIRMED): `siteOrigin()` now
   * returns `null` in production when AUTH_URL is unset or malformed, rather
   * than falling back to `http://localhost:3000`. This page's own job is to
   * OMIT `alternates.canonical` rather than assert a loopback address is
   * this item's permanent URL — see `generateMetadata`'s own comment.
   */
  it("omits alternates.canonical in production when AUTH_URL is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "");
    try {
      const metadata = await generateMetadata(params("pv-page-item-ok"));
      expect(metadata.alternates).toBeUndefined();
      // Title/description are unaffected: they describe the item, not its
      // own URL.
      expect(metadata.title).toBe("A bowl of mushroom risotto on a wooden table");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still includes alternates.canonical outside production, via the localhost fallback", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_URL", "");
    try {
      const metadata = await generateMetadata(params("pv-page-item-ok"));
      expect(metadata.alternates?.canonical).toBe(
        "http://localhost:3000/media/pv-page-item-ok",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * K1 (ugcportal-lju): og:title, og:description, og:image, og:url and
   * twitter:card, with og:title/og:description derived from the item's own
   * alt text/caption. Compared against `siteOrigin()`/`mediaItemPath`/
   * `mediaPreviewPath` themselves, not a hardcoded "http://localhost:3000"
   * literal, so a future change to any of those three still gets the right
   * expectation rather than a test that silently stopped checking anything.
   */
  it("carries og:title, og:description, og:url, og:image and twitter:card built from the item", async () => {
    const origin = siteOrigin();
    expect(origin).not.toBeNull();
    const previewId = "pv-page-item-ok";

    const metadata = await generateMetadata(params(previewId));

    const expectedUrl = `${origin}${mediaItemPath(previewId)}`;
    const expectedImage = `${origin}${mediaPreviewPath(previewId)}`;

    expect(metadata.openGraph?.title).toBe(
      "A bowl of mushroom risotto on a wooden table",
    );
    expect(metadata.openGraph?.description).toBe(
      "Simple mushroom risotto for weeknights.",
    );
    expect(metadata.openGraph?.url).toBe(expectedUrl);
    expect(metadata.openGraph?.images).toEqual([expectedImage]);
    // `openGraph`/`twitter` are each a discriminated union keyed on
    // `type`/`card`, declared in next's own vendored (node_modules, not a
    // file this repo tracks) opengraph-types.d.ts/twitter-types.d.ts,
    // with one bare, discriminant-less member in the union (a caller that set
    // neither) — so TS refuses a bare `.type`/`.card` read on the union as a
    // whole without first narrowing to a member that actually declares it.
    // This repo's own code never constructs that bare member (the `return`
    // above always sets `type`/`card` or omits the block entirely), so the
    // narrowing here is a type-level technicality, not a live branch.
    expect((metadata.openGraph as { type?: string } | undefined)?.type).toBe(
      "website",
    );

    expect(
      (metadata.twitter as { card?: string } | undefined)?.card,
    ).toBe("summary_large_image");
    expect(metadata.twitter?.title).toBe(
      "A bowl of mushroom risotto on a wooden table",
    );
    expect(metadata.twitter?.description).toBe(
      "Simple mushroom risotto for weeknights.",
    );
    expect(metadata.twitter?.images).toEqual([expectedImage]);
  });

  /**
   * The mutation K1 itself asks for: a second row with a DIFFERENT caption,
   * asserting og:description/twitter:description follow it. Without this,
   * the test above could pass against a version of `generateMetadata` that
   * hardcoded the first row's caption string instead of reading
   * `item.caption` at all.
   */
  it("og:description and twitter:description follow the caption, not a fixed string", async () => {
    await seedMedia(prisma, {
      id: "page-item-og-mutation",
      userId: UPLOADER,
      createdAt: new Date("2026-03-01T01:00:00.000Z"),
      altText: "A plate of pan-fried dumplings",
      caption: "Dumplings, pan-fried until the bottoms crisp.",
    });

    const metadata = await generateMetadata(params("pv-page-item-og-mutation"));

    expect(metadata.openGraph?.description).toBe(
      "Dumplings, pan-fried until the bottoms crisp.",
    );
    expect(metadata.openGraph?.description).not.toBe(
      "Simple mushroom risotto for weeknights.",
    );
    expect(metadata.twitter?.description).toBe(
      "Dumplings, pan-fried until the bottoms crisp.",
    );
  });

  /**
   * Same reasoning as "omits alternates.canonical in production when
   * AUTH_URL is unset" above: `openGraph`/`twitter` both require an absolute
   * URL, and this page refuses to guess one. See generateMetadata's own
   * comment for why the whole block is omitted rather than built around a
   * localhost placeholder.
   */
  it("omits openGraph and twitter metadata in production when AUTH_URL is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "");
    try {
      const metadata = await generateMetadata(params("pv-page-item-ok"));
      expect(metadata.openGraph).toBeUndefined();
      expect(metadata.twitter).toBeUndefined();
      expect(metadata.title).toBe("A bowl of mushroom risotto on a wooden table");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// K3 (ugcportal-lju): none of the tags this bead adds may leak Media.key,
// previewKey or the uploader's id, and every media URL the head carries must
// equal `mediaPreviewPath(previewId)` — compared against that function
// itself, not a literal, so a change to the path shape still gets caught.
describe("K3 (ugcportal-lju): og/twitter tags never leak Media.key, previewKey, or userId", () => {
  const previewId = "pv-page-item-k3";

  beforeEach(async () => {
    await seedMedia(prisma, {
      id: "page-item-k3",
      userId: UPLOADER,
      createdAt: new Date("2026-03-06T00:00:00.000Z"),
    });
  });

  it("every image URL equals mediaPreviewPath(previewId), and no tag value contains the key, previewKey, or uploader id", async () => {
    const metadata = await generateMetadata(params(previewId));
    const origin = siteOrigin();
    expect(origin).not.toBeNull();

    const expectedImage = `${origin}${mediaPreviewPath(previewId)}`;
    expect(metadata.openGraph?.images).toEqual([expectedImage]);
    expect(metadata.twitter?.images).toEqual([expectedImage]);

    // Media.key, previewKey (src/lib/test-support/media-fixtures.ts builds
    // both from the uploader id — "media/{userId}/..." /
    // "previews/{userId}/...") and the bare uploader id itself must appear
    // NOWHERE in the serialised metadata object.
    const serialised = JSON.stringify(metadata);
    expect(serialised).not.toContain(`media/${UPLOADER}/`);
    expect(serialised).not.toContain(`previews/${UPLOADER}/`);
    expect(serialised).not.toContain(UPLOADER);
  });

  /**
   * The mutation this K3 test needs: a fixture that embeds the uploader id
   * somewhere `generateMetadata` does NOT currently read (previewKey/key are
   * never selected — see MEDIA_ANONYMOUS_SELECT) would otherwise let the
   * assertions above pass vacuously against an empty string. Asserting the
   * uploader id string genuinely appears in the fixture's own previewKey
   * closes that gap: if `media-fixtures.ts` ever stopped encoding the
   * uploader id into previewKey, this would fail and say so.
   */
  it("the fixture's own previewKey really does encode the uploader id (sanity check for the assertion above)", async () => {
    const row = await prisma.media.findUniqueOrThrow({
      where: { id: "page-item-k3" },
      select: { previewKey: true },
    });
    expect(row.previewKey).toContain(UPLOADER);
  });
});

describe("K2: a never-published item", () => {
  it("calls notFound() and never reaches the DOM", async () => {
    await seedMedia(prisma, {
      id: "page-item-unpublished",
      userId: UPLOADER,
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
      published: false,
    });

    await expect(
      MediaItemPage(params("pv-page-item-unpublished")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("generateMetadata also calls notFound()", async () => {
    await seedMedia(prisma, {
      id: "page-item-unpublished-meta",
      userId: UPLOADER,
      createdAt: new Date("2026-03-02T01:00:00.000Z"),
      published: false,
    });

    await expect(
      generateMetadata(params("pv-page-item-unpublished-meta")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("K2: an item published and then unpublished again", () => {
  it("calls notFound()", async () => {
    await seedMedia(prisma, {
      id: "page-item-republished",
      userId: UPLOADER,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      published: true,
    });
    await prisma.media.update({
      where: { id: "page-item-republished" },
      data: { publishedAt: null },
    });

    await expect(
      MediaItemPage(params("pv-page-item-republished")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("K2: a deleted item", () => {
  it("calls notFound()", async () => {
    await seedMedia(prisma, {
      id: "page-item-deleted",
      userId: UPLOADER,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    await prisma.media.delete({ where: { id: "page-item-deleted" } });

    await expect(
      MediaItemPage(params("pv-page-item-deleted")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("K2: an unknown previewId", () => {
  it("calls notFound()", async () => {
    await expect(
      MediaItemPage(params("pv-does-not-exist")),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

// K5, at the render layer: nothing in the rendered markup may carry the
// unwatermarked original's key, the preview's storage path, or the
// uploader's account id.
describe("K5: the rendered page never leaks Media.key, previewKey, or userId", () => {
  it("renders only the mediaPreviewPath URL, never a raw storage key", async () => {
    await seedMedia(prisma, {
      id: "page-item-k5",
      userId: UPLOADER,
      createdAt: new Date("2026-03-05T00:00:00.000Z"),
    });

    const element = await MediaItemPage(params("pv-page-item-k5"));
    const html = renderToStaticMarkup(element);

    expect(html).not.toContain(`media/${UPLOADER}/`);
    expect(html).not.toContain(`previews/${UPLOADER}/`);
    expect(html).not.toContain(UPLOADER);
    expect(html).toContain("/api/media/preview/pv-page-item-k5");
  });
});

/**
 * The advertising-disclosure label (ugcportal-e0jv K1/K3/K4, part B of
 * ugcportal-qnq9.1), through the real page component and a real database —
 * same reasoning as every other describe block here.
 */
describe("the advertising-disclosure label (K1, K3, K4)", () => {
  it("K1: shows the exact canonical label, before the photograph, for a labelled item", async () => {
    await seedMedia(prisma, {
      id: "page-item-labelled",
      userId: UPLOADER,
      createdAt: new Date("2026-03-10T00:00:00.000Z"),
    });
    const source = await prisma.benefitSource.create({
      data: { slug: "page-item-brand", name: "Page Item Brand" },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId: "page-item-labelled",
        benefitReceived: true,
        benefitKind: "FREE_PRODUCT",
        benefitSourceId: source.id,
        label: "Advertisement / Reklame",
      },
    });

    const element = await MediaItemPage(params("pv-page-item-labelled"));
    const html = renderToStaticMarkup(element);

    expect(html).toContain('data-gallery-advertising-label="page-item-labelled"');
    expect(html).toContain("Advertisement / Reklame");
    expect(html.indexOf("data-gallery-advertising-label")).toBeLessThan(
      html.indexOf("<figure"),
    );
  });

  it("K4: never exposes benefitReceived or the brand's name/slug in the rendered markup", async () => {
    await seedMedia(prisma, {
      id: "page-item-labelled-leak",
      userId: UPLOADER,
      createdAt: new Date("2026-03-10T00:30:00.000Z"),
    });
    const source = await prisma.benefitSource.create({
      data: { slug: "leaky-brand", name: "Leaky Brand Name" },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId: "page-item-labelled-leak",
        benefitReceived: true,
        benefitKind: "PAYMENT",
        benefitSourceId: source.id,
        label: "Reklame",
      },
    });

    const element = await MediaItemPage(params("pv-page-item-labelled-leak"));
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Reklame");
    expect(html).not.toContain("benefitReceived");
    expect(html).not.toContain("Leaky Brand");
    expect(html).not.toContain("leaky-brand");
  });

  it("K3: shows no label for an item with benefitReceived false", async () => {
    await seedMedia(prisma, {
      id: "page-item-no-benefit",
      userId: UPLOADER,
      createdAt: new Date("2026-03-10T01:00:00.000Z"),
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: { mediaId: "page-item-no-benefit", benefitReceived: false },
    });

    const element = await MediaItemPage(params("pv-page-item-no-benefit"));
    const html = renderToStaticMarkup(element);

    expect(html).not.toContain("data-gallery-advertising-label");
  });

  it("K3: shows no label for an item with no disclosure row at all — the ordinary case", async () => {
    await seedMedia(prisma, {
      id: "page-item-no-disclosure",
      userId: UPLOADER,
      createdAt: new Date("2026-03-10T01:30:00.000Z"),
    });

    const element = await MediaItemPage(params("pv-page-item-no-disclosure"));
    const html = renderToStaticMarkup(element);

    expect(html).not.toContain("data-gallery-advertising-label");
  });
});

/**
 * ugcportal-yzo7 K4, at the surface that renders it: the item page shows a
 * price only while the gate still clears the item, and the clearance is
 * re-read on every render.
 *
 * Here rather than only in src/lib/sellable-media.test.ts because the two
 * claims are different. That file proves `getPublicOffer` returns null; this
 * proves the PAGE then draws nothing — a page that called the gate and
 * rendered the amount anyway would pass there and leak here.
 */
describe("ugcportal-yzo7 K4: the price block on the item page", () => {
  const ADMIN = "admin-yzo7-page";
  const PREVIEW_ID = "pv-page-item-priced";

  beforeEach(async () => {
    await prisma.user.create({
      data: { id: ADMIN, email: "admin-yzo7-page@example.com", role: "ADMIN" },
    });
    await seedMedia(prisma, {
      id: "page-item-priced",
      userId: UPLOADER,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      altText: "A bowl of mushroom risotto on a wooden table",
    });
    await prisma.mediaListing.create({
      data: {
        mediaId: "page-item-priced",
        priceCents: 125_000,
        currency: "NOK",
        depictsPeople: false,
        depictsMinors: false,
        containsMusic: false,
        thirdPartyCreator: false,
        sponsoredContent: false,
        depictsAlcohol: false,
        wineAccessory: false,
        triagedByUserId: ADMIN,
        triagedAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    });
    await prisma.resaleRightsReview.create({
      data: {
        uploaderUserId: UPLOADER,
        status: "CLEARED",
        checklistVersion: CURRENT_CHECKLIST_VERSION,
        reviewedByUserId: ADMIN,
        reviewedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    });
  });

  it("renders the price while the uploader's clearance holds", async () => {
    const html = renderToStaticMarkup(await MediaItemPage(params(PREVIEW_ID)));

    expect(html).toContain(`id="${PURCHASE_OFFER_ID}"`);
    expect(html).toContain("1,250.00");
    // The licence the price is under, not a per-item one that does not exist.
    expect(html).toContain(`href="${LICENCE_PATH}"`);
  });

  it("renders nothing at all once that clearance is revoked, and the price is still stored", async () => {
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: UPLOADER },
      data: { status: "REVOKED" },
    });

    const html = renderToStaticMarkup(await MediaItemPage(params(PREVIEW_ID)));

    // By id AND by the formatted amount: the id is the structural needle,
    // the amount is what would actually leak.
    expect(html).not.toContain(`id="${PURCHASE_OFFER_ID}"`);
    expect(html).not.toContain("1,250.00");
    // The page itself still renders — this withdraws an offer, not an item.
    expect(html).toContain("A bowl of mushroom risotto on a wooden table");
    await expect(
      prisma.mediaListing.findUniqueOrThrow({
        where: { mediaId: "page-item-priced" },
        select: { priceCents: true },
      }),
    ).resolves.toEqual({ priceCents: 125_000 });

    // THE RESTORE: the needle can come back, so its absence above was about
    // the status and not about the fixture.
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: UPLOADER },
      data: { status: "CLEARED" },
    });
    expect(
      renderToStaticMarkup(await MediaItemPage(params(PREVIEW_ID))),
    ).toContain(`id="${PURCHASE_OFFER_ID}"`);
  });

  it("renders no price for an item nobody has priced", async () => {
    await prisma.mediaListing.update({
      where: { mediaId: "page-item-priced" },
      data: { priceCents: null },
    });

    expect(
      renderToStaticMarkup(await MediaItemPage(params(PREVIEW_ID))),
    ).not.toContain(`id="${PURCHASE_OFFER_ID}"`);
  });

  it("keeps the price out of the page's own metadata", async () => {
    /*
     * An og:description quoting an amount would be cached by crawlers and
     * by every chat app that unfurls a link, long after the clearance behind
     * it lapsed — a price this site could not honour, served from somebody
     * else's cache, where no render-time gate can reach it.
     */
    const metadata = await generateMetadata(params(PREVIEW_ID));
    expect(JSON.stringify(metadata)).not.toContain("1,250.00");
    expect(JSON.stringify(metadata)).not.toContain("125000");
  });
});
