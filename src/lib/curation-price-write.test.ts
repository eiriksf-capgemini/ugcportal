import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ResaleRightsStatus } from "@/generated/prisma/enums";
import { completeAttestationRow } from "@/lib/test-support/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { FIXTURE_CLEARANCE_SCOPE } from "@/lib/test-support/resale-rights";

/**
 * ugcportal-yzo7 K1, K2 and K3 against a real database: what the one price
 * writer stores, and the two states it refuses.
 *
 * EVERY REFUSAL IS PAIRED WITH THE FIXTURE MUTATION THAT LIFTS IT, in the
 * same case. "Refused when the uploader is not CLEARED" is also true of a
 * writer that refuses everything, and this repo has shipped an assertion of
 * exactly that shape before; "…and the same call succeeds once the uploader
 * is CLEARED" is not.
 */

vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the price writer must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { CURRENT_CHECKLIST_VERSION, isSellable, MEDIA_GATE_SELECT } =
  await import("@/lib/resale-rights");
const { recordPrice } = await import("@/lib/curation-price-write");
const { MAX_PRICE_CENTS } = await import("@/lib/pricing");
const { MAX_LICENCE_TERMS_LENGTH } = await import("@/lib/licence-terms");

const OWNER = "owner-price";
const ADMIN = "admin-price";
const MEDIA_ID = "media-price";
const PREVIEW_KEY = `previews/${OWNER}/preview.webp`;

async function storedListing() {
  return prisma.mediaListing.findUniqueOrThrow({
    where: { mediaId: MEDIA_ID },
    select: { id: true, priceCents: true, currency: true, licenceTerms: true },
  });
}

/** The gate's own verdict on the fixture, read the way the catalogue does. */
async function sellableNow(): Promise<boolean> {
  const row = await prisma.media.findUniqueOrThrow({
    where: { id: MEDIA_ID },
    select: MEDIA_GATE_SELECT,
  });
  return isSellable(row);
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: OWNER, email: "owner-price@example.com", role: "USER" },
      { id: ADMIN, email: "admin-price@example.com", role: "ADMIN" },
    ],
  });
  await prisma.media.create({
    data: {
      id: MEDIA_ID,
      userId: OWNER,
      kind: "IMAGE",
      key: `uploads/${OWNER}/original.jpg`,
      previewKey: PREVIEW_KEY,
      previewId: "pv-price",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      originalName: "original.jpg",
      altText: "A bowl of olives",
    },
  });
  await prisma.mediaAttestation.create({
    data: completeAttestationRow(MEDIA_ID, OWNER),
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
      wineAccessory: false,
      triagedByUserId: ADMIN,
      triagedAt: new Date("2026-03-03T00:00:00.000Z"),
    },
  });
  await prisma.resaleRightsReview.create({
    data: {
      uploaderUserId: OWNER,
      status: ResaleRightsStatus.CLEARED,
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      // ugcportal-aqw: wide enough to cover every upload this fixture seeds.
      // See FIXTURE_CLEARANCE_SCOPE for why that is a far cut-off rather
      // than the framework-licence flag, which would be a claim about a
      // document this fixture does not have.
      ...FIXTURE_CLEARANCE_SCOPE,
      reviewedByUserId: ADMIN,
      reviewedAt: new Date("2026-03-01T00:00:00.000Z"),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  await prisma.resaleRightsReview.update({
    where: { uploaderUserId: OWNER },
    data: { status: ResaleRightsStatus.CLEARED },
  });
  await prisma.media.update({
    where: { id: MEDIA_ID },
    data: { previewKey: PREVIEW_KEY },
  });
  await prisma.mediaListing.update({
    where: { mediaId: MEDIA_ID },
    data: { priceCents: null, currency: "NOK", licenceTerms: null },
  });
});

describe("K1: a cleared upload takes a price, and reports as sellable", () => {
  it("stores the amount and the currency, and the gate says yes", async () => {
    const outcome = await recordPrice({
      target: { mediaId: MEDIA_ID },
      priceCents: 99_900,
      currency: "EUR",
    });

    expect(outcome).toMatchObject({ kind: "priced", priceCents: 99_900, currency: "EUR" });
    await expect(storedListing()).resolves.toMatchObject({
      priceCents: 99_900,
      currency: "EUR",
    });
    // The second half of K1, asked of the gate rather than inferred from the
    // write having succeeded.
    await expect(sellableNow()).resolves.toBe(true);
  });

  it("leaves the stored currency alone when none is supplied", async () => {
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 1, currency: "USD" });
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 2 });
    await expect(storedListing()).resolves.toMatchObject({
      priceCents: 2,
      currency: "USD",
    });
  });

  it("takes the same upload by listing id, which is what the HTTP route holds", async () => {
    const { id } = await storedListing();
    const outcome = await recordPrice({
      target: { listingId: id },
      priceCents: 4_200,
      currency: "NOK",
    });
    expect(outcome).toMatchObject({ kind: "priced", listingId: id });
  });

  it("refuses an amount that is not a whole number of minor units", async () => {
    for (const bad of [19.99, Number.NaN, Number.POSITIVE_INFINITY, -1, MAX_PRICE_CENTS + 1]) {
      await expect(
        recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: bad }),
      ).resolves.toEqual({ kind: "price_amount_invalid" });
    }
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });

    // The mutation: the one in-range integer in the same shape succeeds.
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: MAX_PRICE_CENTS }),
    ).resolves.toMatchObject({ kind: "priced" });
  });

  it("refuses a currency nothing can charge", async () => {
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10, currency: "XYZ" }),
    ).resolves.toEqual({ kind: "price_amount_invalid" });
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });

    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10, currency: "NOK" }),
    ).resolves.toMatchObject({ kind: "priced" });
  });

  it("answers not-found for an id nothing is behind", async () => {
    await expect(
      recordPrice({ target: { mediaId: "no-such-media" }, priceCents: 10 }),
    ).resolves.toEqual({ kind: "price_media_not_found" });
    await expect(
      recordPrice({ target: { listingId: "no-such-listing" }, priceCents: 10 }),
    ).resolves.toEqual({ kind: "price_media_not_found" });
  });
});

describe("K2: an uploader with no closed confirmation cannot be priced", () => {
  it("refuses the call made directly, bypassing any UI, then succeeds once CLEARED", async () => {
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { status: ResaleRightsStatus.REVOKED },
    });

    const refused = await recordPrice({
      target: { mediaId: MEDIA_ID },
      priceCents: 50_000,
      currency: "NOK",
    });
    expect(refused).toEqual({
      kind: "price_not_sellable",
      blocker: "status_not_cleared",
    });
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });

    // MUTATE THE FIXTURE: the same call, with the uploader CLEARED.
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { status: ResaleRightsStatus.CLEARED },
    });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 50_000, currency: "NOK" }),
    ).resolves.toMatchObject({ kind: "priced", priceCents: 50_000 });
  });

  it("refuses an uploader nobody has reviewed at all", async () => {
    await prisma.resaleRightsReview.delete({ where: { uploaderUserId: OWNER } });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10 }),
    ).resolves.toEqual({ kind: "price_not_sellable", blocker: "no_review" });

    await prisma.resaleRightsReview.create({
      data: {
        uploaderUserId: OWNER,
        status: ResaleRightsStatus.CLEARED,
        checklistVersion: CURRENT_CHECKLIST_VERSION,
        // ugcportal-aqw: wide enough to cover every upload this fixture seeds.
        // See FIXTURE_CLEARANCE_SCOPE for why that is a far cut-off rather
        // than the framework-licence flag, which would be a claim about a
        // document this fixture does not have.
        ...FIXTURE_CLEARANCE_SCOPE,
        reviewedByUserId: ADMIN,
        reviewedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10 }),
    ).resolves.toMatchObject({ kind: "priced" });
  });

  it("still lets an admin take a revoked uploader's item off sale", async () => {
    /*
     * Un-pricing is ungated, and this is the state it exists for: the
     * clearance has just gone, and the ONE thing an admin must still be able
     * to do is withdraw the offer. A gate in front of this would strand a
     * price on exactly the uploads that lost their clearance.
     */
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 777, currency: "NOK" });
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { status: ResaleRightsStatus.REVOKED },
    });

    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: null }),
    ).resolves.toMatchObject({ kind: "unpriced" });
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });
  });
});

describe("K3: a Media row with no watermarked preview cannot be priced", () => {
  it("refuses a null previewKey, then succeeds once one exists", async () => {
    await prisma.media.update({
      where: { id: MEDIA_ID },
      data: { previewKey: null },
    });

    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 1_000, currency: "NOK" }),
    ).resolves.toEqual({ kind: "price_no_preview" });
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });

    // MUTATE THE FIXTURE: set a previewKey and the same call succeeds.
    await prisma.media.update({
      where: { id: MEDIA_ID },
      data: { previewKey: PREVIEW_KEY },
    });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 1_000, currency: "NOK" }),
    ).resolves.toMatchObject({ kind: "priced", priceCents: 1_000 });
  });

  it("reads a blank previewKey as absent, not as a working preview", async () => {
    // The same reading `recordTriageFacts` and the publish endpoint use, so
    // the three agree about which rows have a protected copy. A writer-side
    // bug that stored "" must not be mistaken for an object in storage.
    await prisma.media.update({
      where: { id: MEDIA_ID },
      data: { previewKey: "   " },
    });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 1_000 }),
    ).resolves.toEqual({ kind: "price_no_preview" });
  });

  it("is checked BEFORE the gate, so the admin is told the useful thing", async () => {
    // Both conditions wrong at once. The preview is the more specific
    // answer — it is not a rights problem an admin can clear — so it is the
    // one reported.
    await prisma.media.update({ where: { id: MEDIA_ID }, data: { previewKey: null } });
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { status: ResaleRightsStatus.REVOKED },
    });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10 }),
    ).resolves.toEqual({ kind: "price_no_preview" });
  });

  it("still allows un-pricing an upload whose preview has gone", async () => {
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 500, currency: "NOK" });
    await prisma.media.update({ where: { id: MEDIA_ID }, data: { previewKey: null } });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: null }),
    ).resolves.toMatchObject({ kind: "unpriced" });
  });
});

describe("ugcportal-74w.1: the licence grant is stored with the price", () => {
  const GRANT = "Web and social use for 12 months.\nCredit the photographer.";

  it("K1: stores the grant in the same write as the price, and it round-trips", async () => {
    const outcome = await recordPrice({
      target: { mediaId: MEDIA_ID },
      priceCents: 99_900,
      currency: "NOK",
      // CRLF from a textarea, with surrounding whitespace: stored normalised.
      licenceTerms: "  Web and social use for 12 months.\r\nCredit the photographer.\n",
    });

    expect(outcome).toMatchObject({ kind: "priced", priceCents: 99_900, licenceTerms: GRANT });
    await expect(storedListing()).resolves.toMatchObject({
      priceCents: 99_900,
      licenceTerms: GRANT,
    });
  });

  it("K1: leaves the stored grant alone when none is supplied, like the currency", async () => {
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 1, licenceTerms: GRANT });
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 2 });
    await expect(storedListing()).resolves.toMatchObject({ priceCents: 2, licenceTerms: GRANT });
  });

  it("K2: stores empty, whitespace-only, invisible-only and null input as null", async () => {
    // The invisible-only three (PR #297 round 1, F2): a zero-width space,
    // two bidi marks, and spaces around a soft hyphen. `trim()` keeps all of
    // them, and each would render the grant heading over an empty block.
    for (const blank of ["", "   \n\t ", "\u200B", "\u200E\u200F", " \u00AD ", null]) {
      // Set first, so a writer that ignored blank input would leave the old
      // grant in place and fail here rather than pass on a null it never wrote.
      await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10, licenceTerms: GRANT });
      await expect(storedListing()).resolves.toMatchObject({ licenceTerms: GRANT });

      await expect(
        recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10, licenceTerms: blank }),
      ).resolves.toMatchObject({ kind: "priced", licenceTerms: null });
      await expect(storedListing(), JSON.stringify(blank)).resolves.toMatchObject({
        licenceTerms: null,
      });
    }
  });

  it("K4: refuses a grant naming instagram.com in any spelling, and writes nothing", async () => {
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 500, licenceTerms: GRANT });

    for (const bad of [
      "See instagram.com/p/abc",
      "INSTAGRAM.COM/gry",
      "https://www.Instagram.com/p/abc",
      "http://instagram.com",
      "www.instagram.com/eirik",
      // Spelled with what a buyer cannot see (PR #297 round 1, F1).
      "instagram.c\u200Eom/p/x",
      "insta\u2066gram.com/p/x",
      "instagram\uFF61com/p/x",
    ]) {
      await expect(
        recordPrice({
          target: { mediaId: MEDIA_ID },
          priceCents: 9_999,
          currency: "EUR",
          licenceTerms: bad,
        }),
        bad,
      ).resolves.toEqual({ kind: "price_terms_instagram_url" });
    }
    // Nothing written: not the grant, and not the price or currency that
    // came with it.
    await expect(storedListing()).resolves.toMatchObject({
      priceCents: 500,
      currency: "NOK",
      licenceTerms: GRANT,
    });

    // THE MUTATION: the same call without the address is stored.
    await expect(
      recordPrice({
        target: { mediaId: MEDIA_ID },
        priceCents: 9_999,
        currency: "EUR",
        licenceTerms: "See the original file.",
      }),
    ).resolves.toMatchObject({ kind: "priced", licenceTerms: "See the original file." });
  });

  it("refuses a grant over the length bound by name, and writes nothing", async () => {
    await expect(
      recordPrice({
        target: { mediaId: MEDIA_ID },
        priceCents: 700,
        licenceTerms: "x".repeat(MAX_LICENCE_TERMS_LENGTH + 1),
      }),
    ).resolves.toEqual({ kind: "price_terms_too_long" });
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null, licenceTerms: null });

    // THE MUTATION: exactly the bound is stored, whole.
    await recordPrice({
      target: { mediaId: MEDIA_ID },
      priceCents: 700,
      licenceTerms: "x".repeat(MAX_LICENCE_TERMS_LENGTH),
    });
    const stored = await storedListing();
    expect(stored.licenceTerms).toHaveLength(MAX_LICENCE_TERMS_LENGTH);
  });

  it("K3: a grant is not stored when the gate refuses the price", async () => {
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { status: ResaleRightsStatus.REVOKED },
    });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10, licenceTerms: GRANT }),
    ).resolves.toMatchObject({ kind: "price_not_sellable" });
    await expect(storedListing()).resolves.toMatchObject({ licenceTerms: null });

    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: OWNER },
      data: { status: ResaleRightsStatus.CLEARED },
    });
    await expect(
      recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10, licenceTerms: GRANT }),
    ).resolves.toMatchObject({ kind: "priced", licenceTerms: GRANT });
  });

  it("un-pricing neither checks nor writes the grant, so it can never be refused over one", async () => {
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 10, licenceTerms: GRANT });
    await expect(
      recordPrice({
        target: { mediaId: MEDIA_ID },
        priceCents: null,
        licenceTerms: "instagram.com/p/abc",
      }),
    ).resolves.toMatchObject({ kind: "unpriced", licenceTerms: GRANT });
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null, licenceTerms: GRANT });
  });
});
