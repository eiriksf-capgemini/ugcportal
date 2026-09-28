import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * Subject tags on the public gallery (ugcportal-jsc): K1, K3, K4 and the read
 * half of K5.
 *
 * A sibling of src/app/page.test.tsx rather than an addition to it, and for
 * the same reason that file exists: nothing below Prisma is mocked, because
 * every claim here is about which rows reach the DOM and what the DOM then
 * says about them. A stubbed feed would prove the component can draw whatever
 * it is handed, which was never the half in doubt.
 *
 * The session helper throws rather than returning null, exactly as it does
 * next door: the public gallery must not consult the session, and a stub that
 * answered null would behave identically for the anonymous visitor this file
 * simulates — the one caller who would never reveal the bug.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the public gallery must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { default: Home } = await import("@/app/page");
const { GALLERY_GRID_CLASS } = await import(
  "@/components/gallery/containment"
);
const { GET } = await import("@/app/api/public/media/route");
const { publicMediaListingPath } = await import("@/lib/routes");

const UPLOADER = "uploader-jsc";

/** The right-to-left override, by code point — see src/lib/tags.test.ts. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);

type SeedOptions = {
  id: string;
  createdAt: Date;
  tags?: string[];
  published?: boolean;
  withPreview?: boolean;
};

/**
 * Attaches tags by SLUG, creating the rows directly.
 *
 * Deliberately not through PUT /api/media/[id]/tags: this file is about what
 * the gallery renders, and routing the fixture through the validator would
 * make the bidi case below unconstructable — the write path refuses it, which
 * is exactly what the read-side check is a second line of defence against.
 * Its own test (src/app/api/media/[id]/tags/route.test.ts) covers the write.
 */
async function seedMedia({
  id,
  createdAt,
  tags = [],
  published = true,
  withPreview = true,
}: SeedOptions) {
  await prisma.media.create({
    data: {
      id,
      userId: UPLOADER,
      kind: "IMAGE",
      key: `media/${UPLOADER}/${id}-original.jpg`,
      previewKey: withPreview ? `previews/${UPLOADER}/${id}.webp` : null,
      previewId: withPreview ? `pv-${id}` : null,
      mimeType: "image/jpeg",
      sizeBytes: 4096,
      originalName: `${id}.jpg`,
      createdAt,
      publishedAt: published ? new Date("2026-03-04T10:00:00.000Z") : null,
      tags: { connect: tags.map((slug) => ({ slug })) },
    },
  });
}

/**
 * A tag row with a DISTINCTIVE id.
 *
 * The id is not a secret, but it is not projected either (see
 * MEDIA_TAGS_SELECT), and the leak check below can only be falsifiable if the
 * string it looks for is one nothing else could produce — the same reasoning
 * as UPLOADER_MARKER in src/app/page.test.tsx, where a short generic id turned
 * a leak check into a coin toss.
 */
const tagIdFor = (slug: string) => `tagid7f3c9d-${slug}`;

async function seedTag(slug: string, name: string) {
  await prisma.tag.create({ data: { id: tagIdFor(slug), slug, name } });
}

async function renderGallery(): Promise<string> {
  return renderToStaticMarkup(await Home());
}

/** One rendered list item: its media id and the tag slugs drawn under it. */
type RenderedTile = { id: string | null; tags: string[] };

/**
 * The tiles in the rendered grid, in document order.
 *
 * Split on the list items rather than collected with two independent global
 * regexes, because the question K1 asks is which tags are on WHICH item — two
 * flat lists of ids and slugs would pass just as happily if every chip had
 * been rendered under the first photograph.
 */
function renderedTiles(markup: string): RenderedTile[] {
  return markup
    .split("<li>")
    .slice(1)
    .map((chunk) => ({
      id: /data-gallery-tile="([^"]+)"/.exec(chunk)?.[1] ?? null,
      tags: [...chunk.matchAll(/data-gallery-tag="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    }));
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
  await prisma.tag.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({
    data: { id: UPLOADER, email: "uploader@example.com", role: "USER" },
  });
  await seedTag("food", "Food");
  await seedTag("books", "Books");
  await seedTag("wine-drink", "Wine & drink");
});

describe("K1 — every item shows its own tags, and an untagged one renders cleanly", () => {
  /**
   * The mixed set K1 names: multi-tagged, single-tagged and untagged, all in
   * one grid.
   *
   * Newest first, so the expected document order is untagged, single, multi.
   */
  async function seedMixed() {
    await seedMedia({
      id: "multi",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      tags: ["food", "books"],
    });
    await seedMedia({
      id: "single",
      createdAt: new Date("2026-03-02T00:00:00Z"),
      tags: ["wine-drink"],
    });
    await seedMedia({
      id: "untagged",
      createdAt: new Date("2026-03-03T00:00:00Z"),
    });
  }

  it("draws each item's own tags under that item", async () => {
    await seedMixed();

    expect(renderedTiles(await renderGallery())).toEqual([
      { id: "untagged", tags: [] },
      { id: "single", tags: ["wine-drink"] },
      // Ordered by slug, which is what MEDIA_TAGS_SELECT asks for — so the
      // chips do not reshuffle between two requests for the same row.
      { id: "multi", tags: ["books", "food"] },
    ]);
  });

  it("shows the tag's NAME, not its slug", async () => {
    await seedMixed();

    const markup = await renderGallery();

    expect(markup).toContain("Wine &amp; drink");
    expect(markup).toContain("Food");
    expect(markup).toContain("Books");
  });

  it("renders no list at all for an untagged item, rather than an empty one", async () => {
    await seedMixed();

    const markup = await renderGallery();

    /*
     * One <ul> for the grid, plus one per TAGGED item — so two of the three
     * tiles. An empty <ul> would satisfy every other assertion in this file
     * and still be wrong twice over: it carries the tag list's top margin, so
     * untagged tiles would sit out of line with their neighbours, and it is
     * announced as "list, 0 items".
     */
    expect([...markup.matchAll(/<ul\b/g)]).toHaveLength(3);
    expect(markup).toContain(GALLERY_GRID_CLASS);
  });

  it("still renders the grid when nothing in it is tagged", async () => {
    await seedMedia({ id: "a", createdAt: new Date("2026-03-01T00:00:00Z") });
    await seedMedia({ id: "b", createdAt: new Date("2026-03-02T00:00:00Z") });

    const markup = await renderGallery();

    expect(renderedTiles(markup).map((tile) => tile.id)).toEqual(["b", "a"]);
    // The grid, and nothing else: no stray tag lists.
    expect([...markup.matchAll(/<ul\b/g)]).toHaveLength(1);
    expect(markup).not.toContain("data-gallery-tag");
  });
});

describe("the leak rule still holds with tags on the payload", () => {
  /*
   * ugcportal-71y's K2 asserts that no storage path and no account id reaches
   * the markup. Tags are the first thing added to the anonymous payload since,
   * so the rule is re-checked over the new field.
   *
   * ASSERTED ON THE FEED'S JSON, NOT ON THE MARKUP, and the difference is the
   * whole value of this test. The first version looked for `Tag.id` in the
   * rendered HTML — and could not fail: the grid writes `tag.slug` into one
   * attribute and `tag.name` as text, so an id added to the projection never
   * reaches the DOM whatever anybody does. Verified by mutation, twice:
   * widening MEDIA_TAGS_SELECT with `id: true`, and spreading the whole entry
   * in `toGalleryTags`. Both left the markup byte-identical and the assertion
   * green. A needle that can never be present is not a guard.
   *
   * GET /api/public/media serialises the projection directly, so that IS
   * where a widened select becomes observable — and it is a surface an
   * anonymous caller reads whether or not any markup is involved.
   */
  it("serves no Tag.id on the public feed", async () => {
    await seedMedia({
      id: "a",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      tags: ["food", "books"],
    });

    const response = await GET(
      new Request(`http://gallery.test${publicMediaListingPath()}`),
    );
    const body = (await response.json()) as {
      items: { tags: Record<string, unknown>[] }[];
    };

    // The tags are there — otherwise every absence below holds trivially.
    expect(body.items).toHaveLength(1);
    expect(body.items[0].tags).toEqual([
      { slug: "books", name: "Books" },
      { slug: "food", name: "Food" },
    ]);
    // And nothing else about a tag is disclosed. The key check is what makes
    // this fail on a widened projection; the substring checks name the value
    // that would have leaked.
    for (const tag of body.items[0].tags) {
      expect(Object.keys(tag).sort()).toEqual(["name", "slug"]);
    }
    expect(JSON.stringify(body)).not.toContain(tagIdFor("food"));
    expect(JSON.stringify(body)).not.toContain(tagIdFor("books"));
  });

  it("is looking for ids the database really holds", async () => {
    // Guards the guard: the `not.toContain`s above are worth nothing if the
    // rows were never given those ids, or were never joined to the row the
    // feed reads.
    await seedMedia({
      id: "a",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      tags: ["food"],
    });

    const stored = await prisma.tag.findUnique({ where: { slug: "food" } });
    expect(stored?.id).toBe(tagIdFor("food"));

    const joined = await prisma.media.findUnique({
      where: { id: "a" },
      select: { tags: { select: { id: true } } },
    });
    expect(joined?.tags.map((tag) => tag.id)).toEqual([tagIdFor("food")]);
  });

  it("still leaks no storage path or account id now that tags are rendered", async () => {
    await seedMedia({
      id: "a",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      tags: ["food"],
    });

    const markup = await renderGallery();

    expect(renderedTiles(markup)).toEqual([{ id: "a", tags: ["food"] }]);
    expect(markup).not.toContain("previews/");
    expect(markup).not.toContain(UPLOADER);
  });
});

describe("K3 — a tag never makes a hidden item visible", () => {
  it("keeps a tagged but unpublished item out of the gallery", async () => {
    await seedMedia({
      id: "shown",
      createdAt: new Date("2026-03-03T00:00:00Z"),
      tags: ["food"],
    });
    await seedMedia({
      id: "private",
      createdAt: new Date("2026-03-02T00:00:00Z"),
      tags: ["food", "books"],
      published: false,
    });

    const markup = await renderGallery();

    expect(renderedTiles(markup).map((tile) => tile.id)).toEqual(["shown"]);
    // The published item carries `food`, so the slug IS in the markup — which
    // is why the id check above is the assertion and "no mention of food"
    // would not have been one. `books` is the tag only the private row has.
    expect(markup).not.toContain('data-gallery-tag="books"');
  });

  it("keeps a tagged item with no watermarked preview out of the gallery", async () => {
    await seedMedia({
      id: "shown",
      createdAt: new Date("2026-03-03T00:00:00Z"),
      tags: ["food"],
    });
    await seedMedia({
      id: "no-preview",
      createdAt: new Date("2026-03-02T00:00:00Z"),
      tags: ["books"],
      withPreview: false,
    });

    const markup = await renderGallery();

    expect(renderedTiles(markup).map((tile) => tile.id)).toEqual(["shown"]);
    expect(markup).not.toContain('data-gallery-tag="books"');
  });

  it("shows nothing at all when every tagged item is unpublished", async () => {
    await seedMedia({
      id: "private",
      createdAt: new Date("2026-03-02T00:00:00Z"),
      tags: ["food"],
      published: false,
    });

    const markup = await renderGallery();

    expect(renderedTiles(markup)).toEqual([]);
    expect(markup).toContain("Nothing is published yet.");
    expect(markup).not.toContain("data-gallery-tag");
  });
});

describe("K4 — one gallery, never a section or a route per tag", () => {
  /**
   * Every route in the app that renders a PAGE, as a URL path.
   *
   * Read off disk rather than listed, so a per-tag page added later is
   * noticed without anybody remembering to update a list — which is the only
   * version of this check worth having.
   */
  function pageRoutes(): string[] {
    const appDir = resolve(process.cwd(), "src/app");
    const routes: string[] = [];

    const walk = (dir: string, route: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (entries.some((entry) => /^page\.tsx?$/.test(entry.name))) {
        routes.push(route === "" ? "/" : route);
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Route groups `(name)` and private folders `_name` contribute no
        // path segment; neither appears in this app today, and skipping the
        // private ones keeps the walk honest if one does.
        if (entry.name.startsWith("_")) continue;
        const segment = entry.name.startsWith("(") ? "" : `/${entry.name}`;
        walk(join(dir, entry.name), `${route}${segment}`);
      }
    };

    walk(appDir, "");
    return routes.sort();
  }

  it("has no page whose path is a tag", async () => {
    const routes = pageRoutes();

    /*
     * Guards the guard, and this one earns its place: the assertion below is
     * `not.toContain`-shaped, so a walker that found nothing — a renamed
     * directory, a thrown-and-swallowed readdir — would pass it forever. The
     * two routes that DO exist have to be found first.
     */
    expect(routes).toContain("/");
    expect(routes).toContain("/upload");

    /*
     * Matched per SEGMENT, not against the whole path. A substring test reads
     * stricter and is simply wrong: `/admin/settings/instagram` contains
     * "tag", so the first version of this failed on a screen that has nothing
     * to do with subjects — a check that cries wolf gets deleted, and then
     * the real per-tag page lands with nothing watching.
     */
    const SUBJECT_SEGMENTS = [
      "tag",
      "tags",
      "subject",
      "subjects",
      "category",
      "categories",
    ];
    const segmentsOf = (route: string) =>
      route.split("/").filter((segment) => segment !== "");

    expect(
      routes.filter((route) =>
        segmentsOf(route).some((segment) =>
          SUBJECT_SEGMENTS.includes(segment.toLowerCase()),
        ),
      ),
    ).toEqual([]);
    // And no dynamic segment anywhere, which is the other shape a per-tag
    // page takes — `/[tag]`, `/browse/[slug]`.
    expect(routes.filter((route) => route.includes("["))).toEqual([]);
  });

  it("renders the tags as inert labels, not as links to anywhere", async () => {
    await seedMedia({
      id: "a",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      tags: ["food"],
    });

    const markup = await renderGallery();

    // The slug is present, so the absence below is about what was rendered
    // rather than about a fixture that never carried a tag.
    expect(markup).toContain('data-gallery-tag="food"');
    expect(markup).not.toMatch(/<a[^>]*href="[^"]*food/);
    // Not a control either: a tag that looks clickable and is not is the
    // worse half of both options.
    expect(markup).not.toMatch(/<button[^>]*data-gallery-tag/);
  });

  it("emits one continuous item set however many distinct tags are present", async () => {
    /*
     * The uneven library Eirik described, in miniature: one item each for two
     * subjects and a run of a third. If the gallery ever grouped by tag, the
     * document order below would come out clustered rather than
     * chronological, and there would be more than one grid.
     */
    await seedTag("technology", "Technology");
    await seedMedia({
      id: "i0",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      tags: ["technology"],
    });
    await seedMedia({
      id: "i1",
      createdAt: new Date("2026-03-02T00:00:00Z"),
      tags: ["food"],
    });
    await seedMedia({
      id: "i2",
      createdAt: new Date("2026-03-03T00:00:00Z"),
      tags: ["books"],
    });
    for (let index = 3; index < 8; index += 1) {
      await seedMedia({
        id: `i${index}`,
        createdAt: new Date(Date.UTC(2026, 2, index + 1)),
        tags: ["food"],
      });
    }

    const markup = await renderGallery();

    // Exactly one grid.
    expect([...markup.matchAll(new RegExp(GALLERY_GRID_CLASS, "g"))]).toHaveLength(1);
    // And strictly reverse-chronological, which grouping by tag would break.
    expect(renderedTiles(markup).map((tile) => tile.id)).toEqual([
      "i7",
      "i6",
      "i5",
      "i4",
      "i3",
      "i2",
      "i1",
      "i0",
    ]);
    /*
     * And ONE heading on the whole page — the site's own h1.
     *
     * Counted rather than pattern-matched against the subject names, which
     * is what the first version of this did and what made it fail for the
     * wrong reason: SITE_DESCRIPTION is literally "Food, wine and drink,
     * technology and books, photographed.", so a "no heading starts with a
     * subject name" rule flags the page's own tagline. A section per tag
     * shows up as extra headings whatever they are called, so counting is
     * both the stricter check and the one that means what it says.
     */
    expect([...markup.matchAll(/<h[1-6]\b/g)]).toHaveLength(1);
  });
});

describe("K5 — a tag name cannot become markup or reorder the page", () => {
  it("renders a name containing HTML as text", async () => {
    await seedTag("markup-tag", "<b>food</b>");
    await seedMedia({
      id: "a",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      tags: ["markup-tag"],
    });

    const markup = await renderGallery();

    // The chip is there…
    expect(markup).toContain('data-gallery-tag="markup-tag"');
    // …carrying the escaped text, and no live element.
    expect(markup).toContain("&lt;b&gt;food&lt;/b&gt;");
    expect(markup).not.toContain("<b>food</b>");
  });

  it("is looking for a name the database really holds", async () => {
    /*
     * Guards the guard. The `not.toContain` above is worth nothing if the
     * stored name drifts from what the assertion looks for — the exact way
     * ugcportal-71y's own leak check became vacuous. This pins the fixture.
     */
    await seedTag("markup-tag", "<b>food</b>");
    const stored = await prisma.tag.findUnique({ where: { slug: "markup-tag" } });
    expect(stored?.name).toBe("<b>food</b>");
  });

  it("drops a name carrying a bidi override rather than drawing it", async () => {
    /*
     * The write path refuses this name (src/lib/tags.test.ts), so the row is
     * created directly here — which is the only way to construct the case,
     * and is also a real one: rows can predate the validator, and any
     * account permitted to sign in can mint a tag (ugcportal-egp). What is
     * asserted is the second line of defence, `toGalleryTags`.
     *
     * Escaping does NOT cover this. U+202E is not markup; React passes it
     * through untouched, and it reverses the reading order of everything
     * after it — the chips beside it, the paging message, the heading.
     */
    const deceptive = `Food${RTL_OVERRIDE}skoob`;
    await seedTag("bidi-tag", deceptive);
    await seedMedia({
      id: "a",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      tags: ["bidi-tag", "books"],
    });

    const markup = await renderGallery();

    // The tile renders, and its OTHER tag still does — so this is a targeted
    // drop rather than the whole item vanishing.
    expect(renderedTiles(markup)).toEqual([
      { id: "a", tags: ["books"] },
    ]);
    expect(markup).not.toContain(RTL_OVERRIDE);
    expect(markup).not.toContain(deceptive);
  });

  it("is looking for a character the database really holds", async () => {
    // The other half of the guard: without this, "the markup contains no
    // U+202E" would pass against a fixture that never stored one.
    const deceptive = `Food${RTL_OVERRIDE}skoob`;
    await seedTag("bidi-tag", deceptive);
    const stored = await prisma.tag.findUnique({ where: { slug: "bidi-tag" } });
    expect(stored?.name).toBe(deceptive);
    expect(stored?.name).toContain(RTL_OVERRIDE);
  });
});
