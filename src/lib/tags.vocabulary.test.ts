import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The vocabulary the upload page offers (ugcportal-jsc, rounds 1–3).
 *
 * AGAINST A REAL DATABASE, and that is why this is a separate file from
 * src/lib/tags.test.ts, which is pure. `where`, `take` and `orderBy` are
 * instructions to SQLite: a mocked `findMany` that records its arguments
 * proves the code asked for something, not that fewer rows come back, and
 * certainly not that the right ones do.
 *
 * The finding this file is mostly about, restated so the fixtures read as
 * the thing they are: the picker is a SHARED surface, and any authenticated
 * account can mint a Tag row by naming it on its own upload (sign-in has no
 * allowlist — ugcportal-egp). Round 1 bounded how many rows were rendered.
 * That was not enough: only four subjects ship, so the rest of the window
 * was free and first-come, and nothing in this product deletes a tag. What
 * bounds it now is `curated`.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { MAX_PICKER_TAGS, listPickerTags, resolveTagRows } = await import(
  "@/lib/tags"
);

/** The right-to-left override, by code point — see src/lib/tags.test.ts. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);

/**
 * The four subjects the migration seeds, in the order it inserts them.
 *
 * Spelled here so the assertions below are about the shipped vocabulary
 * rather than whatever the test happened to create — if the seed changes,
 * these have to be updated on purpose.
 */
const SEEDED = ["food", "wine-drink", "technology", "books"];

/**
 * Creates a tag as a LATER writer would, uncurated by default.
 *
 * `createdAt` is set explicitly and far in the future so age, not the `id`
 * tiebreak, decides the ordering assertions. The seeds carry literal 2026-01
 * timestamps from the migration, so anything here is unambiguously newer.
 */
async function mintTag(
  slug: string,
  name = slug,
  { curated = false, minutesLater = 1 } = {},
) {
  await prisma.tag.create({
    data: {
      slug,
      name,
      curated,
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
  await prisma.media.deleteMany({});
  await prisma.tag.deleteMany({ where: { slug: { notIn: SEEDED } } });
});

describe("the seeded vocabulary", () => {
  it("is the four subjects in use, and the migration really curated them", async () => {
    /*
     * Guards every fixture below. If the seed stopped applying — or stopped
     * setting `curated` — "an uncurated tag is not offered" would pass
     * against an empty result and mean nothing.
     */
    const tags = await listPickerTags();
    expect(tags.map((tag) => tag.slug).sort()).toEqual([...SEEDED].sort());
    expect(tags.map((tag) => tag.name).sort()).toEqual([
      "Books",
      "Food",
      "Technology",
      "Wine & drink",
    ]);
    expect(await prisma.tag.count({ where: { curated: true } })).toBe(4);
  });

  it("discloses the name and the slug, and never Tag.id", async () => {
    for (const tag of await listPickerTags()) {
      expect(Object.keys(tag).sort()).toEqual(["name", "slug"]);
    }
  });

  it("stores a timestamp in the format Prisma reads back unshifted", async () => {
    /*
     * The seed writes an explicit ISO literal rather than letting SQLite's
     * DEFAULT CURRENT_TIMESTAMP produce `2026-09-28 10:34:39`. Two reasons,
     * and this asserts the one with a silent failure mode: V8 parses the
     * space-separated form as SERVER-LOCAL time, so a seeded row read back
     * through Prisma came out shifted by the host's UTC offset.
     *
     * Asserted against a fixed instant rather than "is a Date", because the
     * bug produced a perfectly valid Date — just the wrong one, and only on
     * a host that is not UTC.
     */
    const food = await prisma.tag.findUnique({ where: { slug: "food" } });
    expect(food?.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("only curated subjects are offered", () => {
  it("does not offer a tag an uploader minted", async () => {
    /*
     * THE ROUND-3 MEDIUM, in one assertion. Before `curated`, this row took
     * the fifth-oldest slot and became a permanent checkbox on every user's
     * upload page — with no un-mint path anywhere in the product.
     */
    await mintTag("defacement", "Buy cheap watches at");

    const slugs = (await listPickerTags()).map((tag) => tag.slug);

    expect(slugs).not.toContain("defacement");
    expect(slugs.sort()).toEqual([...SEEDED].sort());
  });

  it("does not offer twenty of them either", async () => {
    // The scenario as described: the free slots filled in a loop. The point
    // is that there are no free slots to fill, not that there are few.
    for (let index = 0; index < MAX_PICKER_TAGS; index += 1) {
      await mintTag(`minted-${index}`, `Minted ${index}`, {
        minutesLater: index + 1,
      });
    }

    // Guards the guard: the rows really are in the table.
    expect(await prisma.tag.count()).toBeGreaterThan(MAX_PICKER_TAGS);
    expect(await listPickerTags()).toHaveLength(SEEDED.length);
  });

  it("MINTING STILL WORKS — it just does not reach everyone's form", async () => {
    /*
     * The other half of the decision, and the one that keeps the bead's
     * "adding a fifth subject is not a migration" true. An uploader naming a
     * new subject still gets a row, and still sees it under their own
     * photograph; `curated` governs the shared control only.
     */
    await resolveTagRows([{ name: "Ceramics", slug: "ceramics" }]);

    const created = await prisma.tag.findUnique({ where: { slug: "ceramics" } });
    expect(created?.name).toBe("Ceramics");
    expect(created?.curated).toBe(false);
    expect((await listPickerTags()).map((tag) => tag.slug)).not.toContain(
      "ceramics",
    );
  });

  it("offers a subject once it IS curated, with no migration", async () => {
    // Curating is a column value, so extending the vocabulary stays a data
    // change. Who may do it is ugcportal-x0l's.
    await mintTag("ceramics", "Ceramics", { curated: true });

    expect((await listPickerTags()).map((tag) => tag.slug)).toContain(
      "ceramics",
    );
  });
});

describe("the read is still bounded and ordered", () => {
  it("returns at most MAX_PICKER_TAGS even if everything is curated", async () => {
    // Curation is the first line; the cap is the second. It matters if
    // curation is ever widened to something more generous than a migration.
    for (let index = 0; index < MAX_PICKER_TAGS * 2; index += 1) {
      await mintTag(`curated-${index}`, `Curated ${index}`, {
        curated: true,
        minutesLater: index + 1,
      });
    }

    expect(await prisma.tag.count({ where: { curated: true } })).toBeGreaterThan(
      MAX_PICKER_TAGS,
    );
    expect(await listPickerTags()).toHaveLength(MAX_PICKER_TAGS);
  });

  it("keeps the seeded subjects at the front of the window", async () => {
    /*
     * Every name here sorts BEFORE the seeded ones alphabetically, and there
     * are more of them than the cap — so an alphabetical order would drop
     * all four real subjects off the end. The seeds carry 2026-01-01
     * timestamps from the migration, so oldest-first keeps them.
     */
    for (let index = 0; index < MAX_PICKER_TAGS; index += 1) {
      await mintTag(`aaa-${index}`, `Aaa ${index}`, {
        curated: true,
        minutesLater: index + 1,
      });
    }

    const slugs = (await listPickerTags()).map((tag) => tag.slug);
    for (const seeded of SEEDED) {
      expect(slugs).toContain(seeded);
    }
  });

  it("orders oldest-first, by a real chronological comparison", async () => {
    /*
     * The seeds' timestamps are ISO literals now, and Prisma writes ISO, so
     * this is a like-for-like comparison rather than the byte accident the
     * previous version of this depended on (a space sorting before `T`).
     */
    await mintTag("zzz-new", "Zzz new", { curated: true, minutesLater: 5 });

    const slugs = (await listPickerTags()).map((tag) => tag.slug);

    expect(slugs.slice(0, SEEDED.length).sort()).toEqual([...SEEDED].sort());
    expect(slugs.at(-1)).toBe("zzz-new");
  });
});

describe("the read is filtered", () => {
  it("drops a curated name carrying a bidi override (K5, third end)", async () => {
    /*
     * Curation is a decision about WHICH subjects to offer, not a promise
     * that their text is safe — a curated row is a trusted decision, not
     * trusted text. So the denylist still applies, and the fixture has to
     * be curated or it would be excluded for the wrong reason.
     *
     * Created directly, because the write path refuses this name: that is
     * what makes this the only way to construct the case, and also why the
     * case is worth covering rather than assumed away.
     */
    const deceptive = `Food${RTL_OVERRIDE}skoob`;
    await mintTag("bidi-tag", deceptive, { curated: true });

    const tags = await listPickerTags();

    expect(tags.map((tag) => tag.slug)).not.toContain("bidi-tag");
    expect(tags.map((tag) => tag.name)).not.toContain(deceptive);
    // A targeted drop, not the whole vocabulary collapsing over one row.
    expect(tags).toHaveLength(SEEDED.length);
  });

  it("is looking for a character the database really holds", async () => {
    // Guards the guard: without this, "the vocabulary contains no U+202E"
    // would pass against a fixture that never stored one.
    const deceptive = `Food${RTL_OVERRIDE}skoob`;
    await mintTag("bidi-tag", deceptive, { curated: true });

    const stored = await prisma.tag.findUnique({ where: { slug: "bidi-tag" } });
    expect(stored?.name).toBe(deceptive);
    expect(stored?.name).toContain(RTL_OVERRIDE);
  });

  it("drops an unsafe SLUG as well as an unsafe name", async () => {
    // The slug reaches the DOM too, as the checkbox's `value`. Testing only
    // the name would leave that attribute unguarded.
    await mintTag(`ceramics${RTL_OVERRIDE}`, "Ceramics", { curated: true });

    expect((await listPickerTags()).map((tag) => tag.name)).not.toContain(
      "Ceramics",
    );
  });

  it("keeps a name containing HTML, because React escapes that", async () => {
    // Same division as everywhere else in this feature: markup is the
    // renderer's problem and is handled; the characters escaping does NOT
    // neutralise are dropped. Dropping markup here would remove a subject
    // somebody legitimately curated.
    await mintTag("markup-tag", "<b>food</b>", { curated: true });

    expect((await listPickerTags()).map((tag) => tag.name)).toContain(
      "<b>food</b>",
    );
  });
});

describe("tag rows do not outlive the write they were created for", () => {
  /**
   * The round-3 medium on the upload path, at the level the mechanism
   * actually lives.
   *
   * Both writers create Tag rows and then write a Media row pointing at
   * them. If the second statement fails, anything the first minted is
   * permanent — nothing in this product deletes a tag, and the upload
   * route's compensating cleanup only removes S3 objects. The fix is that
   * the two share a transaction; this asserts that the transaction really
   * does take the tag rows with it, rather than that the route calls
   * `$transaction`.
   */
  it("rolls the new tag rows back when the write after them fails", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await resolveTagRows([{ name: "Ceramics", slug: "ceramics" }], tx);
        // Proof the tag row exists INSIDE the transaction, so the assertion
        // after it is about a rollback and not about a write that never
        // happened.
        expect(
          await tx.tag.findUnique({ where: { slug: "ceramics" } }),
        ).not.toBeNull();
        throw new Error("media.create failed");
      }),
    ).rejects.toThrow("media.create failed");

    expect(
      await prisma.tag.findUnique({ where: { slug: "ceramics" } }),
    ).toBeNull();
  });

  it("leaves a tag that already existed alone when the write fails", async () => {
    /*
     * The other side, and the reason a transaction beats "delete what you
     * created on the way out": rolling back must not remove a subject that
     * was already there and that other media may point at. `resolveTagRows`
     * upserts, so a pre-existing row is found rather than created.
     */
    await expect(
      prisma.$transaction(async (tx) => {
        await resolveTagRows([{ name: "Food", slug: "food" }], tx);
        throw new Error("media.create failed");
      }),
    ).rejects.toThrow();

    expect(
      await prisma.tag.findUnique({ where: { slug: "food" } }),
    ).not.toBeNull();
  });

  it("commits the tag rows when the write after them succeeds", async () => {
    // The happy path, so the rollback tests are not passing because the
    // transaction never commits anything.
    await prisma.user.create({
      data: { id: "owner-tx", email: "tx@example.com", role: "USER" },
    });

    await prisma.$transaction(async (tx) => {
      const refs = await resolveTagRows(
        [{ name: "Ceramics", slug: "ceramics" }],
        tx,
      );
      await tx.media.create({
        data: {
          id: "media-tx",
          userId: "owner-tx",
          kind: "IMAGE",
          key: "media/owner-tx/a.jpg",
          previewKey: "previews/owner-tx/a.webp",
          previewId: "pv-tx",
          mimeType: "image/jpeg",
          sizeBytes: 1,
          originalName: "a.jpg",
          tags: { connect: refs },
        },
      });
    });

    expect(
      await prisma.tag.findUnique({ where: { slug: "ceramics" } }),
    ).not.toBeNull();
    const media = await prisma.media.findUnique({
      where: { id: "media-tx" },
      select: { tags: { select: { slug: true } } },
    });
    expect(media?.tags.map((tag) => tag.slug)).toEqual(["ceramics"]);

    await prisma.media.deleteMany({});
    await prisma.user.deleteMany({});
  });
});
