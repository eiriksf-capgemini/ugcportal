import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The session helper, stubbed to THROW rather than to return null.
 *
 * Not squeamishness about next-auth's module graph — though it is that too,
 * since importing it for real pulls `next/server` into a node test run. It is
 * the assertion: GET /api/public/media's header says the feed "deliberately
 * never calls auth(), because the answer must not depend on who is asking",
 * and the gallery is now a second reader of the same rows. A stub returning
 * null would let a future `auth()` call slip in and behave identically for an
 * anonymous visitor, which is exactly the caller this test simulates and
 * exactly the one who would never reveal the bug. Throwing makes any such call
 * fail here, loudly, in the anonymous case.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the public gallery must not consult the session");
  },
}));

/**
 * The public gallery, against a real database and the real listing code
 * (ugcportal-71y).
 *
 * Nothing here is mocked below the Prisma client, on purpose. K1, K2 and K3 are
 * claims about which rows reach the DOM and what the DOM then says about them,
 * and both halves — the where-clause and the render — have to hold for the
 * claim to be true. A test that stubbed the feed would prove the component can
 * draw whatever it is given, which is the half that was never in doubt.
 *
 * K4 is a claim about the endpoint's cursor contract rather than about the
 * component, so it pages the real route handler. Deliberately NOT through the
 * gallery's own append helper: that helper drops ids it has already seen, so
 * running the union check through it would launder a server-side duplicate
 * into a pass. The contract is checked where it is made.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { default: Home } = await import("@/app/page");
const { GET } = await import("@/app/api/public/media/route");
const { mediaPreviewPath, publicMediaListingPath } = await import(
  "@/lib/routes"
);

const UPLOADER = "uploader-71y";

/**
 * The uploader id every seeded row belongs to, spelled once.
 *
 * It is a distinctive string rather than "user-1" so K2's "does the markup
 * mention the uploader" assertion cannot pass by the id simply not appearing
 * anywhere — a short generic id is exactly the kind of value that shows up in
 * unrelated markup by accident and turns a leak check into a coin toss.
 */
const UPLOADER_MARKER = "u71yAcct7f3c9d";

type SeedOptions = {
  id: string;
  createdAt: Date;
  published?: boolean;
  withPreview?: boolean;
  kind?: "IMAGE" | "VIDEO";
};

async function seedMedia({
  id,
  createdAt,
  published = true,
  withPreview = true,
  kind = "IMAGE",
}: SeedOptions) {
  await prisma.media.create({
    data: {
      id,
      userId: UPLOADER,
      kind,
      // The exact shape src/app/api/media/route.ts writes, so K2 is checking
      // for the string the product would actually leak.
      key: `media/${UPLOADER_MARKER}/${id}-original.jpg`,
      previewKey: withPreview
        ? `previews/${UPLOADER_MARKER}/${id}-preview.webp`
        : null,
      previewId: withPreview ? `pv-${id}` : null,
      mimeType: "image/jpeg",
      sizeBytes: 4096,
      originalName: `holiday-passport-scan-${id}.jpg`,
      createdAt,
      publishedAt: published ? new Date("2026-03-04T10:00:00.000Z") : null,
    },
  });
}

async function renderGallery(): Promise<string> {
  return renderToStaticMarkup(await Home());
}

/** The media ids of the tiles in the rendered grid, in document order. */
function renderedIds(markup: string): string[] {
  return [...markup.matchAll(/data-gallery-tile="([^"]+)"/g)].map(
    (match) => match[1],
  );
}

/** Every `src` attribute in the rendered markup. */
function renderedSources(markup: string): string[] {
  return [...markup.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map(
    (match) => match[1],
  );
}

/**
 * One page of the real public endpoint, addressed through the SAME path
 * builder the browser uses (publicMediaListingPath). That is deliberate: a
 * hand-built query string here would still pass if the client spelled the
 * cursor parameter differently from the server that reads it, which is a
 * silent always-first-page bug rather than an error.
 */
async function fetchPage(cursor: string | null, limit: number) {
  const url = new URL(
    publicMediaListingPath({
      limit,
      ...(cursor === null ? {} : { cursor }),
    }),
    "http://gallery.test",
  );
  const response = await GET(new Request(url));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    items: { id: string }[];
    hasMore: boolean;
    nextCursor: string | null;
  };
}

/**
 * Walks the feed from the start, returning every id it emitted — WITH
 * duplicates preserved, which is the entire point. Collecting into a Set here
 * would make "no duplicates" unfalsifiable.
 */
async function pageThroughFeed(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  // A hard stop, so a cursor that fails to advance fails this test rather
  // than hanging the suite.
  for (let request = 0; request < 50; request += 1) {
    const page = await fetchPage(cursor, limit);
    seen.push(...page.items.map((item) => item.id));
    expect(page.hasMore).toBe(page.nextCursor !== null);
    if (!page.hasMore) return seen;
    cursor = page.nextCursor;
  }
  throw new Error("the feed never reported the end of the list");
}

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
    data: { id: UPLOADER, email: "uploader@example.com", role: "USER" },
  });
});

describe("K1 — the gallery renders published previews to an anonymous visitor", () => {
  it("renders one tile per published item, sourced from the preview route", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });
    await seedMedia({ id: "b", createdAt: new Date("2026-03-02T00:00:00Z") });

    const markup = await renderGallery();

    // Newest first: the feed orders by createdAt desc.
    expect(renderedIds(markup)).toEqual(["b", "a"]);
    expect(renderedSources(markup)).toEqual([
      mediaPreviewPath("pv-b"),
      mediaPreviewPath("pv-a"),
    ]);
  });

  it("gives every tile an activation target with its own accessible name", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });
    await seedMedia({ id: "b", createdAt: new Date("2026-03-02T00:00:00Z") });

    const markup = await renderGallery();

    const buttons = [...markup.matchAll(/<button[^>]*data-gallery-tile[^>]*>/g)];
    expect(buttons).toHaveLength(2);
    for (const [button] of buttons) {
      expect(button).toMatch(/aria-label="[^"]+"/);
      expect(button).toContain('type="button"');
    }
  });

  it("renders no <main> of its own — the app shell owns the only one", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });
    expect(await renderGallery()).not.toContain("<main");
  });

  it("shows an empty state, not a broken grid, when nothing is published", async () => {
    await seedMedia({
      id: "private",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      published: false,
    });

    const markup = await renderGallery();

    expect(renderedIds(markup)).toEqual([]);
    expect(markup).toContain("Nothing is published yet.");
  });
});

describe("K2 — nothing about the original or its uploader reaches the markup", () => {
  it("renders no original key, no preview key and no account id", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });

    const markup = await renderGallery();

    // The tile exists — otherwise every assertion below passes vacuously.
    expect(renderedIds(markup)).toEqual(["a"]);

    expect(markup).not.toContain("media/a-original.jpg");
    expect(markup).not.toContain("previews/");
    expect(markup).not.toContain(UPLOADER_MARKER);
    expect(markup).not.toContain(UPLOADER);
    // The uploader-supplied filename is owner-only (src/lib/media-access.ts),
    // and is emphatically not alt text.
    expect(markup).not.toContain("holiday-passport-scan");
    // No field named `key` survives to the DOM in any attribute form.
    expect(markup).not.toMatch(/\bkey="/);
  });

  it("builds every image source from the opaque previewId alone", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });

    for (const source of renderedSources(await renderGallery())) {
      expect(source).toBe(mediaPreviewPath("pv-a"));
      expect(source).not.toContain(UPLOADER_MARKER);
    }
  });
});

describe("K3 — unpublished and preview-less rows never appear", () => {
  it("excludes an unpublished row and a published VIDEO with no preview", async () => {
    await seedMedia({ id: "shown", createdAt: new Date("2026-03-03T00:00:00Z") });
    await seedMedia({
      id: "unpublished",
      createdAt: new Date("2026-03-02T00:00:00Z"),
      published: false,
    });
    await seedMedia({
      id: "video",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      kind: "VIDEO",
      withPreview: false,
    });

    expect(renderedIds(await renderGallery())).toEqual(["shown"]);
  });

  it("excludes a published IMAGE that has no preview either", async () => {
    // Not the same case as the VIDEO above: the exclusion must follow from the
    // missing preview, not from the kind. A filter that keyed on `kind` would
    // pass the previous test and fail this one.
    await seedMedia({ id: "shown", createdAt: new Date("2026-03-03T00:00:00Z") });
    await seedMedia({
      id: "no-preview",
      createdAt: new Date("2026-03-02T00:00:00Z"),
      withPreview: false,
    });

    expect(renderedIds(await renderGallery())).toEqual(["shown"]);
  });
});

describe("K4 — paging yields the union of items exactly once", () => {
  /**
   * Twelve published rows, of which four share a single timestamp.
   *
   * The shared timestamp is the fixture's whole job. The cursor is a
   * (createdAt, id) keyset, so a comparison that used `createdAt` alone would
   * be correct on any set of distinct timestamps and wrong here — it would
   * either re-serve or skip the rows either side of the boundary. Seeding only
   * distinct dates is the "a date that could not collide" harness: green, and
   * blind to the bug it exists to find.
   *
   * The collision is placed at rows 4..7 so that a page size of 5 cuts through
   * the middle of it rather than landing tidily on either edge.
   */
  const COLLIDING_AT = new Date("2026-02-10T09:00:00.000Z");

  async function seedTwelve() {
    for (let index = 0; index < 12; index += 1) {
      const colliding = index >= 4 && index <= 7;
      await seedMedia({
        id: `m${String(index).padStart(2, "0")}`,
        createdAt: colliding
          ? COLLIDING_AT
          : new Date(Date.UTC(2026, 1, 1 + index, 9, 0, 0)),
      });
    }
  }

  it("emits every published item once across pages that split a timestamp tie", async () => {
    await seedTwelve();

    const ids = await pageThroughFeed(5);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect([...ids].sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `m${String(i).padStart(2, "0")}`),
    );
  });

  it("agrees with the single-page listing on order as well as membership", async () => {
    await seedTwelve();

    // Same rows, one page, no cursor involved: the paged walk must reproduce
    // this sequence exactly. Membership alone would not catch a cursor that
    // re-orders around the tie.
    const wholeFeed = await fetchPage(null, 100);
    expect(wholeFeed.hasMore).toBe(false);

    expect(await pageThroughFeed(5)).toEqual(
      wholeFeed.items.map((item) => item.id),
    );
  });

  it("skips nothing when withheld rows sit between two pages", async () => {
    // Published rows interleaved with rows the feed must not serve, so the
    // page boundaries fall on withheld rows rather than on emitted ones.
    for (let index = 0; index < 10; index += 1) {
      await seedMedia({
        id: `pub-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1 + index * 2, 9)),
      });
      await seedMedia({
        id: `priv-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 2 + index * 2, 9)),
        published: false,
      });
    }

    const ids = await pageThroughFeed(3);

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `pub-${i}`).sort(),
    );
  });

  it("hands the gallery a cursor only when there is another page", async () => {
    await seedMedia({ id: "only", createdAt: new Date("2026-03-01T00:00:00Z") });

    const page = await fetchPage(null, 5);

    expect(page.items.map((item) => item.id)).toEqual(["only"]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
