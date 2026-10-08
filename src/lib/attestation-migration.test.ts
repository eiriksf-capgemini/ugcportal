import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
} from "@/lib/attestation";
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
 * ugcportal-15r K4, against a real database rather than a reading of the
 * SQL: "not asked" and "answered no" must stay distinguishable, and the
 * shape of the table is half of what makes that true.
 *
 * THIS IS THE MIRROR IMAGE OF src/lib/minors-triage-migration.test.ts, and
 * the two together are the point. That one asserts `MediaListing.
 * depictsMinors` is NULLABLE WITH NO DEFAULT, because a triage column is
 * added to rows that already exist and `null` has to mean "no admin has
 * answered this yet". This one asserts every answer column here is NOT NULL
 * WITH NO DEFAULT, because an attestation ROW only ever comes into existence
 * as a complete set of answers written in one statement — so there is no
 * legitimate half-filled state, and a nullable column would be a place for
 * one to appear.
 *
 * Both are the fail-closed choice for their own table, and both close the
 * same failure: the database answering a rights question on a person's
 * behalf. `DEFAULT 0` on `showsMinors` would be this system asserting, about
 * every file anyone ever uploads through a path that forgot the column, that
 * no child is shown in it. No human made that assertion.
 *
 * It also asserts the other half of K4 end to end on real rows: an upload
 * with NO attestation and an upload with an all-negative one get different
 * verdicts out of the gate.
 */

const ATTESTATION_MIGRATION = migrationNames().find((name) =>
  name.endsWith("_add_upload_rights_attestation"),
);

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

async function gateUpload(id: string) {
  return prisma.media.findUniqueOrThrow({
    where: { id },
    select: MEDIA_GATE_SELECT,
  });
}

beforeAll(async () => {
  // Derived rather than hard-coded, but still asserted: a renamed migration
  // must fail loudly instead of silently applying everything and proving
  // nothing.
  expect(ATTESTATION_MIGRATION).toBeTruthy();

  await applyMigrations(prisma, { stopBefore: ATTESTATION_MIGRATION! });

  /*
   * TWO uploads by the same cleared uploader, with identical, complete,
   * admin-signed triage. Seeded through raw SQL because the generated
   * client only knows the schema as it is NOW: it would insist on the very
   * table this fixture must not yet have.
   *
   * They differ in exactly one thing, added after the migration below:
   * media-1 gets an all-negative attestation, media-2 gets none. Everything
   * else about them is the same, which is what makes the difference in
   * verdict attributable to the attestation and not to anything else.
   */
  const triageColumns = TRIAGE_FACTS.map((fact) => `"${fact.field}"`).join(",");
  const triageZeros = TRIAGE_FACTS.map(() => "0").join(",");
  const seed = [
    `INSERT INTO "User" ("id","email","role","createdAt","updatedAt")
     VALUES ('admin-1','admin@example.com','ADMIN',0,0),
            ('owner-1','owner@example.com','USER',0,0)`,
    `INSERT INTO "Media"
       ("id","userId","kind","key","mimeType","sizeBytes","originalName","createdAt")
     VALUES ('media-1','owner-1','IMAGE','uploads/owner-1/a.jpg','image/jpeg',10,'a.jpg',0),
            ('media-2','owner-1','IMAGE','uploads/owner-1/b.jpg','image/jpeg',10,'b.jpg',0)`,
    `INSERT INTO "ResaleRightsReview"
       ("id","uploaderUserId","status","route","checklistVersion","reviewedByUserId","reviewedAt","validUntil","productDecisionRef","createdAt","updatedAt")
     VALUES ('rev-1','owner-1','CLEARED','CONTRACT','${CURRENT_CHECKLIST_VERSION}','admin-1',0,NULL,'ugcportal-2eh',0,0)`,
    `INSERT INTO "MediaListing"
       ("id","mediaId","priceCents","currency",${triageColumns},"triagedByUserId","triagedAt","createdAt","updatedAt")
     VALUES ('listing-1','media-1',24900,'NOK',${triageZeros},'admin-1',0,0,0),
            ('listing-2','media-2',24900,'NOK',${triageZeros},'admin-1',0,0,0)`,
  ];
  for (const statement of seed) {
    await prisma.$executeRawUnsafe(statement);
  }

  await applyMigration(prisma, ATTESTATION_MIGRATION!);
  // Anything committed after this migration, so the generated client can
  // read the database at all. A no-op while this is the newest migration; it
  // is here so the next one does not break this file in a way that looks
  // like a defect in the migration under test.
  await applyMigrations(prisma, { startAfter: ATTESTATION_MIGRATION! });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-15r: the shape of the attestation table", () => {
  it("makes every answer NOT NULL with no default", async () => {
    /*
     * The DDL itself, not just its effect on one row. A `DEFAULT 0` added
     * later would make every future insert answer the questions too, and a
     * nullable column would let a half-filled row exist at all — neither of
     * which a row-level assertion would notice, because the write path this
     * repo has would keep supplying every value.
     */
    const columns = await prisma.$queryRawUnsafe<
      { name: string; dflt_value: string | null; notnull: number }[]
    >(`PRAGMA table_info("MediaAttestation")`);

    // Guards the loop below against passing on an empty result — a renamed
    // or missing table would otherwise make every assertion vacuous.
    expect(columns.length).toBeGreaterThan(ATTESTATION_QUESTIONS.length);

    for (const { field } of [...ATTESTATION_QUESTIONS, { field: "authorship" }]) {
      const column = columns.find((row) => row.name === field);
      expect(column, `${field} is not a column`).toBeTruthy();
      expect(column!.notnull, `${field} is nullable`).toBe(1);
      expect(column!.dflt_value, `${field} has a default`).toBeNull();
    }
  });

  it("requires an actor and a version, with no default either", async () => {
    const columns = await prisma.$queryRawUnsafe<
      { name: string; dflt_value: string | null; notnull: number }[]
    >(`PRAGMA table_info("MediaAttestation")`);

    for (const name of ["attestedByUserId", "attestationVersion"]) {
      const column = columns.find((row) => row.name === name);
      expect(column, `${name} is not a column`).toBeTruthy();
      expect(column!.notnull, `${name} is nullable`).toBe(1);
      expect(column!.dflt_value, `${name} has a default`).toBeNull();
    }
  });

  it("refuses a half-filled row at the database, not only at the validator", async () => {
    /*
     * The NOT NULLs above, exercised rather than read. A row with eight of
     * nine answers is the state K4 says must not be representable, and this
     * is the only assertion in the repo that proves the DATABASE refuses it
     * — every other guard is above it and could be bypassed by a second
     * write path or a raw statement.
     */
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MediaAttestation"
           ("id","mediaId","attestedByUserId","attestationVersion","attestedAt",
            "authorship","ownOriginalNotFromWeb","showsIdentifiablePeople",
            "containsMusicNotOwned","otherCreativeContributor",
            "brandOrSponsorship","aiGenerated","uploaderIsAdult")
         VALUES ('att-partial','media-2','owner-1','${CURRENT_ATTESTATION_VERSION}',0,
                 'AUTHOR',1,0,0,0,0,0,1)`,
      ),
    ).rejects.toThrow();

    // And nothing landed: a constraint that threw after inserting would be
    // worse than one that did not exist.
    expect(
      await prisma.mediaAttestation.findUnique({ where: { mediaId: "media-2" } }),
    ).toBeNull();
  });

  it("allows one attestation per file and no more", async () => {
    await prisma.mediaAttestation.create({
      data: completeAttestationRow("media-1", "owner-1"),
    });

    await expect(
      prisma.mediaAttestation.create({
        data: { ...completeAttestationRow("media-1", "owner-1"), id: "att-2" },
      }),
    ).rejects.toThrow();
  });
});

describe("ugcportal-15r K4: an unattested upload is not an all-negative one", () => {
  it("leaves the two fixtures identical apart from the attestation", async () => {
    /*
     * The premise of the case below, asserted rather than assumed. Without
     * it, a difference in verdict could be attributed to the attestation
     * while actually coming from a triage column one of them was missing.
     */
    const [one, two] = await Promise.all([
      prisma.mediaListing.findUniqueOrThrow({ where: { mediaId: "media-1" } }),
      prisma.mediaListing.findUniqueOrThrow({ where: { mediaId: "media-2" } }),
    ]);
    for (const fact of TRIAGE_FACTS) {
      expect(one[fact.field], fact.field).toBe(false);
      expect(two[fact.field], fact.field).toBe(false);
    }
    expect(one.triagedByUserId).toBe(two.triagedByUserId);

    expect(
      await prisma.mediaAttestation.findUnique({ where: { mediaId: "media-1" } }),
    ).toBeTruthy();
    expect(
      await prisma.mediaAttestation.findUnique({ where: { mediaId: "media-2" } }),
    ).toBeNull();
  });

  it("sells the attested one and refuses the unattested one", async () => {
    // media-1's attestation answers `no` to every question except
    // `uploaderIsAdult` (`true`, the one clean answer) — including every
    // other question an administrator would triage — and `AUTHOR` to the
    // authorship one. That is the strongest form of the claim: a row of
    // explicit `no`s SELLS, so the refusal below cannot be the gate
    // disliking negative answers. It is the absence of the row.
    expect(await evaluateSellability(await gateUpload("media-1"))).toEqual({
      sellable: true,
    });

    expect(await evaluateSellability(await gateUpload("media-2"))).toEqual({
      sellable: false,
      blocker: "attestation_missing",
    });
  });

  it("stores a `no` as a real `false`, not as a null the gate could re-read", async () => {
    // The database side of the same claim. If a `no` round-tripped as NULL,
    // the two states above would be the same stored value and the verdicts
    // would only differ by accident of which row the gate found first.
    const row = await prisma.mediaAttestation.findUniqueOrThrow({
      where: { mediaId: "media-1" },
    });

    for (const { field } of ATTESTATION_QUESTIONS) {
      expect(typeof row[field], field).toBe("boolean");
    }
    expect(row.showsMinors).toBe(false);
    expect(row.uploaderIsAdult).toBe(true);
  });
});
