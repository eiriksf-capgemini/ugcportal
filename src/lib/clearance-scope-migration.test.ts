import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CURRENT_CHECKLIST_VERSION,
  MEDIA_GATE_SELECT,
  TRIAGE_FACTS,
  evaluateSellability,
} from "@/lib/resale-rights";
import { completeAttestationRow } from "@/lib/test-support/attestation";
import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
  migrationNames,
} from "@/lib/test-support/db";

/**
 * ugcportal-aqw, against a real database: the scope columns and what the
 * migration does to clearances that were recorded before they existed.
 *
 * Two separate claims, and the second is the one a reading of the SQL
 * cannot settle.
 *
 * THE SHAPE. `coversUploadsBefore` is NULLABLE WITH NO DEFAULT and
 * `coversFutureUploads` is NOT NULL DEFAULT false, and neither is an
 * accident. A `DEFAULT CURRENT_TIMESTAMP` on the cut-off — which is what a
 * `NOT NULL` column added to an existing table would have needed — would be
 * the database deciding, on every reviewer's behalf, that their clearance
 * reaches everything uploaded up to the moment the column was added. The
 * `false` default on the framework mark is the opposite choice for the same
 * reason: it is the narrow reading, and åvl § 67(2) says the wide one has
 * to be written down.
 *
 * THE BACKFILL. Rows written before this migration are given the instant
 * their reviewer actually signed (`reviewedAt`, falling back to
 * `createdAt`), because that is the only material they can have examined.
 * The alternative — leaving them NULL — would be correct in the fail-closed
 * direction and wrong in substance: a clearance signed in good faith over
 * files that existed at the time would stop covering any of them.
 */

const SCOPE_MIGRATION = migrationNames().find((name) =>
  name.endsWith("_add_clearance_upload_scope"),
);

/** When each seeded reviewer signed, in epoch milliseconds. */
const SIGNED_AT = Date.UTC(2026, 8, 20, 12, 0, 0);
/** A file that already existed when they signed. */
const UPLOADED_BEFORE = Date.UTC(2026, 8, 19, 9, 0, 0);
/** A file added afterwards, which no reviewer ever looked at. */
const UPLOADED_AFTER = Date.UTC(2026, 8, 21, 9, 0, 0);
/** When the unreviewed uploader's row was created. */
const ROW_CREATED_AT = Date.UTC(2026, 8, 10, 8, 0, 0);

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

async function gateUpload(id: string) {
  return prisma.media.findUniqueOrThrow({
    where: { id },
    select: MEDIA_GATE_SELECT,
  });
}

function columns() {
  return prisma.$queryRawUnsafe<
    { name: string; dflt_value: string | null; notnull: number }[]
  >(`PRAGMA table_info("ResaleRightsReview")`);
}

beforeAll(async () => {
  // Derived rather than hard-coded, but still asserted: a renamed migration
  // must fail loudly instead of silently applying everything and proving
  // nothing about the state before it ran.
  expect(SCOPE_MIGRATION).toBeTruthy();

  await applyMigrations(prisma, { stopBefore: SCOPE_MIGRATION! });

  /*
   * The world as it was before this bead: two clearances with no scope
   * column to record, and two uploads by the same cleared uploader that
   * differ in exactly one thing — when they were uploaded.
   *
   * Seeded through raw SQL because the generated client only knows the
   * schema as it is NOW, and would insist on the very columns this fixture
   * must not yet have.
   */
  const triageColumns = TRIAGE_FACTS.map((fact) => `"${fact.field}"`).join(",");
  const triageZeros = TRIAGE_FACTS.map(() => "0").join(",");
  const seed = [
    `INSERT INTO "User" ("id","email","role","createdAt","updatedAt")
     VALUES ('admin-1','admin@example.com','ADMIN',0,0),
            ('owner-1','owner@example.com','USER',0,0),
            ('owner-2','never-reviewed@example.com','USER',0,0)`,
    `INSERT INTO "Media"
       ("id","userId","kind","key","mimeType","sizeBytes","originalName","createdAt")
     VALUES ('media-before','owner-1','IMAGE','uploads/owner-1/a.jpg','image/jpeg',10,'a.jpg',${UPLOADED_BEFORE}),
            ('media-after','owner-1','IMAGE','uploads/owner-1/b.jpg','image/jpeg',10,'b.jpg',${UPLOADED_AFTER})`,
    // A reviewed uploader, and an uploader whose row exists without any
    // admin ever having decided on it (`reviewedAt` NULL — a SYSTEM revoke
    // produces exactly this). The second is what makes the COALESCE in the
    // backfill load-bearing rather than decorative.
    `INSERT INTO "ResaleRightsReview"
       ("id","uploaderUserId","status","route","checklistVersion","reviewedByUserId","reviewedAt","validUntil","productDecisionRef","createdAt","updatedAt")
     VALUES ('rev-1','owner-1','CLEARED','CONTRACT','${CURRENT_CHECKLIST_VERSION}','admin-1',${SIGNED_AT},NULL,'ugcportal-2eh',0,0),
            ('rev-2','owner-2','REVOKED',NULL,'${CURRENT_CHECKLIST_VERSION}',NULL,NULL,NULL,NULL,${ROW_CREATED_AT},0)`,
    `INSERT INTO "MediaListing"
       ("id","mediaId","priceCents","currency",${triageColumns},"triagedByUserId","triagedAt","createdAt","updatedAt")
     VALUES ('listing-1','media-before',24900,'NOK',${triageZeros},'admin-1',0,0,0),
            ('listing-2','media-after',24900,'NOK',${triageZeros},'admin-1',0,0,0)`,
  ];
  for (const statement of seed) {
    await prisma.$executeRawUnsafe(statement);
  }

  await applyMigration(prisma, SCOPE_MIGRATION!);
  // Anything committed after this migration, so the generated client can
  // read the database at all. A no-op while this is the newest migration;
  // it is here so the next one does not break this file in a way that looks
  // like a defect in the migration under test.
  await applyMigrations(prisma, { startAfter: SCOPE_MIGRATION! });

  // The attestations the gate needs before it will look at anything else.
  // Added after the migration, by the generated client, because they are
  // about the uploader's declaration and not about this bead.
  await prisma.mediaAttestation.create({
    data: completeAttestationRow("media-before", "owner-1"),
  });
  await prisma.mediaAttestation.create({
    data: { ...completeAttestationRow("media-after", "owner-1"), id: "att-2" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-aqw: the shape of the scope columns", () => {
  it("makes the cut-off nullable with no default", async () => {
    const all = await columns();
    // Guards every lookup below against passing on an empty result — a
    // renamed table would otherwise make them all vacuous.
    expect(all.length).toBeGreaterThan(10);

    const cutOff = all.find((row) => row.name === "coversUploadsBefore");
    expect(cutOff, "coversUploadsBefore is not a column").toBeTruthy();
    expect(cutOff!.notnull, "coversUploadsBefore is NOT NULL").toBe(0);
    // The one that matters. A `DEFAULT CURRENT_TIMESTAMP` here would stamp
    // every future row — including one written by a path that never
    // thought about scope — with a cut-off nobody decided.
    expect(cutOff!.dflt_value, "coversUploadsBefore has a default").toBeNull();
  });

  it("makes the framework mark NOT NULL, defaulting to the narrow reading", async () => {
    const framework = (await columns()).find(
      (row) => row.name === "coversFutureUploads",
    );
    expect(framework, "coversFutureUploads is not a column").toBeTruthy();
    expect(framework!.notnull, "coversFutureUploads is nullable").toBe(1);
    // `false`, not `true` and not absent: a row nobody has said anything
    // about covers no future work.
    expect(framework!.dflt_value).toBe("false");
  });
});

describe("ugcportal-aqw: what the backfill gives a clearance signed earlier", () => {
  it("anchors it to the instant the reviewer signed", async () => {
    const review = await prisma.resaleRightsReview.findUniqueOrThrow({
      where: { id: "rev-1" },
    });
    expect(review.coversUploadsBefore?.getTime()).toBe(SIGNED_AT);
    // Equal to `reviewedAt` TODAY, and that is a one-off starting value,
    // not a rule: `reviewedAt` is re-stamped on every later admin edit and
    // this column is not. The writer's own suite
    // (resale-rights-review.test.ts, ugcportal-aqw K2) is where the two are
    // held apart.
    expect(review.reviewedAt?.getTime()).toBe(SIGNED_AT);
  });

  it("falls back to the row's own createdAt when nobody ever reviewed it", async () => {
    // `reviewedAt` is NULL on this row, so a bare copy would have left the
    // cut-off NULL and the COALESCE is what fills it.
    const review = await prisma.resaleRightsReview.findUniqueOrThrow({
      where: { id: "rev-2" },
    });
    expect(review.reviewedAt).toBeNull();
    expect(review.coversUploadsBefore?.getTime()).toBe(ROW_CREATED_AT);
  });

  it("invents no framework licence on anyone's behalf", async () => {
    const reviews = await prisma.resaleRightsReview.findMany({
      select: { id: true, coversFutureUploads: true },
      orderBy: { id: "asc" },
    });
    expect(reviews).toEqual([
      { id: "rev-1", coversFutureUploads: false },
      { id: "rev-2", coversFutureUploads: false },
    ]);
  });
});

describe("ugcportal-aqw K1: the backfilled scope decides real rows", () => {
  it("leaves the two uploads identical apart from when they were made", async () => {
    // The premise of the case below, asserted rather than assumed. Without
    // it a difference in verdict could come from a triage column one of
    // them was missing.
    const [before, after] = await Promise.all([
      gateUpload("media-before"),
      gateUpload("media-after"),
    ]);
    const { createdAt: beforeAt, ...beforeRest } = before;
    const { createdAt: afterAt, ...afterRest } = after;
    expect(beforeRest).toEqual(afterRest);
    expect(beforeAt.getTime()).toBe(UPLOADED_BEFORE);
    expect(afterAt.getTime()).toBe(UPLOADED_AFTER);
  });

  it("sells the file that existed when the reviewer signed", async () => {
    expect(evaluateSellability(await gateUpload("media-before"))).toEqual({
      sellable: true,
    });
  });

  it("refuses the file added afterwards", async () => {
    expect(evaluateSellability(await gateUpload("media-after"))).toEqual({
      sellable: false,
      blocker: "upload_outside_clearance_scope",
    });
  });
});
