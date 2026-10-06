import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { GalleryItem } from "@/lib/gallery-items";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-qqnt.5 K1: `Home()` passes `listPortfolioPieces()`'s result
 * through to `<EmptyState pieces={...}>` on the genuinely-empty branch.
 *
 * `@/lib/portfolio` IS MOCKED HERE, unlike src/app/page.test.tsx's own
 * "nothing below the Prisma client" discipline — deliberately, and for a
 * structural reason rather than convenience: `listPortfolioPieces` and
 * `listPublicMedia` both read through the identical `PUBLIC_MEDIA_SCOPE`
 * (src/lib/public-media.ts; see src/lib/portfolio.ts's own comment), so a
 * portfolio piece seeded through the real publish pipeline is, by
 * construction, ALSO a row `listPublicMedia` would return. Seeding one for
 * real would make `result.page.items` non-empty, which makes
 * `isGenuinelyEmptyPage` false and renders `<Gallery>` instead of
 * `<EmptyState>` — the opposite of the K1 case this file exists to observe.
 * That combination (a genuinely empty gallery feed, at least one portfolio
 * piece) is therefore unreachable through the real listing pipeline today;
 * mocking `listPortfolioPieces` is what lets this file exercise `Home()`'s
 * own wiring — that it calls the function at all, only on the branch that
 * needs it, and threads the result into the component unchanged — without
 * asserting something the current schema cannot produce.
 *
 * `listPublicMedia` ITSELF IS NOT MOCKED: a real, empty database (via
 * `createTemporaryDatabase`) is what puts `Home()` on the genuinely-empty
 * branch, the same real listing src/app/page.test.tsx's own empty-state
 * tests use — only the portfolio half of that branch is faked here.
 *
 * src/components/home/empty-state.test.tsx covers what `EmptyState` does
 * with an already-resolved `pieces` array in isolation; this file is the
 * "wired as well as written" half, the same split K1's hero test in
 * page.test.tsx draws for `signedIn`.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the public gallery must not consult the session");
  },
  getSession: () => Promise.resolve(null),
}));

const listPortfolioPiecesMock = vi.fn<() => Promise<GalleryItem[]>>(async () => []);
vi.mock("@/lib/portfolio", async (importOriginal) => {
  // `importOriginal` so `SPEC_SAMPLE_LABEL` (which `PortfolioTile` also
  // imports from this module) stays real — only `listPortfolioPieces`
  // itself, the one export that needs a database, is replaced.
  const actual = await importOriginal<typeof import("@/lib/portfolio")>();
  return { ...actual, listPortfolioPieces: () => listPortfolioPiecesMock() };
});

const database = createTemporaryDatabase();
const { default: Home } = await import("@/app/page");

async function renderHome(): Promise<string> {
  return renderToStaticMarkup(await Home());
}

function piece(id: string): GalleryItem {
  return {
    id,
    previewSrc: `/api/media/preview/pv-${id}`,
    kind: "IMAGE",
    publishedAt: "2026-03-04T10:00:00.000Z",
    altText: `Photograph ${id}`,
    caption: "",
    tags: [],
    advertisingLabel: null,
  };
}

beforeAll(async () => {
  const { prisma } = await import("@/lib/prisma");
  await applyMigrations(prisma);
});

afterEach(() => {
  listPortfolioPiecesMock.mockReset();
  listPortfolioPiecesMock.mockImplementation(async () => []);
});

afterAll(async () => {
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-qqnt.5 K1 — Home() wires listPortfolioPieces() into the empty state", () => {
  it("passes real pieces through to the tile row when the gallery itself is empty", async () => {
    listPortfolioPiecesMock.mockImplementation(async () => [piece("p1"), piece("p2")]);

    const markup = await renderHome();

    expect(markup).toContain("Nothing is published yet.");
    expect(markup).toContain('data-gallery-state="empty"');
    expect(markup).toContain('data-portfolio-piece="p1"');
    expect(markup).toContain('data-portfolio-piece="p2"');
    expect(markup).toMatch(/<h2[^>]*>From the portfolio<\/h2>/);
  });

  it("K2: renders no tile row when listPortfolioPieces resolves empty", async () => {
    const markup = await renderHome();

    expect(markup).toContain("Nothing is published yet.");
    expect(markup).not.toContain("data-portfolio-piece");
    expect(markup).not.toContain("From the portfolio");
    expect(listPortfolioPiecesMock).toHaveBeenCalledTimes(1);
  });
});
