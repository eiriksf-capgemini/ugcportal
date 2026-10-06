import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedMedia } from "@/lib/test-support/media-fixtures";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

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
