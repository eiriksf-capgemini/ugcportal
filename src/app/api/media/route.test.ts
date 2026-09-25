import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_ORIGINAL_NAME_LENGTH, MAX_UPLOAD_BYTES } from "@/lib/media";

const authMock = vi.fn();
const s3SendMock = vi.fn();
const mediaCreateMock = vi.fn();
const mediaFindManyMock = vi.fn();
const mediaFindFirstMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      create: mediaCreateMock,
      findMany: mediaFindManyMock,
      findFirst: mediaFindFirstMock,
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: s3SendMock }),
  getBucketName: () => "test-bucket",
}));

const { GET, POST } = await import("@/app/api/media/route");
const { encodeMediaCursor } = await import("@/lib/media-listing");

// A valid PNG signature with nothing decodable behind it: enough to pass the
// magic-byte sniff in src/lib/media.ts, but sharp cannot turn it into an
// image. Doubles as the fixture for the watermark-failure policy below.
const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// A real, decodable PNG — the happy path now runs the actual watermark
// service, so a header-only stub is no longer a valid upload.
const REAL_PNG = await sharp({
  create: {
    width: 320,
    height: 240,
    channels: 3,
    background: { r: 40, g: 90, b: 110 },
  },
})
  .png()
  .toBuffer();

// ISO base media container: an `ftyp` box at offset 4 is what sniffKind looks
// for. Videos get no preview yet (ugcportal-pmb).
const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypmp42", "ascii"),
]);

/**
 * The shape prisma returns when the handler passes `select:` — i.e. `key` is
 * already absent at the DB layer. The tests assert on the handler's own
 * projection by feeding it exactly what that select would yield.
 */
function selectedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "media-1",
    kind: "IMAGE",
    previewKey: "previews/user-1/abc.webp",
    previewId: "preview-abc",
    mimeType: "image/png",
    sizeBytes: 1234,
    originalName: "photo.png",
    createdAt: new Date("2026-09-24T10:00:00Z"),
    // Owner's own view: unpublished by default, and still listed. See the
    // regression test at the bottom of the GET block (ugcportal-r1d).
    publishedAt: null,
    ...overrides,
  };
}

function buildRequest(file: File | null) {
  const formData = new FormData();
  if (file) {
    formData.set("file", file);
  }
  return new Request("http://localhost/api/media", {
    method: "POST",
    body: formData,
  });
}

const MULTIPART_BOUNDARY = "----ugcportaltestboundary";
const MULTIPART_CHUNK_BYTES = 64 * 1024;

/**
 * A multipart upload delivered as a stream, with the Content-Length header
 * under the test's control — which is the whole point, since that header is
 * exactly what the cap must not depend on.
 *
 * Assembled by hand rather than via `new Request(url, { body: formData })`
 * deliberately: on Node 24 a FormData-backed request body throws
 * ERR_INVALID_STATE out of undici's internal pump when the reader is
 * cancelled early, which crashes the worker rather than failing the test.
 * A plain ReadableStream cancels cleanly. Don't "simplify" this into
 * FormData.
 */
function multipartRequest({
  payload,
  payloadBytes,
  filename = "photo.png",
  contentType = "image/png",
  contentLength,
}: {
  payload?: Uint8Array;
  payloadBytes?: number;
  filename?: string;
  contentType?: string;
  contentLength?: string;
}) {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${MULTIPART_BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${MULTIPART_BOUNDARY}--\r\n`);

  const chunks: Uint8Array[] = [head];
  if (payload) {
    chunks.push(payload);
  } else {
    const total = payloadBytes ?? 0;
    for (let sent = 0; sent < total; sent += MULTIPART_CHUNK_BYTES) {
      chunks.push(
        new Uint8Array(Math.min(MULTIPART_CHUNK_BYTES, total - sent)).fill(0x41),
      );
    }
  }
  chunks.push(tail);

  let index = 0;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunks[index++]);
    },
  });

  const headers = new Headers({
    "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
  });
  if (contentLength !== undefined) {
    headers.set("content-length", contentLength);
  }

  const request = {
    url: "http://localhost/api/media",
    method: "POST",
    headers,
    body,
  } as unknown as Request;

  return { request, pulled: () => pulled };
}

beforeEach(() => {
  authMock.mockReset();
  s3SendMock.mockReset();
  mediaCreateMock.mockReset();
  mediaFindManyMock.mockReset();
  mediaFindFirstMock.mockReset();
});

describe("POST /api/media", () => {
  it("returns 401 for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const file = new File([PNG_HEADER], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(401);
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("returns 413 for a request body exceeding the absolute upload cap without buffering it", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const formDataMock = vi.fn();
    const fakeRequest = {
      headers: new Headers({
        "content-length": String(MAX_UPLOAD_BYTES + 1),
      }),
      formData: formDataMock,
    } as unknown as Request;

    const response = await POST(fakeRequest);

    expect(response.status).toBe(413);
    expect(formDataMock).not.toHaveBeenCalled();
  });

  // The Content-Length gate is only an early-out; these two shapes are the
  // ones that used to walk straight past it into an unbounded formData()
  // (ugcportal-i04). Built by hand rather than from a FormData instance on
  // purpose — see the note on multipartRequest.
  it.each([
    ["no content-length header", undefined],
    ["a malformed content-length header", "4096abc"],
  ])("returns 413 for an oversized upload with %s", async (_label, header) => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const { request, pulled } = multipartRequest({
      payloadBytes: MAX_UPLOAD_BYTES + 512 * 1024,
      contentLength: header,
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Request body too large",
    });
    // Stopped near the cap instead of draining the whole body.
    expect(pulled() * MULTIPART_CHUNK_BYTES).toBeLessThanOrEqual(
      MAX_UPLOAD_BYTES + 2 * MULTIPART_CHUNK_BYTES,
    );
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("still accepts a chunked upload that stays under the cap", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ originalName: data.originalName }),
    );
    const { request } = multipartRequest({ payload: REAL_PNG });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(mediaCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ originalName: "photo.png" }),
      }),
    );
  });

  it("returns 415 for an unsupported file type", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const file = new File(["hello"], "doc.pdf", { type: "application/pdf" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(415);
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("returns 415 when the file content doesn't match the declared type", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const file = new File(["not actually a png"], "photo.png", {
      type: "image/png",
    });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(415);
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("returns 413 for a file exceeding its type's size cap", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    oversized.set(PNG_HEADER);
    const file = new File([oversized], "big.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(413);
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("stores a watermarked preview alongside the original and persists its key", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({
        kind: data.kind,
        previewKey: data.previewKey,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        originalName: data.originalName,
      }),
    );
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(s3SendMock).toHaveBeenCalledTimes(2);

    const [originalPut, previewPut] = s3SendMock.mock.calls.map(
      (call) => call[0] as PutObjectCommand,
    );
    expect(originalPut).toBeInstanceOf(PutObjectCommand);
    expect(previewPut).toBeInstanceOf(PutObjectCommand);
    expect(originalPut.input.Key).toMatch(/^media\/user-1\//);
    expect(previewPut.input.Key).toMatch(/^previews\/user-1\/.+\.webp$/);
    expect(previewPut.input.ContentType).toBe("image/webp");

    // The preview must be a different object with different bytes — not the
    // original copied under a second key (ugcportal-44q K1).
    expect(previewPut.input.Key).not.toBe(originalPut.input.Key);
    expect(Buffer.from(previewPut.input.Body as Uint8Array)).not.toEqual(
      Buffer.from(originalPut.input.Body as Uint8Array),
    );
    await expect(
      sharp(previewPut.input.Body as Uint8Array).metadata(),
    ).resolves.toMatchObject({ format: "webp" });

    expect(mediaCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        kind: "IMAGE",
        mimeType: "image/png",
        sizeBytes: REAL_PNG.length,
        originalName: "photo.png",
        previewKey: previewPut.input.Key,
      }),
      select: expect.objectContaining({ previewKey: true }),
    });
    expect(body).toMatchObject({ id: "media-1", previewKey: previewPut.input.Key });
  });

  // The rename path's denylist is worthless if a file can simply arrive
  // already named this way (ugcportal-bdh). Same case the PATCH tests use.
  it("strips a bidi override from the uploaded filename instead of storing it", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ originalName: data.originalName }),
    );
    const file = new File([REAL_PNG], "invoice\u202Egnp.exe", {
      type: "image/png",
    });

    const response = await POST(buildRequest(file));
    const body = await response.json();

    expect(response.status).toBe(201);
    const stored = mediaCreateMock.mock.calls[0][0].data.originalName;
    expect(stored).toBe("invoicegnp.exe");
    expect(stored).not.toContain("\u202E");
    // And the listing-visible value the client gets back is the repaired one.
    expect(body.originalName).toBe("invoicegnp.exe");
  });

  it("truncates an over-long uploaded filename rather than failing the upload", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ originalName: data.originalName }),
    );
    const file = new File([REAL_PNG], `${"x".repeat(400)}.png`, {
      type: "image/png",
    });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(201);
    const stored = mediaCreateMock.mock.calls[0][0].data.originalName;
    expect(Array.from(stored as string)).toHaveLength(
      MAX_ORIGINAL_NAME_LENGTH,
    );
  });

  it("never returns the original key in the upload response either (K2)", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ previewKey: data.previewKey }),
    );
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));
    const body = await response.json();

    // The POST response is as much an exposure surface as the listing: the
    // select must exclude `key` there too, not just in GET.
    const select = mediaCreateMock.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("key");
    expect(body).not.toHaveProperty("key");
    expect(JSON.stringify(body)).not.toContain("media/");
  });

  it("does not let the original key be reconstructed from the exposed fields (K2)", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ previewKey: data.previewKey }),
    );
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    await POST(buildRequest(file));

    const { key, previewKey } = mediaCreateMock.mock.calls[0][0].data;
    const [originalId] = key.replace("media/user-1/", "").split("-photo.png");
    const previewId = previewKey
      .replace("previews/user-1/", "")
      .replace(".webp", "");

    // Hiding `key` achieves nothing if it can be recomputed from previewKey +
    // originalName, since sanitizeFilename is deterministic. The two ids must
    // be independent.
    expect(previewId).not.toBe(originalId);
    expect(`media/user-1/${previewId}-photo.png`).not.toBe(key);
  });

  it("gives the preview an opaque public id that embeds nothing about the row", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ previewKey: data.previewKey, previewId: data.previewId }),
    );
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    await POST(buildRequest(file));

    const { key, previewKey, previewId } =
      mediaCreateMock.mock.calls[0][0].data;

    // The same argument as the test above, one field further out. `previewKey`
    // is a storage path and embeds `userId`, so it is owner-only; `previewId`
    // is what the anonymous feed publishes instead, and it is only safe there
    // if nothing about the row can be read back out of it or used to rebuild
    // the paths it stands in for (ugcportal-r1d review round 2, finding 1).
    expect(typeof previewId).toBe("string");
    expect(previewId).not.toContain("user-1");
    expect(previewId).not.toContain("previews/");
    expect(previewId).not.toContain("photo");
    // Independent of both storage paths, in either direction.
    expect(previewKey).not.toContain(previewId);
    expect(key).not.toContain(previewId);
    expect(previewId).not.toBe(previewKey);
  });

  it("nulls previewId together with previewKey, never one without the other", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ previewKey: data.previewKey, previewId: data.previewId }),
    );

    for (const [file, hasPreview] of [
      [new File([REAL_PNG], "photo.png", { type: "image/png" }), true],
      [new File([MP4_HEADER], "clip.mp4", { type: "video/mp4" }), false],
    ] as const) {
      mediaCreateMock.mockClear();

      await POST(buildRequest(file));

      const { previewKey, previewId } = mediaCreateMock.mock.calls[0][0].data;
      // "Has a watermarked preview" must stay one fact. Both listings filter
      // on both columns, so a row where they disagree would be excluded
      // everywhere — fail-closed, but a bug worth never writing.
      expect(previewKey === null).toBe(!hasPreview);
      expect(previewId === null).toBe(!hasPreview);
    }
  });

  it("stores no preview for a video upload and leaves previewKey null", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ id: "media-2", kind: data.kind, previewKey: data.previewKey }),
    );
    const file = new File([MP4_HEADER], "clip.mp4", { type: "video/mp4" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(201);
    // Original only: watermarked poster frames are ugcportal-pmb's job.
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    expect(mediaCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "VIDEO", previewKey: null }),
      select: expect.any(Object),
    });
  });

  it("fails the whole upload when the watermark can't be generated", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Valid PNG signature, undecodable body: sharp throws.
    const file = new File([PNG_HEADER], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(422);
    // Nothing stored and nothing recorded — an unprotected original must not
    // survive a watermark failure (ugcportal-44q K2).
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();

    // A 422 alone can't be told apart from "the user uploaded junk"; the
    // underlying sharp failure has to reach the logs so a systemic outage is
    // visible.
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] watermark generation failed",
      expect.objectContaining({ cause: expect.any(Error) }),
    );
    errorSpy.mockRestore();
  });

  it("deletes both the original and the preview if the DB write fails", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockRejectedValue(new Error("db down"));
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    await expect(POST(buildRequest(file))).rejects.toThrow("db down");

    const commands = s3SendMock.mock.calls.map((call) => call[0]);
    const puts = commands.filter((c) => c instanceof PutObjectCommand);
    const deletes = commands.filter((c) => c instanceof DeleteObjectCommand);
    expect(puts).toHaveLength(2);
    expect(deletes).toHaveLength(2);
    expect(deletes.map((c) => (c as DeleteObjectCommand).input.Key).sort()).toEqual(
      puts.map((c) => (c as PutObjectCommand).input.Key).sort(),
    );
  });

  it("deletes the original if uploading the preview fails", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("bucket down"))
      .mockResolvedValue({});
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    await expect(POST(buildRequest(file))).rejects.toThrow("bucket down");

    const commands = s3SendMock.mock.calls.map((call) => call[0]);
    expect(commands.filter((c) => c instanceof DeleteObjectCommand)).toHaveLength(1);
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("logs, rather than discards, a failed cleanup of an orphaned object", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    s3SendMock.mockImplementation(async (command) => {
      if (command instanceof DeleteObjectCommand) throw new Error("delete denied");
      return {};
    });
    mediaCreateMock.mockRejectedValue(new Error("db down"));
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    // The original failure is still what propagates...
    await expect(POST(buildRequest(file))).rejects.toThrow("db down");

    // ...but a compensation that quietly fails every time leaks storage
    // indefinitely with nothing to notice it by.
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] failed to clean up orphaned object",
      expect.objectContaining({ cause: expect.any(Error) }),
    );
    errorSpy.mockRestore();
  });
});

function buildListRequest(query = "") {
  return new Request(`http://localhost/api/media${query}`);
}

describe("GET /api/media — caching", () => {
  it("marks every response private and unstorable, whatever the status", async () => {
    // All three exits, not just the happy one. A header set on 200 alone is
    // one refactor away from not being set at all, and the 401 is the
    // response a signed-out caller is most likely to hit repeatedly.
    authMock.mockResolvedValue(null);
    const unauthorized = await GET(buildListRequest());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe(
      "private, no-store",
    );

    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const badCursor = await GET(buildListRequest("?cursor=not-a-cursor"));
    expect(badCursor.status).toBe(400);
    expect(badCursor.headers.get("cache-control")).toBe("private, no-store");

    mediaFindManyMock.mockResolvedValueOnce([selectedRow({ id: "a" })]);
    const ok = await GET(buildListRequest());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
  });

  it("says `private`, not merely `no-store`, because the body belongs to one account", async () => {
    // This route authenticates with a session cookie, and a shared cache does
    // not treat a cookie-bearing response as unshareable the way it treats an
    // Authorization-bearing one. Without `private`, an intermediary keying on
    // the URL alone could serve one user's library — drafts included — to the
    // next caller. The public feed is uncacheable for a different reason and
    // carries a different header; these two must not be collapsed into one
    // shared constant on the grounds that they look similar.
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValueOnce([selectedRow({ id: "a" })]);

    const header = (await GET(buildListRequest())).headers.get(
      "cache-control",
    );

    expect(header).toContain("private");
    expect(header).toContain("no-store");
  });
});

describe("GET /api/media", () => {
  it("returns 401 for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(buildListRequest());

    expect(response.status).toBe(401);
    expect(mediaFindManyMock).not.toHaveBeenCalled();
  });

  it("queries only rows that have a preview, and never selects the original key", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([]);

    await GET(buildListRequest());

    const args = mediaFindManyMock.mock.calls[0][0];
    expect(args.where).toMatchObject({
      userId: "user-1",
      previewKey: { not: null },
      // Both halves of "has a watermarked preview", so a row where the two
      // disagree is excluded rather than half-served (ugcportal-r1d).
      previewId: { not: null },
    });
    expect(args.select).not.toHaveProperty("key");
    expect(args.select.previewKey).toBe(true);
    expect(args.select.previewId).toBe(true);
    // Unique tiebreak, otherwise cursor paging skips or repeats rows that
    // share a createdAt.
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("exposes preview keys only — no original key reaches the listing (K2)", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    // A VIDEO row with no preview, returned here even though the where-clause
    // should have excluded it: the handler must not emit a row that has no
    // protected representation, whatever the query hands back.
    const videoRow = selectedRow({
      id: "media-2",
      kind: "VIDEO",
      previewKey: null,
      previewId: null,
      mimeType: "video/mp4",
      originalName: "clip.mp4",
    });
    mediaFindManyMock.mockResolvedValue([videoRow, selectedRow()]);

    const response = await GET(buildListRequest());
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: "media-1",
      previewKey: "previews/user-1/abc.webp",
    });

    for (const item of body.items) {
      expect(item).not.toHaveProperty("key");
    }
    // Nothing anywhere in the payload points at the media/ prefix the
    // unwatermarked originals live under.
    expect(serialized).not.toContain("media/");
    expect(serialized).not.toContain("clip.mp4");
  });

  it("requests one row beyond the page size and reports hasMore with a cursor", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([
      selectedRow({ id: "a", previewKey: "previews/user-1/a.webp" }),
      selectedRow({ id: "b", previewKey: "previews/user-1/b.webp" }),
      selectedRow({ id: "c", previewKey: "previews/user-1/c.webp" }),
    ]);

    const response = await GET(buildListRequest("?limit=2"));
    const body = await response.json();

    expect(mediaFindManyMock.mock.calls[0][0].take).toBe(3);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["a", "b"]);
    expect(body.hasMore).toBe(true);
    // The cursor is the position the page ended at — (createdAt, id) — not a
    // row reference (ugcportal-r1d). Decoded here without the library's own
    // decoder, so the encoding is pinned rather than assumed.
    expect(Buffer.from(body.nextCursor, "base64url").toString("utf8")).toBe(
      "2026-09-24T10:00:00.000Z|b",
    );
  });

  it("reports the end of the list", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([selectedRow({ id: "a" })]);

    const body = await (await GET(buildListRequest("?limit=2"))).json();

    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("pages past the first screenful with a keyset predicate, not Prisma's cursor", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const position = {
      id: "media-42",
      createdAt: new Date("2026-09-24T10:00:00Z"),
    };
    mediaFindManyMock.mockResolvedValue([]);

    await GET(buildListRequest(`?cursor=${encodeMediaCursor(position)}`));

    const args = mediaFindManyMock.mock.calls[0][0];
    // Prisma's `cursor` compiles to a subquery that ignores the outer `where`,
    // so the window must be an ordinary predicate inside it instead.
    expect(args).not.toHaveProperty("cursor");
    expect(args).not.toHaveProperty("skip");
    expect(args.where).toMatchObject({
      userId: "user-1",
      previewKey: { not: null },
      OR: [
        { createdAt: { lt: position.createdAt } },
        { createdAt: position.createdAt, id: { lt: "media-42" } },
      ],
    });
  });

  it("needs no anchor lookup, so a since-deleted row's cursor still pages", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([selectedRow({ id: "next" })]);

    // Nothing in the table matches this position any more — the row it came
    // from is gone. Paging must carry on from where it left off rather than
    // 400-ing the caller back to the top of the feed (ugcportal-r1d).
    const cursor = encodeMediaCursor({
      id: "since-deleted",
      createdAt: new Date("2026-09-24T10:00:00Z"),
    });
    const response = await GET(buildListRequest(`?cursor=${cursor}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mediaFindFirstMock).not.toHaveBeenCalled();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["next"]);
  });

  it("keeps the window inside the same where as the scoping", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([]);

    const cursor = encodeMediaCursor({
      id: "media-42",
      createdAt: new Date("2026-09-24T10:00:00Z"),
    });
    await GET(buildListRequest(`?cursor=${cursor}`));

    // A forged cursor can move the window but never widen it: the keyset
    // predicate sits alongside the userId scoping, not in a subquery that
    // could outrun it.
    const where = mediaFindManyMock.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect(where.previewKey).toEqual({ not: null });
    expect(where).toHaveProperty("OR");
  });

  it("rejects a malformed cursor rather than faking an empty page", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });

    for (const bad of [
      // A bare row id, which is what this cursor used to be.
      "media-42",
      "not-base64!!",
      // Well-formed base64url, but not a cursor.
      Buffer.from("no-separator").toString("base64url"),
      // Empty id.
      Buffer.from("2026-09-24T10:00:00.000Z|").toString("base64url"),
      // Timestamps Date() tolerates but that are not full ISO instants, so
      // they would silently mean a different position than the row they came
      // from.
      Buffer.from("2026|media-42").toString("base64url"),
      Buffer.from("not-a-date|media-42").toString("base64url"),
    ]) {
      mediaFindManyMock.mockClear();

      const response = await GET(buildListRequest(`?cursor=${bad}`));

      expect(response.status).toBe(400);
      // An empty page would read as end-of-list and the caller would stop,
      // believing it had seen everything.
      expect(mediaFindManyMock).not.toHaveBeenCalled();
    }
  });

  it("treats an empty ?cursor= as an ordinary first-page request", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([]);

    for (const query of ["", "?cursor=", "?cursor=%20"]) {
      mediaFindManyMock.mockClear();

      const response = await GET(buildListRequest(query));

      expect(response.status).toBe(200);
      expect(mediaFindManyMock.mock.calls[0][0].where).not.toHaveProperty("OR");
    }
  });

  it("steps past an entirely withheld page instead of stranding the caller", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    // The query handed back preview-less rows its own where-clause should have
    // excluded. The advance past them happens server-side, so the caller gets
    // the next real row rather than a cursor naming a row it never received.
    mediaFindManyMock
      .mockResolvedValueOnce([
        selectedRow({
          id: "withheld-1",
          previewId: null,
          createdAt: new Date("2026-09-24T10:00:00Z"),
        }),
        selectedRow({
          id: "withheld-2",
          previewId: null,
          createdAt: new Date("2026-09-23T10:00:00Z"),
        }),
      ])
      .mockResolvedValueOnce([
        selectedRow({
          id: "real",
          previewId: "preview-real",
          createdAt: new Date("2026-09-22T10:00:00Z"),
        }),
      ]);

    const body = await (await GET(buildListRequest("?limit=1"))).json();
    const serialized = JSON.stringify(body);

    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["real"]);
    expect(serialized).not.toContain("withheld-1");
    expect(serialized).not.toContain("withheld-2");
    expect(mediaFindManyMock).toHaveBeenCalledTimes(2);
    // The second window starts strictly after the last row read, and stays
    // inside the same owner scoping.
    const second = mediaFindManyMock.mock.calls[1][0].where;
    expect(second.userId).toBe("user-1");
    expect(second.OR).toEqual([
      { createdAt: { lt: new Date("2026-09-24T10:00:00Z") } },
      {
        createdAt: new Date("2026-09-24T10:00:00Z"),
        id: { lt: "withheld-1" },
      },
    ]);
  });

  it("reports the end of the list rather than naming a withheld row", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    // Every window entirely withheld: the where-clause and the filter
    // disagree. The scan is bounded and gives up rather than handing back a
    // position taken from a row the caller never received.
    mediaFindManyMock.mockResolvedValue([
      selectedRow({
        id: "withheld-1",
        previewId: null,
        createdAt: new Date("2026-09-24T10:00:00Z"),
      }),
      selectedRow({
        id: "withheld-2",
        previewId: null,
        createdAt: new Date("2026-09-23T10:00:00Z"),
      }),
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = await (await GET(buildListRequest("?limit=1"))).json();

    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(mediaFindManyMock).toHaveBeenCalledTimes(5);
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] listing filter withheld every scanned row",
      expect.objectContaining({ scans: 5 }),
    );
    errorSpy.mockRestore();
  });

  it("reports no cursor when there genuinely is no further page", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([
      selectedRow({ id: "a", previewId: null }),
    ]);

    const body = await (await GET(buildListRequest("?limit=1"))).json();

    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("still lists the owner's own unpublished rows (ugcportal-r1d)", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([
      selectedRow({ id: "draft", publishedAt: null }),
      selectedRow({
        id: "live",
        previewKey: "previews/user-1/live.webp",
        publishedAt: new Date("2026-09-24T12:00:00Z"),
      }),
    ]);

    const body = await (await GET(buildListRequest())).json();

    // This is the owner's library, not the public feed. Filtering it by
    // publishedAt would hide the very rows the publish toggle acts on.
    const args = mediaFindManyMock.mock.calls[0][0];
    expect(args.where).not.toHaveProperty("publishedAt");
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([
      "draft",
      "live",
    ]);
    expect(body.items[0].publishedAt).toBeNull();
    expect(body.items[1].publishedAt).toBe("2026-09-24T12:00:00.000Z");
  });

  it("withholds a row with a preview id but no preview key", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    // The half-set pair, from the owner's side. The owner projection does
    // select previewKey, so guarding only previewId would emit this row with
    // `previewKey: null` — while POST /api/media/[id]/publish refuses the very
    // same row with 409. Two surfaces disagreeing about whether one row has a
    // preview is worse than either answer on its own (ugcportal-r1d review
    // round 6, finding 2).
    mediaFindManyMock.mockResolvedValueOnce([
      selectedRow({
        id: "half-set",
        previewId: "preview-half",
        previewKey: null,
        createdAt: new Date("2026-09-24T10:00:00Z"),
      }),
      selectedRow({
        id: "whole",
        previewId: "preview-whole",
        previewKey: "previews/user-1/whole.webp",
        createdAt: new Date("2026-09-23T10:00:00Z"),
      }),
    ]);

    const body = await (await GET(buildListRequest())).json();

    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["whole"]);
    expect(JSON.stringify(body)).not.toContain("half-set");
  });

  it("still emits rows whose preview columns are both set", async () => {
    // The guard must not have become so broad it drops ordinary rows — the
    // anonymous arm has no previewKey at all, and "absent" must not be read
    // as "null".
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValueOnce([
      selectedRow({
        id: "ok",
        previewId: "preview-ok",
        previewKey: "previews/user-1/ok.webp",
      }),
    ]);

    const body = await (await GET(buildListRequest())).json();

    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["ok"]);
  });

  it("never builds nextCursor from a withheld row", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValueOnce([
      selectedRow({
        id: "a",
        previewId: "preview-a",
        createdAt: new Date("2026-09-24T10:00:00Z"),
      }),
      selectedRow({
        id: "b",
        previewId: null,
        createdAt: new Date("2026-09-23T10:00:00Z"),
      }),
      selectedRow({
        id: "c",
        previewId: "preview-c",
        createdAt: new Date("2026-09-22T10:00:00Z"),
      }),
    ]);

    const body = await (await GET(buildListRequest("?limit=2"))).json();

    // The page read is [a, b]; `b` is withheld. The cursor names `a`, the last
    // row actually emitted. Resuming after `a` re-reads `b`, which is dropped
    // again, so nothing is skipped and nothing is served twice.
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["a"]);
    expect(body.hasMore).toBe(true);
    expect(Buffer.from(body.nextCursor, "base64url").toString("utf8")).toBe(
      "2026-09-24T10:00:00.000Z|a",
    );
  });

  it("clamps or defaults a bogus limit instead of trusting it", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([]);

    for (const [query, expectedTake] of [
      ["", 51],
      ["?limit=abc", 51],
      ["?limit=0", 2],
      ["?limit=-5", 2],
      ["?limit=10000", 101],
    ] as const) {
      mediaFindManyMock.mockClear();
      await GET(buildListRequest(query));
      expect(mediaFindManyMock.mock.calls[0][0].take).toBe(expectedTake);
    }
  });
});
