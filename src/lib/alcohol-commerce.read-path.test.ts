import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaAuthorship, RightsLayer } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { PORTFOLIO_TAG_SLUG } from "@/lib/curation-tags";
import { CURRENT_CHECKLIST_VERSION } from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { seedMedia } from "@/lib/test-support/media-fixtures";
import { FIXTURE_CLEARANCE_SCOPE } from "@/lib/test-support/resale-rights";

/**
 * ugcportal-pgpq: THE § 9-2 PAIR, READ WHEN THE ROW IS SERVED.
 *
 * THE DEFECT, STATED ONCE AND DRIVEN BELOW. An item is public. Nobody has
 * triaged it, so `MediaListing` does not exist and the alkoholloven § 9-2
 * question "does this picture show alcohol?" has never been answered. Its
 * owner then declares a benefit (PUT /api/media/[id]/disclosure) and attaches
 * a commercial link (POST /api/media/[id]/commercial-links). Both are
 * accepted — deliberately, because the advertising label is itself a legal
 * requirement and refusing the write would make it unrecordable until an
 * admin got round to the item (see `benefitAttachmentRefusal`'s own comment).
 * Neither route writes `publishedAt` and neither reads it. The result at
 * `b592ba0` was a published row carrying a permitted advertising label and
 * one live affiliate link with the § 9-2 question unasked, served by the
 * public feed — the exact state `commercialPublishRefusal` exists to refuse,
 * reached by three ordinary owner requests in an order nobody had gated.
 *
 * THE FIX IS OPTION C, decided by the product owner and recorded with its
 * alternatives in docs/legal/alcohol-commerce-public-visibility.md: the
 * writes still succeed, `publishedAt` is untouched, and the pair is judged on
 * the READ path instead — `PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE`
 * (src/lib/alcohol-commerce.ts), a third arm of `PUBLIC_MEDIA_RIGHTS_SCOPE`
 * and so of `PUBLIC_MEDIA_SCOPE`, which every anonymous reader spreads.
 *
 * WHY THIS FILE IS NOT A RESTATEMENT OF alcohol-commerce.test.ts OR OF
 * alcohol-commerce.scope-agreement.test.ts. The first tests the predicate
 * with no database; the second compares the predicate against the `where` row
 * by row. Neither drives a REQUEST, and the defect was entirely about which
 * requests cause the pair to be evaluated: every unit test of
 * `commercialPublishRefusal` passed at `b592ba0` while the hole was live. So
 * every case here goes through the real route handlers, in the real order,
 * and then asks the six real readers of `PUBLIC_MEDIA_SCOPE` what the public
 * can see — the same six, through the same shape of helper,
 * src/lib/public-media.lapse.test.ts uses for ugcportal-nffp.
 *
 * AND EVERY ABSENCE IS MEASURED AGAINST A PRESENCE ON THE SAME ROW. In the
 * pgpq cases the item is served first, the commercial fact arrives, the item
 * is gone, and then the alcohol answer arrives and it comes back. In the
 * row-per-state cases of the qnq9.11 describe, each withheld row is followed,
 * on that same row, by its alcohol answer set to a recorded `no`, and the item
 * is asserted served. A `where` clause that filtered on everything would pass
 * the absences alone.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

/**
 * Settable rather than a thrower: five of the six readers never call `auth()`
 * at all, but GET /api/media/preview/[previewId] has an owner arm and an
 * operator arm, and the three write routes all require the owner's session.
 * Every reader below is asked ANONYMOUSLY — see {@link surfaces}.
 */
const authMock = vi.fn<() => Promise<unknown>>(async () => null);
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

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

const { PUT: DISCLOSE } = await import("@/app/api/media/[id]/disclosure/route");
const { POST: PUBLISH } = await import("@/app/api/media/[id]/publish/route");
const { POST: ATTACH_LINK } = await import(
  "@/app/api/media/[id]/commercial-links/route"
);
const { listPublicMedia, publicMediaListingUrl } = await import(
  "@/lib/public-media"
);
const { listPortfolioPieces } = await import("@/lib/portfolio");
const { getPublicMediaItem } = await import("@/lib/media-item");
const { getPublicOffer } = await import("@/lib/sellable-media");
const { default: sitemap } = await import("@/app/sitemap");
const { GET: previewGET } = await import(
  "@/app/api/media/preview/[previewId]/route"
);
const { isAlcoholUnclearedAdvertisement } = await import(
  "@/lib/alcohol-commerce"
);

/**
 * The owner of every item here, and also the admin. That is what this product
 * is (docs/ugc-research.md Decisions table: a two-person hobby, only the
 * operators' own content), and it means no case below is refused because a
 * second account happened to lack a permission.
 */
const OPERATOR = "operator-pgpq";
const MEDIA_ID = "media-pgpq";
const PREVIEW_ID = `pv-${MEDIA_ID}`;

const context = (id: string = MEDIA_ID) => ({
  params: Promise.resolve({ id }),
});

/** The owner's session, which all three write routes require. */
function asOperator(): void {
  authMock.mockResolvedValue({ user: { id: OPERATOR, role: "ADMIN" } });
}

function publishRequest() {
  return new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
    method: "POST",
  });
}

/**
 * The benefit declaration an operator who received a gifted wine glass would
 * send: a permitted label, a real brand, and that brand's § 9-2 answer
 * recorded as `no`.
 *
 * `benefitSourceAlcoholLinked: false` is carried here because an UNCHECKED
 * brand is refused by `benefitAttachmentRefusal` exactly as an alcohol-linked
 * one is — so a body without it would make every case below fail for the
 * BRAND half of § 9-2 rather than for the depiction half this bead is about.
 */
const GIFTED_GLASS = {
  benefitReceived: true,
  benefitKind: "FREE_PRODUCT",
  benefitSource: "Riedel",
  benefitSourceAlcoholLinked: false,
  marketValueOre: 49900,
  label: "Advertisement / Reklame",
};

function disclosureRequest(body: unknown = GIFTED_GLASS) {
  return new Request(`http://localhost/api/media/${MEDIA_ID}/disclosure`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function attachLinkRequest() {
  return new Request(
    `http://localhost/api/media/${MEDIA_ID}/commercial-links`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://track.adtraction.com/t/t?a=1234&m=pgpq",
        network: "ADTRACTION",
        benefitSource: "Riedel",
      }),
    },
  );
}

/**
 * Which public surfaces are serving the one seeded row right now.
 *
 * Every entry is a real reader called the way its own caller calls it, not a
 * re-implementation of its query. `feed` covers two surfaces with one query
 * site (GET /api/public/media and the server-rendered home page, which both
 * call `listPublicMedia`); the other five are one each. The list is not
 * maintained here: src/lib/public-media.consumers.test.ts derives it from the
 * source tree and requires each reader to be covered by a test naming this
 * bead, which is what makes a seventh reader somebody adds a failure there
 * rather than a silent gap here.
 */
async function surfaces(): Promise<Record<string, boolean>> {
  const feed = await listPublicMedia(publicMediaListingUrl());
  if (!feed.ok) throw new Error(`listPublicMedia failed: ${feed.error}`);

  // ANONYMOUS, always: this helper answers "what does the public see", and
  // the three write routes above leave the operator's session in the mock.
  authMock.mockResolvedValue(null);
  const previewStatus = (
    await previewGET(
      new Request(`https://example.test/api/media/preview/${PREVIEW_ID}`),
      { params: Promise.resolve({ previewId: PREVIEW_ID }) },
    )
  ).status;

  return {
    feed: feed.page.items.some((item) => item.id === MEDIA_ID),
    portfolio: (await listPortfolioPieces()).some((item) => item.id === MEDIA_ID),
    sitemap: (await sitemap()).some((entry) => entry.url.endsWith(PREVIEW_ID)),
    item: (await getPublicMediaItem(PREVIEW_ID)) !== null,
    offer: (await getPublicOffer(PREVIEW_ID)) !== null,
    // The bytes, not a link to them. 200 means a stranger can still download
    // the photograph; 404 means it is gone from the public web.
    previewBytes: previewStatus === 200,
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

/**
 * Served everywhere except the price block, which is what an UNPRICED item
 * looks like.
 *
 * `offer` is `false` here for a reason that has nothing to do with this bead:
 * `getPublicOffer` needs a `MediaListing.priceCents` and a standing
 * `ResaleRightsReview`, and an untriaged item has no listing at all to put a
 * price on. Stated as its own constant rather than folded into
 * {@link NONE_SERVED} so the difference is visible: the untriaged cases below
 * cannot exercise that column, and the priced describe further down exists
 * precisely so it is not a constant `false` across the whole file.
 */
const WITHOUT_OFFER = { ...ALL_SERVED, offer: false };

/** The Media row and its uploader attestation. Never a listing: the untriaged
 * state — no `MediaListing` row, § 9-2 unanswered — is this bead's subject,
 * and each case that wants an answer records one explicitly. */
async function seedUntriagedItem(): Promise<void> {
  await prisma.media.create({
    data: {
      id: MEDIA_ID,
      userId: OPERATOR,
      kind: "IMAGE",
      key: `media/${OPERATOR}/${MEDIA_ID}.jpg`,
      previewKey: `previews/${OPERATOR}/${MEDIA_ID}.webp`,
      previewId: PREVIEW_ID,
      mimeType: "image/jpeg",
      sizeBytes: 4096,
      originalName: `${MEDIA_ID}.jpg`,
      altText: "An empty wine glass on a windowsill",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      tags: { connect: [{ slug: PORTFOLIO_TAG_SLUG }] },
    },
  });
  await prisma.mediaAttestation.create({
    data: {
      mediaId: MEDIA_ID,
      attestedByUserId: OPERATOR,
      attestationVersion: CURRENT_ATTESTATION_VERSION,
      authorship: MediaAuthorship.AUTHOR,
      ownOriginalNotFromWeb: true,
      showsIdentifiablePeople: false,
      showsMinors: false,
      containsMusicNotOwned: false,
      otherCreativeContributor: false,
      brandOrSponsorship: true,
      aiGenerated: false,
      uploaderIsAdult: true,
    },
  });
}

/**
 * An admin triage answering the § 9-2 question, written to `MediaListing`
 * directly.
 *
 * NOT THROUGH THE CURATION ROUTE, unlike the three owner requests this file
 * drives, and the reason is that the triage write is not what is being
 * tested: its own gate (`alcoholReclassificationRefusal`) is ugcportal-6uxv's
 * subject and has its own suite. What this file needs from the answer is that
 * it exists on the row at read time, and `depictsAlcohol: false` is a state
 * that write path produces freely (it refuses only a `true` landing on an
 * item that already carries a link). The states below that NO write path
 * produces — a non-boolean — are written with raw SQL and say so.
 */
async function recordAlcoholAnswer(
  depictsAlcohol: boolean | null,
): Promise<void> {
  await prisma.mediaListing.upsert({
    where: { mediaId: MEDIA_ID },
    create: {
      mediaId: MEDIA_ID,
      depictsPeople: false,
      depictsMinors: false,
      containsMusic: false,
      thirdPartyCreator: false,
      sponsoredContent: false,
      depictsAlcohol,
      wineAccessory: true,
      triagedByUserId: OPERATOR,
      triagedAt: new Date("2026-03-03T00:00:00.000Z"),
    },
    update: { depictsAlcohol },
  });
}

beforeAll(async () => {
  // src/app/sitemap.ts returns an EMPTY sitemap when `siteOrigin()` is null,
  // which would make the `sitemap` column a constant `false` and every
  // absence asserted on it vacuous.
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
  await prisma.benefitSource.deleteMany({});
  await prisma.user.deleteMany({});

  await prisma.user.create({
    data: { id: OPERATOR, email: "operator-pgpq@example.com", role: "ADMIN" },
  });
  await prisma.tag.upsert({
    where: { slug: PORTFOLIO_TAG_SLUG },
    update: {},
    create: { slug: PORTFOLIO_TAG_SLUG, name: "Portfolio" },
  });
  asOperator();
});

describe("the three ordinary owner requests, in the order nobody gated (ugcportal-pgpq K1, K2)", () => {
  it("accepts all three, leaves publishedAt alone, and stops serving the item from every reader", async () => {
    await seedUntriagedItem();

    // (1) PUBLISH. Nothing commercial is attached yet, so § 9-2 has nothing
    // to say: a photograph of a glass is perfectly publishable as personal
    // content. 200, and the item is on every reader an unpriced item can
    // reach — the presence that makes the absences below a change.
    expect((await PUBLISH(publishRequest(), context())).status).toBe(200);
    expect(await surfaces()).toEqual(WITHOUT_OFFER);

    // (2) PUT DISCLOSURE — K1. The write SUCCEEDS, which is the decision:
    // the advertising label is a legal requirement of its own and must be
    // recordable before anybody has triaged the photograph. What changes is
    // what the public sees.
    asOperator();
    expect((await DISCLOSE(disclosureRequest(), context())).status).toBe(200);
    expect(await surfaces()).toEqual(NONE_SERVED);

    // (3) POST COMMERCIAL-LINKS — K2. Same rule, same outcome, and the
    // attach gate still lets it through for the same reason.
    asOperator();
    expect((await ATTACH_LINK(attachLinkRequest(), context())).status).toBe(201);
    expect(await surfaces()).toEqual(NONE_SERVED);

    // NOTHING WAS DEPUBLISHED, which is the other half of the decision and
    // the part that distinguishes option C from the rejected option B. A fix
    // that cleared `publishedAt` in the disclosure transaction would satisfy
    // every absence above and would also contradict ugcportal-mqh8's
    // recorded "no auto-unpublish"; this asserts it did not happen.
    const row = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: {
        publishedAt: true,
        listing: { select: { depictsAlcohol: true } },
        advertisingDisclosure: { select: { label: true } },
        _count: { select: { commercialLinks: true } },
      },
    });
    expect(row.publishedAt).not.toBeNull();
    expect(row.listing).toBeNull();
    expect(row.advertisingDisclosure?.label).toBe("Advertisement / Reklame");
    expect(row._count.commercialLinks).toBe(1);

    // (4) THE CONTROL the bead's premise rests on: the publish gate refuses
    // this exact state, and did so at `b592ba0` too while the feed served
    // it. The two now agree.
    asOperator();
    const control = await PUBLISH(publishRequest(), context());
    expect(control.status).toBe(400);
    expect(await control.json()).toMatchObject({ field: "depictsAlcohol" });

    // AND THE WAY BACK. An admin answers the question `no`; the item
    // reappears, with its label and its link. This is what connects every
    // absence above to the § 9-2 pair rather than to some other predicate —
    // and it is the owner's route out, which is what makes refusing to serve
    // the item an honest answer rather than a trap.
    await recordAlcoholAnswer(false);
    expect(await surfaces()).toEqual(WITHOUT_OFFER);
  });

  it("K1's control: with the alcohol question already answered `no`, the same PUT leaves the item public", async () => {
    // The mutation the criterion names, committed as a case. Identical
    // requests, one fact different, opposite outcome — so the absence above
    // is attributable to `depictsAlcohol` and to nothing else about the
    // disclosure body.
    await seedUntriagedItem();
    await recordAlcoholAnswer(false);

    expect((await PUBLISH(publishRequest(), context())).status).toBe(200);
    asOperator();
    expect((await DISCLOSE(disclosureRequest(), context())).status).toBe(200);
    expect(await surfaces()).toEqual(WITHOUT_OFFER);
  });

  it("K2's control: a labelled disclosure recorded BEFORE publication, then a link attached after it", async () => {
    /*
     * The other ordering the criterion asks for. The disclosure exists
     * before `publishedAt` is set, so the publish request itself is refused
     * (`commercialPublishRefusal` — this is the gate working as it always
     * did) until the answer is recorded. With the answer recorded, the
     * publish succeeds, the attach succeeds, and the item stays public;
     * clearing the answer afterwards takes it off every reader again with no
     * write to `Media` at all.
     */
    await seedUntriagedItem();
    expect((await DISCLOSE(disclosureRequest(), context())).status).toBe(200);

    asOperator();
    expect((await PUBLISH(publishRequest(), context())).status).toBe(400);

    await recordAlcoholAnswer(false);
    asOperator();
    expect((await PUBLISH(publishRequest(), context())).status).toBe(200);
    asOperator();
    expect((await ATTACH_LINK(attachLinkRequest(), context())).status).toBe(201);
    expect(await surfaces()).toEqual(WITHOUT_OFFER);

    // The answer is withdrawn — an admin un-answering a question they had
    // answered. One UPDATE on `MediaListing`, nothing written to `Media`, and
    // the advertisement is off the public web on the next request.
    await recordAlcoholAnswer(null);
    expect(await surfaces()).toEqual(NONE_SERVED);
  });
});

describe("every state that is not a recorded `no` leaves the advertisement unserved (ugcportal-pgpq)", () => {
  /**
   * FAIL-CLOSED, PROVED STATE BY STATE.
   *
   * The repo's reference for this direction is the expiry check in
   * src/lib/resale-rights.ts, written `!(expiresAt > timeOf(now))` so that a
   * `NaN` falls to the blocked side rather than to the served one.
   * `alcoholDepiction` takes the same direction by returning `"absent"` only
   * for a literal `false`, and the read-side filter takes it by asking for
   * `depictsAlcohol: false` positively instead of negating `true`.
   *
   * Each case puts the item in the SERVED state first (the answer recorded
   * `no`), then moves `depictsAlcohol` to the state under test, and asserts
   * the item is gone from all six readers. Without the first half an
   * assertion here would hold just as well for a filter that served nothing.
   */
  async function publishedAdvertisement(): Promise<void> {
    await seedUntriagedItem();
    await recordAlcoholAnswer(false);
    expect((await PUBLISH(publishRequest(), context())).status).toBe(200);
    asOperator();
    expect((await DISCLOSE(disclosureRequest(), context())).status).toBe(200);
    asOperator();
    expect((await ATTACH_LINK(attachLinkRequest(), context())).status).toBe(201);
    expect(await surfaces()).toEqual(WITHOUT_OFFER);
  }

  it("the listing is deleted outright — the question has no row to be answered in", async () => {
    await publishedAdvertisement();
    await prisma.mediaListing.deleteMany({ where: { mediaId: MEDIA_ID } });
    expect(await surfaces()).toEqual(NONE_SERVED);
  });

  it("the answer is set back to null — nobody has looked", async () => {
    await publishedAdvertisement();
    await recordAlcoholAnswer(null);
    expect(await surfaces()).toEqual(NONE_SERVED);
  });

  it("the answer is `true` — the picture shows the drink", async () => {
    await publishedAdvertisement();
    await recordAlcoholAnswer(true);
    expect(await surfaces()).toEqual(NONE_SERVED);
  });

  it("the column holds something that is not a boolean at all", async () => {
    /*
     * RAW SQL, because no write path in the product can produce this and the
     * typed Prisma client will not either — which is the point. SQLite is
     * dynamically typed, so a hand-written statement, a bad migration or a
     * restored dump can leave a string in a BOOLEAN column, and `'maybe' = 0`
     * is simply false there. A filter written `NOT: { depictsAlcohol: true }`
     * would have served this row; `depictsAlcohol: false` does not.
     *
     * The value is read back first — through SQLite's own `typeof()`, because
     * Prisma coerces a raw `SELECT` of this column to the BOOLEAN the schema
     * declares and answers `false` for the string, which is exactly the
     * coercion this case must not be assertion-blind to. Without the
     * read-back a future SQLite or Prisma that rejected or normalised the
     * write would leave this case quietly asserting the `null` branch
     * instead.
     */
    await publishedAdvertisement();
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: MEDIA_ID },
      select: { id: true },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "MediaListing" SET "depictsAlcohol" = 'maybe' WHERE "id" = ?`,
      listing.id,
    );
    const [stored] = await prisma.$queryRawUnsafe<
      { kind: string; text: string }[]
    >(
      `SELECT typeof("depictsAlcohol") AS kind, CAST("depictsAlcohol" AS TEXT) AS text
         FROM "MediaListing" WHERE "id" = ?`,
      listing.id,
    );
    expect(stored).toEqual({ kind: "text", text: "maybe" });

    expect(await surfaces()).toEqual(NONE_SERVED);
  });

  it("the predicate refuses the same four states, including the two a database cannot hold", () => {
    /*
     * The TypeScript side of the same four. `undefined` is not a database
     * state at all — it is what a `select` that found no related row hands a
     * caller — so it is unreachable from the cases above and has to be
     * asserted here. The non-boolean is cast in because the parameter type
     * forbids it, which is the same reason the raw-SQL case above exists.
     */
    const advertisement = {
      disclosure: { benefitReceived: true },
      commercialLinks: { commercialLinkCount: 1 },
    };
    const unanswered = [
      undefined,
      null,
      { depictsAlcohol: null },
      { depictsAlcohol: undefined } as unknown as { depictsAlcohol: null },
      { depictsAlcohol: "maybe" } as unknown as { depictsAlcohol: null },
      { depictsAlcohol: true },
    ];
    for (const listing of unanswered) {
      expect(
        isAlcoholUnclearedAdvertisement({ ...advertisement, listing }),
        `listing ${JSON.stringify(listing ?? null)} should refuse`,
      ).toBe(true);
    }
    // The one answered state, so the loop above is not asserting `true` for
    // every input a reader could hand it.
    expect(
      isAlcoholUnclearedAdvertisement({
        ...advertisement,
        listing: { depictsAlcohol: false },
      }),
    ).toBe(false);
  });
});

describe("a priced, cleared, fully-served item loses its price block too (ugcportal-pgpq)", () => {
  /**
   * The sixth reader, exercised rather than left constant.
   *
   * `getPublicOffer` (src/lib/sellable-media.ts) is a reader of
   * `PUBLIC_MEDIA_SCOPE` in its own right, and the cases above cannot reach
   * it: an untriaged item has no `MediaListing`, so it has nowhere to put a
   * price. This fixture is the lapse suite's one — an identifiable person,
   * cleared, priced, with the uploader's standing review — plus the § 9-2
   * answer recorded `no`, so the item starts out served on all six. Clearing
   * that one answer then has to take the price block with it: an item that is
   * not public cannot carry a public price.
   */
  async function seedSellableItem(): Promise<void> {
    await prisma.media.create({
      data: {
        id: MEDIA_ID,
        userId: OPERATOR,
        kind: "IMAGE",
        key: `media/${OPERATOR}/${MEDIA_ID}.jpg`,
        previewKey: `previews/${OPERATOR}/${MEDIA_ID}.webp`,
        previewId: PREVIEW_ID,
        mimeType: "image/jpeg",
        sizeBytes: 4096,
        originalName: `${MEDIA_ID}.jpg`,
        altText: "A portrait with a wine glass on the table",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        tags: { connect: [{ slug: PORTFOLIO_TAG_SLUG }] },
      },
    });
    await prisma.mediaAttestation.create({
      data: {
        mediaId: MEDIA_ID,
        attestedByUserId: OPERATOR,
        attestationVersion: CURRENT_ATTESTATION_VERSION,
        authorship: MediaAuthorship.AUTHOR,
        ownOriginalNotFromWeb: true,
        showsIdentifiablePeople: true,
        showsMinors: false,
        containsMusicNotOwned: false,
        otherCreativeContributor: false,
        brandOrSponsorship: true,
        aiGenerated: false,
        uploaderIsAdult: true,
      },
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
        wineAccessory: true,
        modelReleaseKey: `rights-evidence/${OPERATOR}/release.pdf`,
        triagedByUserId: OPERATOR,
        priceCents: 45000,
        currency: "NOK",
        layerClearances: {
          create: [
            {
              layer: RightsLayer.PEOPLE,
              reason:
                "Model release on file; covers online commercial publication.",
              clearedByUserId: OPERATOR,
            },
            {
              layer: RightsLayer.MINORS,
              reason: "Nobody shown is under 18.",
              clearedByUserId: OPERATOR,
            },
          ],
        },
      },
    });
    await prisma.resaleRightsReview.create({
      data: {
        uploaderUserId: OPERATOR,
        status: "CLEARED",
        route: "CONTRACT",
        checklistVersion: CURRENT_CHECKLIST_VERSION,
        // ugcportal-aqw: wide enough to cover this fixture's upload. See
        // FIXTURE_CLEARANCE_SCOPE for why that is a far cut-off rather than
        // the framework-licence flag, which would be a claim about a
        // document this fixture does not have.
        ...FIXTURE_CLEARANCE_SCOPE,
        reviewedByUserId: OPERATOR,
        reviewedAt: new Date("2026-02-01T00:00:00.000Z"),
        validUntil: new Date("2099-01-01T00:00:00.000Z"),
        productDecisionRef: "ugcportal-pgpq",
      },
    });
  }

  it("serves all six, then none of them once the alcohol answer is withdrawn, then all six again", async () => {
    await seedSellableItem();
    expect((await PUBLISH(publishRequest(), context())).status).toBe(200);
    asOperator();
    expect((await DISCLOSE(disclosureRequest(), context())).status).toBe(200);
    asOperator();
    expect((await ATTACH_LINK(attachLinkRequest(), context())).status).toBe(201);

    // A published, priced, labelled, link-carrying advertisement on a picture
    // recorded as free of alcohol. Entirely lawful, and served everywhere.
    expect(await surfaces()).toEqual(ALL_SERVED);

    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsAlcohol: null },
    });
    expect(await surfaces()).toEqual(NONE_SERVED);

    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsAlcohol: false },
    });
    expect(await surfaces()).toEqual(ALL_SERVED);
  });

  it("serves an item that carries nothing commercial unless its alcohol answer is a recorded yes (a null answer drops only the offer)", async () => {
    /*
     * THE OTHER DIRECTION, and the one that keeps this fix from being a
     * blanket "hide anything untriaged". § 9-2 is about advertising: a
     * photograph of a glass of wine with no benefit, no label and no link is
     * not advertising, so the commercial-marker gate is unchanged and lets it
     * publish. What is served is then decided by the alcohol answer alone: a
     * `null` answer keeps today's behaviour, and a recorded `true` is withheld
     * from every public surface (ugcportal-qnq9.11, docs/ugc-research.md
     * §3.1a practical rule 2).
     * Narrowing the whole filter to `depictsAlcohol: false` — dropping the
     * "nothing commercial" arm — reddens a great many tests across the
     * suite, but nearly all of them only because their own untriaged
     * fixtures have silently gone. This is the case that says what actually
     * broke, on a fixture built for the purpose.
     *
     * THE PRICE BLOCK IS THE ONE EXCEPTION, and it is not this bead's work.
     * The SALE gate already refuses an item whose ALCOHOL layer is
     * unanswered or answered `yes` (src/lib/resale-rights.ts — the layer's
     * `settledBy: "nothing"`), so `getPublicOffer` stops answering for a
     * reason that predates this filter and holds whether or not anything
     * commercial is attached. For the `null` answer the photograph itself
     * stays on all five other readers, which is the claim this case makes
     * first; the recorded `true` at the end is served on none.
     */
    await seedSellableItem();
    expect((await PUBLISH(publishRequest(), context())).status).toBe(200);
    expect(await surfaces()).toEqual(ALL_SERVED);

    // `null` (untriaged) keeps today's behaviour; a recorded `true` is
    // withheld on every reader since ugcportal-qnq9.11 (option (a), true-only).
    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsAlcohol: null },
    });
    expect(await surfaces(), "depictsAlcohol: null").toEqual(WITHOUT_OFFER);

    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsAlcohol: true },
    });
    expect(await surfaces(), "depictsAlcohol: true").toEqual(NONE_SERVED);
  });
});

describe("an item recorded as showing alcohol is served nowhere, commercial or not (ugcportal-qnq9.11 K2)", () => {
  /**
   * OPTION (a), TRUE-ONLY (decided 2026-10-14, ugcportal-6yrd): `true` is
   * withheld, `null` keeps today's behaviour. One row per state of
   * `depictsAlcohol` (a listing that does not exist, `null`, `false`, `true`)
   * crossed with commercial (nothing attached / a declared benefit AND a link)
   * against a real database, through the six real readers. The assertion is
   * the whole served set, not "the true rows are missing", so a rule that
   * served everything and a rule that served nothing both fail it.
   */
  type State = "no listing" | null | false | true;
  const STATES: State[] = ["no listing", null, false, true];

  function served(state: State, commercial: boolean): boolean {
    if (state === true) return false;
    if (commercial) return state === false;
    return true;
  }

  async function seedRow(state: State, commercial: boolean): Promise<void> {
    await seedUntriagedItem();
    if (state !== "no listing") await recordAlcoholAnswer(state);
    await prisma.media.update({
      where: { id: MEDIA_ID },
      data: { publishedAt: new Date("2026-03-02T00:00:00.000Z") },
    });
    if (!commercial) return;
    // Written directly: the routes refuse every commercial row whose alcohol
    // answer is not `no` (the publish-side gate), and this file is about what
    // the READ path does with a row that exists anyway.
    const brand = await prisma.benefitSource.create({
      data: {
        slug: "riedel-qnq9-11",
        name: "Riedel",
        alcoholLinked: false,
        alcoholAnsweredAt: new Date(),
      },
    });
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId: MEDIA_ID,
        benefitReceived: true,
        benefitKind: "FREE_PRODUCT",
        marketValueOre: 49900,
        label: "Advertisement / Reklame",
        benefitSourceId: brand.id,
      },
    });
    await prisma.commercialLink.create({
      data: {
        mediaId: MEDIA_ID,
        url: "https://track.adtraction.com/t/t?a=1234&m=qnq9-11",
        network: "ADTRACTION",
        benefitSourceId: brand.id,
      },
    });
  }

  for (const state of STATES) {
    for (const commercial of [false, true]) {
      const isServed = served(state, commercial);
      it(`depictsAlcohol ${state === "no listing" ? "(no listing)" : state}, ${commercial ? "commercial" : "nothing commercial"}: ${isServed ? "served without the offer on the five readers" : "withheld on all six readers"}`, async () => {
        await seedRow(state, commercial);
        expect(await surfaces()).toEqual(isServed ? WITHOUT_OFFER : NONE_SERVED);
        if (!isServed) {
          // The presence control on the SAME row: the absence above is the
          // alcohol/commercial rule at work, not a row nothing could ever
          // serve. Recording a `no` brings the item back on the five readers.
          await recordAlcoholAnswer(false);
          expect(await surfaces(), "same row, answer set to no").toEqual(WITHOUT_OFFER);
        }
      });
    }
  }

  it("is absent from every page of a cursor walk, with a recorded-no sibling on page two still served (K2: feed page two)", async () => {
    /*
     * The feed is newest-first and keyset-paginated. At `limit: 1` the three
     * rows below fall on pages one, two and three, so the item under test
     * (created 2026-03-01) sits on PAGE TWO, behind the cursor, between a
     * newer and an older recorded-no sibling. The control walk first proves
     * that position (with the item recorded `false` it is the page-two row);
     * the second walk then records it `true` and asserts it is on no page,
     * and that the recorded-no siblings, including the one that now occupies
     * page two, are still served.
     */
    await seedUntriagedItem();
    await recordAlcoholAnswer(false);
    await prisma.media.update({
      where: { id: MEDIA_ID },
      data: { publishedAt: new Date("2026-03-02T00:00:00.000Z") },
    });
    for (const [id, createdAt] of [
      ["newer-no", new Date("2026-03-05T00:00:00.000Z")],
      ["older-no", new Date("2026-02-01T00:00:00.000Z")],
    ] as const) {
      await seedMedia(prisma, { id, userId: OPERATOR, createdAt });
      await prisma.mediaListing.create({
        data: {
          mediaId: id,
          depictsPeople: false,
          depictsMinors: false,
          containsMusic: false,
          thirdPartyCreator: false,
          sponsoredContent: false,
          depictsAlcohol: false,
          wineAccessory: true,
          triagedByUserId: OPERATOR,
          triagedAt: new Date("2026-03-03T00:00:00.000Z"),
        },
      });
    }

    const walk = async (): Promise<string[][]> => {
      const pages: string[][] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 8; page += 1) {
        const result = await listPublicMedia(
          publicMediaListingUrl({ limit: 1, cursor }),
        );
        if (!result.ok) throw new Error(`listPublicMedia failed: ${result.error}`);
        pages.push(result.page.items.map((item) => item.id));
        if (!result.page.nextCursor) break;
        cursor = result.page.nextCursor;
      }
      return pages;
    };

    // Control: the item really is the page-two row when it is served.
    expect(await walk()).toEqual([["newer-no"], [MEDIA_ID], ["older-no"]]);

    await recordAlcoholAnswer(true);
    const pages = await walk();
    expect(pages.flat()).not.toContain(MEDIA_ID);
    expect(pages).toEqual([["newer-no"], ["older-no"]]);
  });
});
