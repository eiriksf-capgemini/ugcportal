import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MediaAuthorship, RightsLayer } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-3ae: two expressions of the RIGHTS rule, checked against each
 * other on a real database.
 *
 * `publishabilityBlocker` (TypeScript, one row at a time) decides a publish
 * — a manual publish request, or a configured uploader's auto-publish at
 * upload (ugcportal-ho7j) — against the rights rule alone — the attestation and the PEOPLE
 * layer. `PUBLIC_MEDIA_RIGHTS_SCOPE` (a Prisma `where`, spread into
 * `PUBLIC_MEDIA_SCOPE`) decides what every anonymous surface SERVES, and
 * since ugcportal-pgpq that scope also carries a third arm — alkoholloven
 * § 9-2's commercial pair, widened at ugcportal-qnq9.11 by a recorded
 * `depictsAlcohol = true` (the complement of `isWithheldFromPublicRead`,
 * src/lib/alcohol-commerce.ts) — that
 * `publishabilityBlocker` does not evaluate at all. Over the rights rule the
 * two have to mean the same thing, and nothing in either file makes them:
 * they are written in different languages against different engines, and
 * the way they come apart is silent in exactly the dangerous direction — a
 * row the publish gate would refuse, sitting on the public site because the
 * where-clause was written one condition short. The § 9-2 arm's own
 * agreement is checked separately, by
 * src/lib/alcohol-commerce.scope-agreement.test.ts against
 * `isWithheldFromPublicRead`; every CASE below seeds no advertising
 * disclosure, no commercial link and no recorded `depictsAlcohol = true` (its
 * listing seed leaves the field null), which keeps that arm trivially
 * satisfied here, so this file's comparison stays exact for the rights rule
 * — it is not a claim that the scope and the predicate agree on every row
 * either can produce.
 *
 * So this file seeds one row per RIGHTS state, asks BOTH, and compares row
 * by row. It is not a restatement of either one's own unit tests: neither
 * of those can fail when the OTHER drifts.
 *
 * TWO DISAGREEMENTS ARE EXPECTED within the rights rule, and are asserted as
 * such rather than excluded from the comparison — see `SQL_CANNOT_EXPRESS`
 * below. Both are the predicate being STRICTER than the filter, both are
 * states nothing in the product can write, and both are tracked as
 * ugcportal-0epl. Writing them down here is what makes a third one of THIS
 * kind — within the rights rule, on a state these CASES can seed — a test
 * failure rather than a discovery. It says nothing about the § 9-2 arm: a
 * row carrying a declared benefit or a commercial link with the alcohol
 * question unanswered disagrees in the OTHER direction (the filter stricter
 * than the predicate, because the predicate never asks the § 9-2 question at
 * all), and that disagreement is real — measured directly, on a published,
 * attested, people-free row with no listing, one declared benefit and one
 * commercial link: `publishabilityBlocker` returns `null`, while
 * `prisma.media.count({ where: { id, ...PUBLIC_MEDIA_SCOPE } })` returns
 * `0`. That disagreement is the safe direction (the filter over-refuses
 * rather than under-refusing) and is out of scope for this file by
 * construction, not a drift this file would have caught.
 *
 * "Nothing in the product can write them" re-checked at `ba9991f`, after
 * ugcportal-qfy9 landed the clearance write path this bead's PR had
 * described as in flight: `recordLayerClearance`
 * (src/lib/curation-clearance-write.ts) stores `reason.trim()` and refuses
 * a blank one as `clearance_reason_blank` before it writes, so the
 * whitespace-only clearance stays unreachable through the only surface
 * that mints one.
 *
 * THE OTHER ONE — an attestation whose `attestedByUserId` is not the
 * file's `Media.userId` — stays unreachable too, but not for the one-line
 * reason it would be tempting to give. "Nothing updates `Media.userId`" is
 * FALSE: `prisma/migrations/20261005120500_reconcile_configured_users/migration.sql`
 * does, repointing a stray configured user's rows at their canonical
 * account. The conclusion survives, for a reason worth knowing rather than
 * re-deriving: that migration predates `MediaAttestation`, which
 * `20261008200000_add_upload_rights_attestation` creates, so there is no
 * attestation row in existence when it runs and nothing it can put out of
 * step. No runtime writer of `Media.userId` exists anywhere in `src/` or
 * `scripts/`.
 *
 * SO THE CONSTRAINT, STATED FOR WHOEVER ADDS THE NEXT `Media` WRITE: this
 * disagreement is unreachable only while `Media.userId` is written once at
 * upload and thereafter only by migrations that run before an attestation
 * can exist. A runtime path that repoints an upload at a different owner —
 * an account merge, a transfer, an admin reassignment — would make a row
 * the publish gate refuses and this scope serves, and would have to move
 * or delete the attestation in the same transaction.
 */

// The configured row below carries the fixture handle "fixture-handle", which
// is configured only while the checked array derives it (ugcportal-lskg):
// append the fixture person to the real CONFIGURED_USERS rather than seed a
// real name.
vi.mock("@/config/users", async (importOriginal) => {
  const { withFixtureConfiguredUser } = await import(
    "@/lib/test-support/fixture-configured-user"
  );
  return withFixtureConfiguredUser(await importOriginal());
});

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
const { isConfiguredUser } = await import("@/lib/publish-gates");
const { FIXTURE_CONFIGURED_HANDLE, FORMER_CONFIGURED_HANDLE } = await import(
  "@/lib/test-support/fixture-configured-user"
);

const OWNER = "owner-scope-3ae";
const ADMIN = "admin-scope-3ae";
const DEMOTED = "demoted-scope-3ae";
/**
 * A CONFIGURED uploader (ugcportal-ho7j): a `User.configuredHandle`, the
 * state src/lib/configured-user-link.ts leaves the people in
 * src/config/users.ts in. The handle is a fixture value, not one of the
 * real ones: since ugcportal-lskg the rule reads "in the list the checked
 * array derives today", so the fixture person (with one identity, so the
 * check keeps them) is appended to the array by the `vi.mock` above.
 */
const CONFIGURED_OWNER = "configured-owner-scope-ho7j";
/**
 * A person REMOVED from the array after signing in (ugcportal-lskg): the
 * column still carries their handle — nothing clears it — but no person in
 * the checked CONFIGURED_USERS derives it, so they are not configured.
 */
const FORMER_OWNER = "former-owner-scope-lskg";

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
  /** The uploader is a configured user (ugcportal-ho7j). Default: not. */
  configured?: boolean;
  /**
   * The uploader's row carries a handle the checked array no longer derives
   * (ugcportal-lskg). Takes precedence over `configured`.
   */
  former?: boolean;
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
  // ugcportal-ho7j: the same states, for an uploader who is CONFIGURED.
  {
    id: "configured-undeclared",
    what: "a configured user's upload: no declaration, never triaged",
    attestation: null,
    configured: true,
  },
  {
    id: "configured-undeclared-listing-no-people",
    what: "a configured user's undeclared upload, triaged: nobody shown",
    attestation: null,
    configured: true,
    depictsPeople: false,
  },
  {
    id: "configured-undeclared-listing-untriaged",
    what: "a configured user's undeclared upload, people question unanswered",
    attestation: null,
    configured: true,
    depictsPeople: null,
  },
  {
    id: "configured-undeclared-admin-says-people",
    what: "a configured user's undeclared upload the admin says shows a person",
    attestation: null,
    configured: true,
    depictsPeople: true,
  },
  {
    id: "configured-undeclared-people-cleared",
    what: "the same, with the PEOPLE layer cleared by a current admin",
    attestation: null,
    configured: true,
    depictsPeople: true,
    clearance: {},
  },
  {
    id: "configured-declared",
    what: "a configured user who did answer the questions, cleanly",
    attestation: {},
    configured: true,
  },
  {
    id: "configured-rights-disclaimed",
    what: "a configured user who declared they neither made it nor hold a licence",
    attestation: { authorship: MediaAuthorship.NEITHER },
    configured: true,
  },
  {
    id: "configured-retired-version",
    what: "a configured user's declaration under a version no longer in force",
    attestation: { attestationVersion: "1999-01-01.1" },
    configured: true,
  },
  {
    id: "configured-declared-people",
    what: "a configured user who declared a person is shown, no clearance",
    attestation: { showsIdentifiablePeople: true },
    configured: true,
  },
  // ugcportal-lskg: an uploader removed from the array, row left as it was.
  {
    id: "former-undeclared",
    what: "a removed person's upload: no declaration, stale handle on the row",
    attestation: null,
    former: true,
  },
  {
    id: "former-undeclared-listing-no-people",
    what: "a removed person's undeclared upload, triaged: nobody shown",
    attestation: null,
    former: true,
    depictsPeople: false,
  },
  {
    id: "former-declared",
    what: "a removed person who did answer the questions, cleanly",
    attestation: {},
    former: true,
  },
];

async function seed(testCase: Case): Promise<void> {
  const { id } = testCase;
  const owner = testCase.former
    ? FORMER_OWNER
    : testCase.configured
      ? CONFIGURED_OWNER
      : OWNER;

  // Every row satisfies the COLUMN half of the scope, so the only thing
  // that can decide its visibility below is the rights half.
  await prisma.media.create({
    data: {
      id,
      userId: owner,
      kind: "IMAGE",
      key: `media/${owner}/${id}.jpg`,
      previewKey: `previews/${owner}/${id}.webp`,
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
        attestedByUserId: a.attestedByUserId ?? owner,
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
  // `uploaderConfigured` from the uploader's own `User` row, BY the
  // function the routes decide it with (`isConfiguredUser`,
  // src/lib/publish-gates.ts) rather than a restatement of it: a copy here
  // read "not null" and would have kept agreeing with a scope that never
  // learned the checked array (ugcportal-lskg).
  return publishabilityBlocker({
    ...row,
    uploaderConfigured: await isConfiguredUser(prisma, row.userId),
  });
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
      {
        id: CONFIGURED_OWNER,
        email: "configured-owner-scope-ho7j@example.com",
        role: "USER",
        configuredHandle: "fixture-handle",
      },
      {
        id: FORMER_OWNER,
        email: "former-owner-scope-lskg@example.com",
        role: "USER",
        configuredHandle: FORMER_CONFIGURED_HANDLE,
      },
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

/**
 * ugcportal-ho7j K5, at the scope, stated as EXPECTED OUTCOMES rather than
 * only as agreement with the predicate — so that the predicate and the scope
 * being wrong in the same direction cannot pass. The agreement cases above
 * cover the same rows from the other side.
 */
describe("the configured-uploader exemption, in the scope itself (ugcportal-ho7j K5)", () => {
  it("configured, declaration missing: in scope", () => {
    expect(visibleIds.has("configured-undeclared")).toBe(true);
  });

  it("NOT configured, declaration missing: out of scope", () => {
    expect(visibleIds.has("no-attestation")).toBe(false);
  });

  it("configured, declaration present but disclaiming or retired: out of scope", () => {
    expect(visibleIds.has("configured-rights-disclaimed")).toBe(false);
    expect(visibleIds.has("configured-retired-version")).toBe(false);
    expect(visibleIds.has("configured-declared-people")).toBe(false);
  });

  it("configured or not, declaration present and clean: in scope", () => {
    expect(visibleIds.has("configured-declared")).toBe(true);
    expect(visibleIds.has("ok-plain")).toBe(true);
  });

  it("with no declaration, the listing alone decides the people question", () => {
    expect(visibleIds.has("configured-undeclared-admin-says-people")).toBe(false);
    expect(visibleIds.has("configured-undeclared-people-cleared")).toBe(true);
    expect(visibleIds.has("configured-undeclared-listing-no-people")).toBe(true);
    expect(visibleIds.has("configured-undeclared-listing-untriaged")).toBe(true);
  });
});

/**
 * ugcportal-lskg K1, at the scope, as EXPECTED OUTCOMES — the same reason
 * the ho7j block above states them: the predicate and the scope wrong in
 * the same direction would still agree.
 */
describe("a person removed from CONFIGURED_USERS, in the scope itself (ugcportal-lskg K1)", () => {
  it("the premise: the fixture handle is in today's checked list and the stale one is not", async () => {
    const { CURRENT_CONFIGURED_HANDLES } = await import("@/lib/sign-in-policy");
    expect(CURRENT_CONFIGURED_HANDLES).toContain(FIXTURE_CONFIGURED_HANDLE);
    expect(CURRENT_CONFIGURED_HANDLES).not.toContain(FORMER_CONFIGURED_HANDLE);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: FORMER_OWNER } });
    expect(row.configuredHandle).toBe(FORMER_CONFIGURED_HANDLE);
  });

  it("stale handle, declaration missing: out of scope (it was in scope before lskg)", () => {
    expect(visibleIds.has("former-undeclared")).toBe(false);
    expect(visibleIds.has("former-undeclared-listing-no-people")).toBe(false);
  });

  it("stale handle, clean declaration: in scope, judged like anybody's", () => {
    expect(visibleIds.has("former-declared")).toBe(true);
  });
});

/**
 * What Prisma does with `in: []` on SQLite, measured rather than assumed
 * (ugcportal-lskg): an array with nobody in it must leave the configured
 * arm matching NO row, never every row. Checked twice — the bare filter,
 * and the module's own scope rebuilt with CONFIGURED_USERS empty.
 */
describe("an empty handle list matches nothing (ugcportal-lskg)", () => {
  it("`configuredHandle: { in: [] }` matches no user, even ones with a handle", async () => {
    // Non-vacuous: rows with a handle exist to be matched.
    expect(
      await prisma.user.count({ where: { configuredHandle: { not: null } } }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.user.count({ where: { configuredHandle: { in: [] } } }),
    ).toBe(0);
  });

  it("the scope built from an empty array serves no undeclared configured upload", async () => {
    vi.resetModules();
    vi.doMock("@/config/users", () => ({ CONFIGURED_USERS: [] }));
    try {
      const fresh = await import("@/lib/publishability");
      // The rebuilt list really is empty, so this is the `in: []` case.
      expect(
        (await import("@/lib/sign-in-policy")).CURRENT_CONFIGURED_HANDLES,
      ).toEqual([]);
      const undeclaredConfigured = [
        "configured-undeclared",
        "configured-undeclared-listing-no-people",
        "configured-undeclared-listing-untriaged",
        "configured-undeclared-people-cleared",
      ];
      // The same rows ARE in scope under the module-load list (the ho7j
      // block above), so a zero here is the empty list doing it.
      for (const id of undeclaredConfigured) {
        expect(visibleIds.has(id)).toBe(true);
        expect(
          await prisma.media.count({
            where: { id, ...fresh.PUBLIC_MEDIA_RIGHTS_SCOPE },
          }),
        ).toBe(0);
      }
      // A declared row is untouched by the empty list.
      expect(
        await prisma.media.count({
          where: { id: "configured-declared", ...fresh.PUBLIC_MEDIA_RIGHTS_SCOPE },
        }),
      ).toBe(1);
    } finally {
      vi.doUnmock("@/config/users");
      vi.resetModules();
    }
  });
});
