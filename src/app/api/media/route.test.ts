import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_UPLOAD_BYTES } from "@/lib/media";

const authMock = vi.fn();
const s3SendMock = vi.fn();
const mediaCreateMock = vi.fn();
const mediaFindManyMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      create: mediaCreateMock,
      findMany: mediaFindManyMock,
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: s3SendMock }),
  getBucketName: () => "test-bucket",
}));

const { GET, POST } = await import("@/app/api/media/route");

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

beforeEach(() => {
  authMock.mockReset();
  s3SendMock.mockReset();
  mediaCreateMock.mockReset();
  mediaFindManyMock.mockReset();
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
    mediaCreateMock.mockImplementation(async ({ data }) => ({
      id: "media-1",
      createdAt: new Date(),
      ...data,
    }));
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
    });
    expect(body).toMatchObject({ id: "media-1", userId: "user-1" });
  });

  it("stores no preview for a video upload and leaves previewKey null", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockImplementation(async ({ data }) => ({
      id: "media-2",
      createdAt: new Date(),
      ...data,
    }));
    const file = new File([MP4_HEADER], "clip.mp4", { type: "video/mp4" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(201);
    // Original only: watermarked poster frames are ugcportal-pmb's job.
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    expect(mediaCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "VIDEO", previewKey: null }),
    });
  });

  it("fails the whole upload when the watermark can't be generated", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    // Valid PNG signature, undecodable body: sharp throws.
    const file = new File([PNG_HEADER], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));

    expect(response.status).toBe(422);
    // Nothing stored and nothing recorded — an unprotected original must not
    // survive a watermark failure (ugcportal-44q K2).
    expect(s3SendMock).not.toHaveBeenCalled();
    expect(mediaCreateMock).not.toHaveBeenCalled();
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
});

describe("GET /api/media", () => {
  it("returns 401 for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mediaFindManyMock).not.toHaveBeenCalled();
  });

  it("queries only rows that have a preview, and never selects the original key", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    mediaFindManyMock.mockResolvedValue([]);

    await GET();

    const args = mediaFindManyMock.mock.calls[0][0];
    expect(args.where).toMatchObject({
      userId: "user-1",
      previewKey: { not: null },
    });
    expect(args.select).not.toHaveProperty("key");
    expect(args.select.previewKey).toBe(true);
  });

  it("exposes preview keys only — no original key reaches the listing (K2)", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    const imageRow = {
      id: "media-1",
      kind: "IMAGE",
      previewKey: "previews/user-1/abc.webp",
      originalName: "photo.png",
      createdAt: new Date("2026-09-24T10:00:00Z"),
    };
    // A VIDEO row with no preview, returned here even though the where-clause
    // should have excluded it: the handler must not emit a row that has no
    // protected representation, whatever the query hands back.
    const videoRow = {
      id: "media-2",
      kind: "VIDEO",
      previewKey: null,
      originalName: "clip.mp4",
      createdAt: new Date("2026-09-24T11:00:00Z"),
    };
    mediaFindManyMock.mockResolvedValue([videoRow, imageRow]);

    const response = await GET();
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
});
