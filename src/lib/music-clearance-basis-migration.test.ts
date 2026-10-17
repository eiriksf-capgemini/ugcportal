import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClearanceBasis } from "@/generated/prisma/enums";
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
 * ugcportal-hx2, against a real database: the basis columns, and what
 * happens to a MUSIC clearance recorded before they existed.
 *
 * The migration backfills nothing, so such a row comes out with basis NULL —
 * and the gate no longer counts a MUSIC clearance with no basis. That is the
 * fail-closed direction the bead chose (there is no production data to
 * re-record), and it is a claim about a real row going through the real
 * migration and the real gate select, which a unit test over hand-built
 * objects cannot make.
 */

const BASIS_MIGRATION = migrationNames().find((name) =>
  name.endsWith("_add_music_clearance_basis"),
);

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

async function gateUpload() {
  return prisma.media.findUniqueOrThrow({
    where: { id: "media-1" },
    select: MEDIA_GATE_SELECT,
  });
}

function columns() {
  return prisma.$queryRawUnsafe<
    { name: string; dflt_value: string | null; notnull: number }[]
  >(`PRAGMA table_info("MediaRightsClearance")`);
}

beforeAll(async () => {
  // Derived, and asserted: a renamed migration must fail loudly rather than
  // applying everything and proving nothing about the state before it ran.
  expect(BASIS_MIGRATION).toBeTruthy();
  await applyMigrations(prisma, { stopBefore: BASIS_MIGRATION! });

  /*
   * The world before this bead: a cleared uploader, one upload whose only
   * triage `true` is containsMusic, and a MUSIC clearance with a reason and
   * an admin's signature — the shape the gate counted as cleared before
   * ugcportal-hx2. Raw SQL, because the generated client knows only the current
   * schema and would select the columns this fixture must not yet have.
   */
  const triageColumns = TRIAGE_FACTS.map((fact) => `"${fact.field}"`).join(",");
  const triageValues = TRIAGE_FACTS.map((fact) =>
    fact.field === "containsMusic" ? "1" : "0",
  ).join(",");
  const farFuture = Date.UTC(2099, 0, 1);
  const seed = [
    `INSERT INTO "User" ("id","email","role","createdAt","updatedAt")
     VALUES ('admin-1','admin@example.com','ADMIN',0,0),
            ('owner-1','owner@example.com','USER',0,0)`,
    `INSERT INTO "Media"
       ("id","userId","kind","key","mimeType","sizeBytes","originalName","createdAt")
     VALUES ('media-1','owner-1','VIDEO','media/owner-1/clip.mp4','video/mp4',10,'clip.mp4',${Date.UTC(2026, 8, 19)})`,
    `INSERT INTO "ResaleRightsReview"
       ("id","uploaderUserId","status","route","checklistVersion","reviewedByUserId","reviewedAt","coversUploadsBefore","coversFutureUploads","productDecisionRef","createdAt","updatedAt")
     VALUES ('rev-1','owner-1','CLEARED','CONTRACT','${CURRENT_CHECKLIST_VERSION}','admin-1',${Date.UTC(2026, 8, 20)},${farFuture},0,'ugcportal-2eh',0,0)`,
    `INSERT INTO "MediaListing"
       ("id","mediaId",${triageColumns},"triagedByUserId","triagedAt","createdAt","updatedAt")
     VALUES ('listing-1','media-1',${triageValues},'admin-1',0,0,0)`,
    `INSERT INTO "MediaRightsClearance"
       ("id","listingId","layer","reason","clearedByUserId","clearedAt")
     VALUES ('clr-1','listing-1','MUSIC','Deliver muted to the buyer.','admin-1',0)`,
  ];
  for (const statement of seed) {
    await prisma.$executeRawUnsafe(statement);
  }

  await applyMigration(prisma, BASIS_MIGRATION!);
  // Anything committed after this migration, so the generated client can
  // read the database at all; a no-op while this is the newest one.
  await applyMigrations(prisma, { startAfter: BASIS_MIGRATION! });

  await prisma.mediaAttestation.create({
    data: completeAttestationRow("media-1", "owner-1"),
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-hx2: the shape of the basis columns", () => {
  it("adds basis and basisEvidence, both nullable with no default", async () => {
    const all = await columns();
    // Guards the lookups below against passing on an empty result.
    expect(all.length).toBeGreaterThan(4);
    for (const name of ["basis", "basisEvidence"]) {
      const column = all.find((row) => row.name === name);
      expect(column, `${name} is not a column`).toBeTruthy();
      expect(column!.notnull, `${name} is NOT NULL`).toBe(0);
      // A default would be the database choosing a basis on every admin's
      // behalf — LICENCE with no evidence, or worse.
      expect(column!.dflt_value, `${name} has a default`).toBeNull();
    }
  });
});

describe("ugcportal-hx2: a MUSIC clearance recorded before the column", () => {
  it("comes through the migration untouched, with basis and evidence NULL", async () => {
    const row = await prisma.mediaRightsClearance.findUniqueOrThrow({
      where: { id: "clr-1" },
    });
    expect(row.reason).toBe("Deliver muted to the buyer.");
    expect(row.clearedByUserId).toBe("admin-1");
    expect(row.basis).toBeNull();
    expect(row.basisEvidence).toBeNull();
  });

  it("no longer clears MUSIC, so the upload is not sellable", async () => {
    expect(evaluateSellability(await gateUpload())).toEqual({
      sellable: false,
      blocker: "third_party_layer_uncleared",
    });
  });

  it("sells once the same row carries an accepted basis — the control for the case above", async () => {
    // Without this, the refusal above could be any other defect in the
    // fixture. Only the basis column changes.
    await prisma.mediaRightsClearance.update({
      where: { id: "clr-1" },
      data: { basis: ClearanceBasis.ORIGINAL_SCORE },
    });
    try {
      expect(evaluateSellability(await gateUpload())).toEqual({ sellable: true });
    } finally {
      await prisma.mediaRightsClearance.update({
        where: { id: "clr-1" },
        data: { basis: null },
      });
    }
  });
});
