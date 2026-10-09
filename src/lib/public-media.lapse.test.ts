import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RightsLayer } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { PORTFOLIO_TAG_SLUG } from "@/lib/curation-tags";
import { CURRENT_CHECKLIST_VERSION } from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { seedMedia } from "@/lib/test-support/media-fixtures";

/**
 * ugcportal-nffp: A CLEARANCE THAT LAPSES AFTER PUBLICATION.
 *
 * THE FAILURE, STATED ONCE. An administrator clears the PEOPLE layer on a
 * photograph of an identifiable person; the owner publishes it; something
 * then makes that clearance stop holding — the clearance row is deleted, the
 * admin who signed it is demoted, the attestation version it relied on is
 * retired, or a later triage answers "yes, somebody is shown" on a file
 * whose uploader said nobody was. NOTHING IS WRITTEN TO THE MEDIA ROW in any
 * of those. `publishedAt` is untouched. If any public surface decided what
 * to serve from a snapshot taken at publish time, it would go on serving an
 * uncleared photograph of a real person — and `src/app/sitemap.ts` would go
 * on handing its URL to search engines, which is the surface nobody gets to
 * withdraw from afterwards.
 *
 * WHY THIS FILE IS NOT A RESTATEMENT OF ugcportal-3ae'S SUITE. That bead put
 * the rights predicates inside `PUBLIC_MEDIA_SCOPE`, and its tests seed rows
 * that were ALREADY in the refused state and assert they are not served.
 * Not one of them takes a row that IS public and makes it lapse. The
 * difference is not pedantry: a `where` clause and a materialised
 * `isPublic` column both pass "seed it broken, assert it is hidden", and
 * only one of them survives a condition that stops holding with no write.
 * So every case here MUTATES A LIVE, CURRENTLY-VISIBLE ROW and then PUTS IT
 * BACK, and asserts the row reappears — the restore is what connects the
 * absence to the lapse rather than to some unrelated predicate.
 *
 * SIX READERS, DERIVED FROM THE SOURCE. `src/lib/public-media.consumers.test.ts`
 * scans the tree for them and requires each one to name this bead; the list
 * is kept there, not here. All six run against the same row in
 * {@link surfaces} below, so a fix that reaches the HTML and not the bytes —
 * or the listings and not the sitemap — fails here.
 *
 * A REAL DATABASE AND THE REAL MIGRATIONS, for the reason
 * src/lib/test-support/db.ts gives: the claim is about what SQLite returns
 * for a relation filter after another table changed, and a mocked client
 * agrees with whatever the test expects.
 */

/**
 * Not a thrower, unlike the other anonymous-surface suites: five of the six
 * readers here never call `auth()`, but GET /api/media/preview/[previewId]
 * does — it has an owner arm and an operator arm — and WHO IS ASKING is
 * itself one of the things this file has to assert. Settable rather than a fixed `null` for that reason; every
 * caller goes through {@link previewStatus}, which sets it and puts it back.
 */
const authMock = vi.fn<() => Promise<unknown>>(async () => null);

vi.mock("@/lib/auth", () => ({ auth: authMock }));

vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...actual,
    getS3Client: () => ({
      send: async () => ({
        Body: {
          transformToWebStream: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
                controller.close();
              },
            }),
        },
      }),
    }),
    getBucketName: () => "test-bucket",
  };
});

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { PUBLIC_MEDIA_SCOPE } = await import("@/lib/public-media");
const { PUBLIC_MEDIA_RIGHTS_SCOPE } = await import("@/lib/publishability");
const { listPublicMedia, publicMediaListingUrl } = await import("@/lib/public-media");
const { listPortfolioPieces } = await import("@/lib/portfolio");
const { getPublicMediaItem } = await import("@/lib/media-item");
const { getPublicOffer } = await import("@/lib/sellable-media");
const { default: sitemap } = await import("@/app/sitemap");
const { GET: previewGET } = await import(
  "@/app/api/media/preview/[previewId]/route"
);

const OWNER = "owner-nffp";
const ADMIN = "admin-nffp";
/** Signed in, an ordinary USER, and not the uploader of anything here. */
const STRANGER = "stranger-nffp";
const MEDIA_ID = "media-nffp";
const PREVIEW_ID = `pv-${MEDIA_ID}`;

/**
 * Who is asking for the bytes. `null` is nobody signed in.
 *
 * The ROLE is carried here because the route reads it off the session —
 * `src/lib/auth.ts`'s session callback re-derives it from the `User` row on
 * every request — so a test that wants to demote an operator has to change
 * both the row and what the session reports, exactly as production does.
 */
type Viewer = null | {
  id: string;
  /**
   * ABSENT is a state of its own, not a default. A session carrying a user
   * id and no role at all is what a malformed or older-shaped session looks
   * like, and it has to be expressible here — otherwise the cases that
   * exercise it cannot go through {@link previewStatus} and have to build
   * their own session and restore it by hand, which is the discipline this
   * type exists to keep.
   */
  role?: "USER" | "ADMIN";
};

const ANONYMOUS: Viewer = null;
const AS_STRANGER: Viewer = { id: STRANGER, role: "USER" };
const AS_OPERATOR: Viewer = { id: ADMIN, role: "ADMIN" };
const AS_OWNER: Viewer = { id: OWNER, role: "USER" };

/**
 * The status GET /api/media/preview/[previewId] answers one viewer, for one
 * handle.
 *
 * 200 means that caller can still download the photograph; 404 means it is
 * gone for them. Restores the anonymous session afterwards in a `finally`,
 * so a case that throws cannot leave the next one running as somebody else
 * — the failure mode that would make {@link surfaces} silently measure an
 * operator's view and call it the public's.
 *
 * EVERY CASE IN THIS FILE THAT TOUCHES THE ROUTE GOES THROUGH HERE, and
 * that is enforced by {@link Viewer} being expressive enough to cover the
 * odd sessions too — a role is optional and an id may be blank — rather
 * than by each case remembering. There is no `restoreMocks` in
 * vitest.config.ts, so a case that set `authMock` and called the route
 * directly would leak its session into the next one with nothing to catch
 * it.
 *
 * `role` is omitted from the session object when the viewer has none,
 * rather than being passed as `undefined`: `{ user: { id, role: undefined } }`
 * and `{ user: { id } }` are different objects to anything that uses `in`,
 * and the route's own `?? null` is being exercised for the second shape.
 */
async function previewStatus(
  viewer: Viewer,
  previewId: string = PREVIEW_ID,
): Promise<number> {
  authMock.mockResolvedValue(
    viewer === null
      ? null
      : {
          user: {
            id: viewer.id,
            ...(viewer.role === undefined ? {} : { role: viewer.role }),
          },
        },
  );
  try {
    const response = await previewGET(
      new Request(`https://example.test/api/media/preview/${previewId}`),
      { params: Promise.resolve({ previewId }) },
    );
    return response.status;
  } finally {
    authMock.mockResolvedValue(null);
  }
}

/**
 * Which public surfaces are serving the one seeded row right now.
 *
 * Every entry is a real reader called the way its own caller calls it, not a
 * re-implementation of its query. `feed` covers two surfaces with one query
 * site (`GET /api/public/media` and the server-rendered home page, which
 * both call `listPublicMedia`); the other five are one each.
 */
async function surfaces(): Promise<Record<string, boolean>> {
  const feed = await listPublicMedia(publicMediaListingUrl());
  if (!feed.ok) throw new Error(`listPublicMedia failed: ${feed.error}`);

  // ANONYMOUS, always. This helper answers "what does the public see", and
  // the other five readers are anonymous by construction — they never call
  // `auth()` at all. Who else may fetch the bytes is a different question
  // and has its own describe below.
  const previewStatusCode = await previewStatus(ANONYMOUS);

  return {
    feed: feed.page.items.some((item) => item.id === MEDIA_ID),
    portfolio: (await listPortfolioPieces()).some((item) => item.id === MEDIA_ID),
    sitemap: (await sitemap()).some((entry) => entry.url.endsWith(PREVIEW_ID)),
    item: (await getPublicMediaItem(PREVIEW_ID)) !== null,
    offer: (await getPublicOffer(PREVIEW_ID)) !== null,
    // The bytes, not a link to them. 200 means a stranger can still download
    // the photograph; 404 means it is gone from the public web.
    previewBytes: previewStatusCode === 200,
  };
}

const ALL_SERVED = {
  feed: true,
  portfolio: true,
  sitemap: true,
  item: true,
  offer: true,
  previewBytes: true,
};

const NONE_SERVED = {
  feed: false,
  portfolio: false,
  sitemap: false,
  item: false,
  offer: false,
  previewBytes: false,
};

/** The listing id of the one seeded row, re-read because it is a cuid. */
async function listingId(): Promise<string> {
  const listing = await prisma.mediaListing.findUniqueOrThrow({
    where: { mediaId: MEDIA_ID },
    select: { id: true },
  });
  return listing.id;
}

/**
 * One published, cleared, priced photograph of an identifiable person — the
 * only row in the database, so an assertion below cannot pass because some
 * other row happened to answer.
 *
 * PRICED AND SELLABLE TOO, which is more than the visibility question needs
 * and is the point: `getPublicOffer` (src/lib/sellable-media.ts) is the
 * sixth reader of the scope, and a fixture that was never sellable would
 * make its column of every table below a constant `false` that proves
 * nothing.
 */
async function seed(): Promise<void> {
  await prisma.user.createMany({
    data: [
      { id: OWNER, email: "owner-nffp@example.com", role: "USER" },
      { id: ADMIN, email: "admin-nffp@example.com", role: "ADMIN" },
      { id: STRANGER, email: "stranger-nffp@example.com", role: "USER" },
    ],
  });
  await prisma.tag.upsert({
    where: { slug: PORTFOLIO_TAG_SLUG },
    update: {},
    create: { slug: PORTFOLIO_TAG_SLUG, name: "Portfolio" },
  });

  await seedMedia(prisma, {
    id: MEDIA_ID,
    userId: OWNER,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    tags: [PORTFOLIO_TAG_SLUG],
    // The uploader's own answer: somebody identifiable is in the frame. This
    // is what makes the PEOPLE clearance load-bearing for this row, and so
    // what makes its lapse observable at all.
    showsIdentifiablePeople: true,
  });

  await prisma.mediaListing.create({
    data: {
      mediaId: MEDIA_ID,
      depictsPeople: true,
      depictsMinors: false,
      containsMusic: false,
      thirdPartyCreator: false,
      sponsoredContent: false,
      depictsAlcohol: false,
      wineAccessory: false,
      modelReleaseKey: "rights-evidence/owner-nffp/release.pdf",
      triagedByUserId: ADMIN,
      priceCents: 45000,
      currency: "NOK",
      layerClearances: {
        create: [
          {
            layer: RightsLayer.PEOPLE,
            reason: "Model release on file; covers online commercial publication.",
            clearedByUserId: ADMIN,
          },
          {
            layer: RightsLayer.MINORS,
            reason: "Nobody shown is under 18.",
            clearedByUserId: ADMIN,
          },
        ],
      },
    },
  });

  await prisma.resaleRightsReview.create({
    data: {
      uploaderUserId: OWNER,
      status: "CLEARED",
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      reviewedByUserId: ADMIN,
      reviewedAt: new Date("2026-02-01T00:00:00.000Z"),
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
}

beforeAll(async () => {
  // `src/app/sitemap.ts` returns an EMPTY sitemap when `siteOrigin()` is
  // null, which would make the `sitemap` column below a constant `false`
  // and every absence assertion on it vacuous.
  process.env.AUTH_URL = "https://example.test";
  await applyMigrations(prisma);
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  await prisma.resaleRightsReview.deleteMany({});
  await prisma.media.deleteMany({});
  await prisma.user.deleteMany({});
  await seed();
});

describe("a lapsed clearance removes an already-published item from every public surface (ugcportal-nffp K1)", () => {
  it("serves the row on all six readers to begin with, so every absence below is a change", async () => {
    // Without this the whole file could pass against a scope that filtered
    // on everything. It is also the half of the "mutate the fixture"
    // requirement that is easy to skip: an absence proves nothing unless
    // presence was measured first, on the same row, by the same readers.
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("the admin who signed the PEOPLE clearance is demoted — and promoting them back restores the row", async () => {
    /*
     * The named K1 mutation. A role change is a write to `User`, with
     * nothing at all written to `Media`, `MediaListing` or
     * `MediaRightsClearance` — so a surface deciding from anything
     * snapshotted at publish time keeps serving the photograph. The gate's
     * own `layerIsCleared` re-reads the role for this reason; the scope's
     * `clearedBy: { is: { role: ADMIN } }` is the same rule as a query, and
     * this is what proves the two agree at run time rather than on paper.
     */
    await prisma.user.update({ where: { id: ADMIN }, data: { role: "USER" } });
    expect(await surfaces()).toEqual(NONE_SERVED);

    await prisma.user.update({ where: { id: ADMIN }, data: { role: "ADMIN" } });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("the PEOPLE clearance is withdrawn — and recording it again restores the row", async () => {
    await prisma.mediaRightsClearance.deleteMany({
      where: { listingId: await listingId(), layer: RightsLayer.PEOPLE },
    });
    expect(await surfaces()).toEqual(NONE_SERVED);

    await prisma.mediaRightsClearance.create({
      data: {
        listingId: await listingId(),
        layer: RightsLayer.PEOPLE,
        reason: "Re-reviewed; release re-confirmed with the depicted person.",
        clearedByUserId: ADMIN,
      },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("the PEOPLE clearance loses its justification — and restoring the reason restores the row", async () => {
    // `reason: { not: "" }` in the scope. The whitespace-only case is the
    // one state the `where` judges differently from the predicate and is
    // enumerated as such in src/lib/publishability.scope-agreement.test.ts;
    // this is the empty-string case, which both refuse.
    await prisma.mediaRightsClearance.updateMany({
      where: { listingId: await listingId(), layer: RightsLayer.PEOPLE },
      data: { reason: "" },
    });
    expect(await surfaces()).toEqual(NONE_SERVED);

    await prisma.mediaRightsClearance.updateMany({
      where: { listingId: await listingId(), layer: RightsLayer.PEOPLE },
      data: { reason: "Model release on file." },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("the attestation version is retired — and re-attesting at the current version restores the row", async () => {
    /*
     * Retiring a version is a CODE change (dropping the string from
     * `ACCEPTED_ATTESTATION_VERSIONS`, src/lib/attestation.ts), so it is
     * simulated here from the other side — moving the row to a version that
     * is not in the live set — which is the same comparison with the same
     * outcome and does not require mutating a module constant that other
     * suites in the same worker read.
     */
    await prisma.mediaAttestation.update({
      where: { mediaId: MEDIA_ID },
      data: { attestationVersion: "1999-01-01.1" },
    });
    expect(await surfaces()).toEqual(NONE_SERVED);

    await prisma.mediaAttestation.update({
      where: { mediaId: MEDIA_ID },
      data: { attestationVersion: CURRENT_ATTESTATION_VERSION },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("the uploader disclaims the rights after publishing — and withdrawing that restores the row", async () => {
    await prisma.mediaAttestation.update({
      where: { mediaId: MEDIA_ID },
      data: { authorship: "NEITHER" },
    });
    expect(await surfaces()).toEqual(NONE_SERVED);

    await prisma.mediaAttestation.update({
      where: { mediaId: MEDIA_ID },
      data: { authorship: "AUTHOR" },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("a later admin triage answers yes to the people question on a row whose clearance is gone", async () => {
    /*
     * The lapse that arrives from the ADMIN's side rather than the
     * uploader's: a file published as "nobody identifiable" that triage
     * later disagrees with. Both halves are mutated, because either alone
     * leaves the row public for a legitimate reason — the uploader's `yes`
     * is already covered by the clearance, and a triage `yes` with the
     * clearance still in place is a cleared row.
     */
    await prisma.mediaAttestation.update({
      where: { mediaId: MEDIA_ID },
      data: { showsIdentifiablePeople: false },
    });
    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsPeople: false },
    });
    await prisma.mediaRightsClearance.deleteMany({
      where: { listingId: await listingId(), layer: RightsLayer.PEOPLE },
    });
    // Nobody says a person is shown, no clearance is needed, the row is
    // public — the state this mutation starts from. `false` rather than
    // `null`: an unanswered triage is also not-identifiable for the scope
    // (the `listing-untriaged` case in
    // src/lib/publishability.scope-agreement.test.ts covers that arm), but
    // it is `triage_incomplete` for the SALE gate, which would take the
    // offer column down for a reason that has nothing to do with this
    // mutation.
    expect(await surfaces()).toEqual(ALL_SERVED);

    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsPeople: true },
    });
    expect(await surfaces()).toEqual(NONE_SERVED);

    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsPeople: false },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });
});

/**
 * WHO MAY STILL FETCH THE BYTES — the question `surfaces()` above
 * deliberately does not ask, because it only ever asks anonymously.
 *
 * THE DEFECT THESE EXIST TO CATCH, stated as the failure. Putting
 * `PUBLIC_MEDIA_SCOPE` into the public arm of the SIGNED-IN scope takes the
 * preview away from every signed-in non-owner, operators included — and the
 * admin curation screen (src/app/admin/curation/page.tsx) lists every upload
 * with no `where` and renders each thumbnail through this route. The one
 * screen whose job is recording the clearance then 404s exactly the rows
 * that need one: clear the photograph to see it, see it to clear it. A suite
 * with `auth` pinned to `null` and a single anonymous column cannot see any
 * of that.
 *
 * Four viewers, three rows, and every cell is asserted rather than a
 * representative sample, because that failure lives in one cell.
 */
describe("who may still fetch the preview bytes, by viewer (ugcportal-nffp K1)", () => {
  const UNPUBLISHED_ID = "media-nffp-unpublished";

  beforeEach(async () => {
    // Somebody else's upload, never published. Its own row rather than a
    // mutation of the one above, so the published cases keep their fixture.
    await seedMedia(prisma, {
      id: UNPUBLISHED_ID,
      userId: OWNER,
      createdAt: new Date("2026-02-20T00:00:00.000Z"),
      published: false,
    });
  });

  /** Every viewer's status for one handle, in one object. */
  async function byViewer(previewId: string): Promise<Record<string, number>> {
    return {
      anonymous: await previewStatus(ANONYMOUS, previewId),
      signedInStranger: await previewStatus(AS_STRANGER, previewId),
      operator: await previewStatus(AS_OPERATOR, previewId),
      owner: await previewStatus(AS_OWNER, previewId),
    };
  }

  it("serves a cleared, published row to everyone", async () => {
    // The row that makes every 404 below a change rather than the default.
    expect(await byViewer(PREVIEW_ID)).toEqual({
      anonymous: 200,
      signedInStranger: 200,
      operator: 200,
      owner: 200,
    });
  });

  it("withholds a LAPSED row from the public and the signed-in stranger, and keeps serving the operator and the owner", async () => {
    /*
     * The finding, as an assertion. `signedInStranger` is the cell that
     * proves the gate still closes for an ordinary signed-in visitor — a
     * fix that simply reopened the public arm would turn that cell green
     * and this case red. `operator` is the cell that was 404 before the
     * operator arm existed.
     */
    await prisma.mediaRightsClearance.deleteMany({
      where: { listingId: await listingId(), layer: RightsLayer.PEOPLE },
    });

    expect(await byViewer(PREVIEW_ID)).toEqual({
      anonymous: 404,
      signedInStranger: 404,
      operator: 200,
      owner: 200,
    });
  });

  it("withholds an UNPUBLISHED row from the public and the stranger, and serves the operator and the owner", async () => {
    /*
     * A PRE-EXISTING 404 for the operator, not one this bead introduced:
     * before any of this, the signed-in scope was
     * `OR: [{ publishedAt: { not: null } }, { userId }]`, so an operator
     * looking at somebody else's unpublished upload got nothing either. The
     * operator arm closes it too, which is deliberate — ugcportal-3ae means
     * the ordinary order is upload, triage, clear, THEN publish, so
     * unpublished rows are most of what the curation screen handles, and an
     * operator arm that stopped at published rows would leave the deadlock
     * standing for the common case while looking fixed.
     */
    expect(await byViewer(`pv-${UNPUBLISHED_ID}`)).toEqual({
      anonymous: 404,
      signedInStranger: 404,
      operator: 200,
      owner: 200,
    });
  });

  it("closes the operator arm the moment that operator is demoted", async () => {
    /*
     * The operator arm is `isPublishOperator(role)` over the role the
     * session reports, and `src/lib/auth.ts` re-derives that from the `User`
     * row on every request. So a demotion has to land on the next request
     * with nothing to invalidate — the same property `layerIsCleared` needs
     * for a clearance, and the same lapse this whole file is about, now
     * applied to the person asking rather than to the row.
     *
     * Both halves are changed, because production changes both: the column,
     * and what the next session read therefore reports.
     */
    await prisma.mediaRightsClearance.deleteMany({
      where: { listingId: await listingId(), layer: RightsLayer.PEOPLE },
    });
    expect(await previewStatus(AS_OPERATOR)).toBe(200);

    await prisma.user.update({ where: { id: ADMIN }, data: { role: "USER" } });
    expect(await previewStatus({ id: ADMIN, role: "USER" })).toBe(404);

    await prisma.user.update({ where: { id: ADMIN }, data: { role: "ADMIN" } });
    expect(await previewStatus(AS_OPERATOR)).toBe(200);
  });

  it("does not open the arm for a session that carries no role, even for a user who is an ADMIN", async () => {
    /*
     * The arm is a pure function of the role it is HANDED, not of anything
     * it looks up. This user IS an ADMIN in the database, and the session
     * still does not open the arm, because the session carries no role —
     * the shape a malformed or older-shaped session has.
     *
     * That is the fail-closed direction, and it is the one worth pinning:
     * the route folds a missing role to `null` and `isPublishOperator`
     * refuses it, so a session this route cannot read a role out of is
     * treated as an ordinary signed-in visitor rather than given the
     * benefit of the doubt. Keeping the role FRESH is a different
     * guarantee with a different owner — `src/lib/auth.ts`'s session
     * callback re-reads `User.role` per request — and the demotion case
     * above is what exercises that.
     */
    await prisma.mediaRightsClearance.deleteMany({
      where: { listingId: await listingId(), layer: RightsLayer.PEOPLE },
    });
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: ADMIN },
        select: { role: true },
      }),
    ).toEqual({ role: "ADMIN" });
    expect(await previewStatus({ id: ADMIN })).toBe(404);
  });

  it("treats a session carrying ADMIN but no usable id as anonymous, not as an operator", async () => {
    /*
     * The route normalises "nobody is signed in" exactly once, and the
     * operator arm is guarded on that normalised id as well as on the role
     * — so a half-formed session cannot step around it. Same family as the
     * five `treats … as anonymous` cases in this route's own suite, which
     * exist because Prisma drops an `undefined` filter and an empty `OR`
     * branch matches every row.
     */
    await prisma.mediaRightsClearance.deleteMany({
      where: { listingId: await listingId(), layer: RightsLayer.PEOPLE },
    });
    expect(await previewStatus({ id: "", role: "ADMIN" })).toBe(404);
  });
});

describe("a lapse reaches page two of the paginated feed as well (ugcportal-nffp K1)", () => {
  it("drops the lapsed row from a cursor walk, not only from the first page", async () => {
    /*
     * `listMedia` merges the scope with its keyset predicate as
     * `{ ...scope, ...keyset }` and the keyset is `{ OR: [...] }`. A rights
     * half written at the top level with its own `OR` would be silently
     * overwritten from page two onwards — page one correct, every later
     * page serving the lapsed row. The disjunction is nested under `AND`
     * for exactly that reason, and the structural assertion in
     * src/lib/public-media.consumers.test.ts pins the shape; this walks the
     * pages and pins the behaviour.
     */
    for (const [index, id] of ["older-a", "older-b"].entries()) {
      await seedMedia(prisma, {
        id,
        userId: OWNER,
        createdAt: new Date(Date.UTC(2026, 1, 1 + index)),
      });
    }

    const walk = async (): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 8; page += 1) {
        const result = await listPublicMedia(
          publicMediaListingUrl({ limit: 1, cursor }),
        );
        if (!result.ok) throw new Error(`listPublicMedia failed: ${result.error}`);
        ids.push(...result.page.items.map((item) => item.id));
        if (!result.page.nextCursor) break;
        cursor = result.page.nextCursor;
      }
      return ids;
    };

    // Newest first, so the row under test is on page one and the two
    // filler rows are behind it — the lapse has to survive the cursor.
    expect(await walk()).toEqual([MEDIA_ID, "older-b", "older-a"]);

    await prisma.mediaAttestation.update({
      where: { mediaId: "older-a" },
      data: { attestationVersion: "1999-01-01.1" },
    });
    expect(await walk()).toEqual([MEDIA_ID, "older-b"]);

    await prisma.mediaAttestation.update({
      where: { mediaId: "older-a" },
      data: { attestationVersion: CURRENT_ATTESTATION_VERSION },
    });
    expect(await walk()).toEqual([MEDIA_ID, "older-b", "older-a"]);
  });
});

/**
 * THE OTHER HALF OF K1'S CHOICE, AND IT IS A DECISION RATHER THAN AN
 * OVERSIGHT — recorded here because K1 permits exactly two answers and this
 * family gets the second one.
 *
 * The bead names three lapses of the UPLOADER'S STANDING REVIEW
 * (`ResaleRightsReview`): the status moving to REVOKED or EXPIRED,
 * `validUntil` passing, and the checklist version being retired. None of
 * them depublishes anything, and none of them should.
 *
 *   1. SELLABILITY IS NOT VISIBILITY. `ResaleRightsReview` answers "may this
 *      person's work be RESOLD at all" — Part E.3 of
 *      docs/legal/instagram-resale-rights-checklist.md.
 *      src/lib/publishability.ts says it directly —
 *      "an item can be perfectly publishable and unsellable, which is the
 *      ordinary case for everything on this site today" — and
 *      src/lib/sellable-media.ts says it again from the other side.
 *      Folding the review into `PUBLIC_MEDIA_SCOPE` would empty every
 *      public surface of every photograph nobody has priced, which is all
 *      of them.
 *
 *   2. THE LEGAL REVIEW REACHED THE SAME CONCLUSION, dated 2026-09-28:
 *      docs/legal/manual-upload-rights-review.md §2, the "E.3 Revocation
 *      cascades" row. READ IT AT THE RIGHT STRENGTH, because the row has
 *      two halves and only one of them is settled. Its DESCRIPTIVE half is
 *      a statement of fact about this code and is simply true — the
 *      checklist's "all listings from that account are unpublished
 *      immediately" is "an over-claim … a REVOKED uploader's files are
 *      unsellable (status check), but nothing unpublishes them
 *      (`publishedAt` is untouched; §3.3)". Its PRESCRIPTIVE half — the
 *      proposed replacement "Admin revocation or uploader withdrawal →
 *      REVOKED → every file of that uploader fails the gate immediately.
 *      Public visibility is a separate switch (ugcportal-3ae)" — is a
 *      RECOMMENDATION, not yet the process's decision: that document's own
 *      status header says every decision in it becomes the process's when
 *      ugcportal-zec's process owner ratifies it, and §8's ratification
 *      table is still blank. So it is cited here as a second, independent
 *      author reaching this conclusion, not as an authority that closes
 *      the question. Reason 1 above carries the decision on its own; the
 *      same document's §4 closing paragraph points the same way, scoping
 *      the publish path to the attestation and the PEOPLE clearance, "not
 *      the whole gate, because publishing is not selling" — which is the
 *      gate ugcportal-3ae built and the one the cases above exercise.
 *
 *   3. THE RIGHT INSTRUMENT ALREADY EXISTS for the cases people reach for
 *      this one to cover. An uploader who wants their work off the site
 *      unpublishes it (ugcportal-rh9q owns owner-initiated withdrawal); a
 *      depicted person who objects is ugcportal-qnq9.5, which is per-file
 *      and not per-uploader. Revoking an uploader-grained, sale-scoped
 *      review is the wrong grain for either.
 *
 * So the assertions below are deliberately the opposite shape from the ones
 * above: they pin that the photograph STAYS and only the offer goes. If a
 * later bead decides differently, this suite is what it has to change in
 * the open rather than by accident.
 */
describe("a lapsed ResaleRightsReview withdraws the price and not the photograph (ugcportal-nffp K1)", () => {
  const WITHOUT_OFFER = { ...ALL_SERVED, offer: false };

  it("the uploader's review is REVOKED", async () => {
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { status: "REVOKED" },
    });
    expect(await surfaces()).toEqual(WITHOUT_OFFER);

    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { status: "CLEARED" },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("the uploader's review simply expires, with nobody writing anything", async () => {
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { validUntil: new Date("2020-01-01T00:00:00.000Z") },
    });
    expect(await surfaces()).toEqual(WITHOUT_OFFER);

    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { validUntil: new Date("2099-01-01T00:00:00.000Z") },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("the checklist version the review was granted under is retired", async () => {
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { checklistVersion: "1999-01-01.1" },
    });
    expect(await surfaces()).toEqual(WITHOUT_OFFER);

    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { checklistVersion: CURRENT_CHECKLIST_VERSION },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });
});

describe("the lapse predicate lives in PUBLIC_MEDIA_SCOPE itself, so a later reader inherits it (ugcportal-nffp K2)", () => {
  it("reaches the rights half only through the shared constant", () => {
    // The literal reading of K2: not "each reader checks the gate", but
    // "the scope constant carries it". `src/lib/public-media.consumers.test.ts`
    // asserts the key set; this asserts the values are the same objects, so
    // a reader spreading the scope cannot be getting a different rights
    // half from the one publishability.ts exports.
    expect(PUBLIC_MEDIA_SCOPE.AND).toBe(PUBLIC_MEDIA_RIGHTS_SCOPE.AND);
  });

  it("is RELATION FILTERS ONLY — which is what makes it re-evaluated rather than snapshotted", () => {
    /*
     * THE PROPERTY THE WHOLE BEAD RESTS ON, asserted rather than described.
     *
     * Every lapse above works because the rights half asks another table a
     * question at query time. The failure mode this guards is the natural
     * "optimisation": denormalising the answer onto `Media` as, say, a
     * `rightsOk` boolean kept current by the publish route, and filtering on
     * that instead. It would be faster, it would be indexable alongside the
     * partial index the column half already has — and it would be a
     * snapshot, so every case above would start failing in the one
     * direction nobody notices, with the row STILL SERVED.
     *
     * It would also pass the existing structural check in
     * src/lib/public-media.consumers.test.ts, which compares key sets and
     * has no opinion about whether a key names a column or a relation.
     *
     * So: every arm of the rights half may only key on `attestation`,
     * `listing`, or a nested `OR` of arms that do. A `Media` scalar
     * appearing here fails this test.
     */
    const RELATIONS = ["attestation", "listing"];

    const armKeys = (arm: Record<string, unknown>): string[] =>
      Object.entries(arm).flatMap(([key, value]) =>
        key === "OR" || key === "AND"
          ? (value as Record<string, unknown>[]).flatMap(armKeys)
          : [key],
      );

    const keys = [...new Set(armKeys(PUBLIC_MEDIA_RIGHTS_SCOPE))].sort();
    // Non-empty first: a walker that came back with nothing would make the
    // subset check below pass against a rights half of any shape at all.
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(RELATIONS);
  });
});
