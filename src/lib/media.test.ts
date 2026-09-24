import { describe, expect, it } from "vitest";

import {
  MAX_ORIGINAL_NAME_LENGTH,
  sanitizeOriginalName,
  sniffKind,
  validateOriginalName,
  validateUpload,
} from "@/lib/media";

const BIDI_OVERRIDE = "\u202E";
const NUL = "\u0000";
const C1_NEL = "\u0085";
const RTL_ISOLATE = "\u2067";

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

// Every nasty name the two paths have to cope with, in one place, so the
// strict and lenient forms are always exercised against the same inputs.
const HOSTILE_NAMES: Array<[string, string]> = [
  ["a bidi override disguising the extension", `invoice${BIDI_OVERRIDE}gnp.exe`],
  ["a NUL byte", `bad${NUL}name.png`],
  ["a C1 control character", `bad${C1_NEL}name.png`],
  ["an RTL isolate", `photo${RTL_ISOLATE}gnp.exe`],
  ["an over-long name", `${"x".repeat(400)}.png`],
  ["nothing but whitespace", "   "],
  ["nothing but stripped characters", `${BIDI_OVERRIDE}${NUL}`],
  ["an empty string", ""],
];

describe("validateOriginalName", () => {
  it("accepts an ordinary filename and trims it", () => {
    expect(validateOriginalName("  holiday.png  ")).toEqual({
      ok: true,
      value: "holiday.png",
    });
  });

  it("accepts emoji, which reorder nothing", () => {
    const result = validateOriginalName("sunset 🌅.png");
    expect(result).toEqual({ ok: true, value: "sunset 🌅.png" });
  });

  it("accepts a name exactly at the limit", () => {
    const name = "y".repeat(MAX_ORIGINAL_NAME_LENGTH);
    expect(validateOriginalName(name)).toEqual({ ok: true, value: name });
  });

  it("counts the limit in code points, not UTF-16 units", () => {
    // Each of these is two UTF-16 units but one character to a reader.
    const name = "🌅".repeat(MAX_ORIGINAL_NAME_LENGTH);
    expect(validateOriginalName(name).ok).toBe(true);
    expect(validateOriginalName(`${name}🌅`).ok).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(validateOriginalName(42)).toEqual({
      ok: false,
      message: expect.any(String),
    });
  });

  it.each(HOSTILE_NAMES)("rejects %s", (_label, name) => {
    expect(validateOriginalName(name).ok).toBe(false);
  });
});

describe("sanitizeOriginalName", () => {
  it("leaves an ordinary filename alone", () => {
    expect(sanitizeOriginalName("holiday.png")).toBe("holiday.png");
  });

  it("strips the bidi override rather than rejecting the upload", () => {
    expect(sanitizeOriginalName(`invoice${BIDI_OVERRIDE}gnp.exe`)).toBe(
      "invoicegnp.exe",
    );
  });

  it("truncates an over-long name to the limit", () => {
    const result = sanitizeOriginalName(`${"x".repeat(400)}.png`);
    expect(Array.from(result)).toHaveLength(MAX_ORIGINAL_NAME_LENGTH);
  });

  it("never splits a surrogate pair when truncating", () => {
    const result = sanitizeOriginalName("🌅".repeat(400));
    expect(Array.from(result)).toHaveLength(MAX_ORIGINAL_NAME_LENGTH);
    // A split pair would leave a lone surrogate, which round-trips to U+FFFD.
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  });

  it("falls back to a placeholder when nothing survives", () => {
    expect(sanitizeOriginalName(`${BIDI_OVERRIDE}${NUL}  `)).toBe("untitled");
    expect(sanitizeOriginalName("")).toBe("untitled");
  });

  // The invariant that makes the strict/lenient split safe: the two paths
  // disagree about how the caller is told, never about what may be stored.
  it.each(HOSTILE_NAMES)(
    "produces a value the strict validator accepts, for %s",
    (_label, name) => {
      const sanitized = sanitizeOriginalName(name);
      expect(validateOriginalName(sanitized)).toEqual({
        ok: true,
        value: sanitized,
      });
    },
  );
});
