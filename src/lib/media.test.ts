import { describe, expect, it } from "vitest";

import { sniffKind, validateUpload } from "@/lib/media";

describe("validateUpload", () => {
  it("accepts a small image", () => {
    const result = validateUpload({ type: "image/png", size: 1024 });
    expect(result).toEqual({ ok: true, kind: "IMAGE" });
  });

  it("accepts a small video", () => {
    const result = validateUpload({ type: "video/mp4", size: 1024 });
    expect(result).toEqual({ ok: true, kind: "VIDEO" });
  });

  it("rejects an unsupported mime type", () => {
    const result = validateUpload({ type: "application/pdf", size: 1024 });
    expect(result).toEqual({ ok: false, status: 415, message: expect.any(String) });
  });

  it("rejects an empty file", () => {
    const result = validateUpload({ type: "image/png", size: 0 });
    expect(result).toEqual({ ok: false, status: 400, message: expect.any(String) });
  });

  it("rejects an oversized image", () => {
    const result = validateUpload({
      type: "image/png",
      size: 10 * 1024 * 1024 + 1,
    });
    expect(result).toEqual({ ok: false, status: 413, message: expect.any(String) });
  });

  it("rejects an oversized video", () => {
    const result = validateUpload({
      type: "video/mp4",
      size: 200 * 1024 * 1024 + 1,
    });
    expect(result).toEqual({ ok: false, status: 413, message: expect.any(String) });
  });
});

describe("sniffKind", () => {
  it("recognizes a PNG signature", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffKind(buf)).toBe("IMAGE");
  });

  it("recognizes a JPEG signature", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffKind(buf)).toBe("IMAGE");
  });

  it("recognizes a WEBP signature", () => {
    const buf = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(sniffKind(buf)).toBe("IMAGE");
  });

  it("recognizes an mp4/quicktime ftyp box", () => {
    const buf = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from("ftyp", "ascii"),
    ]);
    expect(sniffKind(buf)).toBe("VIDEO");
  });

  it("recognizes a WebM/EBML signature", () => {
    const buf = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    expect(sniffKind(buf)).toBe("VIDEO");
  });

  it("returns null for content that matches no known signature", () => {
    const buf = Buffer.from("just some text", "ascii");
    expect(sniffKind(buf)).toBeNull();
  });
});
