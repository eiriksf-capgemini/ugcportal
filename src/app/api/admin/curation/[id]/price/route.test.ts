import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ResaleRightsStatus } from "@/generated/prisma/enums";
import {
  CURRENT_CHECKLIST_VERSION,
  MEDIA_GATE_SELECT,
  evaluateSellability,
  isSellable,
} from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-0ss K1 and ugcportal-vsm K1/K3/K4, as an integration test: a real
 * SQLite database with the committed migrations applied, the real Prisma
 * client over the real libsql driver, and the real route handler. Only the
 * session is faked.
 *
 * The point of doing it this way rather than with a mocked Prisma is that
 * the claim under test — "nothing is sellable unless a human cleared the
 * person who uploaded it" — is partly a claim about the *schema* (the
 * default is UNREVIEWED; a missing row reads as null; the review hangs off
 * the uploader) and partly about the driver (the write really is skipped).
 * A mock would agree with whatever the test asserted.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { POST } = await import("@/app/api/admin/curation/[id]/price/route");

const ADMIN_SESSION = { user: { id: "admin-1", email: "a@example.com", role: "ADMIN" } };

function priceRequest(body: unknown, id = "listing-1") {
  return new Request(`http://localhost/api/admin/curation/${id}/price`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

function context(id = "listing-1") {
  return { params: Promise.resolve({ id }) };
}

async function priceOf(id = "listing-1"): Promise<number | null> {
  const listing = await prisma.mediaListing.findUnique({
    where: { id },
    select: { priceCents: true },
  });
  return listing?.priceCents ?? null;
}

/**
 * Puts the *uploader* in `status`, everything else about the review being in
 * order. `owner-1` is who uploaded media-1, which is the only reason this
 * review governs listing-1 at all.
 */
async function setReview(
  status: (typeof ResaleRightsStatus)[keyof typeof ResaleRightsStatus],
  uploaderUserId = "owner-1",
) {
  const data = {
    status,
    checklistVersion: CURRENT_CHECKLIST_VERSION,
    reviewedByUserId: "admin-1",
    reviewedAt: new Date(),
    validUntil: null,
  };
  await prisma.resaleRightsReview.upsert({
    where: { uploaderUserId },
    create: { uploaderUserId, ...data },
    update: data,
  });
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: "admin-1", email: "a@example.com", role: "ADMIN" },
  });
  await prisma.user.create({
    data: { id: "user-1", email: "u@example.com", role: "USER" },
  });
  await prisma.user.create({
    data: { id: "owner-1", email: "owner@example.com", role: "USER" },
  });
  await prisma.media.create({
    data: {
      id: "media-1",
      userId: "owner-1",
      kind: "IMAGE",
      key: "uploads/owner-1/original.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      originalName: "original.jpg",
    },
  });
  await prisma.mediaListing.create({
    data: {
      id: "listing-1",
      mediaId: "media-1",
      depictsPeople: false,
      containsMusic: false,
      thirdPartyCreator: false,
      sponsoredContent: false,
      // The triage is an assertion about third-party rights, so the gate
      // requires a current admin behind it.
      triagedByUserId: "admin-1",
      triagedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  // The same-origin check compares against AUTH_URL (see src/lib/origin.ts).
  process.env.AUTH_URL = "http://localhost";
  authMock.mockReset().mockResolvedValue(ADMIN_SESSION);
  await prisma.mediaListing.update({
    where: { id: "listing-1" },
    data: { priceCents: null },
  });
  await prisma.resaleRightsReview.deleteMany({});
});

describe("the happy path", () => {
  // Without this the 422 assertions below would all pass with the endpoint
  // hard-wired to refuse everything.
  it("sets a price on a cleared uploader's triaged upload", async () => {
    await setReview("CLEARED");

    const response = await POST(priceRequest({ priceCents: 24900 }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "listing-1",
      priceCents: 24900,
      currency: "NOK",
    });
    expect(await priceOf()).toBe(24900);
  });

  it("stores a supported currency and clears a price with null", async () => {
    await setReview("CLEARED");

    expect(
      (await POST(priceRequest({ priceCents: 1000, currency: "EUR" }), context()))
        .status,
    ).toBe(200);
    expect(
      (await POST(priceRequest({ priceCents: null }), context())).status,
    ).toBe(200);
    expect(await priceOf()).toBeNull();
  });
});

/**
 * ugcportal-vsm K4: the re-anchoring must not widen what is sellable, and
 * the widest mistake available is letting one person's clearance cover
 * another person's file.
 *
 * Under ugcportal-0ss the review hung off a connected account and named its
 * rights holder in a column, so the gate had to compare. Here the review is
 * reached through `Media.userId`, so the assertion is the stronger one:
 * moving the *file* to a different uploader changes which clearance applies,
 * with nothing else touched.
 */
describe("ugcportal-vsm: a clearance covers its own uploader only", () => {
  it("refuses an upload whose owner is a different, uncleared user", async () => {
    await setReview("CLEARED", "owner-1");
    expect(
      (await POST(priceRequest({ priceCents: 24900 }), context())).status,
    ).toBe(200);

    // Nothing about the listing changes — only who the file belongs to.
    await prisma.media.update({
      where: { id: "media-1" },
      data: { userId: "user-1" },
    });
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { priceCents: null },
    });

    const response = await POST(priceRequest({ priceCents: 24900 }), context());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Not sellable",
      blocker: "no_review",
    });
    expect(await priceOf()).toBeNull();

    await prisma.media.update({
      where: { id: "media-1" },
      data: { userId: "owner-1" },
    });
  });

  it("follows the file when the other user is the cleared one", async () => {
    // The mirror image, so the test above is not passing because everything
    // is refused. Clear user-1 instead of owner-1 and hand them the file.
    await setReview("CLEARED", "user-1");
    expect(
      (await POST(priceRequest({ priceCents: 100 }), context())).status,
    ).toBe(422);

    await prisma.media.update({
      where: { id: "media-1" },
      data: { userId: "user-1" },
    });
    expect(
      (await POST(priceRequest({ priceCents: 100 }), context())).status,
    ).toBe(200);

    await prisma.media.update({
      where: { id: "media-1" },
      data: { userId: "owner-1" },
    });
  });
});

describe("ugcportal-0ss K1: the gate at the price-setting endpoint", () => {
  const allStatuses = Object.values(ResaleRightsStatus);

  it("covers every status the schema defines", () => {
    expect(allStatuses).toHaveLength(6);
  });

  for (const status of allStatuses) {
    if (status === "CLEARED") continue;

    it(`refuses to price an upload whose uploader is ${status}`, async () => {
      await setReview(status);

      const response = await POST(priceRequest({ priceCents: 24900 }), context());

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "Not sellable",
        blocker: "status_not_cleared",
      });
      expect(await priceOf()).toBeNull();
    });
  }

  // Un-pricing is the safe direction: it takes something *off* sale. Gating
  // it would strand a price on exactly the uploaders that just lost their
  // clearance — and the price route's own concurrency argument depends on a
  // stale price being clearable afterwards.
  for (const status of allStatuses) {
    if (status === "CLEARED") continue;

    it(`still lets an admin un-price an upload whose uploader is ${status}`, async () => {
      await setReview("CLEARED");
      expect(
        (await POST(priceRequest({ priceCents: 24900 }), context())).status,
      ).toBe(200);
      await setReview(status);

      const response = await POST(priceRequest({ priceCents: null }), context());

      expect(response.status).toBe(200);
      expect(await priceOf()).toBeNull();
    });
  }

  it("lets an admin un-price an upload whose uploader was never reviewed", async () => {
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { priceCents: 500 },
    });

    expect(
      (await POST(priceRequest({ priceCents: null }), context())).status,
    ).toBe(200);
    expect(await priceOf()).toBeNull();
  });

  it("does not let un-pricing smuggle a currency change past the gate", async () => {
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { currency: "NOK" },
    });

    await POST(
      priceRequest({ priceCents: null, currency: "USD" }),
      context(),
    );

    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { id: "listing-1" },
    });
    expect(listing.priceCents).toBeNull();
    expect(listing.currency).toBe("NOK");
  });

  /**
   * Per-layer clearance, against the real schema. The unique index on
   * (listingId, layer) is part of the guarantee: one row per layer means the
   * gate never has two answers to the same question.
   */
  it("needs a clearance for each layer that is present, not one for the upload", async () => {
    await setReview("CLEARED");
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { containsMusic: true, thirdPartyCreator: true },
    });

    // A licence for the music says nothing about the collaborator.
    await prisma.mediaRightsClearance.create({
      data: {
        listingId: "listing-1",
        layer: "MUSIC",
        reason: "Licence purchased, receipt in evidence.",
        clearedByUserId: "admin-1",
      },
    });

    let response = await POST(priceRequest({ priceCents: 100 }), context());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      blocker: "third_party_layer_uncleared",
    });

    await prisma.mediaRightsClearance.create({
      data: {
        listingId: "listing-1",
        layer: "THIRD_PARTY_CREATOR",
        reason: "Collaborator signed the assignment.",
        clearedByUserId: "admin-1",
      },
    });

    response = await POST(priceRequest({ priceCents: 100 }), context());
    expect(response.status).toBe(200);

    // And a clearer who has since been demoted stops counting, the same way
    // the uploader's reviewer does.
    await prisma.user.update({
      where: { id: "admin-1" },
      data: { role: "USER" },
    });
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { priceCents: null },
    });

    response = await POST(priceRequest({ priceCents: 100 }), context());
    expect(response.status).toBe(422);
    expect(await priceOf()).toBeNull();

    await prisma.user.update({
      where: { id: "admin-1" },
      data: { role: "ADMIN" },
    });
    await prisma.mediaRightsClearance.deleteMany({});
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { containsMusic: false, thirdPartyCreator: false },
    });
  });

  it("refuses to price an upload whose uploader has no review row at all", async () => {
    // Nothing created in this test: the row genuinely does not exist.
    expect(
      await prisma.resaleRightsReview.findUnique({
        where: { uploaderUserId: "owner-1" },
      }),
    ).toBeNull();

    const response = await POST(priceRequest({ priceCents: 24900 }), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Not sellable",
      blocker: "no_review",
    });
    expect(await priceOf()).toBeNull();
  });

  it("uses UNREVIEWED as the schema default when a row is created bare", async () => {
    await prisma.resaleRightsReview.create({
      data: {
        uploaderUserId: "owner-1",
        checklistVersion: CURRENT_CHECKLIST_VERSION,
      },
    });
    const created = await prisma.resaleRightsReview.findUniqueOrThrow({
      where: { uploaderUserId: "owner-1" },
    });

    expect(created.status).toBe("UNREVIEWED");
    expect((await POST(priceRequest({ priceCents: 1 }), context())).status).toBe(
      422,
    );
  });
});

describe("ugcportal-0ss K2 at the endpoint", () => {
  it("refuses an expired clearance", async () => {
    await setReview("CLEARED");
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: "owner-1" },
      data: { validUntil: new Date(Date.now() - 1000) },
    });

    const response = await POST(priceRequest({ priceCents: 100 }), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ blocker: "clearance_expired" });
    expect(await priceOf()).toBeNull();
  });

  it("refuses a clearance whose reviewer has since been demoted", async () => {
    await setReview("CLEARED");
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: "owner-1" },
      data: { reviewedByUserId: "user-1" },
    });

    const response = await POST(priceRequest({ priceCents: 100 }), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ blocker: "reviewer_not_admin" });
    expect(await priceOf()).toBeNull();
  });

  it("refuses a clearance recorded against a retired checklist version", async () => {
    await setReview("CLEARED");
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: "owner-1" },
      data: { checklistVersion: "2019-01-01.0" },
    });

    const response = await POST(priceRequest({ priceCents: 100 }), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      blocker: "checklist_version_retired",
    });
  });

  it("stops counting a clearance whose reviewer's account is deleted", async () => {
    // ON DELETE SET NULL on reviewedByUserId, asserted against the real
    // database rather than read off the schema: a clearance signed by
    // nobody is not a clearance, and the review row must survive to say so.
    await prisma.user.create({
      data: { id: "admin-2", email: "a2@example.com", role: "ADMIN" },
    });
    await setReview("CLEARED");
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: "owner-1" },
      data: { reviewedByUserId: "admin-2" },
    });
    expect(
      (await POST(priceRequest({ priceCents: 100 }), context())).status,
    ).toBe(200);
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { priceCents: null },
    });

    await prisma.user.delete({ where: { id: "admin-2" } });

    const review = await prisma.resaleRightsReview.findUniqueOrThrow({
      where: { uploaderUserId: "owner-1" },
    });
    expect(review.reviewedByUserId).toBeNull();
    const response = await POST(priceRequest({ priceCents: 100 }), context());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      blocker: "reviewer_not_admin",
    });
  });
});

describe("authorization", () => {
  it("answers 403 for a signed-out caller, with no write", async () => {
    await setReview("CLEARED");
    authMock.mockResolvedValue(null);

    const response = await POST(priceRequest({ priceCents: 100 }), context());

    expect(response.status).toBe(403);
    expect(await priceOf()).toBeNull();
  });

  it("answers 403 for a signed-in non-admin, with no write", async () => {
    await setReview("CLEARED");
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    const response = await POST(priceRequest({ priceCents: 100 }), context());

    expect(response.status).toBe(403);
    expect(await priceOf()).toBeNull();
  });

  // Same second lock as the decision handler. A route handler gets no
  // framework-level origin check, and this one moves money-adjacent state.
  it("answers 403 for a cross-origin post, with no write", async () => {
    await setReview("CLEARED");

    const response = await POST(
      new Request("http://localhost/api/admin/curation/listing-1/price", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ priceCents: 100 }),
      }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(await priceOf()).toBeNull();
  });

  it("answers 403 for a session carrying no role at all", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    expect(
      (await POST(priceRequest({ priceCents: 100 }), context())).status,
    ).toBe(403);
  });
});

describe("input handling", () => {
  beforeEach(async () => {
    await setReview("CLEARED");
  });

  it("404s an unknown listing", async () => {
    const response = await POST(
      priceRequest({ priceCents: 100 }, "nope"),
      context("nope"),
    );
    expect(response.status).toBe(404);
  });

  // `undefined` here means the field is absent once serialised — a caller
  // who forgot it, which is malformed rather than "clear the price".
  for (const priceCents of [19.99, "1000", -1, 10_000_001, undefined]) {
    it(`rejects priceCents = ${String(priceCents)}`, async () => {
      const response = await POST(priceRequest({ priceCents }), context());
      expect(response.status).toBe(400);
      expect(await priceOf()).toBeNull();
    });
  }

  // Not reachable through JSON.stringify (which writes NaN/Infinity as
  // null), so it goes on the wire by hand: JSON.parse turns 1e400 into
  // Infinity, which is a number and is not a safe integer.
  it("rejects a numeric overflow that parses to Infinity", async () => {
    const request = new Request("http://localhost/api/admin/curation/listing-1/price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"priceCents": 1e400}',
    });
    expect((await POST(request, context())).status).toBe(400);
    expect(await priceOf()).toBeNull();
  });

  it("rejects an unsupported currency", async () => {
    const response = await POST(
      priceRequest({ priceCents: 100, currency: "XBT" }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(await priceOf()).toBeNull();
  });

  it("rejects a non-object body", async () => {
    expect((await POST(priceRequest([1, 2, 3]), context())).status).toBe(400);
  });

  it("rejects a body that is not JSON at all", async () => {
    const request = new Request("http://localhost/api/admin/curation/listing-1/price", {
      method: "POST",
      body: "not json",
    });
    expect((await POST(request, context())).status).toBe(400);
  });

  it("refuses an oversized body rather than buffering it", async () => {
    const request = new Request("http://localhost/api/admin/curation/listing-1/price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceCents: 1, padding: "x".repeat(4096) }),
    });
    expect((await POST(request, context())).status).toBe(413);
    expect(await priceOf()).toBeNull();
  });

  it("ignores triage fields smuggled into the body", async () => {
    // The body can move a price. It must not be able to move the things the
    // gate reads — otherwise the gate gates nothing.
    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { depictsPeople: null },
    });

    const response = await POST(
      priceRequest({ priceCents: 100, depictsPeople: false, mediaId: "x" }),
      context(),
    );

    expect(response.status).toBe(422);
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { id: "listing-1" },
    });
    expect(listing.depictsPeople).toBeNull();
    expect(listing.mediaId).toBe("media-1");

    await prisma.mediaListing.update({
      where: { id: "listing-1" },
      data: { depictsPeople: false },
    });
  });
});

/**
 * The gate has to be callable at the two other moments Part E.3 names —
 * catalogue render and checkout — not just here. Those are ugcportal-74w and
 * ugcportal-p3v's code (their K5 and K3 respectively), but the *shape* is
 * this module's responsibility, and a predicate that only fits the one call
 * site it was written for is a predicate those beads will quietly reinvent.
 *
 * So this exercises both shapes against the real database: the list read a
 * catalogue does, and the single read inside a transaction a checkout does.
 * Both call the gate with MEDIA_GATE_SELECT, which is what makes "the same
 * gate" a fact rather than a claim.
 */
describe("the shapes ugcportal-74w and ugcportal-p3v need", () => {
  beforeEach(async () => {
    await prisma.mediaListing.deleteMany({ where: { id: { not: "listing-1" } } });
    await prisma.media.deleteMany({ where: { id: { not: "media-1" } } });
  });

  /**
   * What a catalogue render would do: ONE query over Media with the shared
   * select, then filter in memory. The re-anchoring is what makes this one
   * query — under ugcportal-0ss the listing's `mediaId` had no relation, so
   * the ownership half needed a second `in` lookup and a merge step every
   * caller had to remember.
   */
  async function catalogueListing() {
    const rows = await prisma.media.findMany({
      where: { listing: { priceCents: { not: null } } },
      select: { id: true, ...MEDIA_GATE_SELECT },
    });
    return rows.filter((row) => isSellable(row));
  }

  it("filters a catalogue listing in a single query", async () => {
    await setReview("CLEARED");
    await prisma.media.create({
      data: {
        id: "media-2",
        userId: "owner-1",
        kind: "IMAGE",
        key: "uploads/owner-1/second.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        originalName: "second.jpg",
      },
    });
    await prisma.mediaListing.create({
      data: {
        id: "listing-2",
        mediaId: "media-2",
        priceCents: 500,
        // Same cleared uploader, but this one was never triaged.
        depictsPeople: null,
        triagedByUserId: "admin-1",
        triagedAt: new Date(),
      },
    });

    // listing-1 has no price yet, listing-2 is not triaged: nothing sells.
    expect(await catalogueListing()).toHaveLength(0);

    await POST(priceRequest({ priceCents: 24900 }), context());
    expect((await catalogueListing()).map((row) => row.id)).toEqual(["media-1"]);
  });

  it("keeps an upload out of the catalogue when its uploader loses clearance", async () => {
    await setReview("CLEARED");
    await POST(priceRequest({ priceCents: 24900 }), context());
    expect((await catalogueListing()).map((row) => row.id)).toEqual(["media-1"]);

    await setReview("REVOKED");

    expect(await catalogueListing()).toHaveLength(0);
  });

  it("reports an upload with no sale record as not_listed_for_sale", async () => {
    // Not reachable at the price endpoint — no listing means no id to post
    // to, which is a 404 — but it is exactly what a catalogue asking about
    // an arbitrary upload gets, and it must fail closed.
    await setReview("CLEARED");
    const bare = await prisma.media.create({
      data: {
        id: "media-3",
        userId: "owner-1",
        kind: "IMAGE",
        key: "uploads/owner-1/bare.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        originalName: "bare.jpg",
      },
      select: MEDIA_GATE_SELECT,
    });

    expect(evaluateSellability(bare)).toEqual({
      sellable: false,
      blocker: "not_listed_for_sale",
    });
  });

  it("re-checks at checkout inside the transaction that takes the money", async () => {
    await setReview("CLEARED");
    await POST(priceRequest({ priceCents: 24900 }), context());

    // A revoke lands after the price was set — the race the price route's
    // comment describes. Checkout is the backstop.
    await setReview("REVOKED");

    const decision = await prisma.$transaction(async (tx) => {
      const upload = await tx.media.findFirstOrThrow({
        where: { listing: { id: "listing-1" } },
        select: MEDIA_GATE_SELECT,
      });
      return evaluateSellability(upload);
    });

    expect(decision).toEqual({
      sellable: false,
      blocker: "status_not_cleared",
    });
    // The stale price is still there, which is exactly why checkout must ask
    // rather than trust it.
    expect(await priceOf()).toBe(24900);
  });
});
