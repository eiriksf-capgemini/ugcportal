import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ALT_TEXT_LENGTH,
  MAX_CAPTION_LENGTH,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_ORIGINAL_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
} from "@/lib/media";
import {
  INITIAL_GRANT_BYTES,
  MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
  resetUploadMemoryBudget,
  uploadMemoryStats,
  uploadReservationBytes,
} from "@/lib/upload-memory";

const authMock = vi.fn();
const s3SendMock = vi.fn();
const mediaCreateMock = vi.fn();
// Subject tags (ugcportal-jsc). POST upserts a Tag row per name before it
// creates the Media row, so the mocked client needs the model. Recorded as a
// mock rather than stubbed inline so a test can assert WHICH tags were
// resolved, and in what shape.
const tagUpsertMock = vi.fn();
const mediaFindManyMock = vi.fn();
const mediaFindFirstMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

/*
  The transaction client POST hands to `resolveTagRows` and `media.create`.
  Separate from the top-level client on purpose — see the tripwire below.
*/
const txClient = {
  media: { create: mediaCreateMock },
  tag: { upsert: tagUpsertMock },
};

/**
 * Fails the test if the route creates media OUTSIDE the transaction.
 *
 * The orphan-Tag fix is "the tag rows and the media row are written in one
 * transaction". A mock whose `$transaction` simply hands back the same
 * client cannot tell that apart from two adjacent statements — both call
 * the same spies and both pass. Making the non-transactional
 * `prisma.media.create` throw is what turns "the route happens to call
 * $transaction" into "the route's write actually goes through it".
 */
const mediaCreateOutsideTransaction = vi.fn(() => {
  throw new Error(
    "media.create ran outside the transaction; tag rows would orphan on failure",
  );
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      create: mediaCreateOutsideTransaction,
      findMany: mediaFindManyMock,
      findFirst: mediaFindFirstMock,
    },
    tag: {
      upsert: tagUpsertMock,
    },
    $transaction: async (run: (tx: typeof txClient) => unknown) =>
      run(txClient),
  },
}));

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: s3SendMock }),
  getBucketName: () => "test-bucket",
}));

// Wraps, rather than replaces, the real implementation: every existing test
// below still exercises actual watermark generation (sharp, the real
// concurrency gate) unchanged. Only the two ugcportal-u7g tests that need to
// force WatermarkOverloadedError / WatermarkFontUnavailableError override this
// for a single call via mockRejectedValueOnce; every other call falls through
// to the real function.
vi.mock("@/lib/watermark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/watermark")>();
  return {
    ...actual,
    generateWatermarkedPreview: vi.fn(actual.generateWatermarkedPreview),
  };
});

const { GET, POST } = await import("@/app/api/media/route");
const { encodeMediaCursor } = await import("@/lib/media-listing");
// Dynamic, after the vi.mock calls: @/lib/tags imports the Prisma client at
// module scope, so a static import here would evaluate that mock factory
// before its top-level bindings exist.
const { MAX_TAGS_PER_ITEM } = await import("@/lib/tags");
const {
  generateWatermarkedPreview,
  resetWatermarkConcurrencyGate,
  watermarkConcurrencyStats,
  WatermarkOverloadedError,
  WatermarkFontUnavailableError,
} = await import("@/lib/watermark");
// The real, unmocked implementation. Vitest 3.x already restores this as the
// mock's default on mockReset() below, since it's the implementation
// generateWatermarkedPreview was created with (vi.fn(impl) tracks impl as the
// original to fall back to). Imported here anyway so the beforeEach reset can
// say so explicitly via mockImplementation rather than relying on that.
const { generateWatermarkedPreview: realGenerateWatermarkedPreview } =
  await vi.importActual<typeof import("@/lib/watermark")>("@/lib/watermark");

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
    // Alt text and caption (ugcportal-gwr). Null by default — the ordinary
    // state for a fresh upload that supplied neither — and part of the owner
    // projection for the same reason `tags` is: the select really does
    // return them.
    altText: null,
    caption: null,
    createdAt: new Date("2026-09-24T10:00:00Z"),
    // Owner's own view: unpublished by default, and still listed. See the
    // regression test at the bottom of the GET block (ugcportal-r1d).
    publishedAt: null,
    // Subject tags (ugcportal-jsc). Part of the owner projection, so the
    // select really does return them and a fixture without the field would
    // be describing a row the query cannot produce.
    tags: [],
    ...overrides,
  };
}

/**
 * `tags` parts go AFTER the file part, which is the order the browser sends
 * and the order POST /api/media depends on: it finds the file part by peeking
 * at the first PART_HEADER_PEEK_BYTES, and a field ahead of it pushes the
 * declaration out of that window (ugcportal-05b).
 */
function buildRequest(
  file: File | null,
  tags: readonly string[] = [],
  /** Alt text and caption (ugcportal-gwr), appended after the file and the
   * tags for the same ordering reason both already follow it. */
  fields: { altText?: string; caption?: string } = {},
) {
  const formData = new FormData();
  if (file) {
    formData.set("file", file);
  }
  for (const tag of tags) {
    formData.append("tags", tag);
  }
  if (fields.altText !== undefined) formData.set("altText", fields.altText);
  if (fields.caption !== undefined) formData.set("caption", fields.caption);
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
  mediaCreateOutsideTransaction.mockClear();
  tagUpsertMock.mockReset();
  tagUpsertMock.mockImplementation(async ({ create }) => create);
  mediaFindManyMock.mockReset();
  mediaFindFirstMock.mockReset();
  // Drops any leftover one-shot mockRejectedValueOnce from a prior test (the
  // two ugcportal-u7g tests below queue one each) — a future change that made
  // POST return before reaching this call for their fixture would otherwise
  // leak an unconsumed rejection into whichever test runs next, failing there
  // instead of where it was introduced. mockReset() alone already restores
  // the real implementation as vitest's default for a mock created via
  // vi.fn(impl); the explicit mockImplementation just says so out loud.
  vi.mocked(generateWatermarkedPreview)
    .mockReset()
    .mockImplementation(realGenerateWatermarkedPreview);
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

  it("returns 503 with a matching Retry-After when the watermark gate sheds the upload (ugcportal-u7g)", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(generateWatermarkedPreview).mockRejectedValueOnce(
      new WatermarkOverloadedError(
        "Too many previews are being generated right now",
        { reason: "queue-full", retryAfterSeconds: 7 },
      ),
    );
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    // Blame-wise this is a busy-but-healthy server, not a bad upload (K3):
    // 503, never 422/4xx, with a Retry-After a caller can actually act on.
    expect(response.status).toBe(503);
    expect(response.status).not.toBe(422);
    expect(response.headers.get("Retry-After")).toBe("7");

    // Fails closed exactly like every other watermark failure (ugcportal-44q
    // K2): nothing lands in the bucket or the DB for a shed upload either.
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();

    // Routine shedding must not produce the fault-level line. watermark.ts
    // already emits a throttled console.warn for every shed (logShedUpload);
    // this route logging its own line per rejection on top of that would
    // reintroduce the exact unthrottled-volume problem this bead removes.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("still surfaces a 5xx for a broken (fontless) runtime, distinct from both a shed upload and a bad file (ugcportal-u7g)", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(generateWatermarkedPreview).mockRejectedValueOnce(
      new WatermarkFontUnavailableError("No usable font is installed"),
    );
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    // Deliberately not a WatermarkError: this is the genuine-outage case and
    // must still be loud and unrecovered, not turned into a JSON response.
    await expect(POST(buildRequest(file))).rejects.toThrow(
      "No usable font is installed",
    );

    // The same message the fontless-runtime incident this line was written
    // for produces — that is the point: it must stay reserved for a genuine
    // fault and not be shared with the shed-upload path above.
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] watermark service unavailable",
      expect.any(WatermarkFontUnavailableError),
    );
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("maps a real gate rejection to 503, not just a constructed WatermarkOverloadedError (ugcportal-u7g)", async () => {
    // Round-2 finding 3. The two tests above construct WatermarkOverloadedError
    // by hand and mock generateWatermarkedPreview to reject with it — they pin
    // the route's *mapping*, but nothing in this file exercises the other half
    // of the link: watermark.ts's own ConcurrencyLimitError -> WatermarkOverloadedError
    // wrapping (generateWatermarkedPreview, around the getGate().run() call).
    // Deleting that wrapping would silently regress every real shed back to a
    // bare 500 while both suites stayed green, because neither suite would
    // still be driving an actual rejection through it. This test does: real
    // gate, real generateWatermarkedPreview (the beforeEach above restores it
    // as the mock's default — no mockRejectedValueOnce here), forced into
    // shedding by a gate sized to admit only one.
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ id: "media-1", kind: data.kind, previewKey: data.previewKey }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const envBackup = { ...process.env };
    process.env.WATERMARK_MAX_CONCURRENCY = "1";
    process.env.WATERMARK_QUEUE_LIMIT = "0";
    resetWatermarkConcurrencyGate();

    try {
      // Round-3 finding 2: racing both uploads via Promise.all([...]) from the
      // same tick made "which one sheds" depend on which happened to reach
      // acquire() first — nothing enforced that ordering, and it stopped being
      // consistent once other tests warmed the memoised font probe. Instead,
      // start the first upload, then hold here until the gate's own state
      // shows it has actually acquired the single slot (inFlight === 1) before
      // starting the second. That makes the ordering a fact about the gate
      // rather than a hope about scheduling: the second upload cannot even
      // begin until the first demonstrably holds the only slot, and limit 1 /
      // queue 0 means there is nowhere for it to go but shed.
      const firstUpload = POST(
        buildRequest(new File([REAL_PNG], "photo-a.png", { type: "image/png" })),
      );

      const deadline = Date.now() + 2_000;
      while (watermarkConcurrencyStats().inFlight < 1) {
        if (Date.now() > deadline) {
          throw new Error(
            "Timed out waiting for the first upload to acquire the watermark gate's slot",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const secondUpload = POST(
        buildRequest(new File([REAL_PNG], "photo-b.png", { type: "image/png" })),
      );

      const [first, second] = await Promise.all([firstUpload, secondUpload]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(503);

      const retryAfterHeader = second.headers.get("Retry-After");
      expect(retryAfterHeader).not.toBeNull();
      const retryAfter = Number(retryAfterHeader);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);

      // Same fail-closed behaviour a mocked shed gets: nothing extra reaches
      // storage for the rejected upload, and no fault-level line for it.
      expect(mediaCreateMock).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      process.env = envBackup;
      resetWatermarkConcurrencyGate();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
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

/**
 * ugcportal-1b2c: a transport-level S3 failure (the storage endpoint itself
 * unreachable — connection refused/reset, DNS failure, timed out) used to
 * surface as a bare, unhandled 500 with a raw SDK stack trace. These assert
 * the deliberate 503 instead: a stable, non-disclosing body; one structured
 * log line naming the transport code and the SDK's own retry count; and that
 * whatever already landed in the bucket before the failing call is cleaned
 * up rather than left orphaned.
 */
describe("POST /api/media — object storage unreachable (ugcportal-1b2c)", () => {
  /**
   * Stands in for what the AWS SDK actually throws on a transport failure —
   * see @smithy/node-http-handler's NODEJS_TIMEOUT_ERROR_CODES: the original
   * Node error (ECONNRESET, ECONNREFUSED, ...) gets its `name` overwritten to
   * `"TimeoutError"`, but keeps its own `code`, and @smithy/core's retry
   * middleware stamps `$metadata` (attempts, totalRetryDelay) onto it once
   * retries are exhausted — with no `httpStatusCode`, because no response
   * was ever received.
   */
  function transportError({
    name = "TimeoutError",
    code,
    attempts = 3,
  }: { name?: string; code?: string; attempts?: number } = {}): Error & {
    code?: string;
    $metadata: { attempts: number; totalRetryDelay: number };
  } {
    const error = new Error(`read ${code ?? "ECONNRESET"}`) as Error & {
      code?: string;
      $metadata: { attempts: number; totalRetryDelay: number };
    };
    error.name = name;
    if (code !== undefined) error.code = code;
    error.$metadata = { attempts, totalRetryDelay: 101 };
    return error;
  }

  /**
   * An error shape the classifier must also catch even though it matches
   * neither a known transport `code` nor the SDK's `TimeoutError` rename:
   * `$metadata` present, with no `httpStatusCode` because no HTTP response
   * ever came back. Exercises the fallback branch of
   * `isObjectStorageUnreachableError` on its own, independent of the
   * code/name checks above it.
   */
  function metadataOnlyTransportError(): Error & {
    $metadata: { attempts: number };
  } {
    const error = new Error("socket hang up") as Error & {
      $metadata: { attempts: number };
    };
    error.$metadata = { attempts: 2 };
    return error;
  }

  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("answers 503, not a bare 500, when the original PutObject hits a transport error", async () => {
    s3SendMock.mockRejectedValueOnce(
      transportError({ code: "ECONNRESET", attempts: 3 }),
    );
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(503);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      error: expect.stringContaining("temporarily unavailable"),
    });
    // Non-disclosing: neither the bucket name nor anything endpoint-shaped
    // makes it into the client-facing body.
    expect(JSON.stringify(responseBody)).not.toContain("test-bucket");

    // Structured server-side log, naming the transport code and the SDK's
    // own attempt count — not just "something went wrong".
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] object storage unreachable",
      expect.objectContaining({ code: "ECONNRESET", attempts: 3 }),
    );

    // Nothing had landed in the bucket yet, so there is nothing to clean up,
    // and the DB transaction must never have been reached.
    const commands = s3SendMock.mock.calls.map((call) => call[0]);
    expect(commands.filter((c) => c instanceof DeleteObjectCommand)).toHaveLength(0);
    expect(mediaCreateMock).not.toHaveBeenCalled();

    // Mutation check (see PR body): with `s3SendMock.mockRejectedValueOnce`
    // above replaced by a resolved value, this test fails (201, not 503) —
    // confirmed by hand, then restored to the throwing form above.
  });

  it("answers 503 and cleans up the original when the preview PutObject hits a transport error", async () => {
    s3SendMock
      .mockResolvedValueOnce({}) // original PutObject
      .mockRejectedValueOnce(transportError({ name: "TimeoutError", code: "ETIMEDOUT" })) // preview PutObject
      .mockResolvedValueOnce({}); // compensating DeleteObject
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] object storage unreachable",
      expect.objectContaining({ code: "ETIMEDOUT", attempts: 3 }),
    );

    const commands = s3SendMock.mock.calls.map((call) => call[0]);
    const puts = commands.filter((c) => c instanceof PutObjectCommand);
    const deletes = commands.filter((c) => c instanceof DeleteObjectCommand);
    expect(puts).toHaveLength(2);
    // Only the original made it into the bucket — that is what must be
    // cleaned up, not the preview that never landed.
    expect(deletes).toHaveLength(1);
    expect((deletes[0] as DeleteObjectCommand).input.Key).toBe(
      (puts[0] as PutObjectCommand).input.Key,
    );
    expect(mediaCreateMock).not.toHaveBeenCalled();

    // Mutation check: made the compensating delete also reject below (next
    // test) and confirmed the 503 still answers rather than throwing.
  });

  it("still answers 503, without masking the original error, when the compensating cleanup delete itself fails", async () => {
    let putCount = 0;
    s3SendMock.mockImplementation(async (command) => {
      if (command instanceof DeleteObjectCommand) {
        throw transportError({ code: "ECONNREFUSED" });
      }
      if (command instanceof PutObjectCommand) {
        putCount += 1;
        // The first PutObjectCommand (the original) succeeds; the second
        // (the preview) is the one that fails.
        if (putCount === 2) {
          throw transportError({ code: "ECONNREFUSED" });
        }
        return {};
      }
      return {};
    });
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    // The storage-unreachable 503 still answers — a cleanup failure must not
    // turn into an unhandled rejection or mask the original classification.
    expect(response.status).toBe(503);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      error: expect.stringContaining("temporarily unavailable"),
    });

    // Both failures are logged: the storage-unreachable line for the
    // original cause, and the cleanup-failure line for the delete that
    // could not reach the bucket either.
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] object storage unreachable",
      expect.objectContaining({ code: "ECONNREFUSED" }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] failed to clean up orphaned object",
      expect.objectContaining({ cause: expect.any(Error) }),
    );

    // Mutation check: with the delete mock above changed to resolve `{}`
    // instead of throwing, the second expectation (the cleanup-failure log)
    // stops firing — confirmed by hand, then restored to the throwing form
    // above.
  });

  it("classifies a transport error that carries $metadata but no known code or TimeoutError name", async () => {
    s3SendMock.mockRejectedValueOnce(metadataOnlyTransportError());
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] object storage unreachable",
      expect.objectContaining({ attempts: 2 }),
    );

    // Mutation check: giving this same error a real `$metadata.httpStatusCode`
    // (as a genuine service error like AccessDenied would carry) must take it
    // OUT of this branch — asserted directly below.
  });

  it("does not classify a genuine S3 service error (one with an httpStatusCode) as storage-unreachable", async () => {
    const serviceError = new Error("Access Denied") as Error & {
      name: string;
      $metadata: { httpStatusCode: number; attempts: number };
    };
    serviceError.name = "AccessDenied";
    serviceError.$metadata = { httpStatusCode: 403, attempts: 1 };
    s3SendMock.mockRejectedValueOnce(serviceError);
    const file = new File([REAL_PNG], "photo.png", { type: "image/png" });

    // Not the storage-unreachable path: today that means the error simply
    // propagates, as it did before this bead (unchanged handling, per scope).
    await expect(POST(buildRequest(file))).rejects.toThrow("Access Denied");
    expect(errorSpy).not.toHaveBeenCalledWith(
      "[media] object storage unreachable",
      expect.anything(),
    );
  });
});

/**
 * Stands in for a real preview while a request is parked mid-handler.
 *
 * The parked calls here are about *when* generateWatermarkedPreview settles,
 * not about what it produces, and generating a real preview inside a test
 * that is holding a memory reservation open would add seconds of libvips work
 * to the thing being measured.
 */
const STUB_PREVIEW = {
  data: Buffer.from([0x01, 0x02, 0x03, 0x04]),
  contentType: "image/webp",
  width: 8,
  height: 8,
};

/** A promise plus the handle to settle it, for parking a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Holds until `condition` is true, so a test can establish that one request
 * has actually reached a given state before starting the next.
 *
 * Racing both from the same tick would make "which one is refused" depend on
 * scheduling rather than on the bound under test — the round-3 finding on
 * ugcportal-u7g, in the test directly above this block.
 */
async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("POST /api/media — upload memory (ugcportal-05b)", () => {
  /**
   * Sizes the container for a test and rebuilds both bounds from it.
   *
   * The memory budget is the one input the derivation can be told rather than
   * having to read, and WATERMARK_MEMORY_BUDGET_MB is clamped downwards only
   * — so this is a real configuration, derived by the real resolver, not a
   * stubbed settings object. Returns the settings that actually took effect,
   * because a CI container with its own cgroup limit below the requested one
   * would clamp, and the assertions should be against what is in force.
   */
  function configureContainer(megabytes: number) {
    process.env.WATERMARK_MEMORY_BUDGET_MB = String(megabytes);
    resetWatermarkConcurrencyGate();
    resetUploadMemoryBudget();
    return uploadMemoryStats().settings;
  }

  let envBackup: NodeJS.ProcessEnv;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    envBackup = { ...process.env };
    // A container sized below what the preview configuration needs warns on
    // first use, from both bounds. That is the designed behaviour, not noise
    // this block should silence globally — the tests that care assert on it.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) =>
      selectedRow({ kind: data.kind, originalName: data.originalName }),
    );
  });

  afterEach(() => {
    process.env = envBackup;
    resetWatermarkConcurrencyGate();
    resetUploadMemoryBudget();
    vi.restoreAllMocks();
  });

  it("stops reading an oversized image at the image cap, not at the request cap (K2)", async () => {
    // 60 MB declaring itself image/jpeg. Deliberately not the full ~205 MB
    // from the bead's reproduction — the assertion is against the *cap*, not
    // against the payload, and six times the image cap demonstrates it
    // without allocating 205 MB inside the test process.
    const { request, pulled } = multipartRequest({
      payloadBytes: 60 * 1024 * 1024,
      filename: "huge.jpg",
      contentType: "image/jpeg",
    });

    const response = await POST(request);

    expect(response.status).toBe(413);

    // The K2 evidence: peak allocation stays far below the declared size,
    // because the request stream was capped at the cap validateUpload was
    // going to apply anyway rather than at MAX_UPLOAD_BYTES.
    //
    // The slack is four chunks rather than none because a ReadableStream
    // pulls ahead of its reader, and this body passes through three of them
    // (the peek's replay, the cap's TransformStream, and the re-framed
    // request), each entitled to a chunk of read-ahead past the byte that
    // tripped the cap. The bound that matters is the second assertion.
    const pulledBytes = pulled() * MULTIPART_CHUNK_BYTES;
    expect(pulledBytes).toBeLessThanOrEqual(
      MAX_IMAGE_UPLOAD_BYTES +
        MULTIPART_OVERHEAD_ALLOWANCE_BYTES +
        4 * MULTIPART_CHUNK_BYTES,
    );
    expect(pulledBytes).toBeLessThan(MAX_UPLOAD_BYTES / 10);

    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it("refuses a burst without buffering it, where the gate could only shed it after (K1)", async () => {
    // The bead's third and most important path: image uploads the watermark
    // gate sheds. The gate rejecting them keeps its own accounting true and
    // does nothing about the memory already held, because the route had
    // buffered every body twice before it called in.
    //
    // 512 MB floors the upload budget at one maximum-size image, which makes
    // the burst small enough to drive here. The shape is the same at 1 GB
    // with eight.
    const settings = configureContainer(512);
    const parked = deferred<typeof STUB_PREVIEW>();
    vi.mocked(generateWatermarkedPreview).mockImplementationOnce(
      () => parked.promise,
    );

    const admitted = POST(multipartRequest({ payload: REAL_PNG }).request);
    await until(
      () => uploadMemoryStats().heldBytes > 0,
      "the first upload to reserve its body",
    );

    const burst = Array.from({ length: 5 }, () =>
      multipartRequest({ payloadBytes: 4 * 1024 * 1024 }),
    );
    const refused = await Promise.all(burst.map((b) => POST(b.request)));

    for (const [index, response] of refused.entries()) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Too many uploads are being processed right now",
        retryAfterSeconds: settings.retryAfterSeconds,
      });
      expect(response.headers.get("Retry-After")).toBe(
        String(settings.retryAfterSeconds),
      );
      // The whole point, and the difference from shedding at the gate: the
      // part header the peek read, plus at most one chunk of the stream's own
      // read-ahead. The 4 MB behind it was never read, never parsed into a
      // File and never copied into a Buffer — where before this bead all
      // five bodies were fully resident when the shed decisions were taken.
      expect(burst[index].pulled()).toBeLessThanOrEqual(2);
    }

    const stats = uploadMemoryStats();
    expect(stats.shed).toBe(5);
    expect(stats.peakHeldBytes).toBeLessThanOrEqual(
      Math.max(stats.budgetBytes, settings.soloReservationCeilingBytes),
    );

    parked.resolve(STUB_PREVIEW);
    await expect(admitted.then((r) => r.status)).resolves.toBe(201);
    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it("commits one image's worth for a 200 MB declaration, not 400 (K3)", async () => {
    // Video reaches no gate at all — preview generation is image-only until
    // ugcportal-pmb — so before this bead nothing bounded how many were
    // resident. Round-2 finding 1 then established what "bounded" has to
    // mean: a request that *says* it is a 200 MB video commits the fixed
    // initial grant and nothing more until the bytes turn up. Reserving the
    // declared size up front was itself a denial of service — one such
    // connection took the whole budget on a 1 GB container and, since the
    // stall timer is an idle timer, could hold it for five minutes.
    const settings = configureContainer(1024);
    const parked = deferred<unknown>();
    s3SendMock.mockImplementation(() => parked.promise);

    const videoRequest = () =>
      multipartRequest({
        payload: MP4_HEADER,
        filename: "clip.mp4",
        contentType: "video/mp4",
      });

    const first = POST(videoRequest().request);
    await until(
      () => uploadMemoryStats().heldBytes > 0,
      "the first video to reserve its body",
    );

    expect(uploadMemoryStats().heldBytes).toBe(INITIAL_GRANT_BYTES);
    // The ceiling it *could* have grown to is far larger, and is what the
    // 413 check uses — but it is not a commitment.
    expect(
      uploadReservationBytes(200 * 1024 * 1024 + MULTIPART_OVERHEAD_ALLOWANCE_BYTES),
    ).toBeGreaterThan(settings.budgetBytes);

    // So concurrency is now bounded by bytes actually held, not by what was
    // claimed: several small videos coexist where one claimed-large one used
    // to exclude everything.
    const second = POST(videoRequest().request);
    const third = POST(videoRequest().request);
    await until(
      () => uploadMemoryStats().admitted === 3,
      "all three videos to be admitted",
    );

    expect(uploadMemoryStats().heldBytes).toBe(3 * INITIAL_GRANT_BYTES);
    expect(uploadMemoryStats().shed).toBe(0);

    parked.resolve({});
    const responses = await Promise.all([first, second, third]);
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);

    // The K3 assertion: however many arrived, peak concurrent buffering
    // stayed inside the budget.
    expect(uploadMemoryStats().peakHeldBytes).toBeLessThanOrEqual(
      settings.budgetBytes,
    );
    expect(uploadMemoryStats().heldBytes).toBe(0);
    // And none of them reached the watermark gate, exactly as before.
    expect(watermarkConcurrencyStats().admitted).toBe(0);
  });

  it("grows the reservation only as bytes actually arrive", async () => {
    configureContainer(1024);
    const deliveredBytes = 12 * 1024 * 1024;
    const payload = new Uint8Array(deliveredBytes);
    payload.set(MP4_HEADER);

    const response = await POST(
      multipartRequest({
        payload,
        filename: "clip.mp4",
        contentType: "video/mp4",
      }).request,
    );

    expect(response.status).toBe(201);

    // Past the initial grant, because more than half a grant's worth of body
    // really arrived — and proportional to what arrived rather than to the
    // 200 MB the declaration entitled it to.
    const peak = uploadMemoryStats().peakHeldBytes;
    expect(peak).toBeGreaterThan(INITIAL_GRANT_BYTES);
    expect(peak).toBeGreaterThanOrEqual(uploadReservationBytes(deliveredBytes));
    expect(peak).toBeLessThanOrEqual(
      uploadReservationBytes(deliveredBytes + MULTIPART_OVERHEAD_ALLOWANCE_BYTES),
    );
    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it("cuts off a body that outgrows the budget mid-read, with a 503", async () => {
    // Admission is granted on the fixed grant, so a request whose body turns
    // out to need more than the budget can spare is stopped where it is
    // rather than allowed to finish. The bytes are never forwarded to the
    // parser, so what is resident never exceeds what was committed.
    const settings = configureContainer(640);
    const parked = deferred<typeof STUB_PREVIEW>();
    vi.mocked(generateWatermarkedPreview).mockImplementation(
      () => parked.promise,
    );

    const parkedUploads = [0, 1, 2].map(
      () => POST(multipartRequest({ payload: REAL_PNG }).request),
    );
    await until(
      () => uploadMemoryStats().admitted === 3,
      "three uploads to be holding grants",
    );
    expect(uploadMemoryStats().heldBytes).toBe(3 * INITIAL_GRANT_BYTES);

    const declaredBytes = 25 * 1024 * 1024;
    const payload = new Uint8Array(declaredBytes);
    payload.set(MP4_HEADER);
    const response = await POST(
      multipartRequest({
        payload,
        filename: "clip.mp4",
        contentType: "video/mp4",
        // Needed to bring the ceiling under this container's solo limit, so
        // the request is admitted at all rather than refused with a 413.
        contentLength: String(declaredBytes + 1024),
      }).request,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe(
      String(settings.retryAfterSeconds),
    );
    await expect(response.json()).resolves.toEqual({
      error: "Too many uploads are being processed right now",
      retryAfterSeconds: settings.retryAfterSeconds,
    });
    expect(uploadMemoryStats().outgrown).toBe(1);
    expect(uploadMemoryStats().peakHeldBytes).toBeLessThanOrEqual(
      settings.budgetBytes,
    );
    expect(s3SendMock).not.toHaveBeenCalled();

    parked.resolve(STUB_PREVIEW);
    await Promise.all(parkedUploads);
    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it("accepts a small chunked video instead of refusing it for its kind's cap", async () => {
    // Round-4 finding 2. reserve() derived the ceiling from the declared
    // *kind*, so any video without a usable Content-Length asked for ~420 MB
    // and was refused outright on this container — a 2 MB chunked POST got a
    // non-retryable 413 quoting a limit two orders of magnitude above it.
    // `fetch` with a ReadableStream body, OkHttp with an unknown-length body
    // and a re-chunking proxy all produce exactly this shape.
    //
    // The previous test here pinned that behaviour with an 8-byte payload
    // under a comment describing a 200 MB video, so it read as validating
    // something it did not.
    const settings = configureContainer(768);
    expect(settings.maxSingleUploadBytes).toBeLessThan(200 * 1024 * 1024);

    const { request } = multipartRequest({
      payload: MP4_HEADER,
      filename: "clip.mp4",
      contentType: "video/mp4",
      // No content-length: the whole point of the shape.
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(uploadMemoryStats().refusedTooLarge).toBe(0);
    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it("still refuses a size the client itself states as too large, before reading it", async () => {
    // The early 413 is kept where it is certainly right: the client said how
    // much it is about to send, and this container cannot buffer that. No
    // guesswork, and the caller learns before uploading anything.
    const settings = configureContainer(768);
    const declaredBytes = 200 * 1024 * 1024;

    const { request, pulled } = multipartRequest({
      payload: MP4_HEADER,
      filename: "clip.mp4",
      contentType: "video/mp4",
      contentLength: String(declaredBytes),
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: "Upload is larger than this server can buffer",
      maxBytes: settings.maxSingleUploadBytes,
    });
    expect(pulled()).toBeLessThanOrEqual(2);
    expect(uploadMemoryStats().refusedTooLarge).toBe(1);
  });

  it("refuses a body that really does outgrow the container, from the bytes that arrived", async () => {
    // The other half: with no stated length there is nothing to refuse up
    // front, so the 413 comes from delivered bytes. On this container a
    // single upload may hold about 10 MB, so a 12 MB body is cut somewhere
    // past that — and answered 413, not the retryable 503 that a busy
    // process gets, because retrying will not make it fit.
    const settings = configureContainer(512);
    expect(settings.maxSingleUploadBytes).toBe(MAX_IMAGE_UPLOAD_BYTES);

    const payload = new Uint8Array(12 * 1024 * 1024);
    payload.set(MP4_HEADER);
    const { request, pulled } = multipartRequest({
      payload,
      filename: "clip.mp4",
      contentType: "video/mp4",
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(uploadMemoryStats().refusedTooLarge).toBe(1);
    // Cut off near the limit rather than read to the end.
    expect(pulled() * MULTIPART_CHUNK_BYTES).toBeLessThan(12 * 1024 * 1024);
    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it("lets a small honest upload through where a maximum-size one would not fit", async () => {
    // Content-Length narrows the reservation, so the burst capacity the
    // budget buys is set by what people actually upload rather than by the
    // largest thing the route accepts. Without this, a 512 MB container would
    // serialise every upload including tiny ones.
    configureContainer(512);
    const parked = deferred<typeof STUB_PREVIEW>();
    vi.mocked(generateWatermarkedPreview).mockImplementationOnce(
      () => parked.promise,
    );

    const first = multipartRequest({
      payload: REAL_PNG,
      contentLength: String(REAL_PNG.length + 512),
    });
    const admitted = POST(first.request);
    await until(
      () => uploadMemoryStats().heldBytes > 0,
      "the first upload to reserve its body",
    );

    const second = multipartRequest({
      payload: REAL_PNG,
      contentLength: String(REAL_PNG.length + 512),
    });
    const response = await POST(second.request);

    expect(response.status).toBe(201);

    parked.resolve(STUB_PREVIEW);
    await admitted;
    expect(uploadMemoryStats().shed).toBe(0);
  });

  it("gives a lying declaration the cap it asked for and nothing more", async () => {
    // Declaring video/mp4 to buy the 200 MB cap still has to survive
    // sniffKind, which reads the bytes. The declaration can only ever choose
    // between caps the route already offered somebody; it cannot invent one.
    configureContainer(1024);
    const { request } = multipartRequest({
      payload: REAL_PNG,
      filename: "not-a-video.mp4",
      contentType: "video/mp4",
    });

    const response = await POST(request);

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "File content does not match its declared type",
    });
    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it.each([
    [
      "a rejected upload",
      () => multipartRequest({ payload: new Uint8Array([1, 2, 3, 4]) }).request,
      415,
    ],
    ["an accepted upload", () => multipartRequest({ payload: REAL_PNG }).request, 201],
  ])("releases the reservation after %s", async (_label, build, status) => {
    configureContainer(1024);

    const response = await POST(build());

    expect(response.status).toBe(status);
    expect(uploadMemoryStats().heldBytes).toBe(0);
    expect(uploadMemoryStats().admitted).toBe(1);
  });

  it("releases the reservation when the handler throws", async () => {
    // A leaked reservation is worse than no bound at all: the budget would
    // shrink with every failure until the route refused everything.
    configureContainer(1024);
    mediaCreateMock.mockRejectedValue(new Error("db down"));

    await expect(POST(multipartRequest({ payload: REAL_PNG }).request)).rejects.toThrow(
      "db down",
    );

    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  /**
   * A multipart request with ordinary form fields ahead of the file part,
   * which is what an upload form actually submits.
   *
   * Built here rather than by extending multipartRequest because the shape
   * *is* the subject of these two tests: the peek has to find the file part
   * behind the fields, and the cap has to leave room for them.
   */
  function formRequest({
    fields = [] as Array<[string, string]>,
    payload,
    payloadBytes,
    contentType = "image/png",
    contentLength,
  }: {
    fields?: Array<[string, string]>;
    payload?: Uint8Array;
    payloadBytes?: number;
    contentType?: string;
    contentLength?: string;
  }) {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const [name, value] of fields) {
      chunks.push(
        encoder.encode(
          `--${MULTIPART_BOUNDARY}\r\n` +
            `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
            `${value}\r\n`,
        ),
      );
    }
    chunks.push(
      encoder.encode(
        `--${MULTIPART_BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="photo.png"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
    );
    if (payload) {
      chunks.push(payload);
    } else {
      const total = payloadBytes ?? 0;
      for (let sent = 0; sent < total; sent += MULTIPART_CHUNK_BYTES) {
        chunks.push(
          new Uint8Array(Math.min(MULTIPART_CHUNK_BYTES, total - sent)).fill(
            0x41,
          ),
        );
      }
    }
    chunks.push(encoder.encode(`\r\n--${MULTIPART_BOUNDARY}--\r\n`));

    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
    });

    const headers = new Headers({
      "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    });
    if (contentLength !== undefined) headers.set("content-length", contentLength);

    return {
      url: "http://localhost/api/media",
      method: "POST",
      headers,
      body,
    } as unknown as Request;
  }

  it("finds the file part behind other form fields (round-1 finding 1)", async () => {
    // The trigger is an ordinary form: a caption input rendered above the
    // file input, submitted without a Content-Length (a streamed body).
    // Reading only the first part meant no declaration was found, the cap
    // fell back to MAX_UPLOAD_BYTES, and the reservation became ~430 MB —
    // which on this 512 MB container is more than the whole spendable
    // budget, so the upload was refused outright.
    const settings = configureContainer(512);
    expect(settings.soloReservationCeilingBytes).toBeLessThan(
      uploadReservationBytes(MAX_UPLOAD_BYTES),
    );

    const response = await POST(
      formRequest({
        fields: [
          ["caption", "a day at the beach"],
          ["tags", "summer,sea"],
        ],
        payload: REAL_PNG,
      }),
    );

    expect(response.status).toBe(201);
    // Priced as the image it declares itself to be, not as the largest thing
    // the route accepts from anyone.
    expect(uploadMemoryStats().peakHeldBytes).toBe(
      uploadReservationBytes(
        MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
      ),
    );
    expect(uploadMemoryStats().refusedTooLarge).toBe(0);
    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it("does not charge the other form fields against the file's cap (round-1 finding 4)", async () => {
    // The cap applies to the whole request stream while the per-kind cap it
    // is built from describes the file alone, so every other field eats into
    // the file's allowance. A maximum-size image plus a 100 KB caption is a
    // legitimate upload and used to be refused with a 413 at the old 64 KiB
    // allowance.
    configureContainer(1024);

    const response = await POST(
      formRequest({
        // An unrecognised field name, deliberately — not "caption": since
        // ugcportal-gwr, the route reads and length-checks that one
        // (MAX_CAPTION_LENGTH), and a 100 KB value would now be refused by
        // that check with a 400 before ever reaching the stream-budget
        // behaviour this test exists to prove.
        fields: [["unrelated-note", "c".repeat(100 * 1024)]],
        payloadBytes: MAX_IMAGE_UPLOAD_BYTES,
      }),
    );

    // 415, from sniffKind reading the filler bytes — which is the point:
    // the request got all the way past the stream cap and the per-kind size
    // check to the content check, rather than being cut off as too large.
    expect(response.status).toBe(415);
    expect(response.status).not.toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "File content does not match its declared type",
    });
  });

  it("says which limit cut off an upload it could not read a declaration for", async () => {
    // Round-3 finding 3. A chunked client with the file field out of peek
    // range is held to the smallest supported size — which is the right
    // answer, but a bare "Request body too large" is indistinguishable from
    // being over a per-kind cap, so a 50 MB video cut at ~10 MB had no
    // indication why or what to change. The constant's own comment claimed
    // the client was told; nothing told it.
    configureContainer(1024);
    const fields: Array<[string, string]> = [
      ["caption", "c".repeat(9 * 1024)],
    ];

    const response = await POST(
      formRequest({
        fields,
        payloadBytes: 20 * 1024 * 1024,
        contentType: "video/mp4",
      }),
    );

    expect(response.status).toBe(413);
    const payload = (await response.json()) as {
      error: string;
      maxBytes: number;
    };
    expect(payload.error).toContain("Could not find the 'file' field");
    expect(payload.error).toContain("Put that field earlier in the form");
    // Round-4 finding 3: Content-Length cannot widen this limit, so advising
    // it is unactionable — and a browser form with a large leading field,
    // which is the client that hits this, has already sent one.
    expect(payload.error).not.toContain("Content-Length");
    expect(payload.maxBytes).toBe(
      MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
    );

    expect(uploadMemoryStats().heldBytes).toBe(0);
  });

  it("keeps the plain 413 for an upload that simply exceeds its own kind's cap", async () => {
    // The new message must not leak onto the ordinary case, where the limit
    // that applied *is* the declared kind's and naming Content-Length would
    // be misleading advice.
    configureContainer(1024);

    const response = await POST(
      multipartRequest({
        payloadBytes: 30 * 1024 * 1024,
        filename: "huge.jpg",
        contentType: "image/jpeg",
      }).request,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Request body too large",
    });
  });

  it("warns once, naming the shortfall, when the container is too small", async () => {
    configureContainer(512);
    const settings = uploadMemoryStats().settings;

    expect(settings.fitsBudget).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[media] upload body budget="),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("too small for the preview configuration"),
    );
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
    });
    // NOT previewId. That is the handle the anonymous feed hands out; here it
    // would buy nothing and would hide a row with a real preview object but no
    // public handle from the person who uploaded it (ugcportal-r1d round 9).
    expect(args.where).not.toHaveProperty("previewId");
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
          previewKey: null,
          createdAt: new Date("2026-09-24T10:00:00Z"),
        }),
        selectedRow({
          id: "withheld-2",
          previewKey: null,
          createdAt: new Date("2026-09-23T10:00:00Z"),
        }),
      ])
      .mockResolvedValueOnce([
        selectedRow({
          id: "real",
          previewKey: "previews/user-1/real.webp",
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
        previewKey: null,
        createdAt: new Date("2026-09-24T10:00:00Z"),
      }),
      selectedRow({
        id: "withheld-2",
        previewKey: null,
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
      selectedRow({ id: "a", previewKey: null }),
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

  it("still shows the owner a row that has no public handle yet", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    // previewKey set, previewId null: the preview object exists, only the
    // handle the ANONYMOUS feed hands out is missing. This row belongs in its
    // uploader's library — the alternative is their own work vanishing from
    // their own account with no error and no way to get it back
    // (ugcportal-r1d round 9, finding 1).
    //
    // Reachable two ways: a writer bypassing mediaPreviewColumns, which that
    // helper's doc block names ugcportal-ct0's Instagram sync as, or older
    // code writing against an already-migrated database.
    mediaFindManyMock.mockResolvedValueOnce([
      selectedRow({
        id: "no-handle",
        previewKey: "previews/user-1/no-handle.webp",
        previewId: null,
      }),
    ]);

    const body = await (await GET(buildListRequest())).json();

    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["no-handle"]);
    expect(body.items[0].previewId).toBeNull();
    // And the row the owner can still see is the same one POST /publish
    // refuses with 409 — that refusal is correct, because publishing it would
    // not make it appear on the public feed. The two surfaces disagreeing was
    // the symptom; the library hiding it was the harm.
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
        previewKey: null,
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

/**
 * Subject tags at upload time (ugcportal-jsc).
 *
 * The write itself is owner-scoped by construction rather than by a check:
 * `userId` comes from the session and never from the body, so an uploader can
 * only ever tag their own new row. What is worth testing here is the other
 * half — that a bad tag is refused BEFORE the watermark and the two
 * PutObjects, so a refusal leaves nothing in the bucket to compensate for.
 */
describe("POST /api/media — subject tags", () => {
  const RTL_OVERRIDE = String.fromCodePoint(0x202e);

  function imageFile() {
    return new File([REAL_PNG], "photo.png", { type: "image/png" });
  }

  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async () => selectedRow());
  });

  it("connects the tags it was sent, having made sure the rows exist", async () => {
    const response = await POST(buildRequest(imageFile(), ["Food", "Books"]));

    expect(response.status).toBe(201);
    // Every name upserted by slug first...
    expect(tagUpsertMock.mock.calls.map((call) => call[0].where)).toEqual([
      { slug: "food" },
      { slug: "books" },
    ]);
    // ...and the row connected to them, never `connectOrCreate`: one place
    // decides how a Tag comes into existence, and both writers go through it.
    expect(mediaCreateMock.mock.calls[0][0].data.tags).toEqual({
      connect: [{ slug: "food" }, { slug: "books" }],
    });
  });

  it("upserts with an empty update, so an existing tag is not renamed", async () => {
    await POST(buildRequest(imageFile(), ["FOOD"]));

    // `update: {}` is what stops one uploader typing different capitals from
    // renaming the chip under everybody else's photographs. Asserted on the
    // call because the round trip through a real database lives in
    // src/app/api/media/[id]/tags/route.test.ts.
    expect(tagUpsertMock.mock.calls[0][0]).toEqual({
      where: { slug: "food" },
      create: { slug: "food", name: "FOOD" },
      update: {},
    });
  });

  it("writes the tag rows and the media row in ONE transaction", async () => {
    /*
     * The round-3 medium. Before this, `resolveTagRows` ran and then
     * `media.create` ran, and a failure in the second left the first
     * committed — Tag rows for an upload that never existed, permanent
     * because nothing in this product deletes a tag. The compensating
     * cleanup below only removes S3 objects.
     *
     * The assertion is that BOTH writes went through the transaction
     * client. `mediaCreateOutsideTransaction` is wired to throw, so a route
     * that created the media row on the plain client fails here rather than
     * passing quietly — which a `$transaction` mock that handed back the
     * same client could not have told apart.
     *
     * That the transaction actually rolls the tag rows back is a claim
     * about SQLite, and is covered against a real database in
     * src/lib/tags.vocabulary.test.ts.
     */
    const response = await POST(buildRequest(imageFile(), ["Food"]));

    expect(response.status).toBe(201);
    expect(mediaCreateOutsideTransaction).not.toHaveBeenCalled();
    expect(tagUpsertMock).toHaveBeenCalledTimes(1);
    expect(mediaCreateMock).toHaveBeenCalledTimes(1);
  });

  it("uploads with no tags exactly as it always did", async () => {
    const response = await POST(buildRequest(imageFile()));

    expect(response.status).toBe(201);
    expect(tagUpsertMock).not.toHaveBeenCalled();
    expect(mediaCreateMock.mock.calls[0][0].data.tags).toEqual({ connect: [] });
  });

  it("refuses a bad tag BEFORE watermarking or storing anything", async () => {
    /*
     * The position of the check, not just its existence. Run after the
     * PutObjects, the same 400 would leave an original and a watermarked
     * preview in the bucket for a request that created no row to name them —
     * storage that grows with ordinary use and that nothing can ever clean
     * up, because nothing knows the keys.
     */
    const response = await POST(
      buildRequest(imageFile(), [`Food${RTL_OVERRIDE}skoob`]),
    );

    expect(response.status).toBe(400);
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(tagUpsertMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("refuses more tags than an item may carry", async () => {
    const tooMany = Array.from(
      { length: MAX_TAGS_PER_ITEM + 1 },
      (_, index) => `subject-${index}`,
    );

    const overCap = await POST(buildRequest(imageFile(), tooMany));
    expect(overCap.status).toBe(400);
    expect(s3SendMock).not.toHaveBeenCalled();

    // At the cap is accepted, so the refusal is about the boundary rather
    // than about the endpoint disliking tags in general.
    const atCap = await POST(
      buildRequest(imageFile(), tooMany.slice(0, MAX_TAGS_PER_ITEM)),
    );
    expect(atCap.status).toBe(201);
  });

  it("refuses a 'tags' part sent as a file rather than as text", async () => {
    /*
     * `getAll` hands back a File for a file part, and `String(file)` is
     * "[object File]" — a perfectly valid-looking tag name. This is the
     * branch that stops a stringifying implementation from creating it.
     */
    const form = new FormData();
    form.set("file", imageFile());
    form.append("tags", new File(["x"], "tags.txt", { type: "text/plain" }));

    const response = await POST(
      new Request("http://localhost/api/media", { method: "POST", body: form }),
    );

    expect(response.status).toBe(400);
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });
});

/**
 * Alt text and caption at upload time (ugcportal-gwr).
 *
 * NOT required here — see the publish route's own tests for the K1 gate that
 * actually enforces "required to publish". What this route refuses is a
 * value that is present and malformed (too long, or carrying a bidi
 * override), the same "fails the whole upload rather than being silently
 * dropped" treatment the subject-tags block above already covers, and for
 * the same reason.
 */
describe("POST /api/media — alt text and caption", () => {
  const RTL_OVERRIDE = String.fromCodePoint(0x202e);

  function imageFile() {
    return new File([REAL_PNG], "photo.png", { type: "image/png" });
  }

  beforeEach(() => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async () => selectedRow());
  });

  it("stores the alt text and caption it was sent", async () => {
    const response = await POST(
      buildRequest(imageFile(), [], {
        altText: "A fox crossing a snowy field at dawn",
        caption: "Shot on a walk before sunrise.",
      }),
    );

    expect(response.status).toBe(201);
    expect(mediaCreateMock.mock.calls[0][0].data.altText).toBe(
      "A fox crossing a snowy field at dawn",
    );
    expect(mediaCreateMock.mock.calls[0][0].data.caption).toBe(
      "Shot on a walk before sunrise.",
    );
  });

  it("uploads with neither field exactly as it always did, storing null rather than empty strings", async () => {
    const response = await POST(buildRequest(imageFile()));

    expect(response.status).toBe(201);
    expect(mediaCreateMock.mock.calls[0][0].data.altText).toBeNull();
    expect(mediaCreateMock.mock.calls[0][0].data.caption).toBeNull();
  });

  it("accepts alt text at exactly the length limit (125) and rejects one character more (K2 boundary)", async () => {
    const atLimit = "a".repeat(MAX_ALT_TEXT_LENGTH);
    const overLimit = "a".repeat(MAX_ALT_TEXT_LENGTH + 1);

    const ok = await POST(buildRequest(imageFile(), [], { altText: atLimit }));
    expect(ok.status).toBe(201);
    expect(mediaCreateMock.mock.calls[0][0].data.altText).toBe(atLimit);

    mediaCreateMock.mockClear();
    const refused = await POST(
      buildRequest(imageFile(), [], { altText: overLimit }),
    );
    expect(refused.status).toBe(400);
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("accepts alt text one character below the limit too (124)", async () => {
    const belowLimit = "a".repeat(MAX_ALT_TEXT_LENGTH - 1);
    const response = await POST(
      buildRequest(imageFile(), [], { altText: belowLimit }),
    );
    expect(response.status).toBe(201);
    expect(mediaCreateMock.mock.calls[0][0].data.altText).toBe(belowLimit);
  });

  it("refuses a caption over its own, longer, limit", async () => {
    const response = await POST(
      buildRequest(imageFile(), [], {
        caption: "c".repeat(MAX_CAPTION_LENGTH + 1),
      }),
    );
    expect(response.status).toBe(400);
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("refuses alt text carrying a bidi override, before any watermarking or storage", async () => {
    const response = await POST(
      buildRequest(imageFile(), [], {
        altText: `A fox${RTL_OVERRIDE} in a field`,
      }),
    );

    expect(response.status).toBe(400);
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a caption carrying a bidi override the same way", async () => {
    const response = await POST(
      buildRequest(imageFile(), [], {
        caption: `Caught${RTL_OVERRIDE} at dawn`,
      }),
    );

    expect(response.status).toBe(400);
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("treats whitespace-only alt text as not supplied, rather than storing blank text", async () => {
    const response = await POST(
      buildRequest(imageFile(), [], { altText: "   " }),
    );

    expect(response.status).toBe(201);
    expect(mediaCreateMock.mock.calls[0][0].data.altText).toBeNull();
  });

  // K2 (ugcportal-gwr's Norwegian description): alt text equal to the
  // filename must never happen. Review round 2 finding: nothing stopped an
  // uploader from simply typing it.
  it("refuses alt text that is exactly the file's own name", async () => {
    const response = await POST(
      buildRequest(imageFile(), [], { altText: "photo.png" }),
    );

    expect(response.status).toBe(400);
    expect(mediaCreateMock).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.field).toBe("altText");
  });

  it("refuses alt text equal to the SANITIZED filename too, not only the raw one", async () => {
    // sanitizeOriginalName trims surrounding whitespace, so a file picked
    // with extra space in its name still collapses to "photo.png" — the
    // exact string stored as originalName — and alt text matching THAT
    // must be refused just as much as matching the raw name would be.
    const spaced = new File([REAL_PNG], "  photo.png  ", {
      type: "image/png",
    });

    const response = await POST(
      buildRequest(spaced, [], { altText: "photo.png" }),
    );

    expect(response.status).toBe(400);
    expect(mediaCreateMock).not.toHaveBeenCalled();
  });

  it("accepts alt text that merely contains the filename as a substring", async () => {
    // A literal-equality check, not a fuzzy one — K2 is about alt text that
    // simply IS the filename, not text that happens to mention it.
    const response = await POST(
      buildRequest(imageFile(), [], {
        altText: "A photo named photo.png, taken at dawn",
      }),
    );

    expect(response.status).toBe(201);
  });

  it("accepts alt text 'untitled' even when the file's name sanitizes to the same fallback (review round 4, finding 1)", async () => {
    // A name made only of an invisible character (zero-width space, kept
    // non-empty on purpose — a literally empty filename hits an unrelated
    // "Missing 'file' field" failure mode in how this test harness's
    // multipart writer handles a blank filename parameter) sanitizes to
    // sanitizeOriginalName's own FALLBACK_ORIGINAL_NAME, "untitled" — which
    // is NOT really the filename the uploader saw, it is "no name was
    // readable". Someone honestly typing "untitled" as alt text for an
    // abstract photo must not be refused as though they had repeated a
    // filename.
    const nameless = new File([REAL_PNG], "​", { type: "image/png" });

    const response = await POST(
      buildRequest(nameless, [], { altText: "untitled" }),
    );

    expect(response.status).toBe(201);
  });
});
