import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
  migrationNames,
} from "@/lib/test-support/db";

/**
 * `@/lib/public-media` -> `@/lib/media-access` imports `@/lib/auth`, which
 * pulls in next-auth and, through it, `next/server` — unimportable from a
 * plain node test run (see src/app/page.test.tsx's own copy of this guard
 * for the full rationale). This test never reaches the session, so the
 * mock just needs to exist, not to answer anything in particular.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the public feed must not consult the session");
  },
}));

/**
 * ugcportal-ei7: the public feed's `@@index([createdAt, id])` became a
 * PARTIAL index — `WHERE publishedAt IS NOT NULL AND previewKey IS NOT NULL
 * AND previewId IS NOT NULL` — so a page's cost tracks the published,
 * preview-bearing subset of Media rather than the whole table. See the index
 * comment in prisma/schema.prisma for the measured before/after.
 *
 * K1 (named index, re-measured scan): covered by the EXPLAIN QUERY PLAN /
 * timing comparison recorded in the bead and the schema comment, which needs
 * a much bigger seed than is reasonable to carry in CI. What this file checks
 * instead is K3, the thing that regresses silently and cheaply if this
 * migration and the feed's own filter ever drift apart:
 *
 *   K2 ("`prisma migrate diff ... --exit-code` exits 0") was run and verified
 *   directly during this change (recorded in the PR) — NOT re-asserted here,
 *   and NOT currently wired into CI as its own step. This repo's CI quality
 *   job (.github/workflows/ci.yml) runs lint/test/build/typecheck but no
 *   `migrate diff` check; adding one is a CI change, out of scope for this
 *   bead (filed separately, see ugcportal-ei7's notes) rather than claimed
 *   here as already covered.
 *
 *   K3: the index's WHERE clause must name exactly the predicate the feed
 *   applies, not a subset or a superset of it. A narrower index WHERE than
 *   the feed's filter cannot break correctness — SQLite re-checks every
 *   predicate against the row regardless of whether a partial index narrowed
 *   the scan — but it silently defeats the point of this migration: rows the
 *   feed is supposed to serve cheaply would fall outside the index and the
 *   query would fall back to a full scan to find them, which is exactly the
 *   cost this index exists to remove. This file asserts the WHERE clause
 *   directly off `sqlite_master`, not off a comment, and then proves the
 *   predicate the index now embeds still agrees with reality by running the
 *   real feed function end to end against rows built to disagree with each
 *   of the three predicates individually.
 */

const PARTIAL_INDEX_MIGRATION = migrationNames().find((name) =>
  name.endsWith("_partial_index_public_feed"),
);
if (!PARTIAL_INDEX_MIGRATION) {
  throw new Error(
    "No migration named *_partial_index_public_feed found — ugcportal-ei7's migration is missing or was renamed.",
  );
}

// Created, and DATABASE_URL pointed at it, BEFORE anything imports
// `@/lib/prisma` — directly or (as `@/lib/public-media` does, through
// `@/lib/media-access`) transitively. The prisma client module builds its
// adapter from `process.env.DATABASE_URL` once, at import time, and caches
// the instance on `globalThis`; importing it in the other order would bind
// this test to the repo's own dev.db instead of a fresh temporary one.
const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { listPublicMedia, publicMediaListingUrl, PUBLIC_MEDIA_SCOPE } =
  await import("@/lib/public-media");

/**
 * The predicate set the handler actually sends, read off `PUBLIC_MEDIA_SCOPE`
 * itself rather than hand-copied — so if a future change adds, removes or
 * renames a filter on the feed and the index is not updated to match, this
 * derivation (and the assertion below that uses it) moves with the real
 * scope instead of silently continuing to check a stale, hand-written list.
 *
 * Plain `Object.keys`, not a filter re-deriving "which keys mean not-null" —
 * `MediaAnonymousScope` (src/lib/media-listing.ts) is the type that already
 * decides that, and it is the deciding type on purpose: every key it declares
 * — `publishedAt`, `previewKey`, `previewId` — is typed `{ not: null }`, and
 * the one key that isn't a not-null filter, `userId`, is typed `?: never`, so
 * `PUBLIC_MEDIA_SCOPE` (typed as `MediaAnonymousScope`) cannot assign it at
 * all; `Object.keys` never sees it because nothing can give it a value. A
 * filter re-checking each value's shape here would be re-deciding, in a second
 * place, something the type already decided in one.
 */
const PUBLIC_FEED_NOT_NULL_COLUMNS = Object.keys(PUBLIC_MEDIA_SCOPE).sort();

/** One Media row, with every column this test varies spelled out. */
function mediaRow(options: {
  id: string;
  published: boolean;
  previewKey: string | null;
  previewId: string | null;
  createdAt: string;
}): string {
  const { id, published, previewKey, previewId, createdAt } = options;
  const publishedAt = published ? `'${createdAt}'` : "NULL";
  const previewKeyValue = previewKey === null ? "NULL" : `'${previewKey}'`;
  const previewIdValue = previewId === null ? "NULL" : `'${previewId}'`;
  return `INSERT INTO "Media"
     ("id", "userId", "kind", "key", "previewKey", "previewId",
      "mimeType", "sizeBytes", "originalName", "altText", "createdAt", "publishedAt")
   VALUES
     ('${id}', 'user-feed-index', 'IMAGE', 'media/user-feed-index/${id}.png',
      ${previewKeyValue}, ${previewIdValue},
      'image/png', 1024, '${id}.png', 'alt text for ${id}', '${createdAt}', ${publishedAt})`;
}

beforeAll(async () => {
  await applyMigrations(prisma, { stopBefore: PARTIAL_INDEX_MIGRATION });

  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "createdAt", "updatedAt")
     VALUES ('user-feed-index', 'feed-index@example.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );

  // Four rows, each disagreeing with exactly one of the feed's three
  // predicates, plus one row that satisfies all three — the row the feed
  // must still return once the index exists.
  await prisma.$executeRawUnsafe(
    mediaRow({
      id: "media-qualifies",
      published: true,
      previewKey: "previews/user-feed-index/media-qualifies.webp",
      previewId: "preview-media-qualifies",
      createdAt: "2026-01-04T00:00:03.000Z",
    }),
  );
  await prisma.$executeRawUnsafe(
    mediaRow({
      id: "media-unpublished",
      published: false,
      previewKey: "previews/user-feed-index/media-unpublished.webp",
      previewId: "preview-media-unpublished",
      createdAt: "2026-01-04T00:00:02.000Z",
    }),
  );
  await prisma.$executeRawUnsafe(
    mediaRow({
      id: "media-no-preview-key",
      published: true,
      previewKey: null,
      previewId: "preview-media-no-preview-key",
      createdAt: "2026-01-04T00:00:01.000Z",
    }),
  );
  await prisma.$executeRawUnsafe(
    mediaRow({
      id: "media-no-preview-id",
      published: true,
      previewKey: "previews/user-feed-index/media-no-preview-id.webp",
      previewId: null,
      createdAt: "2026-01-04T00:00:00.000Z",
    }),
  );

  await applyMigration(prisma, PARTIAL_INDEX_MIGRATION);
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("the public feed's partial index (ugcportal-ei7)", () => {
  it("exists on Media(createdAt, id), named the same as the index it replaces, and with no second index doing the same job", async () => {
    const rows = await prisma.$queryRawUnsafe<{ name: string; sql: string }[]>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Media' AND name = 'Media_createdAt_id_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sql).toContain('"createdAt", "id"');

    // The migration must REPLACE the old plain index, not sit alongside it
    // under a different name — the bead is explicit that a hand-authored
    // migration must not leave two indexes doing the same job. Any other
    // index on Media built over (createdAt, id), whatever it's called, would
    // be exactly that: a leftover or a duplicate.
    const createdAtIdIndexes = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Media' AND sql LIKE '%("createdAt", "id")%'`,
    );
    expect(createdAtIdIndexes.map((row) => row.name)).toEqual([
      "Media_createdAt_id_idx",
    ]);
  });

  it("carries a WHERE clause naming EXACTLY the feed's predicate set — not hand-copied, but derived from PUBLIC_MEDIA_SCOPE (K3)", async () => {
    // Fails first if the fixture itself drifted: three columns is what this
    // test is built to exercise, and a change here would silently change
    // what's being asserted below.
    expect(PUBLIC_FEED_NOT_NULL_COLUMNS).toEqual([
      "previewId",
      "previewKey",
      "publishedAt",
    ]);

    const rows = await prisma.$queryRawUnsafe<{ sql: string }[]>(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Media' AND name = 'Media_createdAt_id_idx'`,
    );
    const sql = rows[0]?.sql ?? "";

    for (const column of PUBLIC_FEED_NOT_NULL_COLUMNS) {
      expect(sql).toContain(`${column} IS NOT NULL`);
    }
    // Exactly that many — not a superset either. A fourth `IS NOT NULL`
    // clause the handler never asked for would quietly over-narrow the
    // index: rows the feed is willing to serve would fall outside it.
    expect(sql.match(/IS NOT NULL/g)).toHaveLength(
      PUBLIC_FEED_NOT_NULL_COLUMNS.length,
    );
  });

  it("the real feed returns exactly the row that satisfies all three predicates, and none of the three that each fail one", async () => {
    const result = await listPublicMedia(publicMediaListingUrl());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.page.items.map((item) => item.id);
    expect(ids).toEqual(["media-qualifies"]);
    expect(ids).not.toContain("media-unpublished");
    expect(ids).not.toContain("media-no-preview-key");
    expect(ids).not.toContain("media-no-preview-id");
  });
});
