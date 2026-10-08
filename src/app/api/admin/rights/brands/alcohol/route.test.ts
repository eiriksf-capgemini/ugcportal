import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaAuthorship } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * POST /api/admin/rights/brands/alcohol (ugcportal-mqh8), against a real
 * database. The one and only route that may ever write
 * `BenefitSource.alcoholLinked = true`.
 *
 * Imports the disclosure route and the publish route too, same reason
 * src/app/api/media/[id]/disclosure/route.test.ts gives for importing
 * publish next door: the claims worth making here are claims about what
 * happens ACROSS routes — a brand answered `false` through the ordinary
 * disclosure flow, an item published under it, then this route recording the
 * same brand as alcohol-linked, and the NEXT publish attempt on that item
 * refusing (K1) while the row already public stays public (K2).
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const authMock = vi.fn();
// Both named exports point at the one mock: requireAdminAccess (used by this
// route) calls getSession(), DISCLOSURE's gate calls auth() directly, and
// PUBLISH's gate (via requireOwnedMedia) calls auth() too — one shared mock
// so every handler this file drives sees the same session-switching.
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

// revalidatePath asserts there is a Next.js request-scoped store around it;
// calling a route handler directly, the way every test in this file does,
// has no such store. Mocked the same way RIGHTS_DECISION_PATH's own route
// test does.
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { POST: FLIP } = await import(
  "@/app/api/admin/rights/brands/alcohol/route"
);
const { PUT: DISCLOSURE } = await import(
  "@/app/api/media/[id]/disclosure/route"
);
const { POST: PUBLISH } = await import("@/app/api/media/[id]/publish/route");

const ADMIN_ID = "admin-mqh8";
const OTHER_ADMIN_ID = "admin-mqh8-2";
const OWNER_ID = "owner-mqh8";
const USER_ID = "user-mqh8";
const MEDIA_ID = "media-mqh8";

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: ADMIN_ID, email: "admin-mqh8@example.com", role: "ADMIN" },
  });
  await prisma.user.create({
    data: {
      id: OTHER_ADMIN_ID,
      email: "admin-mqh8-2@example.com",
      role: "ADMIN",
    },
  });
  await prisma.user.create({
    data: { id: OWNER_ID, email: "owner-mqh8@example.com" },
  });
  await prisma.user.create({
    data: { id: USER_ID, email: "user-mqh8@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({ user: { id: ADMIN_ID, role: "ADMIN" } });
  // The same-origin check compares the request's Origin against AUTH_URL
  // (see src/lib/origin.ts) — unset, it treats every request as same-origin,
  // which would make the cross-origin test below pass for the wrong reason.
  process.env.AUTH_URL = "http://localhost";
});

afterEach(async () => {
  await prisma.media.deleteMany({});
  await prisma.benefitSource.deleteMany({});
});

function flipRequest(brandId: string | undefined, extra: Record<string, string> = {}) {
  const body = new URLSearchParams(extra);
  if (brandId !== undefined) {
    body.set("brandId", brandId);
  }
  return new Request("http://localhost/api/admin/rights/brands/alcohol", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function recordBrand(
  name: string,
  alcoholLinked: boolean | null,
  answeredByUserId: string | null = null,
) {
  return prisma.benefitSource.create({
    data: {
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      alcoholLinked,
      alcoholAnsweredAt: alcoholLinked === null ? null : new Date("2026-01-01T00:00:00.000Z"),
      alcoholAnsweredByUserId: alcoholLinked === null ? null : answeredByUserId,
    },
  });
}

function brandRow(id: string) {
  return prisma.benefitSource.findUniqueOrThrow({
    where: { id },
    select: { alcoholLinked: true, alcoholAnsweredAt: true, alcoholAnsweredByUserId: true },
  });
}

describe("authorization", () => {
  it("answers 401 for an anonymous caller, with no write", async () => {
    const brand = await recordBrand("Anon Brand", null);
    authMock.mockResolvedValue(null);

    const response = await FLIP(flipRequest(brand.id));

    expect(response.status).toBe(401);
    expect((await brandRow(brand.id)).alcoholLinked).toBeNull();
  });

  it("answers 403 for a signed-in non-admin, with no write", async () => {
    const brand = await recordBrand("Non Admin Brand", null);
    authMock.mockResolvedValue({ user: { id: USER_ID, role: "USER" } });

    const response = await FLIP(flipRequest(brand.id));

    expect(response.status).toBe(403);
    expect((await brandRow(brand.id)).alcoholLinked).toBeNull();
  });

  it("answers 403 for a session carrying no role at all", async () => {
    const brand = await recordBrand("No Role Brand", null);
    authMock.mockResolvedValue({ user: { id: USER_ID } });

    const response = await FLIP(flipRequest(brand.id));

    expect(response.status).toBe(403);
    expect((await brandRow(brand.id)).alcoholLinked).toBeNull();
  });

  it("answers 403 for a cross-origin post, with no write", async () => {
    const brand = await recordBrand("Cross Origin Brand", null);

    const response = await FLIP(
      new Request("http://localhost/api/admin/rights/brands/alcohol", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
        body: new URLSearchParams({ brandId: brand.id }).toString(),
      }),
    );

    expect(response.status).toBe(403);
    expect((await brandRow(brand.id)).alcoholLinked).toBeNull();
  });
});

describe("recording the answer", () => {
  it("records an unchecked brand as alcohol-linked, dated and attributed", async () => {
    const brand = await recordBrand("Unchecked Brand", null);

    const response = await FLIP(flipRequest(brand.id));

    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toContain("/admin/settings/rights/brands");
    expect(location).toContain("recorded=1");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const row = await brandRow(brand.id);
    expect(row.alcoholLinked).toBe(true);
    expect(row.alcoholAnsweredAt).toBeInstanceOf(Date);
    expect(row.alcoholAnsweredByUserId).toBe(ADMIN_ID);
  });

  it("records a brand previously answered `no` as alcohol-linked", async () => {
    const brand = await recordBrand("Previously Clean Brand", false, OTHER_ADMIN_ID);

    const response = await FLIP(flipRequest(brand.id));

    expect(response.status).toBe(303);
    const row = await brandRow(brand.id);
    expect(row.alcoholLinked).toBe(true);
    expect(row.alcoholAnsweredByUserId).toBe(ADMIN_ID);
  });

  it("redirects with an error for a brand that no longer exists", async () => {
    const response = await FLIP(flipRequest("no-such-brand"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("error=brand_not_found");
  });

  it("redirects with an error when no brand is named", async () => {
    const response = await FLIP(flipRequest(undefined));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("error=brand_id_missing");
  });
});

describe("K3: monotone — no write path can flip yes back to no", () => {
  it("cannot be talked back to false through this route, by any field it is sent", async () => {
    const brand = await recordBrand("Already Linked Brand", true, OTHER_ADMIN_ID);
    const before = await brandRow(brand.id);

    // This route reads no field but which brand: there is no "value" to set
    // to false even by hand-crafting the body.
    const response = await FLIP(
      flipRequest(brand.id, { alcoholLinked: "false", value: "false" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).not.toContain("error=");
    const after = await brandRow(brand.id);
    expect(after.alcoholLinked).toBe(true);
    // The original attribution survives a second "recording" attempt by a
    // DIFFERENT admin — the monotone guard's `where` clause matches nothing
    // once the brand already carries an answer, so the row is not restamped.
    expect(after.alcoholAnsweredAt).toEqual(before.alcoholAnsweredAt);
    expect(after.alcoholAnsweredByUserId).toBe(OTHER_ADMIN_ID);
  });

  it("cannot be talked back to false through the disclosure write path either", async () => {
    // The OTHER write path in the whole product
    // (src/lib/alcohol-commerce.write-paths.test.ts enumerates exactly one:
    // PUT /api/media/[id]/disclosure). Proven here rather than assumed,
    // because K3 asks for a test over EVERY write path, not just this
    // route's own.
    const brand = await recordBrand("Arcus", true, OTHER_ADMIN_ID);
    await prisma.media.create({
      data: {
        id: MEDIA_ID,
        userId: OWNER_ID,
        kind: "IMAGE",
        key: `media/${OWNER_ID}/original.png`,
        previewKey: `previews/${OWNER_ID}/preview.webp`,
        previewId: "preview-mqh8-monotone",
        mimeType: "image/png",
        sizeBytes: 2048,
        originalName: "IMG_0002.HEIC",
        altText: "A bottle of something",
      },
    });
    await prisma.mediaListing.create({
      data: {
        mediaId: MEDIA_ID,
        depictsPeople: false,
        depictsMinors: false,
        containsMusic: false,
        thirdPartyCreator: false,
        sponsoredContent: false,
        depictsAlcohol: false,
        wineAccessory: true,
      },
    });

    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    const response = await DISCLOSURE(
      new Request(`http://localhost/api/media/${MEDIA_ID}/disclosure`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          benefitReceived: true,
          benefitKind: "FREE_PRODUCT",
          benefitSource: "Arcus",
          benefitSourceAlcoholLinked: false,
          label: "Advertisement / Reklame",
        }),
      }),
      { params: Promise.resolve({ id: MEDIA_ID }) },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("benefitSource");
    expect((await brandRow(brand.id)).alcoholLinked).toBe(true);
  });
});

describe("K1: the publish gate refuses on the brand's NEXT publish attempt", () => {
  async function seedPublishedGiftedItem() {
    await prisma.media.create({
      data: {
        id: MEDIA_ID,
        userId: OWNER_ID,
        kind: "IMAGE",
        key: `media/${OWNER_ID}/original.png`,
        previewKey: `previews/${OWNER_ID}/preview.webp`,
        previewId: "preview-mqh8-k1",
        mimeType: "image/png",
        sizeBytes: 2048,
        originalName: "IMG_0003.HEIC",
        altText: "A wine glass on a shelf",
      },
    });
    // The uploader's rights declaration (ugcportal-3ae): without one the
    // publish below is refused 422 for a reason that has nothing to do with
    // this file's subject. Nobody is in the frame, so no PEOPLE clearance is
    // needed.
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
    await prisma.mediaListing.create({
      data: {
        mediaId: MEDIA_ID,
        depictsPeople: false,
        depictsMinors: false,
        containsMusic: false,
        thirdPartyCreator: false,
        sponsoredContent: false,
        depictsAlcohol: false,
        wineAccessory: true,
      },
    });

    // The owner records the benefit, naming a brand nobody has checked yet —
    // the disclosure route mints it and records the FIRST answer, `false`,
    // same as every brand's first contact through that route.
    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    const recorded = await DISCLOSURE(
      new Request(`http://localhost/api/media/${MEDIA_ID}/disclosure`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          benefitReceived: true,
          benefitKind: "FREE_PRODUCT",
          benefitSource: "Riedel Glassware",
          benefitSourceAlcoholLinked: false,
          label: "Advertisement / Reklame",
        }),
      }),
      { params: Promise.resolve({ id: MEDIA_ID }) },
    );
    expect(recorded.status).toBe(200);

    const publishResponse = await PUBLISH(
      new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: MEDIA_ID }) },
    );
    expect(publishResponse.status).toBe(200);

    const brand = await prisma.benefitSource.findUniqueOrThrow({
      where: { slug: "riedel-glassware" },
      select: { id: true },
    });
    return brand.id;
  }

  it("lets an admin record the brand as alcohol-linked, and refuses the item's next publish attempt without unpublishing it", async () => {
    const brandId = await seedPublishedGiftedItem();

    const publishedBefore = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { publishedAt: true },
    });
    expect(publishedBefore.publishedAt).not.toBeNull();

    authMock.mockResolvedValue({ user: { id: ADMIN_ID, role: "ADMIN" } });
    const flipResponse = await FLIP(flipRequest(brandId));
    expect(flipResponse.status).toBe(303);

    authMock.mockResolvedValue({ user: { id: OWNER_ID, role: "USER" } });
    const refused = await PUBLISH(
      new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: MEDIA_ID }) },
    );
    const body = await refused.json();

    expect(refused.status).toBe(400);
    expect(body.field).toBe("benefitSource");
    // The dated, attributed refusal from PR #168 (ugcportal-qnq9.3 K4), not a
    // generic 400: this is the same message `alcoholLinkedBrandRefusal`
    // (src/lib/alcohol-commerce.ts) has always produced for a `true` answer —
    // this bead did not need a new refusal, only a way to reach the state
    // that triggers the existing one.
    expect(body.error).toMatch(
      /produces, imports or sells alcohol.*alkoholloven § 9-2/,
    );

    // K2: not auto-unpublished. The item is still public; it is the NEXT
    // publish attempt that is refused, not the row retroactively hidden.
    const publishedAfter = await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { publishedAt: true },
    });
    expect(publishedAfter.publishedAt).toEqual(publishedBefore.publishedAt);
  });
});
