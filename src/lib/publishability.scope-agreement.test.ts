import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MediaAuthorship, RightsLayer } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-3ae: the two expressions of one rule, checked against each
 * other on a real database.
 *
 * `publishabilityBlocker` (TypeScript, one row at a time) decides a publish
 * REQUEST. `PUBLIC_MEDIA_RIGHTS_SCOPE` (a Prisma `where`, spread into
 * `PUBLIC_MEDIA_SCOPE`) decides what five anonymous surfaces SERVE. They
 * have to mean the same thing, and nothing in either file makes them: they
 * are written in different languages against different engines, and the way
 * they come apart is silent in exactly the dangerous direction — a row the
 * publish gate would refuse, sitting on the public site because the
 * where-clause was written one condition short.
 *
 * So this file seeds one row per state, asks BOTH, and compares row by row.
 * It is not a restatement of either one's own unit tests: neither of those
 * can fail when the OTHER drifts.
 *
 * TWO DISAGREEMENTS ARE EXPECTED, and are asserted as such rather than
 * excluded from the comparison — see `SQL_CANNOT_EXPRESS` below. Both are
 * the predicate being STRICTER than the filter, both are states nothing in
 * the product can write, and both are tracked as ugcportal-0epl. Writing
 * them down here is what makes a third one, or a change to either of these,
 * a test failure rather than a discovery.
 *
 * "Nothing in the product can write them" re-checked at `ba9991f`, after
 * ugcportal-qfy9 landed the clearance write path this bead's PR had
 * described as in flight: `recordLayerClearance`
 * (src/lib/curation-clearance-write.ts) stores `reason.trim()` and refuses
 * a blank one as `clearance_reason_blank` before it writes, so the
 * whitespace-only clearance stays unreachable through the only surface
 * that mints one. Nothing updates `Media.userId`, so the other stays
 * unreachable for its own reason.
 */

vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the anonymous scope must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { PUBLIC_MEDIA_SCOPE } = await import("@/lib/public-media");
const { publishabilityBlocker } = await import("@/lib/publishability");
const { MEDIA_GATE_SELECT } = await import("@/lib/resale-rights");

const OWNER = "owner-scope-3ae";
const ADMIN = "admin-scope-3ae";
const DEMOTED = "demoted-scope-3ae";

type AttestationShape = {
  attestedByUserId?: string;
  attestationVersion?: string;
  authorship?: MediaAuthorship;
  showsIdentifiablePeople?: boolean;
  uploaderIsAdult?: boolean;
};

type ClearanceShape = {
  layer?: RightsLayer;
  reason?: string;
  clearedByUserId?: string | null;
};

type Case = {
  /** The Media row's id, and the case's name in every message below. */
  id: string;
  /** What the case is, in one line — printed when the comparison fails. */
  what: string;
  attestation: AttestationShape | null;
  /** `undefined` writes no MediaListing at all: every upload's real state. */
  depictsPeople?: boolean | null;
  clearance?: ClearanceShape;
};

/**
 * The two states the `where` cannot judge, with the reason and the
 * compensating control. Keyed by case id; the value is the blocker the
 * PREDICATE reports while the scope serves the row anyway.
 */
const SQL_CANNOT_EXPRESS: Record<string, string> = {
  // Prisma field references compare columns of the SAME model; this is a
  // comparison across a relation (`MediaAttestation.attestedByUserId` to
  // `Media.userId`), which no relation filter can make.
  "attested-by-someone-else": "attestation_not_by_uploader",
  // `layerIsCleared` uses `reason?.trim()`. Prisma has no trimming filter,
  // so the scope settles for `reason: { not: "" }`.
  "clearance-reason-blank": "people_uncleared",
};

const CASES: Case[] = [
  {
    id: "ok-plain",
    what: "declared, nobody in the frame, never triaged — the ordinary upload",
    attestation: {},
  },
  {
    id: "no-attestation",
    what: "published before ugcportal-3ae; nobody ever asked the uploader anything",
    attestation: null,
  },
  {
    id: "retired-version",
    what: "declared under a version no longer in force",
    attestation: { attestationVersion: "1999-01-01.1" },
  },
  {
    id: "rights-disclaimed",
    what: "the uploader says they neither made it nor hold a licence",
    attestation: { authorship: MediaAuthorship.NEITHER },
  },
  {
    id: "attested-by-someone-else",
    what: "an admin ticked the boxes on the uploader's behalf",
    attestation: { attestedByUserId: ADMIN },
  },
  {
    id: "under-eighteen",
    what: "the uploader declared they are under 18 — unsellable, still publishable",
    attestation: { uploaderIsAdult: false },
  },
  {
    id: "people-uncleared",
    what: "the uploader says a person is shown; no listing, so no clearance",
    attestation: { showsIdentifiablePeople: true },
  },
  {
    id: "people-cleared",
    what: "a person is shown and a current admin has cleared the PEOPLE layer",
    attestation: { showsIdentifiablePeople: true },
    depictsPeople: true,
    clearance: {},
  },
  {
    id: "clearance-by-demoted",
    what: "the PEOPLE clearance was signed by somebody since demoted",
    attestation: { showsIdentifiablePeople: true },
    depictsPeople: true,
    clearance: { clearedByUserId: DEMOTED },
  },
  {
    id: "clearance-unsigned",
    what: "a PEOPLE clearance nobody signed",
    attestation: { showsIdentifiablePeople: true },
    depictsPeople: true,
    clearance: { clearedByUserId: null },
  },
  {
    id: "clearance-wrong-layer",
    what: "a MUSIC clearance on an item showing a person",
    attestation: { showsIdentifiablePeople: true },
    depictsPeople: true,
    clearance: { layer: RightsLayer.MUSIC },
  },
  {
    id: "clearance-reason-blank",
    what: "a PEOPLE clearance whose justification is nothing but spaces",
    attestation: { showsIdentifiablePeople: true },
    depictsPeople: true,
    clearance: { reason: "   " },
  },
  {
    id: "admin-says-people",
    what: "the uploader said nobody is shown; the admin triage says otherwise",
    attestation: { showsIdentifiablePeople: false },
    depictsPeople: true,
  },
  {
    id: "admin-says-people-cleared",
    what: "the same disagreement, with the PEOPLE layer cleared",
    attestation: { showsIdentifiablePeople: false },
    depictsPeople: true,
    clearance: {},
  },
  {
    id: "listing-says-no-people",
    what: "triaged, and both answers agree nobody is shown",
    attestation: { showsIdentifiablePeople: false },
    depictsPeople: false,
  },
  {
    id: "listing-untriaged",
    what: "a listing exists but the people question is unanswered",
    attestation: { showsIdentifiablePeople: false },
    depictsPeople: null,
  },
];

async function seed(testCase: Case): Promise<void> {
  const { id } = testCase;

  // Every row satisfies the COLUMN half of the scope, so the only thing
  // that can decide its visibility below is the rights half.
  await prisma.media.create({
    data: {
      id,
      userId: OWNER,
      kind: "IMAGE",
      key: `media/${OWNER}/${id}.jpg`,
      previewKey: `previews/${OWNER}/${id}.webp`,
      previewId: `pv-${id}`,
      mimeType: "image/jpeg",
      sizeBytes: 4096,
      originalName: `${id}.jpg`,
      altText: `Alt text for ${id}`,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      publishedAt: new Date("2026-03-02T00:00:00.000Z"),
    },
  });

  if (testCase.attestation) {
    const a = testCase.attestation;
    await prisma.mediaAttestation.create({
      data: {
        mediaId: id,
        attestedByUserId: a.attestedByUserId ?? OWNER,
        attestationVersion: a.attestationVersion ?? CURRENT_ATTESTATION_VERSION,
        authorship: a.authorship ?? MediaAuthorship.AUTHOR,
        ownOriginalNotFromWeb: true,
        showsIdentifiablePeople: a.showsIdentifiablePeople ?? false,
        showsMinors: false,
        containsMusicNotOwned: false,
        otherCreativeContributor: false,
        brandOrSponsorship: false,
        aiGenerated: false,
        uploaderIsAdult: a.uploaderIsAdult ?? true,
      },
    });
  }

  if (testCase.depictsPeople === undefined && !testCase.clearance) return;

  /*
    Clearances are SEEDED DIRECTLY rather than through the admin curation
    screen that ugcportal-qfy9 shipped in `ba9991f`. Not because no writer
    exists — one does now — but because this file compares a src/lib
    predicate against a Prisma `where` over one row per state, including
    states (`clearance-reason-blank`) that writer deliberately refuses to
    produce. Driving a form here would make those states unseedable and
    prove nothing extra about the agreement. What these cases therefore
    establish is the gate's behaviour GIVEN a clearance row, not that the
    admin flow produces one; qfy9's own suite covers that half.
  */
  const clearance = testCase.clearance;
  await prisma.mediaListing.create({
    data: {
      mediaId: id,
      depictsPeople: testCase.depictsPeople ?? null,
      layerClearances: clearance
        ? {
            create: {
              layer: clearance.layer ?? RightsLayer.PEOPLE,
              reason:
                clearance.reason ??
                "Model release on file; covers online commercial publication.",
              clearedByUserId:
                clearance.clearedByUserId === undefined
                  ? ADMIN
                  : clearance.clearedByUserId,
            },
          }
        : undefined,
    },
  });
}

/** What the TypeScript predicate says about one seeded row. */
async function predicateBlocker(id: string): Promise<string | null> {
  const row = await prisma.media.findUniqueOrThrow({
    where: { id },
    select: {
      userId: true,
      attestation: { select: MEDIA_GATE_SELECT.attestation.select },
      listing: {
        select: {
          depictsPeople: true,
          layerClearances: MEDIA_GATE_SELECT.listing.select.layerClearances,
        },
      },
    },
  });
  return publishabilityBlocker(row);
}

let visibleIds: Set<string>;

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: OWNER, email: "owner-scope-3ae@example.com", role: "USER" },
      { id: ADMIN, email: "admin-scope-3ae@example.com", role: "ADMIN" },
      // Signed a clearance and was demoted afterwards. The gate re-reads the
      // role at evaluation time; so must the where-clause.
      { id: DEMOTED, email: "demoted-scope-3ae@example.com", role: "USER" },
    ],
  });

  for (const testCase of CASES) {
    await seed(testCase);
  }

  const rows = await prisma.media.findMany({
    where: PUBLIC_MEDIA_SCOPE,
    select: { id: true },
  });
  visibleIds = new Set(rows.map((row) => row.id));
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("the predicate and PUBLIC_MEDIA_SCOPE agree, row by row (ugcportal-3ae K3)", () => {
  it("exercises both outcomes, so the comparison below cannot pass vacuously", async () => {
    // A seed that produced all-visible or all-hidden rows would make every
    // `expect` in this file agree with a scope that filtered on nothing, or
    // on everything.
    const blockers = await Promise.all(
      CASES.map((testCase) => predicateBlocker(testCase.id)),
    );
    expect(blockers.filter((blocker) => blocker === null).length).toBeGreaterThan(3);
    expect(blockers.filter((blocker) => blocker !== null).length).toBeGreaterThan(3);
    expect(visibleIds.size).toBeGreaterThan(3);
    expect(visibleIds.size).toBeLessThan(CASES.length);
  });

  for (const testCase of CASES) {
    const expected = SQL_CANNOT_EXPRESS[testCase.id];
    if (expected) continue;

    it(`${testCase.id}: ${testCase.what}`, async () => {
      const blocker = await predicateBlocker(testCase.id);
      expect(visibleIds.has(testCase.id), `${testCase.id} (${blocker})`).toBe(
        blocker === null,
      );
    });
  }
});

describe("the two states a Prisma where cannot judge (ugcportal-0epl)", () => {
  it("names exactly two, and the comparison above covers everything else", () => {
    // The exception list is itself the thing most likely to rot: a third
    // entry added to quiet a failing comparison is how a gap gets
    // normalised. Changing this number is a deliberate act.
    expect(Object.keys(SQL_CANNOT_EXPRESS).sort()).toEqual([
      "attested-by-someone-else",
      "clearance-reason-blank",
    ]);
    for (const id of Object.keys(SQL_CANNOT_EXPRESS)) {
      expect(CASES.map((testCase) => testCase.id)).toContain(id);
    }
  });

  for (const [id, blocker] of Object.entries(SQL_CANNOT_EXPRESS)) {
    it(`${id}: the gate refuses it (${blocker}); the query filter does not`, async () => {
      // Both halves asserted, so a change in EITHER direction fails: the
      // gate quietly stopping refusing it, or the filter quietly starting
      // to catch it (which is ugcportal-0epl being fixed, and should be
      // noticed rather than absorbed).
      expect(await predicateBlocker(id)).toBe(blocker);
      expect(visibleIds.has(id)).toBe(true);
    });
  }
});
