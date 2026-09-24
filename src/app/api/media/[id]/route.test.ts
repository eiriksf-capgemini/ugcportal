import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const s3SendMock = vi.fn();
const getS3ClientMock = vi.fn();
const getBucketNameMock = vi.fn();
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

// Indirected through mocks rather than fixed values so a test can make the
// real functions' failure mode — requireEnv() throwing on a missing
// variable — happen at the same point in the handler.
vi.mock("@/lib/s3", () => ({
  getS3Client: () => getS3ClientMock(),
  getBucketName: () => getBucketNameMock(),
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

const BODY_LIMIT_BYTES = 4096;
const CHUNK_BYTES = 1024;
// Chunks the handler may take before giving up: the four that fit under the
// cap, the fifth that trips it, and one more that the stream's internal
// queue pre-pulls to stay one ahead of the reader.
const MAX_EXPECTED_PULLS = BODY_LIMIT_BYTES / CHUNK_BYTES + 2;
// Far more than the cap, so a handler that drained the stream instead of
// bounding it would be obvious in the pull count.
const OVERSIZED_CHUNKS = 64;

/**
 * A PATCH request whose body arrives in 1 KiB chunks and whose
 * Content-Length is whatever the caller says (including nothing at all, as
 * on a chunked request). `pulled()` reports how many chunks the handler
 * actually took, which is how the tests tell a real streaming bound from a
 * check that buffered everything first and only then complained.
 */
function chunkedPatchRequest(chunkCount: number, contentLength?: string) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x20));
    },
  });

  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) {
    headers.set("content-length", contentLength);
  }

  const request = { headers, body: stream } as unknown as Request;
  return { request, pulled: () => pulled };
}

// The gate must read exactly the row the handler then writes; if a refactor
// let those ids drift apart, every other assertion here would still pass.
function expectGateReadRow(id: string = MEDIA_ID) {
  expect(mediaFindUniqueMock).toHaveBeenCalledWith({ where: { id } });
}

function expectNoWrites() {
  expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  expect(mediaDeleteManyMock).not.toHaveBeenCalled();
  expect(s3SendMock).not.toHaveBeenCalled();
}

// Answers from the stored row set rather than unconditionally, so passing
// the wrong id to the gate surfaces as a 404 instead of silently
// authorizing against whatever the mock was told to return.
function seedMedia(...rows: Array<typeof ownedMedia>) {
  mediaFindUniqueMock.mockImplementation(
    async (args: { where: { id: string } }) =>
      rows.find((row) => row.id === args.where.id) ?? null,
  );
}

beforeEach(() => {
  authMock.mockReset();
  s3SendMock.mockReset();
  getS3ClientMock.mockReset();
  getS3ClientMock.mockImplementation(() => ({ send: s3SendMock }));
  getBucketNameMock.mockReset();
  getBucketNameMock.mockImplementation(() => "test-bucket");
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
    seedMedia(ownedMedia);
  });

  it("returns 403 from PATCH without writing", async () => {
    const response = await PATCH(
      patchRequest({ originalName: "hijacked.png" }),
      context(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expectGateReadRow();
    expectNoWrites();
  });

  it("returns 403 from DELETE without writing or touching storage", async () => {
    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expectGateReadRow();
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
    seedMedia(ownedMedia);
  });

  it("returns 404 from PATCH", async () => {
    const response = await PATCH(
      patchRequest({ originalName: "new.png" }),
      context("does-not-exist"),
    );

    expect(response.status).toBe(404);
    expectGateReadRow("does-not-exist");
    expectNoWrites();
  });

  it("returns 404 from DELETE", async () => {
    const response = await DELETE(deleteRequest(), context("does-not-exist"));

    expect(response.status).toBe(404);
    expectGateReadRow("does-not-exist");
    expectNoWrites();
  });
});

describe("PATCH /api/media/[id] as the owner", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: OWNER_ID } });
    seedMedia(ownedMedia);
  });

  it("renames the item and scopes the write by owner", async () => {
    mediaUpdateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(
      patchRequest({ originalName: "  holiday.png  " }),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expectGateReadRow();
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
    ["a name with a C1 control character", { originalName: "bad\u0085name.png" }],
    ["a non-object body", ["originalName"]],
  ])("returns 400 for %s", async (_label, body) => {
    const response = await PATCH(patchRequest(body), context());

    expect(response.status).toBe(400);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  // Renders as "invoice exe.png" wherever originalName is shown, which is
  // the whole point of rejecting it.
  it("returns 400 for a name using a bidi override to disguise its extension", async () => {
    const response = await PATCH(
      patchRequest({ originalName: "invoice\u202Egnp.exe" }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Field 'originalName' must not contain control or text-direction characters",
    });
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const response = await PATCH(patchRequest("{not json"), context());

    expect(response.status).toBe(400);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 413 from the Content-Length early-out without reading the body", async () => {
    let bodyRead = false;
    const fakeRequest = {
      headers: new Headers({
        "content-length": String(BODY_LIMIT_BYTES + 1),
      }),
      get body() {
        bodyRead = true;
        return null;
      },
    } as unknown as Request;

    const response = await PATCH(fakeRequest, context());

    expect(response.status).toBe(413);
    expect(bodyRead).toBe(false);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  // The header is the cheap check, not the enforcement: a chunked request
  // carries no Content-Length at all, so the cap has to hold on the stream.
  it("returns 413 for an oversized body sent with no content-length header", async () => {
    const { request, pulled } = chunkedPatchRequest(OVERSIZED_CHUNKS);

    const response = await PATCH(request, context());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Request body too large",
    });
    // Stopped as soon as the running total passed the cap rather than
    // draining all 64 KiB.
    expect(pulled()).toBeLessThanOrEqual(MAX_EXPECTED_PULLS);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  // Number("4096abc") is NaN, and NaN > limit is false, so a malformed
  // header slips straight past the early-out.
  it("returns 413 for an oversized body sent with a malformed content-length", async () => {
    const { request, pulled } = chunkedPatchRequest(OVERSIZED_CHUNKS, "4096abc");

    const response = await PATCH(request, context());

    expect(response.status).toBe(413);
    expect(pulled()).toBeLessThanOrEqual(MAX_EXPECTED_PULLS);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("accepts a body streamed in chunks when it stays under the cap", async () => {
    mediaUpdateManyMock.mockResolvedValue({ count: 1 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const payload = new TextEncoder().encode(
          JSON.stringify({ originalName: "streamed.png" }),
        );
        controller.enqueue(payload.slice(0, 5));
        controller.enqueue(payload.slice(5));
        controller.close();
      },
    });
    const request = {
      headers: new Headers({ "content-type": "application/json" }),
      body: stream,
    } as unknown as Request;

    const response = await PATCH(request, context());

    expect(response.status).toBe(200);
    expect(mediaUpdateManyMock).toHaveBeenCalledWith({
      where: { id: MEDIA_ID, userId: OWNER_ID },
      data: { originalName: "streamed.png" },
    });
  });

  it("returns 400 when the request carries no body at all", async () => {
    const request = {
      headers: new Headers(),
      body: null,
    } as unknown as Request;

    const response = await PATCH(request, context());

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
    seedMedia(ownedMedia);
  });

  it("deletes the row, then the stored object, and returns 204", async () => {
    mediaDeleteManyMock.mockResolvedValue({ count: 1 });
    s3SendMock.mockResolvedValue({});

    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expectGateReadRow();
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

  // The row is already gone by this point, so a throw from the storage
  // helpers themselves — requireEnv() on a missing S3_BUCKET_NAME — must
  // not turn a completed delete into a 500 and swallow the orphan log.
  it("still returns 204 when the storage config throws, and logs the orphan", async () => {
    mediaDeleteManyMock.mockResolvedValue({ count: 1 });
    getBucketNameMock.mockImplementation(() => {
      throw new Error("Missing required environment variable: S3_BUCKET_NAME");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(deleteRequest(), context());

    expect(response.status).toBe(204);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0][0])).toContain(ownedMedia.key);
  });

  it("still returns 204 when the storage client cannot be constructed", async () => {
    mediaDeleteManyMock.mockResolvedValue({ count: 1 });
    getS3ClientMock.mockImplementation(() => {
      throw new Error("Missing required environment variable: S3_ENDPOINT");
    });
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
