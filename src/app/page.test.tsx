import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The session helper. `auth` is stubbed to THROW rather than to return null;
 * `getSession` is stubbed to resolve as an anonymous visitor.
 *
 * Not squeamishness about next-auth's module graph — though it is that too,
 * since importing it for real pulls `next/server` into a node test run. It is
 * the assertion: GET /api/public/media's header says the feed "deliberately
 * never calls auth(), because the answer must not depend on who is asking",
 * and the gallery is now a second reader of the same rows. A stub returning
 * null for `auth` would let a future direct `auth()` call slip in and behave
 * identically for an anonymous visitor, which is exactly the caller this test
 * simulates and exactly the one who would never reveal the bug. Throwing
 * makes any such call fail here, loudly, in the anonymous case.
 *
 * `getSession` is a SEPARATE stub, not a relaxation of the guarantee above:
 * it backs the front page's hero (ugcportal-6dvg K1), a concern entirely
 * independent of which rows the listing serves — `listPublicMedia` and
 * `<Gallery>` never call it, only `Home()` itself does, to pick the hero's
 * call-to-action target. A real `vi.fn()` (not a bare arrow function),
 * defaulting to `null` — the true anonymous case every test in this file
 * simulates by never seeding a session — so the one K1 test below that
 * needs a SIGNED-IN visitor can override it with `mockResolvedValueOnce`
 * without disturbing every other test's default.
 */
const getSessionMock = vi.fn();
getSessionMock.mockResolvedValue(null);
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the public gallery must not consult the session");
  },
  getSession: () => getSessionMock(),
}));

/**
 * Stubbed only for the one test below that renders the full page through
 * AppShell (ugcportal-14k9 PR #94 review round 2, finding 1) rather than
 * Home()/Gallery alone. Both are real async Server Components that import
 * `getSession` from "@/lib/auth" - a module this file's own mock above
 * replaces wholesale, so an un-stubbed UploadNavLink/AuthStatus would call
 * `undefined()` the moment AppShell's tree actually resolves them. Harmless
 * for every OTHER test in this file, which renders Home()/Gallery directly
 * and never touches either.
 */
vi.mock("@/components/upload-nav-link", () => ({
  UploadNavLink: () => null,
}));
vi.mock("@/components/auth-status", () => ({
  AuthStatus: () => null,
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
const { AppShell } = await import("@/components/app-shell");
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

/*
 * The three strings a row is seeded with that K2 then looks for, each built by
 * ONE function used by both the seeder and the assertion.
 *
 * Spelling them twice is how K2's original-key check became unfalsifiable: the
 * seeder wrote `media/{UPLOADER_MARKER}/a-original.jpg` and the assertion
 * looked for `media/a-original.jpg`, a string that was never in the database,
 * so it could not have appeared in the markup however badly the gallery
 * behaved. The leak check that `r1d` spent three review rounds establishing
 * was, at the render layer, asserting the absence of a string nothing could
 * produce.
 *
 * Deriving both ends from these functions removes the possibility.
 */
const originalKeyFor = (id: string) =>
  `media/${UPLOADER_MARKER}/${id}-original.jpg`;
const previewKeyFor = (id: string) =>
  `previews/${UPLOADER_MARKER}/${id}-preview.webp`;
const originalNameFor = (id: string) => `holiday-passport-scan-${id}.jpg`;

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
      key: originalKeyFor(id),
      previewKey: withPreview ? previewKeyFor(id) : null,
      previewId: withPreview ? `pv-${id}` : null,
      mimeType: "image/jpeg",
      sizeBytes: 4096,
      originalName: originalNameFor(id),
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
  // After media (whose disclosure rows cascade-delete with it, see the
  // schema's own `onDelete: Cascade`): a BenefitSource has no delete path
  // in the product and is Restrict-protected, so a test that seeds one
  // (ugcportal-e0jv's K2 describe block, below) would collide with the
  // next test's same slug otherwise.
  await prisma.benefitSource.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({
    data: { id: UPLOADER, email: "uploader@example.com", role: "USER" },
  });
  // Clears call history only, not the default resolved value set above —
  // a test that overrode it with `mockResolvedValueOnce` already consumed
  // that override on its one call, so there is nothing left to leak.
  getSessionMock.mockClear();
});

/**
 * ugcportal-6dvg K1 (CTA target revised by ugcportal-qqnt.4 K2): the hero's
 * call to action tracks session state, on the real assembled Home() page
 * (src/components/home/hero.test.tsx covers the same claim against `<Hero>`
 * in isolation — this is the "wired as well as written" half, the same
 * reasoning src/lib/auth.ts's own comment on `authConfig` gives for testing
 * the sign-in gate as wired).
 */
describe("K1 — the front page hero's call to action tracks session state", () => {
  it("signed out (the default for every test in this file), the call to action leads to the portfolio", async () => {
    const markup = await renderGallery();

    expect(markup).toContain("See the portfolio");
    expect(markup).not.toContain('href="/upload"');
  });

  it("signed in, the call to action leads straight to /upload", async () => {
    getSessionMock.mockResolvedValueOnce({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });

    const markup = await renderGallery();

    expect(markup).toContain('href="/upload"');
    expect(markup).not.toContain("See the portfolio");
  });
});

describe("K2 — the hero renders above the gallery, and the empty state does not render", () => {
  it("with published items present, shows the hero's title above the gallery grid and no living-empty-state marker", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });

    const markup = await renderGallery();

    const heroIndex = markup.indexOf("Real photos of the things you actually use.");
    const tileIndex = markup.indexOf('data-gallery-tile="a"');
    expect(heroIndex).toBeGreaterThanOrEqual(0);
    expect(tileIndex).toBeGreaterThan(heroIndex);
    expect(markup).not.toContain("data-home-empty-state");
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

  it("gives no two tiles the same accessible name", async () => {
    /*
     * Note what the fixture already does: seedMedia publishes every row at the
     * SAME instant, because that is what the product does — publishing is a
     * batch action. So this is the collision case by construction rather than
     * by contrivance, and it is the one an earlier version of the label failed:
     * naming only the publication date gave a whole day's uploads the identical
     * accessible name, in a grid whose entire purpose is choosing between them.
     */
    for (const id of ["a", "b", "c", "d"]) {
      await seedMedia({ id, createdAt: new Date(`2026-03-0${id === "a" ? 1 : 2}T00:00:00Z`) });
    }

    const labels = [
      ...(await renderGallery()).matchAll(/aria-label="([^"]+)"/g),
    ].map((match) => match[1]);

    expect(labels.length).toBeGreaterThanOrEqual(4);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("renders no <main> of its own — the app shell owns the only one", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });
    expect(await renderGallery()).not.toContain("<main");
  });

  /**
   * ugcportal-14k9 PR #94 review, two rounds of the same mistake. Round 1
   * found the gallery's own h1 repeating SITE_DESCRIPTION — the same
   * sentence src/app/layout.tsx puts in `<meta name="description">` — once
   * the header (src/components/site-header.tsx) started rendering
   * SITE_TAGLINE on every page too, duplicating it in different words.
   * Round 1's own fix (switching this heading TO SITE_TAGLINE) just swapped
   * which sentence got duplicated — round 2 found it now repeats the
   * header's tagline WORD FOR WORD. The actual fix is for this heading to
   * stop restating site-wide copy at all: "Gallery" names the page, the
   * same word the header's own nav link already uses for it, so it cannot
   * drift into a second description no matter what either SITE_TAGLINE or
   * SITE_DESCRIPTION says later. The cross-component duplication claim
   * itself — that the tagline sentence appears exactly once on the whole
   * rendered page — is asserted below, through AppShell, not here: a
   * Gallery-only render cannot see the header's copy at all, which is
   * exactly how round 1's fix shipped a new instance of the round-1 bug
   * with every Gallery-only test still green.
   *
   * `<h2>`, not `<h1>` (ugcportal-qqnt.1): the hero now supplies the one
   * real `<h1>` for the whole page (src/components/home/hero.tsx), so this
   * heading steps down to a section-level `<h2>`.
   */
  it("gives the gallery its own heading, not site-wide copy", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });

    const markup = await renderGallery();

    expect(markup).toMatch(/<h2[^>]*>Gallery<\/h2>/);
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
    // Against the real listing rather than a mock: ugcportal-0dh's
    // `GalleryUnavailable` (the OTHER reason the grid can be empty — the
    // listing failed rather than came back with nothing) carries
    // `data-gallery-state="error"` instead, so this is the genuinely-empty
    // case's half of that distinction, pinned here where the row really is
    // absent rather than where a fetch failed.
    expect(markup).toContain('data-gallery-state="empty"');
  });
});

/**
 * ugcportal-14k9 PR #94 review round 2, finding 1. Rendered through
 * `AppShell`, not `Home()`/`Gallery` alone - the bug both review rounds
 * found is a relationship BETWEEN two components (the header's tagline and
 * the gallery's own heading), which no render of either component in
 * isolation can observe. Every other test in this file renders `Home()`
 * directly for exactly that narrower, component-scoped reason; this is the
 * one claim that needs the composed page instead.
 */
describe("the header's tagline is not duplicated elsewhere on the composed page", () => {
  const TAGLINE =
    "Original photography of food, wine accessories, technology and books.";

  it("appears exactly once across the whole rendered home page", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });

    const page = await Home();
    const markup = renderToStaticMarkup(AppShell({ children: page }));

    const occurrences = markup.split(TAGLINE).length - 1;
    expect(occurrences, markup).toBe(1);
  });
});

describe("K2 — nothing about the original or its uploader reaches the markup", () => {
  it("renders no original key, no preview key and no account id", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });

    const markup = await renderGallery();

    // The tile exists — otherwise every assertion below passes vacuously.
    expect(renderedIds(markup)).toEqual(["a"]);

    /*
     * Each forbidden string is the one actually written to the row, taken
     * from the same helper the seeder used. Re-typing them here is how this
     * assertion previously came to look for `media/a-original.jpg`, which the
     * database never held — so it could not have failed. Asserting the absence
     * of a string nothing can produce is not a leak check.
     */
    expect(markup).not.toContain(originalKeyFor("a"));
    expect(markup).not.toContain(previewKeyFor("a"));
    expect(markup).not.toContain(originalNameFor("a"));
    expect(markup).not.toContain("previews/");
    expect(markup).not.toContain(UPLOADER_MARKER);
    expect(markup).not.toContain(UPLOADER);
    // No field named `key` survives to the DOM in any attribute form.
    expect(markup).not.toMatch(/\bkey="/);
  });

  it("is looking for strings the seeded row really contains", () => {
    /*
     * Guards the guard. The assertions above are all `not.toContain`, so they
     * hold trivially if the strings drift away from what seedMedia writes —
     * which is exactly what happened once. This pins the helpers to the shape
     * src/app/api/media/route.ts actually produces, so a rename that made the
     * leak check vacuous fails HERE, loudly, instead of passing everywhere.
     */
    expect(originalKeyFor("a")).toBe(`media/${UPLOADER_MARKER}/a-original.jpg`);
    expect(previewKeyFor("a")).toBe(
      `previews/${UPLOADER_MARKER}/a-preview.webp`,
    );
    for (const key of [originalKeyFor("a"), previewKeyFor("a")]) {
      expect(key).toContain(UPLOADER_MARKER);
    }
  });

  it("builds every image source from the opaque previewId alone", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });

    for (const source of renderedSources(await renderGallery())) {
      expect(source).toBe(mediaPreviewPath("pv-a"));
      expect(source).not.toContain(UPLOADER_MARKER);
    }
  });
});

/**
 * K2 (ugcportal-e0jv, part B of ugcportal-qnq9.1): the advertising-
 * disclosure label crosses to the public feed and the rendered gallery, and
 * NOTHING ELSE from the disclosure does — not `benefitReceived`, not the
 * benefit kind or market value, not the brand's name or slug. Exercised
 * against the REAL public feed route (`GET /api/public/media`) and the
 * real server-rendered home page, over a real database, the same reasoning
 * every other leak check in this file gives: a mocked feed would prove the
 * render layer can draw whatever it is handed, not that the query ever
 * withholds anything.
 */
describe("K2 — the advertising label crosses to the feed, and nothing else from the disclosure does", () => {
  const BRAND_NAME_MARKER = "AcmeCamerasLtdMarker";
  const BRAND_SLUG_MARKER = "acme-cameras-ltd-marker";

  async function seedLabelledDisclosure(mediaId: string) {
    const source = await prisma.benefitSource.create({
      data: { slug: BRAND_SLUG_MARKER, name: BRAND_NAME_MARKER },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId,
        benefitReceived: true,
        benefitKind: "FREE_PRODUCT",
        benefitSourceId: source.id,
        marketValueOre: 450000,
        label: "Advertisement / Reklame",
      },
    });
  }

  it("the rendered home page shows the label and nothing else about the disclosure", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });
    await seedLabelledDisclosure("a");

    const markup = await renderGallery();

    expect(markup).toContain("Advertisement / Reklame");
    expect(markup).not.toContain("benefitReceived");
    expect(markup).not.toContain("FREE_PRODUCT");
    expect(markup).not.toContain("450000");
    expect(markup).not.toContain(BRAND_NAME_MARKER);
    expect(markup).not.toContain(BRAND_SLUG_MARKER);
  });

  it("the real GET /api/public/media JSON carries only { label } from the disclosure relation", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });
    await seedLabelledDisclosure("a");

    const response = await GET(
      new Request(new URL(publicMediaListingPath({}), "http://gallery.test")),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        id: string;
        advertisingDisclosure?: { label?: string } | null;
      }>;
    };

    const item = body.items.find((entry) => entry.id === "a");
    expect(item).toBeDefined();
    expect(item?.advertisingDisclosure).toEqual({
      label: "Advertisement / Reklame",
    });
    // Exhaustive on the relation's OWN keys, not merely a `not.toContain` on
    // the whole response — a sibling field on the same object would not show
    // up in a substring scan if it happened to equal another field's value,
    // but it cannot escape a direct key-list assertion.
    expect(Object.keys(item?.advertisingDisclosure ?? {})).toEqual(["label"]);

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("benefitReceived");
    expect(serialised).not.toContain("benefitKind");
    expect(serialised).not.toContain("marketValueOre");
    expect(serialised).not.toContain("benefitSource");
    expect(serialised).not.toContain(BRAND_NAME_MARKER);
    expect(serialised).not.toContain(BRAND_SLUG_MARKER);
  });

  it("shows nothing for an item with benefitReceived false, or no disclosure row at all (K3)", async () => {
    await seedMedia({ id: "no-benefit", createdAt: new Date("2026-03-02T00:00:00Z") });
    await prisma.mediaAdvertisingDisclosure.create({
      data: { mediaId: "no-benefit", benefitReceived: false },
    });
    await seedMedia({ id: "no-disclosure", createdAt: new Date("2026-03-03T00:00:00Z") });

    const markup = await renderGallery();
    expect(renderedIds(markup)).toEqual(
      expect.arrayContaining(["no-benefit", "no-disclosure"]),
    );
    expect(markup).not.toContain("data-gallery-advertising-label");

    const response = await GET(
      new Request(new URL(publicMediaListingPath({}), "http://gallery.test")),
    );
    const body = (await response.json()) as {
      items: Array<{ id: string; advertisingDisclosure?: unknown }>;
    };
    const noBenefit = body.items.find((entry) => entry.id === "no-benefit");
    const noDisclosure = body.items.find((entry) => entry.id === "no-disclosure");
    expect(noBenefit?.advertisingDisclosure).toEqual({ label: null });
    expect(noDisclosure?.advertisingDisclosure).toBeNull();
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
