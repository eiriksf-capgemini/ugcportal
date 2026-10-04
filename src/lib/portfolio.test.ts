import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedMedia } from "@/lib/test-support/media-fixtures";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The portfolio selection mechanism (ugcportal-qnq9.7), against a real
 * database and the real migrations — including
 * 20261004150000_seed_portfolio_tag, whose own seed row this file also
 * exercises.
 *
 * Nothing below Prisma is mocked, for the same reason src/app/page.test.tsx
 * gives: the claim here is about which rows a query returns, and a stubbed
 * Prisma client would only prove this module calls `findMany`, not that the
 * where-clause actually selects the right rows.
 *
 * `@/lib/auth` IS mocked, same as that file — not because this module calls
 * `auth()` (it does not), but because `@/lib/portfolio` imports
 * `MEDIA_ANONYMOUS_SELECT` from `@/lib/media-access`, which imports
 * `@/lib/auth` at module scope. The real module pulls in next-auth's own
 * provider config, which this node test run has no business loading.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("listPortfolioPieces must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { listPickerTags } = await import("@/lib/tags");
const { PORTFOLIO_TAG_SLUG } = await import("@/lib/curation-tags");
const { MAX_PORTFOLIO_PIECES, listPortfolioPieces } = await import(
  "@/lib/portfolio"
);

const UPLOADER = "uploader-qnq9-7";

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
    data: { id: UPLOADER, email: "uploader-qnq9-7@example.com", role: "USER" },
  });
});

describe("the seeded portfolio tag (20261004150000_seed_portfolio_tag)", () => {
  it("exists, is named Portfolio, and is curated", async () => {
    const tag = await prisma.tag.findUnique({
      where: { slug: PORTFOLIO_TAG_SLUG },
    });
    expect(tag).not.toBeNull();
    expect(tag?.name).toBe("Portfolio");
    expect(tag?.curated).toBe(true);
  });

  it("is therefore offered by the existing curated-tag picker", async () => {
    const picked = await listPickerTags();
    expect(picked.map((tag) => tag.slug)).toContain(PORTFOLIO_TAG_SLUG);
  });
});

describe("listPortfolioPieces", () => {
  it("returns a published, portfolio-tagged IMAGE", async () => {
    await seedMedia(prisma, {
      id: "piece-ok",
      userId: UPLOADER,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
      caption: "Flat-lay, 5 images",
    });

    const pieces = await listPortfolioPieces();
    expect(pieces.map((p) => p.id)).toContain("piece-ok");
    const piece = pieces.find((p) => p.id === "piece-ok");
    expect(piece?.caption).toBe("Flat-lay, 5 images");
  });

  it("excludes media with no portfolio tag", async () => {
    await seedMedia(prisma, {
      id: "piece-untagged",
      userId: UPLOADER,
      createdAt: new Date("2026-02-02T00:00:00.000Z"),
      tags: [],
    });

    const pieces = await listPortfolioPieces();
    expect(pieces.map((p) => p.id)).not.toContain("piece-untagged");
  });

  it("excludes an unpublished portfolio-tagged item", async () => {
    await seedMedia(prisma, {
      id: "piece-unpublished",
      userId: UPLOADER,
      createdAt: new Date("2026-02-03T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
      published: false,
    });

    const pieces = await listPortfolioPieces();
    expect(pieces.map((p) => p.id)).not.toContain("piece-unpublished");
  });

  // K4/ugcportal-dzz: v0.5.0 ships photo pieces only (Eirik's 2026-10-04
  // release-scoping note). A VIDEO tagged "portfolio" by mistake (or ahead of
  // v0.6.0's video support landing) must not reach this page at all, rather
  // than reach it and render wrong — the exact defect ugcportal-dzz already
  // named for the gallery itself.
  it("excludes a portfolio-tagged VIDEO (release scope: photo pieces only)", async () => {
    await seedMedia(prisma, {
      id: "piece-video",
      userId: UPLOADER,
      createdAt: new Date("2026-02-04T00:00:00.000Z"),
      kind: "VIDEO",
      tags: [PORTFOLIO_TAG_SLUG],
    });

    const pieces = await listPortfolioPieces();
    expect(pieces.map((p) => p.id)).not.toContain("piece-video");
  });

  it("excludes a portfolio-tagged item with no preview (not yet watermarked)", async () => {
    await seedMedia(prisma, {
      id: "piece-no-preview",
      userId: UPLOADER,
      createdAt: new Date("2026-02-05T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
      withPreview: false,
    });

    const pieces = await listPortfolioPieces();
    expect(pieces.map((p) => p.id)).not.toContain("piece-no-preview");
  });

  it("orders pieces oldest first", async () => {
    await seedMedia(prisma, {
      id: "piece-order-b",
      userId: UPLOADER,
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
    });
    await seedMedia(prisma, {
      id: "piece-order-a",
      userId: UPLOADER,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
    });

    const pieces = await listPortfolioPieces();
    const order = pieces.map((p) => p.id);
    expect(order.indexOf("piece-order-a")).toBeLessThan(
      order.indexOf("piece-order-b"),
    );
  });

  // Round-2 review: the actual filtering moved to toGalleryItems
  // (src/lib/gallery-items.ts), which covers every public surface, not only
  // this one's query. This integration-level check stays here too, as a
  // second line of evidence that THIS caller's output carries the fix.
  it("strips the curation tag itself from a piece's visible tags, keeping real subjects", async () => {
    await prisma.tag.upsert({
      where: { slug: "food" },
      create: { slug: "food", name: "Food" },
      update: {},
    });
    await seedMedia(prisma, {
      id: "piece-tags",
      userId: UPLOADER,
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG, "food"],
    });

    const pieces = await listPortfolioPieces();
    const piece = pieces.find((p) => p.id === "piece-tags");
    expect(piece?.tags.map((t) => t.slug)).toEqual(["food"]);
  });

  // Round-1 review: a bounded `take` on the query, so the curated set (which
  // nothing ever un-tags or deletes from) cannot grow the page's render cost
  // without limit.
  it("never returns more than MAX_PORTFOLIO_PIECES pieces", async () => {
    for (let index = 0; index < MAX_PORTFOLIO_PIECES + 3; index += 1) {
      await seedMedia(prisma, {
        id: `piece-bound-${index}`,
        userId: UPLOADER,
        createdAt: new Date(2026, 3, 1 + index),
        tags: [PORTFOLIO_TAG_SLUG],
      });
    }

    const pieces = await listPortfolioPieces();
    expect(pieces.length).toBe(MAX_PORTFOLIO_PIECES);
  });
});
