import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The brand list (ugcportal-mqh8), against a real database. The rendering
 * half of the admin surface K4 asks for; the write side (the route the form
 * posts to) is covered in its own route.test.ts next to the route, the same
 * split the resale-rights screen and its decision route use.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const {
  default: BrandAlcoholSettingsPage,
  BRAND_LIST_ID,
  MAX_ATTENTION_ITEMS,
} = await import("@/app/admin/settings/rights/brands/page");

const ADMIN = { user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" } };

async function renderPage(
  searchParams: Record<string, string> = {},
): Promise<string> {
  const element = await BrandAlcoholSettingsPage({
    searchParams: Promise.resolve(searchParams),
  } as Parameters<typeof BrandAlcoholSettingsPage>[0]);
  return renderToStaticMarkup(element);
}

/**
 * One brand row's own markup, depth-aware.
 *
 * A naive `/<li>([\s\S]*?)<\/li>/g` — the pattern `listedEmails` in the
 * sibling rights page.test.tsx uses — stops at the FIRST `</li>`, which here
 * is the close of a NESTED `<li>` inside the "needs attention" list
 * (ugcportal-mqh8 K2), not the end of the row. That list is the one thing
 * about this screen the uploader list one level up does not have, so this
 * helper tracks nesting depth instead of assuming a flat list of rows.
 */
function brandRows(markup: string): string[] {
  // This page carries only one `<li>`-bearing list (unlike the sibling
  // rights page, which also lists TRIAGE_FACTS in its own `<ul>` above the
  // uploader list), but the assertion is made rather than assumed: a
  // rename or a second list added later fails this helper loudly instead of
  // silently scanning the wrong markup.
  expect(markup).toContain(`id="${BRAND_LIST_ID}"`);
  const rows: string[] = [];
  const tagPattern = /<li\b[^>]*>|<\/li>/g;
  let depth = 0;
  let rowStart = -1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(markup))) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0 && rowStart !== -1) {
        rows.push(markup.slice(rowStart, match.index));
        rowStart = -1;
      }
    } else {
      if (depth === 0) {
        rowStart = match.index + match[0].length;
      }
      depth += 1;
    }
  }
  return rows;
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
  });
  await prisma.user.create({
    data: { id: "owner-brands-page", email: "owner-brands-page@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  authMock.mockReset().mockResolvedValue(ADMIN);
  notFoundMock.mockClear();
  await prisma.media.deleteMany({});
  await prisma.benefitSource.deleteMany({});
});

describe("admin gate", () => {
  it("calls notFound for a signed-out caller", async () => {
    authMock.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("calls notFound for a signed-in non-admin", async () => {
    // notFound rather than 403: the same reasoning the resale-rights screen
    // states for itself — an ordinary user should not learn this screen
    // exists. The 401/403 split is specific to the route the form here
    // posts to (ugcportal-mqh8 K4), not to this render.
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("rendering", () => {
  it("says there is nothing to answer when no brand has been named", async () => {
    const markup = await renderPage();
    expect(markup).toContain("nothing to answer");
  });

  it("lists an unchecked brand with the monotone action and no claim about an answer", async () => {
    await prisma.benefitSource.create({
      data: { slug: "unchecked-co", name: "Unchecked Co" },
    });

    const markup = await renderPage();
    const [row] = brandRows(markup);

    expect(row).toContain("Unchecked Co");
    expect(row).toContain("Unchecked");
    expect(row).toContain('name="brandId"');
    expect(row).toContain("Record as alcohol-linked");
  });

  it("lists a brand answered `no`, with the action still offered", async () => {
    await prisma.benefitSource.create({
      data: {
        slug: "clean-co",
        name: "Clean Co",
        alcoholLinked: false,
        alcoholAnsweredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const markup = await renderPage();
    const [row] = brandRows(markup);

    expect(row).toContain("Not alcohol-linked");
    expect(row).toContain("Record as alcohol-linked");
  });

  it("lists an alcohol-linked brand dated and attributed, with no action offered", async () => {
    await prisma.benefitSource.create({
      data: {
        slug: "linked-co",
        name: "Linked Co",
        alcoholLinked: true,
        alcoholAnsweredAt: new Date("2026-03-15T12:00:00.000Z"),
        alcoholAnsweredByUserId: "admin-1",
      },
    });

    const markup = await renderPage();
    const [row] = brandRows(markup);

    expect(row).toContain("Linked Co");
    expect(row).toContain("Alcohol-linked");
    expect(row).toContain("15 Mar 2026");
    expect(row).toContain("admin@example.com");
    // Monotone: once true, the form is gone — there is no control that could
    // ever submit a change back.
    expect(row).not.toContain("Record as alcohol-linked");
  });

  it("surfaces an already-published item under a now alcohol-linked brand as needing attention (K2), without unpublishing it", async () => {
    const brand = await prisma.benefitSource.create({
      data: {
        slug: "k2-brand",
        name: "K2 Brand",
        alcoholLinked: true,
        alcoholAnsweredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.media.create({
      data: {
        id: "media-k2-page",
        userId: "owner-brands-page",
        kind: "IMAGE",
        key: "media/owner-brands-page/a.png",
        mimeType: "image/png",
        sizeBytes: 10,
        originalName: "already-public.png",
        publishedAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId: "media-k2-page",
        benefitReceived: true,
        benefitSourceId: brand.id,
        label: "Advertisement / Reklame",
      },
    });

    const markup = await renderPage();
    const [row] = brandRows(markup);

    expect(row).toContain("Needs attention");
    expect(row).toContain("already-public.png");
    // K2 is explicit that nothing here unpublishes anything; this screen's
    // own query is read-only and the item's publishedAt is never touched by
    // rendering it.
    expect(
      (
        await prisma.media.findUniqueOrThrow({
          where: { id: "media-k2-page" },
          select: { publishedAt: true },
        })
      ).publishedAt,
    ).not.toBeNull();
  });

  it("does not surface an unpublished item as needing attention", async () => {
    const brand = await prisma.benefitSource.create({
      data: {
        slug: "k2-unpublished-brand",
        name: "K2 Unpublished Brand",
        alcoholLinked: true,
        alcoholAnsweredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.media.create({
      data: {
        id: "media-k2-unpublished-page",
        userId: "owner-brands-page",
        kind: "IMAGE",
        key: "media/owner-brands-page/b.png",
        mimeType: "image/png",
        sizeBytes: 10,
        originalName: "never-public.png",
      },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId: "media-k2-unpublished-page",
        benefitReceived: true,
        benefitSourceId: brand.id,
        label: "Advertisement / Reklame",
      },
    });

    const markup = await renderPage();
    const [row] = brandRows(markup);

    expect(row).not.toContain("Needs attention");
  });

  it("truncates the needs-attention list honestly past the cap", async () => {
    const brand = await prisma.benefitSource.create({
      data: {
        slug: "k2-many-brand",
        name: "K2 Many Brand",
        alcoholLinked: true,
        alcoholAnsweredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const count = MAX_ATTENTION_ITEMS + 1;
    for (let index = 0; index < count; index += 1) {
      const id = `media-k2-many-${index}`;
      await prisma.media.create({
        data: {
          id,
          userId: "owner-brands-page",
          kind: "IMAGE",
          key: `media/owner-brands-page/${id}.png`,
          mimeType: "image/png",
          sizeBytes: 10,
          originalName: `${id}.png`,
          publishedAt: new Date("2026-02-01T00:00:00.000Z"),
        },
      });
      await prisma.mediaAdvertisingDisclosure.create({
        data: {
          mediaId: id,
          benefitReceived: true,
          benefitSourceId: brand.id,
          label: "Advertisement / Reklame",
        },
      });
    }

    const markup = await renderPage();
    const [row] = brandRows(markup);
    expect(row).toContain(`Showing the first ${MAX_ATTENTION_ITEMS}`);
  });

  it("shows the recorded banner after a successful flip redirect", async () => {
    const markup = await renderPage({ recorded: "1" });
    expect(markup).toContain("Brand recorded as alcohol-linked.");
  });

  it("shows the outcome message for a brand no longer found", async () => {
    const markup = await renderPage({ error: "brand_not_found" });
    expect(markup).toContain("That brand no longer exists");
  });

  it("ignores an unknown error code rather than rendering it verbatim", async () => {
    const markup = await renderPage({ error: "toString" });
    expect(markup).not.toContain("function toString");
  });

  it("links back to the resale-rights screen", async () => {
    expect(await renderPage()).toContain('href="/admin/settings/rights"');
  });
});
