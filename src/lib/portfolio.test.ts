import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const {
  PORTFOLIO_TAG_SLUG,
  listPortfolioPieces,
} = await import("@/lib/portfolio");

const UPLOADER = "uploader-qnq9-7";

type SeedOptions = {
  id: string;
  createdAt: Date;
  kind?: "IMAGE" | "VIDEO";
  tags?: string[];
  published?: boolean;
  withPreview?: boolean;
  caption?: string;
};

async function seedMedia({
  id,
  createdAt,
  kind = "IMAGE",
  tags = [],
  published = true,
  withPreview = true,
  caption,
}: SeedOptions) {
  await prisma.media.create({
    data: {
      id,
      userId: UPLOADER,
      kind,
      key: `media/${UPLOADER}/${id}-original.jpg`,
      previewKey: withPreview ? `previews/${UPLOADER}/${id}.webp` : null,
      previewId: withPreview ? `pv-${id}` : null,
      mimeType: kind === "VIDEO" ? "video/mp4" : "image/jpeg",
      sizeBytes: 4096,
      originalName: `${id}.jpg`,
      altText: `Alt text for ${id}`,
      caption,
      createdAt,
      publishedAt: published ? new Date("2026-03-04T10:00:00.000Z") : null,
      tags: { connect: tags.map((slug) => ({ slug })) },
    },
  });
}

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  // Media rows only — the migration's own "portfolio" Tag row, and any tag
  // created by an earlier test, are left alone, matching
  // src/app/page.tags.test.tsx's own beforeEach. Deleting Media first is load
  // bearing: the implicit _MediaToTag join table has no ON DELETE on the
  // Media side that would otherwise matter here, but a stale Media row with a
  // FK to a User this suite is about to delete is exactly the ordering bug
  // this sequence avoids.
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
    await seedMedia({
      id: "piece-ok",
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
    await seedMedia({
      id: "piece-untagged",
      createdAt: new Date("2026-02-02T00:00:00.000Z"),
      tags: [],
    });

    const pieces = await listPortfolioPieces();
    expect(pieces.map((p) => p.id)).not.toContain("piece-untagged");
  });

  it("excludes an unpublished portfolio-tagged item", async () => {
    await seedMedia({
      id: "piece-unpublished",
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
    await seedMedia({
      id: "piece-video",
      createdAt: new Date("2026-02-04T00:00:00.000Z"),
      kind: "VIDEO",
      tags: [PORTFOLIO_TAG_SLUG],
    });

    const pieces = await listPortfolioPieces();
    expect(pieces.map((p) => p.id)).not.toContain("piece-video");
  });

  it("excludes a portfolio-tagged item with no preview (not yet watermarked)", async () => {
    await seedMedia({
      id: "piece-no-preview",
      createdAt: new Date("2026-02-05T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
      withPreview: false,
    });

    const pieces = await listPortfolioPieces();
    expect(pieces.map((p) => p.id)).not.toContain("piece-no-preview");
  });

  it("orders pieces oldest first", async () => {
    await seedMedia({
      id: "piece-order-b",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
    });
    await seedMedia({
      id: "piece-order-a",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
    });

    const pieces = await listPortfolioPieces();
    const order = pieces.map((p) => p.id);
    expect(order.indexOf("piece-order-a")).toBeLessThan(
      order.indexOf("piece-order-b"),
    );
  });

  it("strips the curation tag itself from a piece's visible tags, keeping real subjects", async () => {
    await prisma.tag.upsert({
      where: { slug: "food" },
      create: { slug: "food", name: "Food" },
      update: {},
    });
    await seedMedia({
      id: "piece-tags",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG, "food"],
    });

    const pieces = await listPortfolioPieces();
    const piece = pieces.find((p) => p.id === "piece-tags");
    expect(piece?.tags.map((t) => t.slug)).toEqual(["food"]);
  });

  it("marks every piece as a spec sample with no advertising label (ugcportal-qnq9.1 not built yet)", async () => {
    await seedMedia({
      id: "piece-marker",
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
    });

    const pieces = await listPortfolioPieces();
    const piece = pieces.find((p) => p.id === "piece-marker");
    expect(piece?.isSpec).toBe(true);
    expect(piece?.advertisingLabel).toBeNull();
  });
});
