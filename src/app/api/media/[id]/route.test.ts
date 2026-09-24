import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const s3SendMock = vi.fn();
const mediaFindUniqueMock = vi.fn();
const mediaUpdateManyMock = vi.fn();
const mediaDeleteManyMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      findUnique: mediaFindUniqueMock,
      updateMany: mediaUpdateManyMock,
      deleteMany: mediaDeleteManyMock,
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: s3SendMock }),
  getBucketName: () => "test-bucket",
}));

const { DELETE, PATCH } = await import("@/app/api/media/[id]/route");

const OWNER_ID = "user-a";
const OTHER_ID = "user-b";
const MEDIA_ID = "media-1";

const ownedMedia = {
  id: MEDIA_ID,
  userId: OWNER_ID,
  kind: "IMAGE" as const,
  key: "media/user-a/abc-photo.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  originalName: "photo.png",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function context(id: string = MEDIA_ID) {
  return { params: Promise.resolve({ id }) };
}

function patchRequest(body: unknown) {
  return new Request(`http://localhost/api/media/${MEDIA_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deleteRequest() {
  return new Request(`http://localhost/api/media/${MEDIA_ID}`, {
    method: "DELETE",
  });
}

function expectNoWrites() {
  expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  expect(mediaDeleteManyMock).not.toHaveBeenCalled();
  expect(s3SendMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  authMock.mockReset();
  s3SendMock.mockReset();
  mediaFindUniqueMock.mockReset();
  mediaUpdateManyMock.mockReset();
  mediaDeleteManyMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// K2: no session must never edit or delete anything.
describe("unauthenticated requests", () => {
  it("returns 401 from PATCH and never reads or writes media", async () => {
    authMock.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ originalName: "new" }), context());

    expect(response.status).toBe(401);
    expect(mediaFindUniqueMock).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("returns 401 from DELETE and never reads or writes media", async () => {
    authMock.mockResolvedValue(null);

    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(401);
    expect(mediaFindUniqueMock).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("returns 401 when the session exists but carries no user id", async () => {
    authMock.mockResolvedValue({ user: {} });

    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(401);
    expectNoWrites();
  });
});

// K1: an authenticated user must not touch someone else's media.
describe("authenticated non-owner", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: OTHER_ID } });
    mediaFindUniqueMock.mockResolvedValue(ownedMedia);
  });

  it("returns 403 from PATCH without writing", async () => {
    const response = await PATCH(
      patchRequest({ originalName: "hijacked.png" }),
      context(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expectNoWrites();
  });

  it("returns 403 from DELETE without writing or touching storage", async () => {
    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expectNoWrites();
  });

  it("stays 403 even for an admin, since there is no admin override", async () => {
    authMock.mockResolvedValue({ user: { id: OTHER_ID, role: "ADMIN" } });

    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(403);
    expectNoWrites();
  });
});

describe("missing media", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID } });
    mediaFindUniqueMock.mockResolvedValue(null);
  });

  it("returns 404 from PATCH", async () => {
    const response = await PATCH(
      patchRequest({ originalName: "new.png" }),
      context("does-not-exist"),
    );

    expect(response.status).toBe(404);
    expectNoWrites();
  });

  it("returns 404 from DELETE", async () => {
    const response = await DELETE(deleteRequest(), context("does-not-exist"));

    expect(response.status).toBe(404);
    expectNoWrites();
  });
});

describe("PATCH /api/media/[id] as the owner", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID } });
    mediaFindUniqueMock.mockResolvedValue(ownedMedia);
  });

  it("renames the item and scopes the write by owner", async () => {
    mediaUpdateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(
      patchRequest({ originalName: "  holiday.png  " }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mediaUpdateManyMock).toHaveBeenCalledWith({
      where: { id: MEDIA_ID, userId: OWNER_ID },
      data: { originalName: "holiday.png" },
    });
    expect(body).toMatchObject({ id: MEDIA_ID, originalName: "holiday.png" });
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("ignores unknown fields instead of forwarding them to Prisma", async () => {
    mediaUpdateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(
      patchRequest({
        originalName: "renamed.png",
        userId: OTHER_ID,
        key: "media/user-b/stolen.png",
        id: "other-id",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mediaUpdateManyMock).toHaveBeenCalledWith({
      where: { id: MEDIA_ID, userId: OWNER_ID },
      data: { originalName: "renamed.png" },
    });
  });

  it.each([
    ["an empty name", { originalName: "   " }],
    ["a non-string name", { originalName: 42 }],
    ["a missing name", { note: "nothing editable here" }],
    ["an oversized name", { originalName: "x".repeat(256) }],
    ["a name with control characters", { originalName: "bad\u0000name.png" }],
    ["a non-object body", ["originalName"]],
  ])("returns 400 for %s", async (_label, body) => {
    const response = await PATCH(patchRequest(body), context());

    expect(response.status).toBe(400);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await PATCH(patchRequest("{not json"), context());

    expect(response.status).toBe(400);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the row is deleted between the check and the write", async () => {
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await PATCH(
      patchRequest({ originalName: "renamed.png" }),
      context(),
    );

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/media/[id] as the owner", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID } });
    mediaFindUniqueMock.mockResolvedValue(ownedMedia);
  });

  it("deletes the row, then the stored object, and returns 204", async () => {
    mediaDeleteManyMock.mockResolvedValue({ count: 1 });
    s3SendMock.mockResolvedValue({});

    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mediaDeleteManyMock).toHaveBeenCalledWith({
      where: { id: MEDIA_ID, userId: OWNER_ID },
    });
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    const command = s3SendMock.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "test-bucket",
      Key: ownedMedia.key,
    });
  });

  it("still returns 204 when storage deletion fails, and logs the orphan", async () => {
    mediaDeleteManyMock.mockResolvedValue({ count: 1 });
    s3SendMock.mockRejectedValue(new Error("bucket unreachable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(204);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0][0])).toContain(ownedMedia.key);
  });

  it("returns 404 when the row is deleted between the check and the write", async () => {
    mediaDeleteManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(404);
    expect(s3SendMock).not.toHaveBeenCalled();
  });
});
