import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { MediaAuthorship } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * PUT /api/media/[id]/disclosure (ugcportal-qnq9.1), against a REAL database
 * rather than a mocked Prisma client.
 *
 * WHY REAL. The claims worth making about this route are claims a mock simply
 * agrees with: that a declared benefit with no permitted label is never
 * STORED (the storage half of K5), that re-declaring the same brand under a
 * different spelling reuses one BenefitSource row, that withdrawing a benefit
 * actually clears the label out of the table, and that the publish gate then
 * sees what was written. The same reasoning route.integration.test.ts next
 * door gives for the alt-text gate.
 *
 * The publish route is imported here too, so the pair can be exercised in the
 * order an operator would hit them: record the benefit, then try to publish.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { PUT } = await import("@/app/api/media/[id]/disclosure/route");
const { POST: PUBLISH } = await import("@/app/api/media/[id]/publish/route");
const { PERMITTED_ADVERTISING_LABELS } = await import(
  "@/lib/advertising-disclosure"
);

const OWNER_ID = "owner-qnq9-1";
const OTHER_ID = "other-qnq9-1";
const MEDIA_ID = "media-qnq9-1";

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: OWNER_ID, email: "owner-qnq9-1@example.com" },
  });
  await prisma.user.create({
    data: { id: OTHER_ID, email: "other-qnq9-1@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(() => {
  // The owner, signed in -- and an OPERATOR (ugcportal-9gt1). `role` is
  // `ADMIN` because the cases below that cross into the publish route need
  // it: publishing takes an operator as well as the row's owner since that
  // bead, so an ordinary-user session would make them refuse 403 for a
  // reason that is not what they are testing. Nothing in THIS route reads
  // the role (it gates on `requireOwnedMedia` alone), so the change is
  // invisible to every other case here.
  // The ownership-gate describe overrides this per test; every other test
  // in this file is about what the owner's own request does.
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "ADMIN" } });
});

afterEach(async () => {
  // Media cascades the disclosure away; brands are their own table and are
  // cleared separately so each test starts with an empty vocabulary.
  await prisma.media.deleteMany({});
  await prisma.benefitSource.deleteMany({});
});

async function seedMedia(publishedAt: Date | null = null) {
  await prisma.media.create({
    data: {
      id: MEDIA_ID,
      userId: OWNER_ID,
      kind: "IMAGE",
      key: `media/${OWNER_ID}/original.png`,
      previewKey: `previews/${OWNER_ID}/preview.webp`,
      previewId: "preview-qnq9-1",
      mimeType: "image/png",
      sizeBytes: 2048,
      originalName: "IMG_0001.HEIC",
      altText: "A wine glass on a windowsill",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAt,
    },
  });

  // The uploader's rights declaration (ugcportal-3ae). The publish gate
  // refuses without one, and this file's publish cases are about the
  // disclosure rather than about that — nobody identifiable is in the frame,
  // so no PEOPLE clearance is needed either.
  await prisma.mediaAttestation.create({
    data: {
      mediaId: MEDIA_ID,
      attestedByUserId: OWNER_ID,
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

function context(id: string = MEDIA_ID) {
  return { params: Promise.resolve({ id }) };
}

function disclosureRequest(body: unknown, id: string = MEDIA_ID) {
  return new Request(`http://localhost/api/media/${id}/disclosure`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The row as stored, or null. */
function storedDisclosure() {
  return prisma.mediaAdvertisingDisclosure.findUnique({
    where: { mediaId: MEDIA_ID },
    select: {
      benefitReceived: true,
      benefitKind: true,
      marketValueOre: true,
      label: true,
      benefitSource: { select: { slug: true, name: true, alcoholLinked: true } },
    },
  });
}

/**
 * A listing on the seeded item with the alcohol question answered `no` and
 * every other triage question answered too (ugcportal-qnq9.3).
 *
 * Only `depictsAlcohol` is read by anything in this file — the publish gate
 * selects that column and nothing else — but the row is filled in completely
 * so it is not a half-triaged listing that a later reader has to interpret.
 */
async function seedAlcoholFreeListing(depictsAlcohol: boolean | null = false) {
  await prisma.mediaListing.create({
    data: {
      mediaId: MEDIA_ID,
      depictsPeople: false,
      depictsMinors: false,
      containsMusic: false,
      thirdPartyCreator: false,
      sponsoredContent: false,
      depictsAlcohol,
      wineAccessory: true,
    },
  });
}

const GIFTED_GLASS = {
  benefitReceived: true,
  benefitKind: "FREE_PRODUCT",
  benefitSource: "Riedel",
  // §3.1a practical rule 1's answer, checked and clean (ugcportal-qnq9.3 K4).
  // Carried by the baseline fixture because an UNCHECKED brand is refused
  // exactly as an alcohol-linked one is, so a body that left this out would
  // make every case below fail for this bead's reason rather than its own.
  // Riedel makes glasses, which is the site's chosen subject, and does not
  // make the drink — so `false` is the true answer as well as the convenient
  // one. The qnq9.3 describe at the bottom of this file is where the other
  // two answers are the subject.
  benefitSourceAlcoholLinked: false,
  marketValueOre: 49900,
  label: "Advertisement / Reklame",
};

describe("the ownership gate", () => {
  it("returns 401 for an anonymous caller and stores nothing", async () => {
    authMock.mockResolvedValue(null);
    await seedMedia();

    const response = await PUT(disclosureRequest(GIFTED_GLASS), context());

    expect(response.status).toBe(401);
    expect(await storedDisclosure()).toBeNull();
  });

  it("returns 403 for someone else's item and stores nothing", async () => {
    authMock.mockResolvedValue({ user: { id: OTHER_ID, role: "USER" } });
    await seedMedia();

    const response = await PUT(disclosureRequest(GIFTED_GLASS), context());

    expect(response.status).toBe(403);
    expect(await storedDisclosure()).toBeNull();
  });

  it("returns 404 for an item that does not exist", async () => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });

    const response = await PUT(
      disclosureRequest(GIFTED_GLASS, "no-such-media"),
      context("no-such-media"),
    );

    expect(response.status).toBe(404);
  });

  it("stays 403 for an admin — a disclosure is the owner's own declaration", async () => {
    authMock.mockResolvedValue({ user: { id: OTHER_ID, role: "ADMIN" } });
    await seedMedia();

    expect((await PUT(disclosureRequest(GIFTED_GLASS), context())).status).toBe(
      403,
    );
  });
});

describe("recording a benefit", () => {
  it("stores the whole declaration and mints the brand", async () => {
    await seedMedia();

    const response = await PUT(disclosureRequest(GIFTED_GLASS), context());

    expect(response.status).toBe(200);
    expect(await storedDisclosure()).toEqual({
      benefitReceived: true,
      benefitKind: "FREE_PRODUCT",
      marketValueOre: 49900,
      label: "Advertisement / Reklame",
      benefitSource: { slug: "riedel", name: "Riedel", alcoholLinked: false },
    });
  });

  it("reuses one brand row across two items spelled differently", async () => {
    // The point of the entity: ugcportal-qnq9.3's alcohol answer is recorded
    // against the brand, so two spellings must not become two brands with two
    // answers.
    await seedMedia();
    await PUT(disclosureRequest(GIFTED_GLASS), context());
    await PUT(
      disclosureRequest({ ...GIFTED_GLASS, benefitSource: "RIEDEL" }),
      context(),
    );

    expect(await prisma.benefitSource.count()).toBe(1);
    expect((await storedDisclosure())?.benefitSource).toEqual({
      slug: "riedel",
      name: "Riedel",
      alcoholLinked: false,
    });
  });

  it("accepts a declaration with no market value", async () => {
    await seedMedia();

    const response = await PUT(
      disclosureRequest({
        benefitReceived: true,
        benefitKind: "EVENT_INVITATION",
        benefitSource: "Oslo Vinfestival",
        benefitSourceAlcoholLinked: false,
        label: "Annonse",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect((await storedDisclosure())?.marketValueOre).toBeNull();
  });

  it.each(PERMITTED_ADVERTISING_LABELS)("accepts the label %j", async (label) => {
    await seedMedia();

    const response = await PUT(
      disclosureRequest({ ...GIFTED_GLASS, label }),
      context(),
    );

    expect(response.status).toBe(200);
    expect((await storedDisclosure())?.label).toBe(label);
  });

  it("replaces an earlier declaration rather than merging into it", async () => {
    await seedMedia();
    await PUT(disclosureRequest(GIFTED_GLASS), context());

    await PUT(
      disclosureRequest({
        benefitReceived: true,
        benefitKind: "PAYMENT",
        benefitSource: "Coravin",
        benefitSourceAlcoholLinked: false,
        label: "Annonse",
      }),
      context(),
    );

    expect(await storedDisclosure()).toEqual({
      benefitReceived: true,
      benefitKind: "PAYMENT",
      // The old market value is gone, not carried over — PUT is a
      // replacement, and a stale NOK 499 next to a cash payment is a wrong
      // number in a tax record.
      marketValueOre: null,
      label: "Annonse",
      benefitSource: { slug: "coravin", name: "Coravin", alcoholLinked: false },
    });
  });
});

describe("refusing to store an unlabelled benefit (the storage half of K5)", () => {
  it.each([
    ["a null label", { label: null }],
    ["a blank label", { label: "   " }],
    ["a forbidden label", { label: "Sponsored" }],
    ["a bare English label", { label: "Advertisement" }],
    ["an unknown label", { label: "Paid post" }],
  ])("refuses a declared benefit with %s", async (_name, override) => {
    await seedMedia();

    const response = await PUT(
      disclosureRequest({ ...GIFTED_GLASS, ...override }),
      context(),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("label");
    // NEVER STORED: K3's "each is rejected and never stored", asserted
    // against the table rather than against the response body.
    expect(await storedDisclosure()).toBeNull();
  });

  it("refuses a declared benefit with no label field at all", async () => {
    // `label: undefined` and not `...{}`: a spread of an empty object does
    // not REMOVE a key, so a "missing field" row written that way silently
    // sends the valid body and passes without testing anything. An explicit
    // `undefined` is dropped by JSON.stringify, so the key really is absent
    // from the request — the same mechanism the undefined rows below rely on.
    await seedMedia();
    const withoutLabel = { ...GIFTED_GLASS, label: undefined };

    const response = await PUT(disclosureRequest(withoutLabel), context());

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("label");
    expect(await storedDisclosure()).toBeNull();
  });

  it("leaves an earlier valid declaration untouched when a replacement is refused", async () => {
    await seedMedia();
    await PUT(disclosureRequest(GIFTED_GLASS), context());

    const response = await PUT(
      disclosureRequest({ ...GIFTED_GLASS, label: "Sponsored" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect((await storedDisclosure())?.label).toBe("Advertisement / Reklame");
  });

  /*
   * `undefined` rows DO remove the field: JSON.stringify drops an undefined
   * value, so the request body genuinely lacks the key. (`{}` as an override
   * does not — see the spelled-out missing-label test above.)
   */
  it.each([
    ["benefitKind", { benefitKind: undefined }],
    ["benefitKind", { benefitKind: "CASH" }],
    ["benefitSource", { benefitSource: undefined }],
    ["benefitSource", { benefitSource: "   " }],
    ["marketValueOre", { marketValueOre: -1 }],
    ["marketValueOre", { marketValueOre: 12.5 }],
    ["marketValueOre", { marketValueOre: "49900" }],
    ["marketValueOre", { marketValueOre: 2_000_000_000 }],
  ])("refuses a declaration with a bad %s", async (field, override) => {
    await seedMedia();

    const response = await PUT(
      disclosureRequest({ ...GIFTED_GLASS, ...override }),
      context(),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe(field);
    expect(await storedDisclosure()).toBeNull();
  });

  it("mints no brand row when the declaration is refused", async () => {
    // The debris case: resolving the brand happens inside the same
    // transaction as the write, and the label check happens before either.
    await seedMedia();

    await PUT(
      disclosureRequest({
        ...GIFTED_GLASS,
        benefitSource: "Brand That Should Not Exist",
        label: "Sponsored",
      }),
      context(),
    );

    expect(await prisma.benefitSource.count()).toBe(0);
  });
});

describe("declaring no benefit, and withdrawing an answer", () => {
  it.each([false, null])("stores %j and clears every detail", async (answer) => {
    await seedMedia();
    await PUT(disclosureRequest(GIFTED_GLASS), context());

    const response = await PUT(
      disclosureRequest({ benefitReceived: answer }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await storedDisclosure()).toEqual({
      benefitReceived: answer,
      benefitKind: null,
      marketValueOre: null,
      // K4's storage side: a label on honest content is itself misleading, so
      // withdrawing the benefit must take the label with it rather than
      // leaving it behind for part B to render.
      label: null,
      benefitSource: null,
    });
  });

  it.each([
    ["benefitKind", { benefitKind: "PAYMENT" }],
    ["benefitSource", { benefitSource: "Riedel" }],
    ["marketValueOre", { marketValueOre: 100 }],
    ["label", { label: "Reklame" }],
  ])(
    "refuses a contradictory 'no benefit' that still carries %s",
    async (field, override) => {
      await seedMedia();

      const response = await PUT(
        disclosureRequest({ benefitReceived: false, ...override }),
        context(),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).field).toBe(field);
      expect(await storedDisclosure()).toBeNull();
    },
  );

  it("refuses a body with no benefitReceived field at all", async () => {
    // `{}` is a caller who spelled the field wrong, not a declaration that no
    // benefit was received. Treating it as the latter records an assertion
    // nobody made.
    await seedMedia();

    const response = await PUT(disclosureRequest({}), context());

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("benefitReceived");
    expect(await storedDisclosure()).toBeNull();
  });

  it.each([0, 1, "true", "yes", {}])(
    "refuses the non-boolean benefitReceived %j",
    async (value) => {
      await seedMedia();

      const response = await PUT(
        disclosureRequest({ benefitReceived: value }),
        context(),
      );

      expect(response.status).toBe(400);
      expect(await storedDisclosure()).toBeNull();
    },
  );

  it.each([["not json", "{"], ["an array", "[]"], ["a bare string", '"x"']])(
    "refuses %s as a body",
    async (_name, raw) => {
      await seedMedia();

      const response = await PUT(
        new Request(`http://localhost/api/media/${MEDIA_ID}/disclosure`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
        context(),
      );

      expect(response.status).toBe(400);
      expect(await storedDisclosure()).toBeNull();
    },
  );
});

/** A publish request for the seeded item. Module-level because two describes
 * use it: the label gate's and ugcportal-qnq9.3's. */
function publishRequest() {
  return new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
    method: "POST",
  });
}

describe("the disclosure and the publish gate together (K2, K5)", () => {
  it("refuses to publish once a benefit is declared outside the API with no label", async () => {
    // The row the WRITE path refuses to create, written straight to the table
    // — which is the only way this state can exist, and exactly the state the
    // publish gate is the backstop for. Without this, the gate's
    // defence-in-depth claim is untested: every reachable path already has a
    // label by the time publish runs.
    await seedMedia();
    await prisma.mediaAdvertisingDisclosure.create({
      data: { mediaId: MEDIA_ID, benefitReceived: true, label: null },
    });

    const response = await PUBLISH(publishRequest(), context());

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("advertisingLabel");
    // The claim K5 is about: nothing in the table says this is public.
    const row = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { publishedAt: true },
    });
    expect(row.publishedAt).toBeNull();
  });

  it("publishes once a permitted label is recorded through the route", async () => {
    await seedMedia();
    // The alcohol question answered `no` (ugcportal-qnq9.3 K6). Needed from
    // that bead on: publishing an item that RECORDS A BENEFIT now also
    // requires somebody to have said there is no alcohol in it, so without a
    // listing this case would end in a 400 about the wrong thing. That the
    // untriaged state really does refuse is a case of its own, in the qnq9.3
    // describe below.
    await seedAlcoholFreeListing();
    await prisma.mediaAdvertisingDisclosure.create({
      data: { mediaId: MEDIA_ID, benefitReceived: true, label: null },
    });
    expect((await PUBLISH(publishRequest(), context())).status).toBe(400);

    const recorded = await PUT(disclosureRequest(GIFTED_GLASS), context());
    expect(recorded.status).toBe(200);

    const response = await PUBLISH(publishRequest(), context());

    expect(response.status).toBe(200);
    const row = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { publishedAt: true },
    });
    expect(row.publishedAt).not.toBeNull();
  });

  it("publishes an item the operator declared benefit-free", async () => {
    await seedMedia();
    await PUT(disclosureRequest({ benefitReceived: false }), context());

    expect((await PUBLISH(publishRequest(), context())).status).toBe(200);
  });

  it("cannot be used to make a published item undisclosed", async () => {
    /*
     * The hazard the write-side check exists for. An honest item is
     * published; the operator then remembers it was gifted. There is no
     * request that leaves it public AND unlabelled: the declaration without a
     * label is refused outright, so the table never reaches that pair.
     */
    await seedMedia(new Date("2026-02-01T00:00:00.000Z"));

    const response = await PUT(
      disclosureRequest({ ...GIFTED_GLASS, label: null }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await storedDisclosure()).toBeNull();

    const row = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { publishedAt: true },
    });
    // Still public, and still honest: nothing claims a benefit.
    expect(row.publishedAt).not.toBeNull();
  });

  it("does not touch publishedAt when a disclosure is recorded", async () => {
    await seedMedia();

    await PUT(disclosureRequest(GIFTED_GLASS), context());

    const row = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { publishedAt: true },
    });
    expect(row.publishedAt).toBeNull();
  });
});

/**
 * ugcportal-qnq9.3 K2 (the disclosure affordance) and K4 (the brand check),
 * through the real route and against a real database.
 *
 * K4 is why the brand is a row at all: "does this company produce, import or
 * sell alcohol, or share a brand or trademark with an alcoholic drink" is a
 * fact about a company, and §3.1a practical rule 1 says to ask it BEFORE any
 * paid deal. Two of its three states refuse, and the second one — unchecked —
 * is the one the criterion spells out: "an unasked question never passes as a
 * no".
 *
 * K1 is the other half of every case here, and is asserted throughout the
 * file above rather than only once: GIFTED_GLASS is a free wine GLASS from a
 * glassmaker, which is the accessory §3.1a settles as monetisable, and every
 * success in this file is that item.
 */
describe("alcohol and the brand behind the benefit (ugcportal-qnq9.3 K2/K4)", () => {
  /** Who is already on record as alcohol-linked, or not, before the request.
   * Written straight to the table because no surface in the product records a
   * `yes` — see the route's own comment on why that is deliberate. */
  async function recordBrand(name: string, alcoholLinked: boolean | null) {
    await prisma.benefitSource.create({
      data: {
        slug: name.toLowerCase(),
        name,
        alcoholLinked,
        alcoholAnsweredAt: alcoholLinked === null ? null : new Date(),
      },
    });
  }

  it("refuses a benefit on an item recorded as showing alcohol", async () => {
    // K2: `depictsAlcohol = true` and the row is unchanged. Nothing lifts it
    // — §3.1a judges the picture, whatever the glass actually holds — so the
    // brand being clean and the label being permitted change nothing.
    await seedMedia();
    await seedAlcoholFreeListing(true);

    const response = await PUT(disclosureRequest(GIFTED_GLASS), context());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.field).toBe("depictsAlcohol");
    expect(await storedDisclosure()).toBeNull();
    // And no brand was minted on the way to the refusal: nothing in this
    // product deletes a BenefitSource, so a brand created for a declaration
    // that was then refused is permanent debris.
    expect(await prisma.benefitSource.count()).toBe(0);
  });

  it("records the benefit on an item triaged clean of alcohol", async () => {
    // The comparison that makes the case above about the answer rather than
    // about the fixture: the same request, the same brand, one column
    // different.
    await seedMedia();
    await seedAlcoholFreeListing(false);

    expect((await PUT(disclosureRequest(GIFTED_GLASS), context())).status).toBe(
      200,
    );
  });

  it("records a benefit on an item nobody has triaged yet", async () => {
    // THE ONE PLACE THE WRITE PATH IS DELIBERATELY PERMISSIVE, and it is
    // worth a case of its own because it looks like a gap. The advertising
    // label is itself a legal requirement, and an operator who cannot write
    // down a gift they received publishes an undisclosed advertisement — a
    // worse breach reached by being stricter. The untriaged item simply
    // cannot go PUBLIC, which the next case asserts.
    await seedMedia();

    expect((await PUT(disclosureRequest(GIFTED_GLASS), context())).status).toBe(
      200,
    );
  });

  it("will not publish that item until the alcohol question is answered", async () => {
    // The other half of the case above, and K6's actual guarantee: the
    // honest record is allowed, the public page is not.
    await seedMedia();
    await PUT(disclosureRequest(GIFTED_GLASS), context());

    const refused = await PUBLISH(publishRequest(), context());
    expect(refused.status).toBe(400);
    expect((await refused.json()).field).toBe("depictsAlcohol");

    await seedAlcoholFreeListing(false);
    expect((await PUBLISH(publishRequest(), context())).status).toBe(200);
  });

  it("refuses a benefit from a brand recorded as alcohol-linked", async () => {
    // K4's first half. The picture is clean and the label is permitted, so
    // the refusal can only be about the company.
    await seedMedia();
    await seedAlcoholFreeListing(false);
    await recordBrand("Vinmonopolet", true);

    const response = await PUT(
      disclosureRequest({
        ...GIFTED_GLASS,
        benefitSource: "Vinmonopolet",
        // Submitted as a `no`, and ignored: a recorded `yes` is a one-way
        // door, or the check is bypassable by whoever wants the deal.
        benefitSourceAlcoholLinked: false,
      }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.field).toBe("benefitSource");
    expect(await storedDisclosure()).toBeNull();
    // The recorded answer stands, unrewritten by the attempt.
    expect(
      await prisma.benefitSource.findUniqueOrThrow({
        where: { slug: "vinmonopolet" },
        select: { alcoholLinked: true },
      }),
    ).toEqual({ alcoholLinked: true });
  });

  it("refuses a benefit from a brand nobody has checked", async () => {
    // K4's second half, in both the shapes "unchecked" arrives in: a brand
    // row carrying a null answer, and a brand name nobody has ever submitted
    // (no row at all, which is the first-contact case).
    await seedMedia();
    await seedAlcoholFreeListing(false);
    await recordBrand("Unchecked Brand", null);

    for (const benefitSource of ["Unchecked Brand", "Never Named Before"]) {
      const response = await PUT(
        disclosureRequest({
          ...GIFTED_GLASS,
          benefitSource,
          benefitSourceAlcoholLinked: undefined,
        }),
        context(),
      );
      const body = await response.json();

      expect(response.status, `${benefitSource} was not refused`).toBe(400);
      expect(body.field).toBe("benefitSource");
      expect(body.error).toMatch(/an unasked question is not a no/i);
      expect(await storedDisclosure()).toBeNull();
    }

    // The unnamed brand was not minted by the refused attempt either.
    expect(await prisma.benefitSource.count()).toBe(1);
  });

  it("refuses a benefit the request itself answers `yes` for", async () => {
    // §3.1a practical rule 1's own instruction — "if the company also
    // produces, imports or sells alcohol, decline" — enforced rather than
    // left to the operator's discipline. Answering honestly does not buy a
    // way through.
    await seedMedia();
    await seedAlcoholFreeListing(false);

    const response = await PUT(
      disclosureRequest({
        ...GIFTED_GLASS,
        benefitSource: "Arcus",
        benefitSourceAlcoholLinked: true,
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("benefitSource");
    expect(await storedDisclosure()).toBeNull();
  });

  it("records the brand's `no` once, dated and attributed", async () => {
    // What a passing declaration leaves behind: the answer on the brand row,
    // with a timestamp and the person who gave it, because the bead asks for
    // a "recorded, dated answer" about a commercial relationship.
    await seedMedia();
    await seedAlcoholFreeListing(false);

    await PUT(disclosureRequest(GIFTED_GLASS), context());

    const brand = await prisma.benefitSource.findUniqueOrThrow({
      where: { slug: "riedel" },
      select: {
        alcoholLinked: true,
        alcoholAnsweredAt: true,
        alcoholAnsweredByUserId: true,
      },
    });
    expect(brand.alcoholLinked).toBe(false);
    expect(brand.alcoholAnsweredAt).toBeInstanceOf(Date);
    expect(brand.alcoholAnsweredByUserId).toBe(OWNER_ID);
  });

  it("does not ask again once the brand carries an answer", async () => {
    // The reason the answer lives on the brand and not on the item: the
    // second item from the same brand needs no answer submitted, and does not
    // get a fresh timestamp either — the first answer is the one on record.
    await seedMedia();
    await seedAlcoholFreeListing(false);
    await PUT(disclosureRequest(GIFTED_GLASS), context());

    const first = await prisma.benefitSource.findUniqueOrThrow({
      where: { slug: "riedel" },
      select: { alcoholAnsweredAt: true },
    });

    const response = await PUT(
      disclosureRequest({
        ...GIFTED_GLASS,
        marketValueOre: 10000,
        benefitSourceAlcoholLinked: undefined,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(
      (
        await prisma.benefitSource.findUniqueOrThrow({
          where: { slug: "riedel" },
          select: { alcoholAnsweredAt: true },
        })
      ).alcoholAnsweredAt,
    ).toEqual(first.alcoholAnsweredAt);
  });

  it("refuses an answer that is neither true nor false", async () => {
    // `null` included, unlike `benefitReceived` where it means "withdraw".
    // There is no withdrawing this one: a request that could reset a brand to
    // unchecked is a request that could erase a `yes`.
    await seedMedia();
    await seedAlcoholFreeListing(false);

    for (const answer of [null, "no", 0]) {
      const response = await PUT(
        disclosureRequest({
          ...GIFTED_GLASS,
          benefitSourceAlcoholLinked: answer,
        }),
        context(),
      );
      expect(response.status, `${JSON.stringify(answer)} was accepted`).toBe(
        400,
      );
      expect((await response.json()).field).toBe("benefitSourceAlcoholLinked");
    }
    expect(await storedDisclosure()).toBeNull();
  });

  it("refuses the answer on a declaration of no benefit", async () => {
    // The same contradictory-field rule the kind, the value and the label
    // follow: a withdrawal that also carries a brand answer is a caller who
    // believes they recorded something.
    await seedMedia();

    const response = await PUT(
      disclosureRequest({
        benefitReceived: false,
        benefitSourceAlcoholLinked: false,
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("benefitSourceAlcoholLinked");
  });

  it("never blocks withdrawing a benefit, whatever the item shows", async () => {
    // Taking a declaration back is the remedy, so the gate sits on the
    // declaring branch only — the same rule the curation price route follows
    // for un-pricing. Here the item shows alcohol AND the brand is
    // alcohol-linked, which is the worst state a row can be in.
    await seedMedia();
    await seedAlcoholFreeListing(false);
    await PUT(disclosureRequest(GIFTED_GLASS), context());
    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsAlcohol: true },
    });
    await prisma.benefitSource.update({
      where: { slug: "riedel" },
      data: { alcoholLinked: true },
    });

    const response = await PUT(
      disclosureRequest({ benefitReceived: false }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await storedDisclosure()).toEqual({
      benefitReceived: false,
      benefitKind: null,
      marketValueOre: null,
      label: null,
      benefitSource: null,
    });
  });
});
