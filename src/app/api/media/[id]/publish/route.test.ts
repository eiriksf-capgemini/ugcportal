import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaModel } from "@/generated/prisma/models";

const authMock = vi.fn();

// Every write method the Prisma client exposes for Media, not just the one
// the handlers use. K4 below asserts that a publish touches nothing else —
// a publish path that reached for `update`, `upsert` or a raw statement to
// set price or licence state would show up here rather than sliding past a
// test that only inspects the call the handler was expected to make.
const mediaFindUniqueMock = vi.fn();
const mediaFindFirstMock = vi.fn();
const mediaFindManyMock = vi.fn();
const mediaUpdateManyMock = vi.fn();
const mediaUpdateMock = vi.fn();
const mediaCreateMock = vi.fn();
const mediaCreateManyMock = vi.fn();
const mediaUpsertMock = vi.fn();
const mediaDeleteMock = vi.fn();
const mediaDeleteManyMock = vi.fn();
const executeRawMock = vi.fn();
const queryRawMock = vi.fn();
const transactionMock = vi.fn();

const WRITE_MOCKS = [
  mediaUpdateMock,
  mediaCreateMock,
  mediaCreateManyMock,
  mediaUpsertMock,
  mediaDeleteMock,
  mediaDeleteManyMock,
  executeRawMock,
  queryRawMock,
  transactionMock,
];

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      findUnique: mediaFindUniqueMock,
      findFirst: mediaFindFirstMock,
      findMany: mediaFindManyMock,
      updateMany: mediaUpdateManyMock,
      update: mediaUpdateMock,
      create: mediaCreateMock,
      createMany: mediaCreateManyMock,
      upsert: mediaUpsertMock,
      delete: mediaDeleteMock,
      deleteMany: mediaDeleteManyMock,
    },
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
    $transaction: transactionMock,
  },
}));

const { DELETE, POST } = await import("@/app/api/media/[id]/publish/route");

const OWNER_ID = "user-a";
const OTHER_ID = "user-b";
const MEDIA_ID = "media-1";

const PUBLISHED_AT = new Date("2026-03-01T09:00:00.000Z");

const unpublishedMedia: MediaModel = {
  id: MEDIA_ID,
  userId: OWNER_ID,
  kind: "IMAGE",
  key: "media/user-a/abc-photo.png",
  previewKey: "previews/user-a/def-photo.webp",
  mimeType: "image/png",
  sizeBytes: 1024,
  originalName: "photo.png",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  // The default for every row: private until its owner says otherwise.
  publishedAt: null,
};

const publishedMedia: MediaModel = {
  ...unpublishedMedia,
  publishedAt: PUBLISHED_AT,
};

/** Exactly the fields a publish response may carry — no `key`, no `userId`. */
const PUBLIC_FIELDS = [
  "createdAt",
  "id",
  "kind",
  "mimeType",
  "originalName",
  "previewKey",
  "publishedAt",
  "sizeBytes",
];

function context(id: string = MEDIA_ID) {
  return { params: Promise.resolve({ id }) };
}

function publishRequest(method: "POST" | "DELETE") {
  return new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
    method,
  });
}

function signedInAs(userId: string, role: "USER" | "ADMIN" = "USER") {
  authMock.mockResolvedValue({ user: { id: userId, role } });
}

/** Every prisma write the handlers performed, as `data` payloads. */
function writtenPayloads() {
  return mediaUpdateManyMock.mock.calls.map((call) => call[0].data);
}

function expectNoOtherWrites() {
  for (const mock of WRITE_MOCKS) {
    expect(mock).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(null);
  mediaFindUniqueMock.mockResolvedValue(null);
  mediaFindFirstMock.mockResolvedValue(null);
  mediaUpdateManyMock.mockResolvedValue({ count: 1 });
});

describe("ownership gate on publish/unpublish (K2)", () => {
  it("returns 401 from POST for an anonymous caller, and writes nothing", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(401);
    // Not even a read: the gate bails before it looks the row up.
    expect(mediaFindUniqueMock).not.toHaveBeenCalled();
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("returns 401 from DELETE for an anonymous caller, and writes nothing", async () => {
    authMock.mockResolvedValue(null);

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(401);
    expect(mediaFindUniqueMock).not.toHaveBeenCalled();
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("returns 401 when a session exists but carries no user id", async () => {
    authMock.mockResolvedValue({ user: {} });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(401);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 403 when user B publishes user A's media, and writes nothing", async () => {
    signedInAs(OTHER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("returns 403 when user B unpublishes user A's media, and writes nothing", async () => {
    signedInAs(OTHER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(403);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("stays 403 for an admin, since publish state has no admin override", async () => {
    // Admin curation of someone else's visibility is explicitly out of scope
    // for ugcportal-r1d; requireOwnedMedia has no role branch at all.
    signedInAs(OTHER_ID, "ADMIN");
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    expect((await POST(publishRequest("POST"), context())).status).toBe(403);
    expect((await DELETE(publishRequest("DELETE"), context())).status).toBe(403);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a row that does not exist", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context("missing"));

    expect(response.status).toBe(404);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/media/[id]/publish", () => {
  it("sets publishedAt and scopes the write by owner as well as id", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(200);

    const args = mediaUpdateManyMock.mock.calls[0][0];
    // The gate's read and this write are separate statements, so the userId
    // has to be on the write too — otherwise a row re-owned in between would
    // be published by the previous owner's request.
    expect(args.where).toEqual({
      id: MEDIA_ID,
      userId: OWNER_ID,
      publishedAt: null,
    });
    expect(typeof body.publishedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.publishedAt))).toBe(false);
  });

  it("is idempotent and never moves an existing 'public since' timestamp", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);

    const body = await (await POST(publishRequest("POST"), context())).json();

    // No write at all — a second publish must not rewrite when it went public.
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expect(body.publishedAt).toBe(PUBLISHED_AT.toISOString());
  });

  it("reports the winner's timestamp when a concurrent publish got there first", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    // `publishedAt: null` in the predicate means the loser updates 0 rows.
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });
    mediaFindFirstMock.mockResolvedValue({
      ...publishedMedia,
      key: undefined,
    });

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    // A 404 here would report a publish that actually succeeded as a failure.
    expect(response.status).toBe(200);
    expect(body.publishedAt).toBe(PUBLISHED_AT.toISOString());
  });

  it("returns 404 when the row was deleted between the gate and the write", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });
    mediaFindFirstMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(404);
  });

  it("never echoes the original object key back", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    // requireOwnedMedia hands back the whole row, `key` included. Spreading
    // that into the response would leak the paid original (ugcportal-5d6).
    expect(body).not.toHaveProperty("key");
    expect(body).not.toHaveProperty("userId");
    expect(JSON.stringify(body)).not.toContain("media/");
    expect(Object.keys(body).sort()).toEqual(PUBLIC_FIELDS);

    // The re-read path must honour the same projection.
    expect(
      mediaFindFirstMock.mock.calls.every(
        (call) => call[0].select?.key === undefined,
      ),
    ).toBe(true);
  });
});

describe("DELETE /api/media/[id]/publish", () => {
  it("writes publishedAt back to null, scoped by owner", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);

    const response = await DELETE(publishRequest("DELETE"), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mediaUpdateManyMock.mock.calls[0][0].where).toEqual({
      id: MEDIA_ID,
      userId: OWNER_ID,
    });
    expect(body.publishedAt).toBeNull();
    expect(body).not.toHaveProperty("key");
  });

  it("is idempotent on an already-private row", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(200);
    expect((await response.json()).publishedAt).toBeNull();
  });

  it("returns 404 when the row was deleted between the gate and the write", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(404);
  });
});

describe("publishing is visibility only, never sellability (K4)", () => {
  // Publishing decides whether something is publicly VISIBLE. Whether it may
  // be SOLD is decided independently by the per-account resale-rights gate
  // (ugcportal-0ss) and the sale catalogue (ugcportal-74w). Both must hold on
  // their own; neither reads publishedAt.
  //
  // The full criterion — "a published row with no CLEARED ResaleRightsReview
  // is still refused by the sellability predicate" — cannot be written yet:
  // ugcportal-0ss has not been built, so there is no ResaleRightsReview model
  // and no sellability predicate to call. When 0ss lands, add that assertion
  // here. What is checkable today is the other half, and it is the half that
  // would actually break the separation from this side: that no publish code
  // path writes anything except publishedAt.

  it("writes publishedAt and nothing else when publishing", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    await POST(publishRequest("POST"), context());

    const payloads = writtenPayloads();
    expect(payloads).toHaveLength(1);
    for (const data of payloads) {
      // Exact key set, not a subset check: a `forSale`, `priceCents` or
      // `licence` written alongside publishedAt would pass `toMatchObject`.
      expect(Object.keys(data)).toEqual(["publishedAt"]);
      expect(data.publishedAt).toBeInstanceOf(Date);
    }
    expectNoOtherWrites();
  });

  it("writes publishedAt and nothing else when unpublishing", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);

    await DELETE(publishRequest("DELETE"), context());

    const payloads = writtenPayloads();
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0])).toEqual(["publishedAt"]);
    expect(payloads[0].publishedAt).toBeNull();
    expectNoOtherWrites();
  });

  it("leaves every other column of the row untouched", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const body = await (await POST(publishRequest("POST"), context())).json();

    // Everything the response reports about the item other than its
    // visibility is byte-for-byte what it was before the publish.
    expect(body.id).toBe(unpublishedMedia.id);
    expect(body.kind).toBe(unpublishedMedia.kind);
    expect(body.previewKey).toBe(unpublishedMedia.previewKey);
    expect(body.mimeType).toBe(unpublishedMedia.mimeType);
    expect(body.sizeBytes).toBe(unpublishedMedia.sizeBytes);
    expect(body.originalName).toBe(unpublishedMedia.originalName);
    expect(body.createdAt).toBe(unpublishedMedia.createdAt.toISOString());
  });

  it("carries no price, licence or purchasability field in the response", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const body = await (await POST(publishRequest("POST"), context())).json();

    // A client cannot infer "this is now buyable" from a publish response,
    // because the response says nothing about buying at all.
    expect(Object.keys(body).sort()).toEqual(PUBLIC_FIELDS);
    for (const forbidden of [
      "price",
      "priceCents",
      "licence",
      "license",
      "forSale",
      "sellable",
      "purchasable",
      "resaleRights",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});
