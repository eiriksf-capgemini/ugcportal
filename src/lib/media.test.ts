import { describe, expect, it } from "vitest";

import {
  MAX_ORIGINAL_NAME_LENGTH,
  mediaPreviewColumns,
  sanitizeOriginalName,
  sniffKind,
  validateOriginalName,
  validateUpload,
} from "@/lib/media";

const BIDI_OVERRIDE = "\u202E";
const NUL = "\u0000";
const C1_NEL = "\u0085";
const RTL_ISOLATE = "\u2067";
const LONE_HIGH_SURROGATE = "\uD800";
const LONE_LOW_SURROGATE = "\uDC00";
const ZERO_WIDTH_SPACE = "\u200B";
const WORD_JOINER = "\u2060";
const LINE_SEPARATOR = "\u2028";
const HANGUL_FILLER = "\u3164";

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
  ["an unpaired high surrogate", `bad${LONE_HIGH_SURROGATE}name.png`],
  ["an unpaired low surrogate", `bad${LONE_LOW_SURROGATE}name.png`],
  ["a zero-width space mid-name", `bad${ZERO_WIDTH_SPACE}name.png`],
  ["a line separator mid-name", `bad${LINE_SEPARATOR}name.png`],
  ["nothing but a zero-width space", ZERO_WIDTH_SPACE],
  ["nothing but a word joiner", WORD_JOINER],
  ["nothing but a Hangul filler", HANGUL_FILLER],
];

describe("validateOriginalName", () => {
  it("accepts an ordinary filename and trims it", () => {
    expect(validateOriginalName("  holiday.png  ")).toEqual({
      ok: true,
      value: "holiday.png",
    });
  });

  it("rejects an unpaired surrogate with a distinct message", () => {
    // Distinct message from the control/bidi case: this is about the string
    // not being well-formed UTF-16, not about which characters it chose.
    // @libsql/client silently stores U+FFFD instead, and PATCH echoes the
    // submitted name without re-reading, so the 200 response would disagree
    // with what a later GET returns.
    expect(validateOriginalName(`a${LONE_HIGH_SURROGATE}b`)).toEqual({
      ok: false,
      message: "Field 'originalName' must be valid text",
    });
    expect(validateOriginalName(`a${LONE_LOW_SURROGATE}b`).ok).toBe(false);
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

  // Regression: these are not whitespace and have non-zero .length, so before
  // they joined the denylist they passed as valid and rendered as a blank row
  // — the exact outcome the fallback exists to prevent.
  it("falls back for names made only of invisible characters", () => {
    expect(sanitizeOriginalName(ZERO_WIDTH_SPACE)).toBe("untitled");
    expect(sanitizeOriginalName(WORD_JOINER)).toBe("untitled");
    expect(sanitizeOriginalName(HANGUL_FILLER)).toBe("untitled");
  });

  // A valid astral character is itself made of surrogate code units, so a
  // naive [\uD800-\uDFFF] denylist would strip every emoji. Only unpaired
  // units may be dropped.
  it("drops unpaired surrogates but keeps valid astral characters", () => {
    expect(sanitizeOriginalName(`a${LONE_HIGH_SURROGATE}b.png`)).toBe("ab.png");
    expect(sanitizeOriginalName(`a${LONE_LOW_SURROGATE}b.png`)).toBe("ab.png");
    expect(sanitizeOriginalName("sunset 🌅.png")).toBe("sunset 🌅.png");
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

describe("mediaPreviewColumns", () => {
  // previewKey (a storage path embedding the uploader's id, owner-only) and
  // previewId (the opaque handle the public feed exposes) are two columns for
  // one fact. Both listings filter on both, so a row carrying only one is
  // invisible in every feed — including its own owner's library — with no
  // repair path. ugcportal-r1d introduced that coupling; this helper is what
  // keeps a future second writer (ugcportal-ct0's Instagram sync) from
  // half-setting it.

  it("returns both columns set when there is a preview", () => {
    const columns = mediaPreviewColumns("previews/user-1/abc.webp");

    expect(columns.previewKey).toBe("previews/user-1/abc.webp");
    expect(typeof columns.previewId).toBe("string");
    expect(columns.previewId).not.toBeNull();
  });

  it("returns both columns null when there is none", () => {
    // Every VIDEO today; poster frames are ugcportal-pmb.
    expect(mediaPreviewColumns(null)).toEqual({
      previewKey: null,
      previewId: null,
    });
  });

  it("never returns a half-set pair, for any accepted input", () => {
    for (const key of [
      null,
      "previews/user-1/a.webp",
      "previews/user-2/b.webp",
      " previews/user-1/leading-space.webp",
    ]) {
      const { previewKey, previewId } = mediaPreviewColumns(key);
      // The invariant stated directly: the two are null together or set
      // together, never one of each.
      expect(previewKey === null).toBe(previewId === null);
    }
  });

  it("rejects a blank path rather than treating it as a preview", () => {
    // This list previously included "" as *accepted* input, and the helper
    // returned { previewKey: "", previewId: <uuid> }. That pair is the one
    // shape that slips past everything downstream: `"" !== null`, so both
    // listings' `not: null` filters, hasCompletePreview() and the publish 409
    // guard all wave it through, and the row publishes and serves with a
    // preview path that resolves to nothing.
    for (const blank of ["", " ", "\t", "\n  "]) {
      expect(() => mediaPreviewColumns(blank)).toThrow(/non-blank/);
    }
  });

  it("still distinguishes a blank path from an absent one", () => {
    // null is the only encoding of "no preview". Blank is a caller bug, and
    // conflating the two would hide it — and strand any object already
    // written to storage under the key the caller failed to build.
    expect(mediaPreviewColumns(null)).toEqual({
      previewKey: null,
      previewId: null,
    });
    expect(() => mediaPreviewColumns("")).toThrow();
  });

  it("derives previewId from nothing about the row", () => {
    // Every distinctive part of this key is outside the hex alphabet, on
    // purpose. An earlier version used `previews/user-1/abc.webp` and asserted
    // the id did not contain "abc" — but a UUID is hex, so "abc" is a
    // perfectly ordinary substring of one. That assertion failed roughly once
    // in a few hundred runs for a reason that had nothing to do with the code.
    const key = "previews/user-1/zzz-sunset.webp";
    const first = mediaPreviewColumns(key);
    const second = mediaPreviewColumns(key);

    // Same input, different id: it is random, not a function of the key. An
    // opaque handle that can be recomputed from the thing it hides is not
    // opaque (the ugcportal-44q decorrelation argument, one field out).
    expect(first.previewId).not.toBe(second.previewId);
    expect(first.previewId).not.toContain("user-1");
    expect(first.previewId).not.toContain("zzz");
    expect(first.previewId).not.toContain("sunset");
    expect(first.previewId).not.toContain("previews/");
    expect(key).not.toContain(String(first.previewId));
  });

  it("gives every row a distinct previewId", () => {
    // previewId is @unique in the schema, so a collision is not a cosmetic
    // problem — it is a failed insert.
    const ids = new Set(
      Array.from(
        { length: 500 },
        () => mediaPreviewColumns("previews/user-1/a.webp").previewId,
      ),
    );

    expect(ids.size).toBe(500);
  });
});
