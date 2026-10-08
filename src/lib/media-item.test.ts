import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RightsLayer } from "@/generated/prisma/enums";
import { seedMedia } from "@/lib/test-support/media-fixtures";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The per-item page's own read (ugcportal-qnq9.12, K1/K2/K5), against a real
 * database — same reasoning as src/lib/portfolio.test.ts: the claim here is
 * about which row a query returns and what it withholds, which a mocked
 * Prisma client cannot prove.
 *
 * `@/lib/auth` is mocked for the same reason src/lib/portfolio.test.ts mocks
 * it: `@/lib/media-item` imports `MEDIA_ANONYMOUS_SELECT` from
 * `@/lib/media-access`, which imports `@/lib/auth` at module scope, and this
 * module never actually calls `auth()` itself — it is anonymous by
 * construction (PUBLIC_MEDIA_SCOPE requires it).
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("getPublicMediaItem must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const {
  getPublicMediaItem,
  mediaItemShortText,
  mediaItemTitle,
} = await import("@/lib/media-item");

const UPLOADER = "uploader-qnq9-12";

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  await prisma.media.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({
    data: { id: UPLOADER, email: "uploader-qnq9-12@example.com", role: "USER" },
  });
});

describe("getPublicMediaItem (K1)", () => {
  it("returns a published item by its previewId, with alt text and caption", async () => {
    await seedMedia(prisma, {
      id: "item-ok",
      userId: UPLOADER,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      altText: "A bowl of mushroom risotto on a wooden table",
      caption: "Simple mushroom risotto for weeknights.",
    });

    const item = await getPublicMediaItem("pv-item-ok");
    expect(item).not.toBeNull();
    expect(item?.id).toBe("item-ok");
    expect(item?.altText).toBe("A bowl of mushroom risotto on a wooden table");
    expect(item?.caption).toBe("Simple mushroom risotto for weeknights.");
  });

  // K5: never the unwatermarked original, never the storage path, never the
  // uploader's id. MEDIA_ANONYMOUS_SELECT never selects previewKey/key/
  // userId in the first place, so this also stands as a check on the
  // SELECT this module is built from, not just on the mapped output.
  it("never exposes Media.key, previewKey, or userId (K5)", async () => {
    await seedMedia(prisma, {
      id: "item-leak-check",
      userId: UPLOADER,
      createdAt: new Date("2026-03-01T00:30:00.000Z"),
    });

    const item = await getPublicMediaItem("pv-item-leak-check");
    expect(item).not.toBeNull();
    expect(item).not.toHaveProperty("key");
    expect(item).not.toHaveProperty("previewKey");
    expect(item).not.toHaveProperty("userId");
    expect(item).not.toHaveProperty("originalName");
  });

  it("returns null for a previewId that does not exist", async () => {
    const item = await getPublicMediaItem("pv-no-such-item");
    expect(item).toBeNull();
  });

  it("returns null for a blank previewId without querying the database", async () => {
    const item = await getPublicMediaItem("   ");
    expect(item).toBeNull();
  });

  // K2: never published, unpublished-again, or deleted — all absent.
  it("returns null for a never-published item", async () => {
    await seedMedia(prisma, {
      id: "item-unpublished",
      userId: UPLOADER,
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
      published: false,
    });

    const item = await getPublicMediaItem("pv-item-unpublished");
    expect(item).toBeNull();
  });

  it("returns null for an item that was published and then unpublished", async () => {
    await seedMedia(prisma, {
      id: "item-republished",
      userId: UPLOADER,
      createdAt: new Date("2026-03-03T00:00:00.000Z"),
      published: true,
    });
    await prisma.media.update({
      where: { id: "item-republished" },
      data: { publishedAt: null },
    });

    const item = await getPublicMediaItem("pv-item-republished");
    expect(item).toBeNull();
  });

  it("returns null for a deleted item", async () => {
    await seedMedia(prisma, {
      id: "item-deleted",
      userId: UPLOADER,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    await prisma.media.delete({ where: { id: "item-deleted" } });

    const item = await getPublicMediaItem("pv-item-deleted");
    expect(item).toBeNull();
  });

  it("returns null for a published item with no preview (never watermarked)", async () => {
    await seedMedia(prisma, {
      id: "item-no-preview",
      userId: UPLOADER,
      createdAt: new Date("2026-03-05T00:00:00.000Z"),
      withPreview: false,
    });

    const item = await getPublicMediaItem("pv-item-no-preview");
    expect(item).toBeNull();
  });
});

describe("mediaItemTitle / mediaItemShortText (K1)", () => {
  it("titles the page from the item's own alt text, never a filename or bare index", async () => {
    await seedMedia(prisma, {
      id: "item-title",
      userId: UPLOADER,
      createdAt: new Date("2026-03-06T00:00:00.000Z"),
      altText: "Open hardback books stacked beside a reading lamp",
    });

    const item = await getPublicMediaItem("pv-item-title");
    expect(item).not.toBeNull();
    const title = mediaItemTitle(item!);
    expect(title).toBe("Open hardback books stacked beside a reading lamp");
    expect(title).not.toBe("item-title.jpg");
    expect(title).not.toMatch(/^\d+$/);
  });

  it("uses the caption as the short text when one is present", async () => {
    await seedMedia(prisma, {
      id: "item-caption",
      userId: UPLOADER,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      altText: "A cold brew coffee maker on a counter",
      caption: "Our go-to cold brew setup for slow weekend mornings.",
    });

    const item = await getPublicMediaItem("pv-item-caption");
    expect(mediaItemShortText(item!)).toBe(
      "Our go-to cold brew setup for slow weekend mornings.",
    );
  });

  it("falls back to the title text when there is no caption", async () => {
    await seedMedia(prisma, {
      id: "item-no-caption",
      userId: UPLOADER,
      createdAt: new Date("2026-03-08T00:00:00.000Z"),
      altText: "A laptop open on a kitchen table",
      caption: undefined,
    });

    const item = await getPublicMediaItem("pv-item-no-caption");
    expect(mediaItemShortText(item!)).toBe(mediaItemTitle(item!));
    expect(mediaItemShortText(item!)).toBe("A laptop open on a kitchen table");
  });
});

/**
 * The advertising-disclosure label (ugcportal-e0jv, part B of
 * ugcportal-qnq9.1), through a REAL database — same reasoning as every
 * other describe block in this file: the claim is about which columns a
 * real query returns and withholds, which a mocked Prisma client cannot
 * prove. `benefitSource` and `mediaAdvertisingDisclosure` are written
 * directly rather than through PUT /api/media/[id]/disclosure (that route's
 * own write-path invariants are src/app/api/media/[id]/disclosure/
 * route.test.ts's job) — this file only needs a row shaped the way that
 * route would have left it.
 */
describe("the advertising-disclosure label (K1, K2, K3)", () => {
  it("K1: surfaces the exact canonical label for a published, labelled item", async () => {
    await seedMedia(prisma, {
      id: "item-labelled",
      userId: UPLOADER,
      createdAt: new Date("2026-03-09T00:00:00.000Z"),
    });
    const source = await prisma.benefitSource.create({
      data: { slug: "acme-cameras", name: "Acme Cameras" },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId: "item-labelled",
        benefitReceived: true,
        benefitKind: "FREE_PRODUCT",
        benefitSourceId: source.id,
        marketValueOre: 250000,
        label: "Advertisement / Reklame",
      },
    });

    const item = await getPublicMediaItem("pv-item-labelled");
    expect(item).not.toBeNull();
    expect(item?.advertisingLabel).toBe("Advertisement / Reklame");
  });

  it("K2: never exposes benefitReceived, the benefit kind, the market value, or the brand's name/slug", async () => {
    await seedMedia(prisma, {
      id: "item-leak-disclosure",
      userId: UPLOADER,
      createdAt: new Date("2026-03-09T00:30:00.000Z"),
    });
    const source = await prisma.benefitSource.create({
      data: { slug: "secret-brand", name: "Secret Brand Ltd" },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId: "item-leak-disclosure",
        benefitReceived: true,
        benefitKind: "PAYMENT",
        benefitSourceId: source.id,
        marketValueOre: 999900,
        label: "Reklame",
      },
    });

    const item = await getPublicMediaItem("pv-item-leak-disclosure");
    expect(item).not.toBeNull();
    expect(item?.advertisingLabel).toBe("Reklame");
    // NOT `expect(item).not.toHaveProperty("benefitReceived")` and siblings —
    // a pre-review mutation check found those cannot fail: Prisma nests a
    // relation under its own key, so a flat, TOP-LEVEL `benefitReceived`
    // could never appear on `item` regardless of what the query selects or
    // how badly a future edit mismapped it. `GalleryItem` has no
    // `advertisingDisclosure` property at all to check a nested leak
    // location on either — `toGalleryItem` replaces the whole relation with
    // the single flat `advertisingLabel` field. The exhaustive key-list
    // assertion in src/lib/gallery-items.test.ts ("carries no field the
    // anonymous projection withholds") is what actually pins the mapped
    // shape; the `JSON.stringify` scan below is what is left to check HERE,
    // and mutation-tested real: widening MEDIA_ANONYMOUS_SELECT's
    // `advertisingDisclosure` AND bypassing `toGalleryItem`'s own narrowing
    // (spreading the raw row onto the result) together made it fail on
    // "Secret Brand Ltd"; neither mutation alone did, which is exactly what
    // "the query is narrow, and the mapping is independently narrow" means.
    const serialised = JSON.stringify(item);
    expect(serialised).not.toContain("Secret Brand");
    expect(serialised).not.toContain("secret-brand");
    expect(serialised).not.toContain("999900");
    expect(serialised).not.toContain("PAYMENT");
  });

  it("K3: is null when benefitReceived is false, even though a disclosure row exists", async () => {
    await seedMedia(prisma, {
      id: "item-no-benefit",
      userId: UPLOADER,
      createdAt: new Date("2026-03-09T01:00:00.000Z"),
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: { mediaId: "item-no-benefit", benefitReceived: false },
    });

    const item = await getPublicMediaItem("pv-item-no-benefit");
    expect(item).not.toBeNull();
    expect(item?.advertisingLabel).toBeNull();
  });

  it("K3: is null when there is no disclosure row at all — the ordinary case", async () => {
    await seedMedia(prisma, {
      id: "item-no-disclosure-row",
      userId: UPLOADER,
      createdAt: new Date("2026-03-09T01:30:00.000Z"),
    });

    const item = await getPublicMediaItem("pv-item-no-disclosure-row");
    expect(item).not.toBeNull();
    expect(item?.advertisingLabel).toBeNull();
  });
});

/**
 * K5, at the query layer specifically — not only at the mapped output.
 *
 * Pre-review mutation check (swap `select: MEDIA_ANONYMOUS_SELECT` for
 * `MEDIA_OWNER_SELECT` in src/lib/media-item.ts) found that the "never
 * exposes Media.key/previewKey/userId" test above did NOT fail: it passed
 * unchanged, because `toGalleryItem` only ever copies the handful of fields
 * `GalleryItem` declares, whatever columns the underlying row happens to
 * carry. That test genuinely holds today, but it is testing `toGalleryItem`
 * (already proven elsewhere), not this module's own choice of select — a
 * test that cannot fail for the risk it names, per `review-standards`
 * family 3. This source check is the one that actually catches that swap:
 * it reads the committed file and asserts the literal select this function
 * queries with, so a future edit that widens it (even one that still
 * happens to map down to the same safe output today) is caught here rather
 * than resting on `toGalleryItem` never changing either.
 */
describe("src/lib/media-item.ts source (K5)", () => {
  it("queries with MEDIA_ANONYMOUS_SELECT and never imports MEDIA_OWNER_SELECT", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { stripComments } = await import("@/lib/design/scan-source");
    const path = fileURLToPath(new URL("./media-item.ts", import.meta.url));
    const live = stripComments(readFileSync(path, "utf8"), path);

    expect(live).toMatch(/select:\s*MEDIA_ANONYMOUS_SELECT\s*,/);
    expect(live).not.toContain("MEDIA_OWNER_SELECT");
  });
});

describe("/media/[previewId] inherits the rights filter (ugcportal-3ae K3)", () => {
  it("answers null for a published row whose uploader never declared anything", async () => {
    await seedMedia(prisma, {
      id: "item-declared",
      userId: UPLOADER,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    await seedMedia(prisma, {
      id: "item-undeclared",
      userId: UPLOADER,
      createdAt: new Date("2026-03-02T00:00:00.000Z"),
      attested: false,
    });

    // The sibling resolves, so `null` below is the filter rather than a
    // lookup that cannot find anything by handle at all.
    expect(await getPublicMediaItem("pv-item-declared")).not.toBeNull();
    expect(await getPublicMediaItem("pv-item-undeclared")).toBeNull();
  });

  it("answers null for one showing an identifiable person, and the item once the PEOPLE layer is cleared", async () => {
    await prisma.user.create({
      data: {
        id: "admin-item-3ae",
        email: "admin-item-3ae@example.com",
        role: "ADMIN",
      },
    });
    // Two rows rather than one queried twice: `getPublicMediaItem` is
    // `cache()`d, so re-asking about the same handle in one test would be
    // asking the cache rather than the database.
    for (const id of ["item-people", "item-people-cleared"]) {
      await seedMedia(prisma, {
        id,
        userId: UPLOADER,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        showsIdentifiablePeople: true,
      });
    }
    // Seeded directly rather than through the admin screen ugcportal-qfy9
    // shipped in `ba9991f`: this file is about what the item page serves,
    // so the clearance is a precondition to arrange. The clearance is the
    // ONLY difference between the two rows.
    await prisma.mediaListing.create({
      data: {
        mediaId: "item-people-cleared",
        depictsPeople: true,
        layerClearances: {
          create: {
            layer: RightsLayer.PEOPLE,
            reason: "Model release on file; covers online commercial publication.",
            clearedByUserId: "admin-item-3ae",
          },
        },
      },
    });

    expect(await getPublicMediaItem("pv-item-people")).toBeNull();
    expect(await getPublicMediaItem("pv-item-people-cleared")).not.toBeNull();
  });
});
