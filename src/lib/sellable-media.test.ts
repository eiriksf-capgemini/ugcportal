import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ResaleRightsStatus } from "@/generated/prisma/enums";
import { completeAttestationRow } from "@/lib/test-support/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { FIXTURE_CLEARANCE_SCOPE } from "@/lib/test-support/resale-rights";

/**
 * ugcportal-yzo7 K4, against a real database: an item priced while its
 * uploader was CLEARED stops being offered the moment that clearance stops
 * holding, with NOTHING written to the priced row.
 *
 * WHY A REAL DATABASE AND THE REAL WRITE PATH. The claim is partly about
 * code (`publicOffer` asks the gate before it reads a price) and partly
 * about state: that `priceCents` really is still sitting in the column while
 * the offer is gone. A mocked Prisma would agree with whatever this file
 * asserted about both. The price is set through `recordPrice` — the real
 * endpoint's own writer — rather than inserted, so what these cases exercise
 * is the path an admin actually takes.
 *
 * THE FIXTURE MUTATION IS THE POINT, and it runs in both directions. Every
 * non-CLEARED status is walked in turn (read off the generated enum, so a
 * seventh status added to the schema is covered without anyone remembering),
 * and then CLEARED is RESTORED and the offer asserted back. Without the
 * restore, every one of those assertions would also pass against a
 * `publicOffer` that returned `null` unconditionally, or against a fixture
 * that was broken in some way unrelated to the status — which is exactly the
 * defect this repo keeps finding in its own suites.
 */

vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("a public offer must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { CURRENT_CHECKLIST_VERSION, MEDIA_GATE_SELECT } = await import(
  "@/lib/resale-rights"
);
const { recordPrice } = await import("@/lib/curation-price-write");
const { SUPPORTED_CURRENCIES, formatOfferPrice } = await import("@/lib/pricing");
const { SELLABLE_MEDIA_SELECT, getPublicOffer, publicOffer } = await import(
  "@/lib/sellable-media"
);

const OWNER = "owner-yzo7";
const ADMIN = "admin-yzo7";
const MEDIA_ID = "media-yzo7";
const PREVIEW_ID = "pv-yzo7";
const PRICE_CENTS = 125_000;

/** Every status that is not the one the gate sells on. */
const NON_CLEARED_STATUSES = Object.values(ResaleRightsStatus).filter(
  (status) => status !== ResaleRightsStatus.CLEARED,
);

async function setStatus(
  status: (typeof ResaleRightsStatus)[keyof typeof ResaleRightsStatus],
  validUntil: Date | null = null,
): Promise<void> {
  await prisma.resaleRightsReview.update({
    where: { uploaderUserId: OWNER },
    data: { status, validUntil },
  });
}

/** The stored price, read straight off the column. */
async function storedPrice(): Promise<number | null> {
  const listing = await prisma.mediaListing.findUniqueOrThrow({
    where: { mediaId: MEDIA_ID },
    select: { priceCents: true },
  });
  return listing.priceCents;
}

/** The row the gate sees, for the cases that need an injectable clock. */
async function gateRow() {
  return prisma.media.findUniqueOrThrow({
    where: { id: MEDIA_ID },
    select: SELLABLE_MEDIA_SELECT,
  });
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: OWNER, email: "owner-yzo7@example.com", role: "USER" },
      { id: ADMIN, email: "admin-yzo7@example.com", role: "ADMIN" },
    ],
  });
  await prisma.media.create({
    data: {
      id: MEDIA_ID,
      userId: OWNER,
      kind: "IMAGE",
      key: `uploads/${OWNER}/original.jpg`,
      previewKey: `previews/${OWNER}/preview.webp`,
      previewId: PREVIEW_ID,
      mimeType: "image/jpeg",
      sizeBytes: 4096,
      originalName: "original.jpg",
      altText: "A plate of figs on a linen cloth",
      publishedAt: new Date("2026-03-02T00:00:00.000Z"),
    },
  });
  await prisma.mediaAttestation.create({
    data: completeAttestationRow(MEDIA_ID, OWNER),
  });
  await prisma.mediaListing.create({
    data: {
      mediaId: MEDIA_ID,
      // Every registered triage fact answered, by an admin. "No" to all of
      // them is the one combination that needs no per-layer clearance, which
      // keeps this fixture about the UPLOADER's status rather than about the
      // layers.
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
      validUntil: null,
    },
  });

  // Priced through the real write path, with the uploader CLEARED — which is
  // the only state in which it would be accepted (K2).
  const outcome = await recordPrice({
    target: { mediaId: MEDIA_ID },
    priceCents: PRICE_CENTS,
    currency: "NOK",
  });
  expect(outcome.kind).toBe("priced");
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  // Every case starts from the state the bead describes: priced, and
  // currently sellable.
  await setStatus(ResaleRightsStatus.CLEARED, null);
});

describe("an offer is re-evaluated at render, not read off the stored price (ugcportal-yzo7 K4)", () => {
  it("offers the item while the uploader is CLEARED", async () => {
    // The needle has to be able to be PRESENT, or every exclusion below
    // proves nothing.
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toEqual({
      priceCents: PRICE_CENTS,
      currency: "NOK",
      licenceTerms: null,
    });
  });

  it("finds statuses to walk at all", () => {
    // Read off the generated enum: a seventh status is covered without
    // anyone remembering, and an empty list would make the case below pass
    // by iterating nothing.
    expect(NON_CLEARED_STATUSES.length).toBeGreaterThan(0);
    expect(NON_CLEARED_STATUSES).not.toContain(ResaleRightsStatus.CLEARED);
  });

  for (const status of NON_CLEARED_STATUSES) {
    it(`withdraws the offer when the uploader becomes ${status}, leaving the price stored`, async () => {
      await setStatus(status);

      await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();
      // THE HALF THAT MAKES THIS K4 RATHER THAN K2: the column is untouched.
      // Nothing wrote to the listing, and the offer is gone anyway.
      await expect(storedPrice()).resolves.toBe(PRICE_CENTS);

      // THE RESTORE, in the same case as the exclusion so the two cannot
      // drift apart. Without it, "excluded" would also be satisfied by an
      // item excluded for an unrelated reason — an unpublished row, a broken
      // fixture, a `publicOffer` that always says null.
      await setStatus(ResaleRightsStatus.CLEARED);
      await expect(getPublicOffer(PREVIEW_ID)).resolves.toEqual({
        priceCents: PRICE_CENTS,
        currency: "NOK",
        licenceTerms: null,
      });
    });
  }

  it("withdraws the offer when the clearance simply EXPIRES, with no write at all", async () => {
    /*
     * The case no transaction could ever close, and the reason this bead
     * does not rest on the write-time race the parent asserted: the status
     * stays CLEARED and nobody writes anything. Time passes.
     */
    const validUntil = new Date("2026-04-01T00:00:00.000Z");
    await setStatus(ResaleRightsStatus.CLEARED, validUntil);
    const row = await gateRow();

    expect(publicOffer(row, new Date("2026-03-20T00:00:00.000Z"))).toEqual({
      priceCents: PRICE_CENTS,
      currency: "NOK",
      licenceTerms: null,
    });
    // One instant later than the window, same row, same stored price.
    expect(publicOffer(row, new Date("2026-04-01T00:00:00.001Z"))).toBeNull();
    await expect(storedPrice()).resolves.toBe(PRICE_CENTS);
  });

  it("withdraws the offer when the admin who signed the triage is demoted", async () => {
    // A write to `User.role`, on a different table again. `triageBlocker`
    // re-reads the role, so the signature is void from the next request.
    await prisma.user.update({ where: { id: ADMIN }, data: { role: "USER" } });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();
    await expect(storedPrice()).resolves.toBe(PRICE_CENTS);

    await prisma.user.update({ where: { id: ADMIN }, data: { role: "ADMIN" } });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.not.toBeNull();
  });

  it("offers nothing once the price is removed, which IS a write", async () => {
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: null });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();
    await expect(storedPrice()).resolves.toBeNull();

    await recordPrice({
      target: { mediaId: MEDIA_ID },
      priceCents: PRICE_CENTS,
      currency: "NOK",
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.not.toBeNull();
  });

  it("offers nothing for a currency the write path would refuse", async () => {
    /*
     * Written straight to the column, which is the only way to reach this
     * state: `recordPrice` refuses an unsupported code. The failure it
     * prevents is not cosmetic: "XYZ" is well-formed enough that
     * `Intl.NumberFormat` renders it rather than throwing (`"XYZ 1,250.00"`),
     * so a reader cannot rely on a crash to keep an un-allowlisted currency
     * off the page — `isSupportedCurrency` is the only thing that does, and
     * without it an offer could show an amount at the wrong number of minor
     * units with nothing to flag that it was wrong.
     */
    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { currency: "XYZ" },
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();
    await expect(storedPrice()).resolves.toBe(PRICE_CENTS);

    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { currency: "NOK" },
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.not.toBeNull();
  });

  it("offers nothing for an amount the write path would refuse", async () => {
    // A negative amount, over the ceiling, or a non-integer: none is
    // reachable through `recordPrice`, all are reachable in the column.
    for (const bad of [-1, 10_000_001]) {
      await prisma.mediaListing.update({
        where: { mediaId: MEDIA_ID },
        data: { priceCents: bad },
      });
      await expect(getPublicOffer(PREVIEW_ID), String(bad)).resolves.toBeNull();
    }

    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { priceCents: PRICE_CENTS },
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.not.toBeNull();
  });

  it("treats a stored price of zero as no offer rather than as free", async () => {
    await recordPrice({ target: { mediaId: MEDIA_ID }, priceCents: 0 });
    await expect(storedPrice()).resolves.toBe(0);
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();

    await recordPrice({
      target: { mediaId: MEDIA_ID },
      priceCents: PRICE_CENTS,
      currency: "NOK",
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.not.toBeNull();
  });
});

/**
 * ugcportal-74w.1 K1/K2/K3: the licence grant travels on the offer, and
 * only on an offer the gate produced at render time.
 */
describe("the licence grant on the offer (ugcportal-74w.1)", () => {
  const GRANT = "Web use for 12 months. Credit the photographer.";

  async function storedTerms(): Promise<string | null> {
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: MEDIA_ID },
      select: { licenceTerms: true },
    });
    return listing.licenceTerms;
  }

  beforeEach(async () => {
    await recordPrice({
      target: { mediaId: MEDIA_ID },
      priceCents: PRICE_CENTS,
      currency: "NOK",
      licenceTerms: GRANT,
    });
  });

  afterEach(async () => {
    await recordPrice({
      target: { mediaId: MEDIA_ID },
      priceCents: PRICE_CENTS,
      currency: "NOK",
      licenceTerms: null,
    });
  });

  it("K1: carries the stored grant on the offer", async () => {
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toEqual({
      priceCents: PRICE_CENTS,
      currency: "NOK",
      licenceTerms: GRANT,
    });
  });

  it("K3: returns no offer, grant included, once the item stops being sellable at render — the grant still stored", async () => {
    // Revoked, expired with no write, and the triage signer demoted: the
    // three render-time lapses K3 names.
    await setStatus(ResaleRightsStatus.REVOKED);
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();
    await setStatus(ResaleRightsStatus.CLEARED);

    await setStatus(ResaleRightsStatus.CLEARED, new Date("2026-04-01T00:00:00.000Z"));
    expect(publicOffer(await gateRow(), new Date("2026-04-01T00:00:00.001Z"))).toBeNull();
    await setStatus(ResaleRightsStatus.CLEARED, null);

    await prisma.user.update({ where: { id: ADMIN }, data: { role: "USER" } });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();
    await prisma.user.update({ where: { id: ADMIN }, data: { role: "ADMIN" } });

    // Nothing wrote to the grant through any of that.
    await expect(storedTerms()).resolves.toBe(GRANT);
    // THE RESTORE: sellable again, and the grant is back on the offer.
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toMatchObject({ licenceTerms: GRANT });
  });

  it("K2: reads a blank stored grant as none", async () => {
    // Written straight to the column — `recordPrice` stores blank as null,
    // so this state is only reachable by some other writer. The second is
    // blank to a buyer though not to `trim()`: zero-width and bidi marks.
    for (const blank of ["  \n ", " \u200B\u2066\u00AD "]) {
      await prisma.mediaListing.update({
        where: { mediaId: MEDIA_ID },
        data: { licenceTerms: blank },
      });
      await expect(getPublicOffer(PREVIEW_ID), JSON.stringify(blank)).resolves.toMatchObject({
        licenceTerms: null,
      });
    }
  });

  it("K4: withdraws the offer for a stored grant the writer would refuse", async () => {
    // Also only reachable by bypassing `recordPrice`. Re-checked on read for
    // the reason the currency and amount are: do not trust that a row was
    // written through the validator.
    for (const bad of ["See instagram.com/p/abc", "instagram.c\u200Eom/p/x", "x".repeat(2_001)]) {
      await prisma.mediaListing.update({
        where: { mediaId: MEDIA_ID },
        data: { licenceTerms: bad },
      });
      await expect(getPublicOffer(PREVIEW_ID), bad.slice(0, 30)).resolves.toBeNull();
    }
    await prisma.mediaListing.update({
      where: { mediaId: MEDIA_ID },
      data: { licenceTerms: GRANT },
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toMatchObject({ licenceTerms: GRANT });
  });
});

describe("the offer read is inside the publish gate too (ugcportal-3ae)", () => {
  /*
   * This file is `lib/sellable-media.ts`'s covering test in
   * src/lib/public-media.consumers.test.ts, and this is what it covers: the
   * offer read spreads PUBLIC_MEDIA_SCOPE, so an item that is not publicly
   * visible carries no public price either. Asserted by MUTATING the row
   * into each of the states that scope excludes and back, rather than by
   * reading the constant.
   */
  it("offers nothing for an item that has been unpublished", async () => {
    await prisma.media.update({
      where: { id: MEDIA_ID },
      data: { publishedAt: null },
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();
    await expect(storedPrice()).resolves.toBe(PRICE_CENTS);

    await prisma.media.update({
      where: { id: MEDIA_ID },
      data: { publishedAt: new Date("2026-03-02T00:00:00.000Z") },
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.not.toBeNull();
  });

  it("offers nothing for an item whose uploader attestation is gone", async () => {
    // The rights half of the scope, which ugcportal-3ae put in the constant.
    // Deleted and re-created rather than edited, because "nobody ever asked
    // the uploader anything" is the absence of a row, not a row of noes.
    await prisma.mediaAttestation.delete({ where: { mediaId: MEDIA_ID } });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.toBeNull();

    await prisma.mediaAttestation.create({
      data: completeAttestationRow(MEDIA_ID, OWNER),
    });
    await expect(getPublicOffer(PREVIEW_ID)).resolves.not.toBeNull();
  });
});

describe("the offer's shape and its select (ugcportal-yzo7)", () => {
  it("projects the gate's own select, key for key", () => {
    // A narrower copy would read as `undefined` on whatever it omitted, and
    // the gate's guards would turn that into a refusal — fail closed, so no
    // leak, but a silent "nothing is ever for sale" no test of the gate
    // itself could notice.
    const { listing: gateListing, ...gateRest } = MEDIA_GATE_SELECT;
    const { listing: offerListing, ...offerRest } = SELLABLE_MEDIA_SELECT;
    expect(offerRest).toEqual(gateRest);
    expect(Object.keys(offerListing.select).sort()).toEqual(
      [...Object.keys(gateListing.select), "priceCents", "currency", "licenceTerms"].sort(),
    );
  });

  it("returns the two money fields and the grant, and nothing else off the row", async () => {
    const offer = await getPublicOffer(PREVIEW_ID);
    expect(offer).not.toBeNull();
    // Named explicitly rather than snapshotted: the row the gate select
    // loads carries `Media.userId` and the uploader's whole review, and a
    // future edit that spread the row into the result would publish both.
    expect(Object.keys(offer ?? {}).sort()).toEqual([
      "currency",
      "licenceTerms",
      "priceCents",
    ]);
  });

  it("answers null for a blank or unknown handle without querying", async () => {
    await expect(getPublicOffer("   ")).resolves.toBeNull();
    await expect(getPublicOffer("pv-does-not-exist")).resolves.toBeNull();
  });

  it("formats every supported currency with a minor unit of 2", () => {
    /*
     * `formatOfferPrice` divides by 100 for every currency. True of the
     * three on the allowlist and not true of ISO-4217 generally — JPY has 0,
     * KWD has 3 — so the allowlist is the control and this is what makes
     * adding JPY to it fail here rather than render a price a hundred times
     * too small.
     */
    for (const currency of SUPPORTED_CURRENCIES) {
      const digits = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits;
      expect(digits, currency).toBe(2);
    }
    expect(formatOfferPrice({ priceCents: 125_000, currency: "NOK" })).toContain(
      "1,250.00",
    );
  });
});
