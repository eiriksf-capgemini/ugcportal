import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { advertisingLabelPublishRefusal } from "@/lib/advertising-disclosure";
import { commercialPublishRefusal } from "@/lib/alcohol-commerce";
import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
  migrationNames,
} from "@/lib/test-support/db";

/**
 * ugcportal-qnq9.2.1's migration
 * (prisma/migrations/20261006180000_add_commercial_link), against a REAL
 * database rather than a reading of the SQL — the same pairing each of the
 * four migrations before it has.
 *
 * It makes three claims about itself that its own comments are not evidence
 * for, and that the route tests do not reach:
 *
 *   1. "ONE NEW TABLE, NOTHING ALTERED AND NOTHING BACKFILLED." Not one
 *      column added to Media, MediaListing or BenefitSource, and not one
 *      existing row touched. Asserted as a diff of the whole schema and of
 *      the pre-existing row, rather than as three spot checks: the point of
 *      the claim is that there is nothing else, and only a diff can say that.
 *   2. "`networkOther` ... HAS NO DEFAULT", and it is the only nullable
 *      column. A `DEFAULT ''` would make "no name was given" and "the name is
 *      the empty string" the same row — the migration's own words for why
 *      that matters are that it "would do it in SQL, below the validator,
 *      where nothing would ever notice". Through the generated client nothing
 *      would: Prisma sends an explicit NULL, so a default is visible only to
 *      a RAW insert that omits the column. That is the shape
 *      advertising-disclosure-migration.test.ts exists for one table over.
 *   3. "an item that existed before this ran ... publishes exactly as it did
 *      before." Asked of the two publish gates that read advertising state,
 *      before the migration and again after it, so this is a comparison
 *      rather than an assertion about the present.
 *
 * Seeded through raw SQL because the generated client only knows the schema
 * as it is now.
 */

const MIGRATION = migrationNames().find((name) =>
  name.endsWith("_add_commercial_link"),
);

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const MEDIA_ID = "media-pre-commercial-link";
const BRAND_ID = "brand-pre-commercial-link";

type SchemaEntry = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

/** Every table, index and trigger the database holds, as SQLite describes it.
 * `sqlite_master` is the database's own account of its schema, so a column
 * added or a constraint rewritten anywhere shows up here as a changed `sql`. */
function schema(): Promise<SchemaEntry[]> {
  return prisma.$queryRawUnsafe<SchemaEntry[]>(
    `SELECT "type", "name", "tbl_name", "sql" FROM sqlite_master ORDER BY "type", "name"`,
  );
}

/** The pre-existing Media row exactly as it is stored, every column of it. */
function mediaRow(): Promise<Record<string, unknown>[]> {
  return prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM "Media" WHERE "id" = '${MEDIA_ID}'`,
  );
}

/**
 * The two publish gates that read this item's advertising state, answered
 * from the database.
 *
 * Both are pure functions over a projection, so this is the publish route's
 * own decision without its auth, its preview check or its HTTP shape — the
 * part of "still publishes" this migration could possibly have broken.
 */
async function publishGateAnswers() {
  const disclosure = await prisma.mediaAdvertisingDisclosure.findUnique({
    where: { mediaId: MEDIA_ID },
    select: {
      benefitReceived: true,
      label: true,
      benefitSource: { select: { alcoholLinked: true } },
    },
  });
  const listing = await prisma.mediaListing.findUnique({
    where: { mediaId: MEDIA_ID },
    select: { depictsAlcohol: true },
  });
  return {
    label: advertisingLabelPublishRefusal(disclosure),
    alcohol: commercialPublishRefusal({ disclosure, listing }),
  };
}

let schemaBefore: SchemaEntry[];
let mediaBefore: Record<string, unknown>[];
let gatesBefore: Awaited<ReturnType<typeof publishGateAnswers>>;

beforeAll(async () => {
  // Derived rather than hard-coded, but still asserted: a renamed migration
  // must fail loudly instead of silently applying everything and proving
  // nothing.
  expect(MIGRATION).toBeTruthy();

  await applyMigrations(prisma, { stopBefore: MIGRATION! });

  const seed = [
    `INSERT INTO "User" ("id","email","role","createdAt","updatedAt")
     VALUES ('owner-pre-commercial-link','owner@example.com','USER',0,0)`,
    // A published item with alt text and a preview — an item that was
    // perfectly publishable the day before this migration existed.
    `INSERT INTO "Media"
       ("id","userId","kind","key","previewKey","previewId","mimeType",
        "sizeBytes","originalName","altText","createdAt","publishedAt")
     VALUES ('${MEDIA_ID}','owner-pre-commercial-link','IMAGE',
             'media/owner-pre-commercial-link/glass.png',
             'previews/owner-pre-commercial-link/glass.webp',
             'preview-pre-commercial-link','image/png',2048,'glass.png',
             'An empty wine glass on a windowsill',0,0)`,
    // A brand with its §3.1a answer already recorded, so the raw INSERT
    // below has something to point its NOT NULL foreign key at.
    `INSERT INTO "BenefitSource"
       ("id","slug","name","alcoholLinked","createdAt","updatedAt")
     VALUES ('${BRAND_ID}','riedel','Riedel',0,0,0)`,
  ];
  for (const statement of seed) {
    await prisma.$executeRawUnsafe(statement);
  }

  schemaBefore = await schema();
  mediaBefore = await mediaRow();
  gatesBefore = await publishGateAnswers();

  await applyMigration(prisma, MIGRATION!);
  // Anything committed after this migration, so the generated client can read
  // the database at all. A no-op while this is the newest migration; it is
  // here so the next one does not break this file in a way that looks like a
  // defect in the migration under test. The schema diff below is what keeps
  // that catch-up honest — a later migration's DDL would show up in it.
  await applyMigrations(prisma, { startAfter: MIGRATION! });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-qnq9.2.1: adding the commercial link to an existing database", () => {
  it("adds the table and its two indexes, and changes nothing else in the schema", async () => {
    const after = await schema();

    const key = (entry: SchemaEntry) => `${entry.type}:${entry.name}`;
    const before = new Map(schemaBefore.map((entry) => [key(entry), entry]));
    const added = after.filter((entry) => !before.has(key(entry)));

    // Exactly what this migration brings into existence, and nothing else:
    // the table, the foreign-key index the ON DELETE RESTRICT needs, the
    // one-destination-per-item unique index — and the index SQLite itself
    // creates for a TEXT PRIMARY KEY, which the migration does not write and
    // is listed here because the assertion is a complete diff rather than a
    // list of the entries somebody expected.
    expect(added.map(key).sort()).toEqual([
      "index:CommercialLink_benefitSourceId_idx",
      "index:CommercialLink_mediaId_url_key",
      // The catch-up above, showing up exactly as its own comment says a
      // later migration's DDL would: 20261008200000 (ugcportal-15r) adds the
      // MediaAttestation table, its foreign-key index, its one-per-file
      // unique index, and SQLite's own autoindex for the TEXT PRIMARY KEY.
      // Listed rather than filtered out, because the value of this
      // assertion is that it is a COMPLETE diff — a later migration that
      // quietly altered CommercialLink or Media would be invisible in a
      // version of this list that only named what somebody expected.
      "index:MediaAttestation_attestedByUserId_idx",
      "index:MediaAttestation_mediaId_key",
      "index:sqlite_autoindex_CommercialLink_1",
      "index:sqlite_autoindex_MediaAttestation_1",
      "table:CommercialLink",
      "table:MediaAttestation",
    ]);

    // Nothing dropped, and no pre-existing table or index redefined — which
    // is the half a "does CommercialLink exist" check would miss. A column
    // added to Media, or a foreign key rewritten on BenefitSource, changes
    // the stored `sql` for that entry and fails here by name.
    const afterKeys = new Set(after.map(key));
    expect([...before.keys()].filter((k) => !afterKeys.has(k))).toEqual([]);
    for (const entry of after) {
      if (!before.has(key(entry))) continue;
      expect(entry.sql, `${key(entry)} was redefined`).toBe(
        before.get(key(entry))!.sql,
      );
    }
  });

  it("leaves the pre-existing item's row byte-for-byte as it was", async () => {
    // Every column, not a chosen few: "nothing backfilled" is a claim about
    // the whole row.
    expect(await mediaRow()).toEqual(mediaBefore);
  });

  it("gives the pre-existing item no commercial links, and mints no rows", async () => {
    const media = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { commercialLinks: { select: { id: true } } },
    });

    expect(media.commercialLinks).toEqual([]);
    expect(await prisma.commercialLink.count()).toBe(0);
  });

  it("publishes exactly as it did before", async () => {
    // Claim 3, as a comparison with the answers taken before the migration
    // ran rather than as an assertion that they are null now. Both gates
    // answered null then; a migration that had added a commercial-link
    // column to the disclosure, or backfilled a benefit, would change one of
    // them.
    expect(await publishGateAnswers()).toEqual(gatesBefore);
    expect(gatesBefore).toEqual({ label: null, alcohol: null });
  });
});

describe("the columns the write path depends on", () => {
  it("stores networkOther as NULL when a raw INSERT omits it", async () => {
    // Through a RAW insert, deliberately: the generated client sends an
    // explicit NULL for an omitted nullable column, so a `DEFAULT ''` on it
    // would never show through `prisma.commercialLink.create`. It would show
    // here.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "CommercialLink"
         ("id","mediaId","url","network","benefitSourceId","updatedAt")
       VALUES ('link-default-probe','${MEDIA_ID}',
               'https://track.adtraction.com/t/t?a=1','ADTRACTION',
               '${BRAND_ID}',0)`,
    );

    const row = await prisma.commercialLink.findUniqueOrThrow({
      where: { id: "link-default-probe" },
      select: { networkOther: true, network: true },
    });

    // NULL rather than "", which is what keeps "no name was given" and "the
    // name is the empty string" two different rows — the second is a state
    // the validator refuses, and a SQL default would create it below the
    // validator.
    expect(row.networkOther).toBeNull();
    expect(row.network).toBe("ADTRACTION");

    await prisma.commercialLink.delete({ where: { id: "link-default-probe" } });
  });

  it("declares networkOther as the only nullable column, with no default", async () => {
    // The DDL itself, not just its effect on the one row above: a DEFAULT
    // added later would answer for every FUTURE insert, and the row-level
    // probe would not notice.
    const columns = await prisma.$queryRawUnsafe<
      { name: string; dflt_value: string | null; notnull: number }[]
    >(`PRAGMA table_info("CommercialLink")`);

    const nullable = columns
      .filter((column) => column.notnull === 0)
      .map((column) => column.name);
    expect(nullable).toEqual(["networkOther"]);

    const column = columns.find((row) => row.name === "networkOther");
    expect(column).toBeTruthy();
    expect(column!.dflt_value).toBeNull();
  });
});
