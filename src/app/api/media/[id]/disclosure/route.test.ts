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
  // The owner, signed in. The ownership-gate describe below overrides this
  // per test; every other test in the file is about what the owner's own
  // request does.
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
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
      benefitSource: { select: { slug: true, name: true } },
    },
  });
}

const GIFTED_GLASS = {
  benefitReceived: true,
  benefitKind: "FREE_PRODUCT",
  benefitSource: "Riedel",
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
      benefitSource: { slug: "riedel", name: "Riedel" },
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
    });
  });

  it("accepts a declaration with no market value", async () => {
    await seedMedia();

    const response = await PUT(
      disclosureRequest({
        benefitReceived: true,
        benefitKind: "EVENT_INVITATION",
        benefitSource: "Oslo Vinfestival",
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
      benefitSource: { slug: "coravin", name: "Coravin" },
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

describe("the disclosure and the publish gate together (K2, K5)", () => {
  function publishRequest() {
    return new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
      method: "POST",
    });
  }

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
