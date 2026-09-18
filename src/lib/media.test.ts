import { describe, expect, it } from "vitest";

import { validateUpload } from "@/lib/media";

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
