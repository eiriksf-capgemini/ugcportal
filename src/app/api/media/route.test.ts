import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_UPLOAD_BYTES } from "@/lib/media";

const authMock = vi.fn();
const s3SendMock = vi.fn();
const mediaCreateMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      create: mediaCreateMock,
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: s3SendMock }),
  getBucketName: () => "test-bucket",
}));

const { POST } = await import("@/app/api/media/route");

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
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

  it("uploads a valid file and associates it with the user", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockResolvedValue({
      id: "media-1",
      userId: "user-1",
      kind: "IMAGE",
      key: "media/user-1/some-key-photo.png",
      mimeType: "image/png",
      sizeBytes: PNG_HEADER.length,
      originalName: "photo.png",
      createdAt: new Date(),
    });
    const file = new File([PNG_HEADER], "photo.png", { type: "image/png" });

    const response = await POST(buildRequest(file));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    expect(mediaCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        kind: "IMAGE",
        mimeType: "image/png",
        sizeBytes: PNG_HEADER.length,
        originalName: "photo.png",
      }),
    });
    expect(body).toMatchObject({ id: "media-1", userId: "user-1" });
  });

  it("deletes the uploaded object if the DB write fails", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    s3SendMock.mockResolvedValue({});
    mediaCreateMock.mockRejectedValue(new Error("db down"));
    const file = new File([PNG_HEADER], "photo.png", { type: "image/png" });

    await expect(POST(buildRequest(file))).rejects.toThrow("db down");

    expect(s3SendMock).toHaveBeenCalledTimes(2);
    expect(s3SendMock.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(s3SendMock.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
  });
});
