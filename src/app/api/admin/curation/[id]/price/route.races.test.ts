import { beforeEach, describe, expect, it, vi } from "vitest";

import { completeAttestationAnswers } from "@/lib/test-support/attestation";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { CURRENT_CHECKLIST_VERSION } from "@/lib/resale-rights";

/**
 * The write races at the price endpoint.
 *
 * The gate read and the update share a transaction, but adapter-libsql opens
 * SQLite transactions as `deferred`, so the listing can be deleted in between.
 * Before this was mapped, that threw P2025 out of `$transaction` as an
 * unhandled 500 — on an endpoint whose whole design is answering 403, 404
 * and 422 deliberately.
 *
 * Mocked rather than raced, for the same reason as
 * resale-rights-review.conflict.test.ts: forcing the interleaving against a
 * real database needs a sleep or a retry loop, and the test would be slow
 * and occasionally lie. The contract — a lost race becomes a status code,
 * not a stack trace — is exact under a mock.
 */

const authMock = vi.fn();
const updateMock = vi.fn();

/** What MEDIA_GATE_SELECT returns for an upload that clears the gate. */
const SELLABLE_UPLOAD = {
  userId: "owner-1",
  user: {
    resaleRightsReview: {
      status: "CLEARED",
      // The constant, not a literal: a hard-coded version silently stops
      // matching ACCEPTED_CHECKLIST_VERSIONS the day it is bumped, and this
      // fixture's whole job is to clear the gate so the write race is what
      // is under test.
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      reviewedByUserId: "admin-1",
      validUntil: null,
      reviewedBy: { role: "ADMIN" },
    },
  },
  // The uploader's own rights attestation (ugcportal-15r). Built from the
  // shared fixture rather than written out, for the reason the checklist
  // version one line up is a constant: a hand-listed set of answers stops
  // covering every question the day a tenth is added, and this fixture's job
  // is to clear the gate so the write race is what is under test.
  attestation: {
    attestedByUserId: "owner-1",
    attestationVersion: CURRENT_ATTESTATION_VERSION,
    ...completeAttestationAnswers(),
  },
  listing: {
    depictsPeople: false,
    depictsMinors: false,
    modelReleaseKey: null,
    containsMusic: false,
    thirdPartyCreator: false,
    sponsoredContent: false,
    depictsAlcohol: false,
    wineAccessory: false,
    triagedByUserId: "admin-1",
    triagedBy: { role: "ADMIN" },
    layerClearances: [],
  },
};

const tx = {
  media: { findFirst: vi.fn().mockResolvedValue(SELLABLE_UPLOAD) },
  mediaListing: { update: updateMock },
};

vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) },
}));

const { POST } = await import("@/app/api/admin/curation/[id]/price/route");

function priceRequest(body: unknown) {
  return new Request("http://localhost/api/admin/curation/listing-1/price", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "listing-1" }) };

beforeEach(() => {
  process.env.AUTH_URL = "http://localhost";
  authMock
    .mockReset()
    .mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
  updateMock.mockReset();
  tx.media.findFirst.mockClear().mockResolvedValue(SELLABLE_UPLOAD);
});

describe("a listing deleted between the gate read and the write", () => {
  it("answers 404 rather than throwing", async () => {
    // The same answer the caller would have got a moment earlier, and the
    // honest one: the thing they asked to price is gone.
    updateMock.mockRejectedValue(
      Object.assign(new Error("Record to update not found"), {
        code: "P2025",
      }),
    );

    const response = await POST(priceRequest({ priceCents: 100 }), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("still lets an unmapped database error surface", async () => {
    // Same allow-list reasoning as the review writer: a fault answered with
    // a tidy status code is a fault nobody investigates.
    updateMock.mockRejectedValue(
      Object.assign(new Error("database is locked"), { code: "P2034" }),
    );

    await expect(
      POST(priceRequest({ priceCents: 100 }), context),
    ).rejects.toThrow("database is locked");
  });

  it("does not treat a plain error as a missing row", async () => {
    updateMock.mockRejectedValue(new Error("boom"));

    await expect(
      POST(priceRequest({ priceCents: 100 }), context),
    ).rejects.toThrow("boom");
  });
});
