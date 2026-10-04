import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The "portfolio" tag seed migration
 * (prisma/migrations/20261004150000_seed_portfolio_tag), against a REAL
 * database rather than asserting on the SQL file's text — same reasoning
 * src/lib/media-alt-text-migration.test.ts gives for its own migration.
 *
 * Round-4 review: a real deployment hazard, not a hypothetical one. `Tag.
 * slug` is UNIQUE, and any account permitted to sign in can mint a tag by
 * naming it on their own upload (src/lib/tags.ts) — so an uploader could
 * already have typed "Portfolio" as a free-text subject, on an instance
 * that has been live a while, before this migration ever runs. This file
 * seeds exactly that row — a free-minted, uncurated "portfolio" tag, with
 * an id this migration did not choose — BEFORE applying the migration under
 * test, and asserts it is curated in place rather than the migration
 * failing outright with a UNIQUE constraint violation.
 */

const MIGRATION_NAME = "20261004150000_seed_portfolio_tag";
const FREE_MINTED_TAG_ID = "tag-free-minted-portfolio";

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

beforeAll(async () => {
  // Stop one migration short, so the seed migration under test has not run
  // yet — the real "before this migration" state.
  await applyMigrations(prisma, { stopBefore: MIGRATION_NAME });

  // The free mint: an uploader typed "Portfolio" as an ordinary subject tag
  // on their own upload, long before this migration shipped. `curated`
  // defaults to false, same as every tag any uploader mints themselves
  // (src/lib/tags.ts#resolveTagRows) — this is not a hand-picked edge case,
  // it is the ordinary shape a free mint takes.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Tag" ("id", "slug", "name", "curated", "createdAt")
     VALUES ('${FREE_MINTED_TAG_ID}', 'portfolio', 'Portfolio', false, '2026-09-01T00:00:00.000+00:00')`,
  );

  // Now run the migration under test, and only it.
  await applyMigration(prisma, MIGRATION_NAME);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("the portfolio tag seed migration, against a pre-existing free-minted row (round-4 review)", () => {
  it("does not fail, and does not create a second row for the same slug", async () => {
    const rows = await prisma.tag.findMany({ where: { slug: "portfolio" } });
    expect(rows).toHaveLength(1);
  });

  it("curates the EXISTING row in place, keeping its own id", async () => {
    const tag = await prisma.tag.findUniqueOrThrow({
      where: { slug: "portfolio" },
    });
    expect(tag.id).toBe(FREE_MINTED_TAG_ID);
    expect(tag.curated).toBe(true);
    expect(tag.name).toBe("Portfolio");
  });

  it("does not rewrite the row's own createdAt to the migration's seed date", async () => {
    // The row predates this migration; overwriting createdAt would silently
    // rewrite a fact this migration has no business changing.
    const tag = await prisma.tag.findUniqueOrThrow({
      where: { slug: "portfolio" },
    });
    expect(tag.createdAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});
