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
 * POST and DELETE /api/media/[id]/commercial-links (ugcportal-qnq9.2.1),
 * against a REAL database rather than a mocked Prisma client.
 *
 * WHY REAL. Every criterion this route carries is a claim about what is or is
 * not IN THE TABLE afterwards — K2 and K3 both end "and no CommercialLink row
 * is created", and K6's guardrail is about rows rather than about responses. A
 * mock agrees with whatever the route asked it to do, so a mocked version of
 * these tests would pass over a route that called `create` on a refused
 * request and ignored the result. The same reasoning
 * src/app/api/media/[id]/disclosure/route.test.ts gives next door.
 *
 * It also lets the two halves be exercised in the order an operator meets
 * them: record the benefit through the disclosure route, then attach the link.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const { POST, DELETE } = await import(
  "@/app/api/media/[id]/commercial-links/route"
);
// The publish route is imported for one case: the thing that makes the attach
// gate's permissive reading of an UNANSWERED alcohol question safe is the
// publish gate's strict one, and that claim cannot be made from this route
// alone. The same pairing disclosure/route.test.ts uses.
const { POST: PUBLISH } = await import("@/app/api/media/[id]/publish/route");
const { benefitSourceSlug } = await import("@/lib/benefit-source");
const { MAX_COMMERCIAL_LINK_URL_LENGTH, MAX_COMMERCIAL_LINKS_PER_ITEM } =
  await import("@/lib/commercial-link");

const OWNER_ID = "owner-qnq9-2-1";
const OTHER_ID = "other-qnq9-2-1";
const MEDIA_ID = "media-qnq9-2-1";

/** A plausible affiliate deep link, already canonical so the assertions below
 * are about the route rather than about canonicalisation (which
 * commercial-link.test.ts owns). */
const LINK_URL = "https://track.adtraction.com/t/t?a=1234&url=https%3A%2F%2Fx.no";

/** The brand at the other end of the link, checked and clean — Riedel makes
 * glasses, which is the site's chosen subject, and does not make the drink.
 * `false` is the true answer as well as the one the gate needs. */
const BRAND = "Riedel";

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: OWNER_ID, email: "owner-qnq9-2-1@example.com" },
  });
  await prisma.user.create({
    data: { id: OTHER_ID, email: "other-qnq9-2-1@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(() => {
  // The owner, signed in. The ownership-gate describe overrides this per
  // test; every other test here is about what the owner's own request does.
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
});

afterEach(async () => {
  // Media first: it cascades the links and the disclosure away. Brands are
  // their own table, are `onDelete: Restrict` from both, and so can only be
  // cleared once nothing points at them.
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
      previewId: "preview-qnq9-2-1",
      mimeType: "image/png",
      sizeBytes: 2048,
      originalName: "IMG_0001.HEIC",
      altText: "An empty wine glass on a windowsill",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAt,
    },
  });
}

/**
 * A brand with its §3.1a answer recorded as given.
 *
 * Written straight through Prisma rather than through the disclosure route,
 * because that route can only ever record `false` (a `true` is a refusal, so
 * control never reaches its write) — and `true` is one of the three cases K2
 * is about.
 */
async function seedBrand(name: string, alcoholLinked: boolean | null) {
  await prisma.benefitSource.create({
    data: { slug: benefitSourceSlug(name), name, alcoholLinked },
  });
}

/**
 * The listing that carries the alcohol triage answer.
 *
 * Only `depictsAlcohol` is read by this route, but the row is filled in
 * completely so it is not a half-triaged listing a later reader has to
 * interpret. `wineAccessory: true` is the site's chosen angle: an empty glass
 * is monetisable precisely because it is not the drink (§3.1a).
 */
async function seedListing(depictsAlcohol: boolean | null = false) {
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

/**
 * The advertising disclosure that makes a commercial link attachable at all.
 *
 * Also written straight through Prisma, and for a reason that is itself one of
 * the cases: the `label` argument is sometimes a string the disclosure route
 * would refuse to store, and K3's third case is about exactly such a row. The
 * route under test re-checks the stored label against the allowlist rather
 * than assuming every row arrived through the validator.
 */
async function seedDisclosure({
  benefitReceived = true,
  label = "Advertisement / Reklame" as string | null,
  brand = BRAND as string | null,
}: {
  benefitReceived?: boolean | null;
  label?: string | null;
  brand?: string | null;
} = {}) {
  const source =
    brand === null
      ? null
      : await prisma.benefitSource.findUnique({
          where: { slug: benefitSourceSlug(brand) },
          select: { id: true },
        });

  await prisma.mediaAdvertisingDisclosure.create({
    data: {
      mediaId: MEDIA_ID,
      benefitReceived,
      benefitKind: benefitReceived === true ? "FREE_PRODUCT" : null,
      benefitSourceId: source?.id ?? null,
      label,
    },
  });
}

/** The baseline K1 world: an alcohol-free wine accessory, a checked brand, and
 * a benefit declared under a permitted label. */
async function seedAttachableItem(depictsAlcohol: boolean | null = false) {
  await seedMedia();
  await seedBrand(BRAND, false);
  await seedListing(depictsAlcohol);
  await seedDisclosure();
}

function context(id: string = MEDIA_ID) {
  return { params: Promise.resolve({ id }) };
}

const ATTACH_BODY = {
  url: LINK_URL,
  network: "ADTRACTION",
  benefitSource: BRAND,
};

function attachRequest(body: unknown, id: string = MEDIA_ID) {
  return new Request(`http://localhost/api/media/${id}/commercial-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function publishRequest(id: string = MEDIA_ID) {
  return new Request(`http://localhost/api/media/${id}/publish`, {
    method: "POST",
  });
}

function detachRequest(query: string, id: string = MEDIA_ID) {
  return new Request(
    `http://localhost/api/media/${id}/commercial-links${query}`,
    { method: "DELETE" },
  );
}

/** Every commercial link in the table, with the brand resolved by slug. The
 * whole table rather than this item's own rows, so "no row is created" is a
 * claim about the database and not about one `mediaId`. */
function storedLinks() {
  return prisma.commercialLink.findMany({
    select: {
      mediaId: true,
      url: true,
      network: true,
      networkOther: true,
      benefitSource: { select: { slug: true, name: true } },
    },
    orderBy: { url: "asc" },
  });
}

describe("the ownership gate", () => {
  it("returns 401 for an anonymous caller and writes nothing", async () => {
    authMock.mockResolvedValue(null);
    await seedAttachableItem();

    const response = await POST(attachRequest(ATTACH_BODY), context());

    expect(response.status).toBe(401);
    expect(await storedLinks()).toEqual([]);
  });

  it("returns 403 for someone else's item and writes nothing", async () => {
    authMock.mockResolvedValue({ user: { id: OTHER_ID, role: "USER" } });
    await seedAttachableItem();

    const response = await POST(attachRequest(ATTACH_BODY), context());

    expect(response.status).toBe(403);
    expect(await storedLinks()).toEqual([]);
  });

  it("returns 404 for an item that does not exist", async () => {
    const response = await POST(
      attachRequest(ATTACH_BODY, "no-such-media"),
      context("no-such-media"),
    );

    expect(response.status).toBe(404);
    expect(await storedLinks()).toEqual([]);
  });

  it("stays 403 for an admin — a commercial link is the owner's own", async () => {
    authMock.mockResolvedValue({ user: { id: OTHER_ID, role: "ADMIN" } });
    await seedAttachableItem();

    const response = await POST(attachRequest(ATTACH_BODY), context());

    expect(response.status).toBe(403);
    expect(await storedLinks()).toEqual([]);
  });

  it("refuses to detach a link from someone else's item", async () => {
    await seedAttachableItem();
    const created = await POST(attachRequest(ATTACH_BODY), context());
    const { id: linkId } = (await created.json()) as { id: string };

    authMock.mockResolvedValue({ user: { id: OTHER_ID, role: "USER" } });
    const response = await DELETE(
      detachRequest(`?linkId=${linkId}`),
      context(),
    );

    expect(response.status).toBe(403);
    expect(await storedLinks()).toHaveLength(1);
  });
});

describe("attaching a commercial link (K1)", () => {
  it("stores the destination, the network and the brand", async () => {
    await seedAttachableItem();

    const response = await POST(attachRequest(ATTACH_BODY), context());

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      url: LINK_URL,
      network: "ADTRACTION",
      networkOther: null,
      benefitSource: { slug: "riedel", name: BRAND },
    });
    expect(await storedLinks()).toEqual([
      {
        mediaId: MEDIA_ID,
        url: LINK_URL,
        network: "ADTRACTION",
        networkOther: null,
        benefitSource: { slug: "riedel", name: BRAND },
      },
    ]);
  });

  it("echoes an id the detach route accepts", async () => {
    // The response's `id` is the only place a link's id is ever handed out,
    // so a response that omitted it would leave every attached link
    // permanently undetachable.
    await seedAttachableItem();

    const created = await POST(attachRequest(ATTACH_BODY), context());
    const { id: linkId } = (await created.json()) as { id: string };
    expect(linkId).toBeTruthy();

    const detached = await DELETE(
      detachRequest(`?linkId=${linkId}`),
      context(),
    );

    expect(detached.status).toBe(204);
    expect(await storedLinks()).toEqual([]);
  });

  it("carries more than one link on one item", async () => {
    // The whole reason this is a table rather than three columns on the 1:1
    // disclosure: §3.2's rule is per LINK, and a gifted glass can carry the
    // maker's link and the retailer's.
    await seedAttachableItem();
    await seedBrand("Vinoteket", false);

    const first = await POST(attachRequest(ATTACH_BODY), context());
    const second = await POST(
      attachRequest({
        url: "https://track.awin.com/cread?id=9&p=https%3A%2F%2Fy.no",
        network: "AWIN",
        benefitSource: "Vinoteket",
      }),
      context(),
    );

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await storedLinks()).toMatchObject([
      { network: "ADTRACTION", benefitSource: { slug: "riedel" } },
      { network: "AWIN", benefitSource: { slug: "vinoteket" } },
    ]);
  });

  it("links a brand that is not the one the benefit came from", async () => {
    // The disclosure's brand and the link's brand are independently checked,
    // which is why CommercialLink carries its own pointer: the glass was
    // gifted by its maker and the link points at a retailer.
    await seedAttachableItem();
    await seedBrand("Vinoteket", false);

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, benefitSource: "Vinoteket" }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(await storedLinks()).toMatchObject([
      { benefitSource: { slug: "vinoteket" } },
    ]);
  });

  it("resolves the brand by slug, so a different spelling is the same brand", async () => {
    // What makes the alcohol answer unbypassable: an answer recorded against
    // "Riedel" applies to "riedel" too. The same `benefitSourceSlug` the
    // disclosure route names a brand through.
    await seedAttachableItem();

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, benefitSource: "  riedel  " }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(await storedLinks()).toMatchObject([
      { benefitSource: { slug: "riedel", name: BRAND } },
    ]);
    // And no second brand was minted under the other spelling.
    expect(await prisma.benefitSource.count()).toBe(1);
  });

  it("does not touch publishedAt", async () => {
    // Attaching a link neither publishes nor unpublishes an item — the same
    // claim the disclosure route makes about its own write.
    const publishedAt = new Date("2026-02-02T00:00:00.000Z");
    await seedMedia(publishedAt);
    await seedBrand(BRAND, false);
    await seedListing(false);
    await seedDisclosure();

    expect((await POST(attachRequest(ATTACH_BODY), context())).status).toBe(201);

    const media = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { publishedAt: true },
    });
    expect(media.publishedAt).toEqual(publishedAt);
  });

  it("answers 409 on a second attach of the same destination", async () => {
    await seedAttachableItem();

    const first = await POST(attachRequest(ATTACH_BODY), context());
    const second = await POST(attachRequest(ATTACH_BODY), context());

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(await storedLinks()).toHaveLength(1);
  });
});

describe("alkoholloven § 9-2: refused attachments (K2)", () => {
  it("refuses an item recorded as showing alcohol, and writes nothing", async () => {
    await seedMedia();
    await seedBrand(BRAND, false);
    await seedListing(true);
    await seedDisclosure();

    const response = await POST(attachRequest(ATTACH_BODY), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "depictsAlcohol" });
    expect(await storedLinks()).toEqual([]);
  });

  it("refuses a brand recorded as alcohol-linked, and writes nothing", async () => {
    await seedMedia();
    await seedBrand("Vinmonopolet", true);
    await seedListing(false);
    await seedDisclosure({ brand: null });

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, benefitSource: "Vinmonopolet" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "benefitSource" });
    expect(await storedLinks()).toEqual([]);
  });

  it("refuses a brand with a row but no recorded answer, and writes nothing", async () => {
    await seedMedia();
    await seedBrand("Unchecked Co", null);
    await seedListing(false);
    await seedDisclosure({ brand: null });

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, benefitSource: "Unchecked Co" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "benefitSource" });
    expect(await storedLinks()).toEqual([]);
  });

  it("refuses a brand nobody has ever named, and mints no row for it", async () => {
    // The commonest way "nobody asked" arrives. The claim worth asserting is
    // the second half: unlike the disclosure route this one never upserts the
    // brand, so a refused request leaves the brand table untouched — and
    // nothing in this product deletes a BenefitSource, so a minted-then-
    // refused row would be permanent debris.
    await seedAttachableItem();

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, benefitSource: "Never Heard Of" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "benefitSource" });
    expect(await storedLinks()).toEqual([]);
    expect(
      await prisma.benefitSource.findMany({ select: { slug: true } }),
    ).toEqual([{ slug: "riedel" }]);
  });

  it.each([null, undefined])(
    "permits an item whose alcohol question is unanswered (%j) — and the publish gate is what stops the public seeing it",
    async (depictsAlcohol) => {
      /*
       * THE ONE STATE K2 DOES NOT LIST, asserted so the asymmetry is a
       * decision on record rather than a gap. `benefitAttachmentRefusal`
       * reads the alcohol question PERMISSIVELY — only a recorded `yes`
       * refuses — and its own docstring gives the reason: refusing an
       * untriaged item at every write would make the advertising label
       * unrecordable on every item nobody has triaged, and the label is
       * itself a legal requirement. This route calls that gate and adds no
       * alcohol logic of its own, so it inherits that reading.
       *
       * What makes the permissiveness safe is the gate one step later, and
       * this is why that is exercised here rather than taken on trust: a link
       * requires a declared benefit (K3), and `commercialPublishRefusal`
       * refuses to publish a declared benefit whose alcohol question is not
       * an explicit `no`. So an untriaged item can hold a link and cannot
       * show it to anybody. `undefined` is the no-MediaListing-row case —
       * the state every item that predates the triage columns is in.
       */
      await seedMedia();
      await seedBrand(BRAND, false);
      if (depictsAlcohol !== undefined) await seedListing(depictsAlcohol);
      await seedDisclosure();

      const attached = await POST(attachRequest(ATTACH_BODY), context());
      expect(attached.status).toBe(201);
      expect(await storedLinks()).toHaveLength(1);

      const published = await PUBLISH(publishRequest(), context());

      expect(published.status).toBe(400);
      expect(await published.json()).toMatchObject({
        field: "depictsAlcohol",
      });
      const row = await prisma.media.findUniqueOrThrow({
        where: { id: MEDIA_ID },
        select: { publishedAt: true },
      });
      expect(row.publishedAt).toBeNull();
    },
  );

  it("reports the alcohol in the picture ahead of a missing disclosure", async () => {
    // Both gates would refuse; the § 9-2 one answers first, because its fix
    // is a different photograph and filling in a disclosure form would end at
    // the same refusal.
    await seedMedia();
    await seedBrand(BRAND, false);
    await seedListing(true);

    const response = await POST(attachRequest(ATTACH_BODY), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "depictsAlcohol" });
  });
});

describe("Forbrukertilsynet § 3.2: the disclosure precondition (K3)", () => {
  it("refuses an item with no disclosure at all, and writes nothing", async () => {
    await seedMedia();
    await seedBrand(BRAND, false);
    await seedListing(false);

    const response = await POST(attachRequest(ATTACH_BODY), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "benefitReceived" });
    expect(await storedLinks()).toEqual([]);
  });

  it.each([null, false])(
    "refuses a disclosure with benefitReceived %j, and writes nothing",
    async (benefitReceived) => {
      await seedMedia();
      await seedBrand(BRAND, false);
      await seedListing(false);
      await seedDisclosure({ benefitReceived, label: null, brand: null });

      const response = await POST(attachRequest(ATTACH_BODY), context());

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ field: "benefitReceived" });
      expect(await storedLinks()).toEqual([]);
    },
  );

  it.each([null, "", "Ad", "reklame", "Sponsored"])(
    "refuses a declared benefit whose stored label is %j, and writes nothing",
    async (label) => {
      // These rows cannot be created through PUT /api/media/[id]/disclosure,
      // which refuses them — which is the point. This route re-checks the
      // stored label against the allowlist rather than assuming every row in
      // the table arrived through that validator.
      await seedMedia();
      await seedBrand(BRAND, false);
      await seedListing(false);
      await seedDisclosure({ label });

      const response = await POST(attachRequest(ATTACH_BODY), context());

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ field: "label" });
      expect(await storedLinks()).toEqual([]);
    },
  );

  it.each([
    "Advertisement / Reklame",
    "Advertisement / Annonse",
    "Reklame",
    "Annonse",
  ])("accepts every permitted label, including %j", async (label) => {
    await seedMedia();
    await seedBrand(BRAND, false);
    await seedListing(false);
    await seedDisclosure({ label });

    expect((await POST(attachRequest(ATTACH_BODY), context())).status).toBe(201);
  });
});

describe("the URL and the network, through the route (K4, K5)", () => {
  it.each([
    ["http://track.adtraction.com/t?a=1", "url"],
    ["javascript:alert(1)", "url"],
    ["data:text/html,<script>alert(1)</script>", "url"],
    ["https://track.adtraction.com/‮exe.gnp", "url"],
    ["https://user:secret@track.adtraction.com/t", "url"],
    [`https://x.example/${"a".repeat(MAX_COMMERCIAL_LINK_URL_LENGTH)}`, "url"],
    ["", "url"],
    [null, "url"],
  ])("refuses the destination %j and writes nothing", async (url, field) => {
    // The exhaustive table is commercial-link.test.ts's; these cases prove
    // the ROUTE runs that validator at all, and that a refusal there leaves
    // the table empty rather than merely answering 400.
    await seedAttachableItem();

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, url }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field });
    expect(await storedLinks()).toEqual([]);
  });

  it.each([undefined, "IMPACT", "adtraction"])(
    "refuses the network %j and writes nothing",
    async (network) => {
      await seedAttachableItem();

      const response = await POST(
        attachRequest({ ...ATTACH_BODY, network }),
        context(),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ field: "network" });
      expect(await storedLinks()).toEqual([]);
    },
  );

  it("round-trips a sixth network as OTHER plus its name (K5)", async () => {
    await seedAttachableItem();

    const response = await POST(
      attachRequest({
        ...ATTACH_BODY,
        network: "OTHER",
        networkOther: "Impact.com",
      }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      network: "OTHER",
      networkOther: "Impact.com",
    });
    expect(await storedLinks()).toMatchObject([
      { network: "OTHER", networkOther: "Impact.com" },
    ]);
  });

  it("refuses OTHER with nothing naming it, naming networkOther, and writes nothing", async () => {
    await seedAttachableItem();

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, network: "OTHER" }),
      context(),
    );

    expect(response.status).toBe(400);
    // `networkOther`, not `network`. Both of these refusals come out of a
    // validator that covers two fields, and the field key is what tells the
    // caller which of the two to fix — so the handler has to carry the
    // validator's own answer through rather than naming one field for every
    // refusal it returns.
    expect(await response.json()).toMatchObject({ field: "networkOther" });
    expect(await storedLinks()).toEqual([]);
  });

  it("refuses a named network carrying stray free text, naming networkOther, and writes nothing", async () => {
    await seedAttachableItem();

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, networkOther: "Impact.com" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "networkOther" });
    expect(await storedLinks()).toEqual([]);
  });

  it.each([
    ["not a brand name at all", { benefitSource: undefined }],
    ["a brand name that slugs to nothing", { benefitSource: "???" }],
    ["an empty brand name", { benefitSource: "  " }],
  ])("refuses %s and writes nothing", async (_name, override) => {
    await seedAttachableItem();

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, ...override }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "benefitSource" });
    expect(await storedLinks()).toEqual([]);
  });

  it("refuses a body that is not a JSON object", async () => {
    await seedAttachableItem();

    const response = await POST(attachRequest([ATTACH_BODY]), context());

    expect(response.status).toBe(400);
    expect(await storedLinks()).toEqual([]);
  });
});

describe("the per-item cap", () => {
  /** `index` distinct destinations under one brand, so the only thing that
   * changes between attaches is how many rows the item already has. */
  function urlNumber(index: number) {
    return `https://track.adtraction.com/t/t?a=1234&n=${index}`;
  }

  async function attachNumber(index: number) {
    return POST(
      attachRequest({ ...ATTACH_BODY, url: urlNumber(index) }),
      context(),
    );
  }

  it("fills the item to the cap and refuses the next attach with a 409", async () => {
    await seedAttachableItem();

    for (let index = 0; index < MAX_COMMERCIAL_LINKS_PER_ITEM; index += 1) {
      expect(
        (await attachNumber(index)).status,
        `attach ${index} should have succeeded`,
      ).toBe(201);
    }
    expect(await storedLinks()).toHaveLength(MAX_COMMERCIAL_LINKS_PER_ITEM);

    const over = await attachNumber(MAX_COMMERCIAL_LINKS_PER_ITEM);

    // 409, not 400: the body is well-formed and the caller owns the item.
    expect(over.status).toBe(409);
    const refusal = (await over.json()) as { error: string; field?: string };
    // The message has to name the way out, because there is no edit to this
    // request that would make it succeed.
    expect(refusal.error).toContain(String(MAX_COMMERCIAL_LINKS_PER_ITEM));
    expect(refusal.error).toContain("DELETE");
    // And no `field`, for the same reason: naming one would point the caller
    // at an input that is not the problem.
    expect(refusal.field).toBeUndefined();

    // Nothing was written: still exactly the cap, and the refused
    // destination is not among them.
    const stored = await storedLinks();
    expect(stored).toHaveLength(MAX_COMMERCIAL_LINKS_PER_ITEM);
    expect(stored.map((link) => link.url)).not.toContain(
      urlNumber(MAX_COMMERCIAL_LINKS_PER_ITEM),
    );
  });

  it("is not vacuous: the attach that was refused succeeds once one is detached", async () => {
    /*
     * Without this, the case above would pass just as well against a route
     * that refused the seventh attach for some other reason — a duplicate
     * URL, a brand that went missing, a transaction that failed. Detaching
     * one row changes exactly the count the cap reads, and the SAME request
     * that was refused is then accepted.
     */
    await seedAttachableItem();
    for (let index = 0; index < MAX_COMMERCIAL_LINKS_PER_ITEM; index += 1) {
      expect((await attachNumber(index)).status).toBe(201);
    }
    expect((await attachNumber(MAX_COMMERCIAL_LINKS_PER_ITEM)).status).toBe(409);

    const first = await prisma.commercialLink.findFirstOrThrow({
      where: { mediaId: MEDIA_ID, url: urlNumber(0) },
      select: { id: true },
    });
    expect(
      (await DELETE(detachRequest(`?linkId=${first.id}`), context())).status,
    ).toBe(204);

    expect((await attachNumber(MAX_COMMERCIAL_LINKS_PER_ITEM)).status).toBe(201);
    expect(await storedLinks()).toHaveLength(MAX_COMMERCIAL_LINKS_PER_ITEM);
  });

  it("counts per item, so a second item of the owner's starts from zero", async () => {
    // The cap is on the collection under one photograph, which is what makes
    // it a claim about the rendered page. A full item must not make the
    // owner's next upload unattachable.
    await seedAttachableItem();
    for (let index = 0; index < MAX_COMMERCIAL_LINKS_PER_ITEM; index += 1) {
      expect((await attachNumber(index)).status).toBe(201);
    }

    const SECOND_ID = `${MEDIA_ID}-second`;
    await prisma.media.create({
      data: {
        id: SECOND_ID,
        userId: OWNER_ID,
        kind: "IMAGE",
        key: `media/${OWNER_ID}/second.png`,
        previewKey: `previews/${OWNER_ID}/second.webp`,
        previewId: "preview-qnq9-2-1-second",
        mimeType: "image/png",
        sizeBytes: 2048,
        originalName: "IMG_0002.HEIC",
        altText: "A second empty wine glass",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        advertisingDisclosure: {
          create: {
            benefitReceived: true,
            benefitKind: "FREE_PRODUCT",
            label: "Advertisement / Reklame",
          },
        },
      },
    });

    const response = await POST(
      attachRequest({ ...ATTACH_BODY, url: urlNumber(0) }, SECOND_ID),
      context(SECOND_ID),
    );

    expect(response.status).toBe(201);
    expect(await storedLinks()).toHaveLength(
      MAX_COMMERCIAL_LINKS_PER_ITEM + 1,
    );
  });
});

describe("detaching a commercial link", () => {
  async function attached() {
    await seedAttachableItem();
    const created = await POST(attachRequest(ATTACH_BODY), context());
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    return id;
  }

  it("removes the row and answers 204", async () => {
    const linkId = await attached();

    const response = await DELETE(
      detachRequest(`?linkId=${linkId}`),
      context(),
    );

    expect(response.status).toBe(204);
    expect(await storedLinks()).toEqual([]);
  });

  it("is never refused by the alcohol gate", async () => {
    /*
     * The decision the route's own docstring states, as an assertion: a link
     * on an item that is NOW recorded as showing alcohol must still be
     * removable. A gate here would refuse to detach exactly the link that
     * most needs detaching.
     */
    const linkId = await attached();
    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { depictsAlcohol: true },
    });

    const response = await DELETE(
      detachRequest(`?linkId=${linkId}`),
      context(),
    );

    expect(response.status).toBe(204);
    expect(await storedLinks()).toEqual([]);
  });

  it("is never refused by the disclosure precondition either", async () => {
    // The other gate, withdrawn after the fact: an item whose benefit
    // declaration has been taken back is an item whose link is now unlabelled,
    // so removing it has to work.
    const linkId = await attached();
    await prisma.mediaAdvertisingDisclosure.update({
      where: { mediaId: MEDIA_ID },
      data: { benefitReceived: false, label: null, benefitSourceId: null },
    });

    const response = await DELETE(
      detachRequest(`?linkId=${linkId}`),
      context(),
    );

    expect(response.status).toBe(204);
    expect(await storedLinks()).toEqual([]);
  });

  it("answers 400 when no link is named", async () => {
    const linkId = await attached();

    const response = await DELETE(detachRequest(""), context());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "linkId" });
    expect(await storedLinks()).toHaveLength(1);
    expect(linkId).toBeTruthy();
  });

  it("answers 404 for a link that is not there", async () => {
    await attached();

    const response = await DELETE(
      detachRequest("?linkId=no-such-link"),
      context(),
    );

    expect(response.status).toBe(404);
    expect(await storedLinks()).toHaveLength(1);
  });

  it("answers 404 for a link that belongs to a different item of the owner's", async () => {
    // The `mediaId` predicate on the delete, which is what stops the path
    // segment and the link id being allowed to disagree. Without it this
    // would answer 204 and delete the other item's link.
    const linkId = await attached();
    await prisma.media.create({
      data: {
        id: "media-qnq9-2-1-other",
        userId: OWNER_ID,
        kind: "IMAGE",
        key: `media/${OWNER_ID}/second.png`,
        previewKey: `previews/${OWNER_ID}/second.webp`,
        previewId: "preview-qnq9-2-1-second",
        mimeType: "image/png",
        sizeBytes: 1024,
        originalName: "IMG_0002.HEIC",
        altText: "A decanter",
      },
    });

    const response = await DELETE(
      detachRequest(`?linkId=${linkId}`, "media-qnq9-2-1-other"),
      context("media-qnq9-2-1-other"),
    );

    expect(response.status).toBe(404);
    expect(await storedLinks()).toHaveLength(1);
  });

  it("takes the links with the item when the item is deleted", async () => {
    // `onDelete: Cascade` on `mediaId`, which is the row
    // docs/access-control.md's delete-cascade runbook gains for this table.
    await attached();

    await prisma.media.delete({ where: { id: MEDIA_ID } });

    expect(await storedLinks()).toEqual([]);
  });

  it("refuses to delete a brand a link still points at", async () => {
    // `onDelete: Restrict` on `benefitSourceId`. A brand is shared
    // vocabulary, and deleting one must not silently erase where a published
    // link pointed.
    await attached();

    await expect(
      prisma.benefitSource.delete({
        where: { slug: benefitSourceSlug(BRAND) },
      }),
    ).rejects.toThrow();

    expect(await storedLinks()).toHaveLength(1);
  });
});
