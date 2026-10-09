import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ResaleRightsStatus } from "@/generated/prisma/enums";
import { completeAttestationRow } from "@/lib/test-support/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The price server action (ugcportal-yzo7 K1/K2), as an integration test: a
 * real SQLite database with the committed migrations applied, the real
 * Prisma client over the real libsql driver, and the real action. Only the
 * session and Next's navigation/cache helpers are faked.
 *
 * WHAT THIS FILE OWNS AND curation-price-write.test.ts DOES NOT: the public
 * entry point. A server action is reachable by POSTing its action id without
 * ever loading the screen, so the session check, which form fields the
 * action trusts, and where a refusal sends the admin are only observable
 * here. The CONDITIONS on the write — the clearance and the preview — are
 * the write's own and are asserted there, which is the whole reason this
 * action may not re-implement either.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { CURRENT_CHECKLIST_VERSION } = await import("@/lib/resale-rights");
const { setPrice } = await import("@/app/admin/curation/actions");

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
};
const USER_SESSION = {
  user: { id: "user-1", email: "user@example.com", role: "USER" },
};

const MEDIA_ID = "media-1";
const PREVIEW_KEY = "previews/owner-1/preview.webp";

function priceForm(overrides: Record<string, string | null> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string | null> = {
    mediaId: MEDIA_ID,
    priceCents: "125000",
    currency: "NOK",
    ...overrides,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) data.append(name, value);
  }
  return data;
}

async function storedListing() {
  return prisma.mediaListing.findUniqueOrThrow({
    where: { mediaId: MEDIA_ID },
    select: { priceCents: true, currency: true },
  });
}

/** The single argument `redirect` was last called with. */
function lastRedirect(): string {
  expect(redirectMock).toHaveBeenCalled();
  return redirectMock.mock.calls.at(-1)?.[0] as string;
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
      { id: "user-1", email: "user@example.com", role: "USER" },
      { id: "owner-1", email: "owner@example.com", role: "USER" },
    ],
  });
  await prisma.media.create({
    data: {
      id: MEDIA_ID,
      userId: "owner-1",
      kind: "IMAGE",
      key: "uploads/owner-1/original.jpg",
      previewKey: PREVIEW_KEY,
      previewId: "pv-action",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      originalName: "original.jpg",
      altText: "A bowl of olives",
    },
  });
  await prisma.mediaAttestation.create({
    data: completeAttestationRow(MEDIA_ID, "owner-1"),
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
      triagedByUserId: "admin-1",
      triagedAt: new Date("2026-03-03T00:00:00.000Z"),
    },
  });
  await prisma.resaleRightsReview.create({
    data: {
      uploaderUserId: "owner-1",
      status: ResaleRightsStatus.CLEARED,
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      reviewedByUserId: "admin-1",
      reviewedAt: new Date("2026-03-01T00:00:00.000Z"),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(ADMIN_SESSION);
  await prisma.resaleRightsReview.update({
    where: { uploaderUserId: "owner-1" },
    data: { status: ResaleRightsStatus.CLEARED },
  });
  await prisma.mediaListing.update({
    where: { mediaId: MEDIA_ID },
    data: { priceCents: null, currency: "NOK" },
  });
});

describe("setPrice: the admin screen's price action (ugcportal-yzo7 K1)", () => {
  it("stores the amount and currency and redirects back to the row", async () => {
    await setPrice(priceForm());

    await expect(storedListing()).resolves.toEqual({
      priceCents: 125_000,
      currency: "NOK",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/curation");
    expect(lastRedirect()).toBe(
      `/admin/curation?price=priced&edit=${encodeURIComponent(MEDIA_ID)}`,
    );
  });

  it("takes a blank amount as removing the price, not as zero", async () => {
    /*
     * `Number("")` is 0, so an action that parsed the field without checking
     * for blank first would price the item at nothing for an admin who meant
     * to withdraw it. Asserted as the stored value, not as the redirect.
     */
    await setPrice(priceForm());
    await setPrice(priceForm({ priceCents: "  " }));

    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });
    expect(lastRedirect()).toContain("price=unpriced");
  });

  it("refuses a caller who is not an admin, and writes nothing", async () => {
    authMock.mockResolvedValue(USER_SESSION);
    await expect(setPrice(priceForm())).rejects.toThrow("Forbidden");
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });

    // MUTATE THE FIXTURE: the same form, from an admin, is stored.
    authMock.mockResolvedValue(ADMIN_SESSION);
    await setPrice(priceForm());
    await expect(storedListing()).resolves.toMatchObject({ priceCents: 125_000 });
  });

  it("refuses a signed-out caller for the same reason", async () => {
    authMock.mockResolvedValue(null);
    await expect(setPrice(priceForm())).rejects.toThrow("Forbidden");
  });

  it("throws on a missing media id rather than rendering a banner for it", async () => {
    // The form carries this in a hidden field on every row, so its absence
    // is a tampered request rather than a mistake an admin can act on.
    await expect(setPrice(priceForm({ mediaId: null }))).rejects.toThrow(
      "Missing media id",
    );
  });

  it("sends a fractional amount back as a code, with nothing stored", async () => {
    await setPrice(priceForm({ priceCents: "19.99" }));

    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });
    expect(lastRedirect()).toContain("error=price_amount_invalid");
  });

  it("sends an uncleared uploader back with the gate's own refusal", async () => {
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: "owner-1" },
      data: { status: ResaleRightsStatus.REVOKED },
    });

    await setPrice(priceForm());
    await expect(storedListing()).resolves.toMatchObject({ priceCents: null });
    expect(lastRedirect()).toContain("error=price_not_sellable");

    // MUTATE THE FIXTURE: cleared again, the same submission is stored.
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: "owner-1" },
      data: { status: ResaleRightsStatus.CLEARED },
    });
    await setPrice(priceForm());
    await expect(storedListing()).resolves.toMatchObject({ priceCents: 125_000 });
  });

  it("never takes the acting admin from the form", async () => {
    /*
     * Nothing on this action reads an actor out of `formData`, and this
     * asserts it by SUPPLYING one: a field named after the column an
     * attacker would want to set must change nothing about what is written.
     */
    await setPrice(priceForm({ triagedByUserId: "user-1", actorUserId: "user-1" }));
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: MEDIA_ID },
      select: { priceCents: true, triagedByUserId: true },
    });
    expect(listing).toEqual({ priceCents: 125_000, triagedByUserId: "admin-1" });
  });

  it("leaves the stored currency alone when the field is absent", async () => {
    await setPrice(priceForm({ currency: "USD" }));
    await setPrice(priceForm({ priceCents: "4200", currency: null }));
    await expect(storedListing()).resolves.toEqual({
      priceCents: 4_200,
      currency: "USD",
    });
  });
});
