import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The bounded tag vocabulary the upload page offers (ugcportal-jsc, round-1
 * review finding).
 *
 * AGAINST A REAL DATABASE, and that is the whole reason this is a separate
 * file from src/lib/tags.test.ts, which is pure. `take` and `orderBy` are
 * instructions to SQLite: a mocked `findMany` that records its arguments
 * proves the code asked for a bound, not that fewer rows come back, and
 * certainly not that the RIGHT ones do. The ordering is the half that makes
 * the cap worth anything, and only a real query can be wrong about it.
 *
 * The finding, restated so the fixtures below read as the thing they are:
 * `resolveTagRows` creates a row for any valid name, both writers are
 * reachable by any authenticated account, sign-in has no allowlist
 * (ugcportal-egp), and nothing deletes a tag — so the table has no ceiling,
 * and an unbounded read rendered one-checkbox-per-row made /upload a denial
 * of service on itself.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { MAX_PICKER_TAGS, listPickerTags } = await import("@/lib/tags");

/** The right-to-left override, by code point — see src/lib/tags.test.ts. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);

/**
 * The four subjects the migration seeds, in the order it inserts them.
 *
 * Spelled here so the assertions below are about the shipped vocabulary
 * rather than about whatever the test happened to create — if the seed is
 * ever changed, "the seeded subjects survive" has to be updated on purpose.
 */
const SEEDED = ["food", "wine-drink", "technology", "books"];

/**
 * Creates a tag as a LATER writer would.
 *
 * `createdAt` is set explicitly and far in the future rather than left to
 * default, because the seeded rows and anything created in the same second
 * would otherwise share a timestamp and the ordering assertion would be
 * decided by the `id` tiebreak instead of by age — which is a real property,
 * but not the one being tested.
 */
async function mintTag(slug: string, name = slug, minutesLater = 1) {
  await prisma.tag.create({
    data: {
      slug,
      name,
      createdAt: new Date(Date.UTC(2030, 0, 1, 0, minutesLater)),
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
  // Back to just the seeded four, which is what a fresh deployment has.
  await prisma.tag.deleteMany({ where: { slug: { notIn: SEEDED } } });
});

describe("the seeded vocabulary", () => {
  it("is the four subjects in use, and the migration really created them", async () => {
    /*
     * Guards every fixture below. If the seed ever stopped applying, "the
     * seeded subjects survive a flood" would pass against an empty result
     * and mean nothing.
     */
    const tags = await listPickerTags();
    expect(tags.map((tag) => tag.slug).sort()).toEqual([...SEEDED].sort());
    expect(tags.map((tag) => tag.name).sort()).toEqual([
      "Books",
      "Food",
      "Technology",
      "Wine & drink",
    ]);
  });

  it("discloses the name and the slug, and never Tag.id", async () => {
    for (const tag of await listPickerTags()) {
      expect(Object.keys(tag).sort()).toEqual(["name", "slug"]);
    }
  });
});

describe("the read is bounded", () => {
  it("returns at most MAX_PICKER_TAGS however many rows exist", async () => {
    for (let index = 0; index < MAX_PICKER_TAGS * 2; index += 1) {
      await mintTag(`minted-${index}`, `Minted ${index}`, index + 1);
    }

    const tags = await listPickerTags();

    // Guards the guard: the flood really is in the table, so the cap below
    // is a fact about the query rather than about an empty fixture.
    expect(await prisma.tag.count()).toBeGreaterThan(MAX_PICKER_TAGS);
    expect(tags).toHaveLength(MAX_PICKER_TAGS);
  });

  it("keeps the seeded subjects when a later writer floods the table", async () => {
    /*
     * THE FIXTURE THAT MAKES THE ORDERING TESTABLE. Every minted name sorts
     * BEFORE the seeded ones alphabetically, and there are more of them than
     * the cap — so with `orderBy: { slug: "asc" }` (which is what
     * MEDIA_TAGS_SELECT uses, and what this originally reached for) the
     * result is twenty-four rows of "aaa-*" and not one real subject. The
     * page would no longer melt and would be exactly as unusable, which is
     * the failure a `take` alone would have hidden.
     */
    for (let index = 0; index < MAX_PICKER_TAGS * 2; index += 1) {
      await mintTag(`aaa-${index}`, `Aaa ${index}`, index + 1);
    }

    const slugs = (await listPickerTags()).map((tag) => tag.slug);

    for (const seeded of SEEDED) {
      expect(slugs).toContain(seeded);
    }
  });

  it("orders oldest-first, which a later writer cannot choose", async () => {
    await mintTag("zzz-new", "Zzz new", 5);

    const slugs = (await listPickerTags()).map((tag) => tag.slug);

    // The seeds come first because the migration inserted them first, not
    // because of how they are spelled.
    expect(slugs.slice(0, SEEDED.length).sort()).toEqual([...SEEDED].sort());
    expect(slugs.at(-1)).toBe("zzz-new");
  });

  it("still offers a genuinely added subject while there is room", async () => {
    // The bound must not make the vocabulary unextendable — "adding a fifth
    // is not a migration" is the property the Tag table exists for.
    await mintTag("ceramics", "Ceramics");

    expect((await listPickerTags()).map((tag) => tag.slug)).toContain(
      "ceramics",
    );
  });
});

describe("the read is filtered", () => {
  it("drops a name carrying a bidi override (K5, third end)", async () => {
    /*
     * The picker is the third surface that renders `Tag.name`, after the
     * gallery grid and the lightbox caption, and it was the one without the
     * drop. The rationale `toGalleryTags` gives applies verbatim: rows can
     * predate a validator, and any authenticated account can mint a tag.
     *
     * Created directly, because the write path refuses this name — which is
     * what makes this the only way to construct the case, and also why the
     * case is worth covering rather than assumed away.
     */
    const deceptive = `Food${RTL_OVERRIDE}skoob`;
    await mintTag("bidi-tag", deceptive);

    const tags = await listPickerTags();

    expect(tags.map((tag) => tag.slug)).not.toContain("bidi-tag");
    expect(tags.map((tag) => tag.name)).not.toContain(deceptive);
    // And the ordinary subjects are untouched — a targeted drop, not the
    // whole vocabulary collapsing because one row was bad.
    expect(tags).toHaveLength(SEEDED.length);
  });

  it("is looking for a character the database really holds", async () => {
    // Guards the guard: without this, "the vocabulary contains no U+202E"
    // would pass against a fixture that never stored one.
    const deceptive = `Food${RTL_OVERRIDE}skoob`;
    await mintTag("bidi-tag", deceptive);

    const stored = await prisma.tag.findUnique({ where: { slug: "bidi-tag" } });
    expect(stored?.name).toBe(deceptive);
    expect(stored?.name).toContain(RTL_OVERRIDE);
  });

  it("drops an unsafe SLUG as well as an unsafe name", async () => {
    // The slug reaches the DOM too, as the checkbox's `value`. Testing only
    // the name would leave that attribute unguarded — the same pairing
    // `toGalleryTags` makes for `data-gallery-tag`.
    await mintTag(`ceramics${RTL_OVERRIDE}`, "Ceramics");

    expect((await listPickerTags()).map((tag) => tag.name)).not.toContain(
      "Ceramics",
    );
  });

  it("keeps a name containing HTML, because React escapes that", () => {
    // Same division as everywhere else in this feature: markup is the
    // renderer's problem and is handled; the characters escaping does NOT
    // neutralise are dropped. Dropping markup here would remove a subject
    // somebody legitimately named.
    return mintTag("markup-tag", "<b>food</b>").then(async () => {
      expect((await listPickerTags()).map((tag) => tag.name)).toContain(
        "<b>food</b>",
      );
    });
  });
});
