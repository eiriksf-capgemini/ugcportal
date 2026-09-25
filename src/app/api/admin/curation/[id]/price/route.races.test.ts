import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The write races at the price endpoint.
 *
 * The gate read and the update share a transaction, but adapter-libsql opens
 * SQLite transactions as `deferred`, so the post can be deleted in between.
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

const SELLABLE_POST = {
  mediaId: "media-1",
  depictsPeople: false,
  modelReleaseKey: null,
  containsMusic: false,
  thirdPartyCreator: false,
  sponsoredContent: false,
  triagedByUserId: "admin-1",
  triagedBy: { role: "ADMIN" },
  layerClearances: [],
  instagramAccount: {
    resaleRightsReview: {
      status: "CLEARED",
      checklistVersion: "2026-09-24.1",
      reviewedByUserId: "admin-1",
      validUntil: null,
      clearedOwnerUserId: "owner-1",
      reviewedBy: { role: "ADMIN" },
    },
  },
};

const tx = {
  curatedPost: {
    findUnique: vi.fn().mockResolvedValue(SELLABLE_POST),
    update: updateMock,
  },
  media: { findUnique: vi.fn().mockResolvedValue({ userId: "owner-1" }) },
};

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) },
}));

const { POST } = await import("@/app/api/admin/curation/[id]/price/route");

function priceRequest(body: unknown) {
  return new Request("http://localhost/api/admin/curation/post-1/price", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "post-1" }) };

beforeEach(() => {
  process.env.AUTH_URL = "http://localhost";
  authMock
    .mockReset()
    .mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
  updateMock.mockReset();
  tx.curatedPost.findUnique.mockClear().mockResolvedValue(SELLABLE_POST);
});

describe("a post deleted between the gate read and the write", () => {
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
