import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ResaleRightsStatus } from "@/generated/prisma/enums";
import {
  CURATED_POST_GATE_SELECT,
  CURRENT_CHECKLIST_VERSION,
  evaluateSellability,
  isSellable,
  loadGateMedia,
} from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-0ss K1, as an integration test: a real SQLite database with the
 * committed migrations applied, the real Prisma client over the real libsql
 * driver, and the real route handler. Only the session is faked.
 *
 * The point of doing it this way rather than with a mocked Prisma is that
 * the claim under test — "nothing is sellable unless a human cleared the
 * account" — is partly a claim about the *schema* (the default is
 * UNREVIEWED; a missing row reads as null) and partly about the driver
 * (the write really is skipped). A mock would agree with whatever the test
 * asserted.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { POST } = await import("@/app/api/admin/curation/[id]/price/route");

const ADMIN_SESSION = { user: { id: "admin-1", email: "a@example.com", role: "ADMIN" } };

function priceRequest(body: unknown, id = "post-1") {
  return new Request(`http://localhost/api/admin/curation/${id}/price`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

function context(id = "post-1") {
  return { params: Promise.resolve({ id }) };
}

async function priceOf(id = "post-1"): Promise<number | null> {
  const post = await prisma.curatedPost.findUnique({
    where: { id },
    select: { priceCents: true },
  });
  return post?.priceCents ?? null;
}

/** Puts the account in `status`, everything else about it being in order. */
async function setReview(
  status: (typeof ResaleRightsStatus)[keyof typeof ResaleRightsStatus],
) {
  const data = {
    status,
    checklistVersion: CURRENT_CHECKLIST_VERSION,
    reviewedByUserId: "admin-1",
    reviewedAt: new Date(),
    validUntil: null,
    // Whose uploads the clearance covers. The gate compares the file's
    // owner against this, so a fixture without it clears nothing.
    clearedOwnerUserId: "owner-1",
  };
  await prisma.resaleRightsReview.upsert({
    where: { instagramAccountId: "acc-1" },
    create: { instagramAccountId: "acc-1", ...data },
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
  await prisma.instagramAccount.create({
    data: {
      id: "acc-1",
      instagramUserId: "ig-1",
      username: "owner",
      accessTokenEncrypted: "sealed",
      tokenExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      scopes: "instagram_business_basic",
      connectedByUserId: "admin-1",
    },
  });
  // A real uploaded original for the listing to point at. The gate checks
  // the row exists and belongs to the party the listing names, so a fixture
  // without one would be testing a different thing.
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
  await prisma.curatedPost.create({
    data: {
      id: "post-1",
      instagramAccountId: "acc-1",
      mediaId: "media-1",
      depictsPeople: false,
      containsMusic: false,
      thirdPartyCreator: false,
      sponsoredContent: false,
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
  await prisma.curatedPost.update({
    where: { id: "post-1" },
    data: { priceCents: null },
  });
  await prisma.resaleRightsReview.deleteMany({});
});

describe("the happy path", () => {
  // Without this the 422 assertions below would all pass with the endpoint
  // hard-wired to refuse everything.
  it("sets a price on a cleared, triaged post", async () => {
    await setReview("CLEARED");

    const response = await POST(priceRequest({ priceCents: 24900 }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "post-1",
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

describe("ugcportal-0ss K1: the gate at the price-setting endpoint", () => {
  const allStatuses = Object.values(ResaleRightsStatus);

  it("covers every status the schema defines", () => {
    expect(allStatuses).toHaveLength(6);
  });

  for (const status of allStatuses) {
    if (status === "CLEARED") continue;

    it(`refuses to price a post whose account is ${status}`, async () => {
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
  // it would strand a price on exactly the accounts that just lost their
  // clearance — and the price route's own concurrency argument depends on a
  // stale price being clearable afterwards.
  for (const status of allStatuses) {
    if (status === "CLEARED") continue;

    it(`still lets an admin un-price a post whose account is ${status}`, async () => {
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

  it("lets an admin un-price a post whose account was never reviewed", async () => {
    await prisma.curatedPost.update({
      where: { id: "post-1" },
      data: { priceCents: 500 },
    });

    expect(
      (await POST(priceRequest({ priceCents: null }), context())).status,
    ).toBe(200);
    expect(await priceOf()).toBeNull();
  });

  it("does not let un-pricing smuggle a currency change past the gate", async () => {
    await prisma.curatedPost.update({
      where: { id: "post-1" },
      data: { currency: "NOK" },
    });

    await POST(
      priceRequest({ priceCents: null, currency: "USD" }),
      context(),
    );

    const post = await prisma.curatedPost.findUniqueOrThrow({
      where: { id: "post-1" },
    });
    expect(post.priceCents).toBeNull();
    expect(post.currency).toBe("NOK");
  });

  /**
   * Per-layer clearance, against the real schema. The unique index on
   * (curatedPostId, layer) is part of the guarantee: one row per layer
   * means the gate never has two answers to the same question.
   */
  it("needs a clearance for each layer that is present, not one for the post", async () => {
    await setReview("CLEARED");
    await prisma.curatedPost.update({
      where: { id: "post-1" },
      data: { containsMusic: true, thirdPartyCreator: true },
    });

    // A licence for the music says nothing about the collaborator.
    await prisma.postRightsClearance.create({
      data: {
        curatedPostId: "post-1",
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

    await prisma.postRightsClearance.create({
      data: {
        curatedPostId: "post-1",
        layer: "THIRD_PARTY_CREATOR",
        reason: "Collaborator signed the assignment.",
        clearedByUserId: "admin-1",
      },
    });

    response = await POST(priceRequest({ priceCents: 100 }), context());
    expect(response.status).toBe(200);

    // And a clearer who has since been demoted stops counting, the same way
    // the account reviewer does.
    await prisma.user.update({
      where: { id: "admin-1" },
      data: { role: "USER" },
    });
    await prisma.curatedPost.update({
      where: { id: "post-1" },
      data: { priceCents: null },
    });

    response = await POST(priceRequest({ priceCents: 100 }), context());
    expect(response.status).toBe(422);
    expect(await priceOf()).toBeNull();

    await prisma.user.update({
      where: { id: "admin-1" },
      data: { role: "ADMIN" },
    });
    await prisma.postRightsClearance.deleteMany({});
    await prisma.curatedPost.update({
      where: { id: "post-1" },
      data: { containsMusic: false, thirdPartyCreator: false },
    });
  });

  it("refuses a cleared account that names no rights holder", async () => {
    await setReview("CLEARED");
    await prisma.resaleRightsReview.update({
      where: { instagramAccountId: "acc-1" },
      data: { clearedOwnerUserId: null },
    });

    const response = await POST(priceRequest({ priceCents: 100 }), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      blocker: "rights_holder_not_recorded",
    });
    expect(await priceOf()).toBeNull();
  });

  it("refuses to price a post whose account has no review row at all", async () => {
    // Nothing created in this test: the row genuinely does not exist.
    expect(
      await prisma.resaleRightsReview.findUnique({
        where: { instagramAccountId: "acc-1" },
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
        instagramAccountId: "acc-1",
        checklistVersion: CURRENT_CHECKLIST_VERSION,
      },
    });
    const created = await prisma.resaleRightsReview.findUniqueOrThrow({
      where: { instagramAccountId: "acc-1" },
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
      where: { instagramAccountId: "acc-1" },
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
      where: { instagramAccountId: "acc-1" },
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
      where: { instagramAccountId: "acc-1" },
      data: { checklistVersion: "2019-01-01.0" },
    });

    const response = await POST(priceRequest({ priceCents: 100 }), context());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      blocker: "checklist_version_retired",
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
      new Request("http://localhost/api/admin/curation/post-1/price", {
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

  it("404s an unknown curated post", async () => {
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
    const request = new Request("http://localhost/api/admin/curation/post-1/price", {
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
    const request = new Request("http://localhost/api/admin/curation/post-1/price", {
      method: "POST",
      body: "not json",
    });
    expect((await POST(request, context())).status).toBe(400);
  });

  it("refuses an oversized body rather than buffering it", async () => {
    const request = new Request("http://localhost/api/admin/curation/post-1/price", {
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
    await prisma.curatedPost.update({
      where: { id: "post-1" },
      data: { depictsPeople: null },
    });

    const response = await POST(
      priceRequest({ priceCents: 100, depictsPeople: false, mediaId: "x" }),
      context(),
    );

    expect(response.status).toBe(422);
    const post = await prisma.curatedPost.findUniqueOrThrow({
      where: { id: "post-1" },
    });
    expect(post.depictsPeople).toBeNull();
    expect(post.mediaId).toBe("media-1");

    await prisma.curatedPost.update({
      where: { id: "post-1" },
      data: { depictsPeople: false },
    });
  });
});

/**
 * The gate has to be callable at the two other moments Part E.3 names —
 * catalogue render and checkout — not just here. Those are ugcportal-74w and
 * ugcportal-p3v's code, but the *shape* is this bead's responsibility, and a
 * predicate that only fits the one call site it was written for is a
 * predicate those beads will quietly reinvent.
 *
 * So this exercises both shapes against the real database: the list read a
 * catalogue does, and the single read inside a transaction a checkout does.
 */
describe("the shapes ugcportal-74w and ugcportal-p3v need", () => {
  beforeEach(async () => {
    await prisma.curatedPost.deleteMany({ where: { id: { not: "post-1" } } });
  });

  /**
   * What a catalogue render would do. Two queries, not one per row: the
   * posts, then their Media rows in a single `in` lookup. The second query
   * is the price of `mediaId` having no foreign key to join on yet — and
   * the reason the ownership check is part of the gate input rather than
   * something each caller is trusted to remember.
   */
  async function catalogueListing() {
    const rows = await prisma.curatedPost.findMany({
      where: { priceCents: { not: null } },
      select: { id: true, priceCents: true, ...CURATED_POST_GATE_SELECT },
    });
    const media = await prisma.media.findMany({
      where: { id: { in: rows.map((row) => row.mediaId) } },
      select: { id: true, userId: true },
    });
    const byId = new Map(media.map((row) => [row.id, { userId: row.userId }]));
    return rows
      .map((row) => ({ ...row, media: byId.get(row.mediaId) ?? null }))
      .filter((row) => isSellable(row));
  }

  it("filters a catalogue listing without a query per row", async () => {
    await setReview("CLEARED");
    await prisma.curatedPost.create({
      data: {
        id: "post-2",
        instagramAccountId: "acc-1",
        mediaId: "media-2",
        // Same cleared account, but this one was never triaged.
        depictsPeople: null,
      },
    });

    // post-1 has no price yet, post-2 is not triaged: nothing is sellable.
    expect(await catalogueListing()).toHaveLength(0);

    await POST(priceRequest({ priceCents: 24900 }), context());
    expect((await catalogueListing()).map((row) => row.id)).toEqual(["post-1"]);
  });

  it("keeps a listing out of the catalogue when its file is someone else's", async () => {
    // The sharp end of finding 3: a priced, triaged post under a cleared
    // account, pointing at an upload that belongs to another user.
    await setReview("CLEARED");
    await POST(priceRequest({ priceCents: 24900 }), context());
    expect((await catalogueListing()).map((row) => row.id)).toEqual(["post-1"]);

    await prisma.media.update({
      where: { id: "media-1" },
      data: { userId: "user-1" },
    });

    expect(await catalogueListing()).toHaveLength(0);

    await prisma.media.update({
      where: { id: "media-1" },
      data: { userId: "owner-1" },
    });
  });

  it("re-checks at checkout inside the transaction that takes the money", async () => {
    await setReview("CLEARED");
    await POST(priceRequest({ priceCents: 24900 }), context());

    // A revoke lands after the price was set — the race the price route's
    // comment describes. Checkout is the backstop.
    await setReview("REVOKED");

    const decision = await prisma.$transaction(async (tx) => {
      const post = await tx.curatedPost.findUniqueOrThrow({
        where: { id: "post-1" },
        select: { id: true, priceCents: true, ...CURATED_POST_GATE_SELECT },
      });
      return evaluateSellability({
        ...post,
        media: await loadGateMedia(tx, post.mediaId),
      });
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
