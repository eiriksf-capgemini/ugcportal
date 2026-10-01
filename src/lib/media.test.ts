import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import {
  MAX_ALT_TEXT_LENGTH,
  MAX_CAPTION_LENGTH,
  MAX_ORIGINAL_NAME_LENGTH,
  altTextEqualsFilename,
  mediaPreviewColumns,
  sanitizeOriginalName,
  sniffKind,
  validateAltText,
  validateCaption,
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

  // `file.type` is whatever the multipart part declared, so these strings are
  // in its input domain. Looked up naively they resolve off Object.prototype:
  // `!kind` is false for the Object constructor, and the size check that
  // follows compares against `MAX_SIZE_BYTES[<constructor>]` — undefined — so
  // `size > undefined` is false and an upload of any size passed it. Caught
  // one step later by sniffKind, but the check itself was not working.
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "rejects %s as an unsupported type rather than resolving it",
    (type) => {
      expect(validateUpload({ type, size: 500 * 1024 * 1024 })).toEqual({
        ok: false,
        status: 415,
        message: expect.any(String),
      });
    },
  );
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

/**
 * Alt text and caption (ugcportal-gwr). Both run through
 * `validateBoundedText` in src/lib/media-rules.ts; these tests exercise it
 * through the two names every caller actually imports, the same way the
 * tag-name tests in src/lib/tags.test.ts exercise their own shared
 * denylist through `parseTagNames` rather than the private helper directly.
 */
describe("validateAltText", () => {
  it("accepts ordinary text", () => {
    expect(validateAltText("A fox crossing a snowy field at dawn")).toEqual({
      ok: true,
      value: "A fox crossing a snowy field at dawn",
    });
  });

  it("treats absent or blank as 'none supplied', not an error", () => {
    // Requiredness is a separate, server-only rule — the publish gate, not
    // this function. See alt-text.ts in src/app/upload for the stricter,
    // client-side rule this page applies on top of it.
    for (const value of [null, undefined, "", "   "]) {
      expect(validateAltText(value)).toEqual({ ok: true, value: "" });
    }
  });

  it("trims surrounding whitespace", () => {
    expect(validateAltText("  a fox in a field  ")).toEqual({
      ok: true,
      value: "a fox in a field",
    });
  });

  // THE BOUNDARY (ugcportal-gwr's own self-check): 124 accepted, 125
  // accepted, 126 rejected. Strict rejection, not truncation — see
  // MAX_ALT_TEXT_LENGTH's docstring for why.
  it("accepts alt text one character below the limit (124)", () => {
    const value = "a".repeat(MAX_ALT_TEXT_LENGTH - 1);
    expect(validateAltText(value)).toEqual({ ok: true, value });
  });

  it("accepts alt text at exactly the limit (125)", () => {
    const value = "a".repeat(MAX_ALT_TEXT_LENGTH);
    expect(validateAltText(value)).toEqual({ ok: true, value });
  });

  it("rejects alt text one character over the limit (126), rather than truncating it", () => {
    const value = "a".repeat(MAX_ALT_TEXT_LENGTH + 1);
    const result = validateAltText(value);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
  });

  it("counts in code points, so an astral character is one unit", () => {
    // U+1F98A (fox emoji) is a surrogate pair in UTF-16 — two code UNITS,
    // one code POINT. Counting units would reject this one character short
    // of where it should.
    const value = "\u{1F98A}".repeat(MAX_ALT_TEXT_LENGTH);
    expect(validateAltText(value).ok).toBe(true);
  });

  it("rejects a bidi override, the same denylist originalName and tags use", () => {
    const result = validateAltText(`A fox‮ in a field`);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string value rather than coercing it", () => {
    expect(validateAltText(42).ok).toBe(false);
    expect(validateAltText({}).ok).toBe(false);
  });
});

describe("validateCaption", () => {
  it("accepts ordinary text, and absence, the same way validateAltText does", () => {
    expect(validateCaption("Shot on a walk before sunrise.")).toEqual({
      ok: true,
      value: "Shot on a walk before sunrise.",
    });
    expect(validateCaption(undefined)).toEqual({ ok: true, value: "" });
  });

  it("has its own, longer limit", () => {
    expect(MAX_CAPTION_LENGTH).toBeGreaterThan(MAX_ALT_TEXT_LENGTH);
    const atLimit = "c".repeat(MAX_CAPTION_LENGTH);
    expect(validateCaption(atLimit)).toEqual({ ok: true, value: atLimit });
    expect(validateCaption("c".repeat(MAX_CAPTION_LENGTH + 1)).ok).toBe(false);
  });

  it("rejects a bidi override", () => {
    expect(validateCaption(`Caught‮ at dawn`).ok).toBe(false);
  });

  // Review round 1, finding 6: the caption field is a multi-row <textarea>
  // and the shared denylist's control-character range includes \n and \r,
  // so an ordinary two-line caption was refused outright before this.
  it("accepts a line break, unlike every other field that shares this denylist", () => {
    expect(validateCaption("Line one\nLine two")).toEqual({
      ok: true,
      value: "Line one\nLine two",
    });
    // CRLF too — a paste from a Windows editor should not be refused either.
    expect(validateCaption("Line one\r\nLine two").ok).toBe(true);
  });

  it("still rejects every other control character and every bidi override once newlines are set aside", () => {
    expect(validateCaption("Line one\nLine two").ok).toBe(false);
    expect(validateCaption(`Line one\nLine two‮ bidi`).ok).toBe(false);
  });

  it("counts a line break toward the length limit — it is not stripped from the stored value", () => {
    // The newline sits in the MIDDLE, deliberately: `.trim()` removes one at
    // either edge (the same as any other whitespace), which would make this
    // test pass for the wrong reason — proving trimming, not preservation.
    const withNewline = `${"c".repeat(MAX_CAPTION_LENGTH - 1)}\nc`;
    expect(Array.from(withNewline).length).toBe(MAX_CAPTION_LENGTH + 1);
    expect(validateCaption(withNewline).ok).toBe(false);

    const withinLimit = `${"c".repeat(MAX_CAPTION_LENGTH - 2)}\nc`;
    expect(Array.from(withinLimit).length).toBe(MAX_CAPTION_LENGTH);
    expect(validateCaption(withinLimit)).toEqual({
      ok: true,
      value: withinLimit,
    });
  });
});

describe("validateAltText still refuses a line break (unlike validateCaption)", () => {
  it("rejects a newline in alt text — it is a single-line field", () => {
    expect(validateAltText("A fox\nin a field").ok).toBe(false);
  });
});

/**
 * K2's filename-equality rule (review round 3 finding 4), as the one
 * function both `POST /api/media` and the upload form's client-side
 * precheck call — see that function's own docstring for why they cannot
 * share the WHOLE check (the server additionally compares against
 * `sanitizeOriginalName`, which needs a node-only module).
 */
describe("altTextEqualsFilename", () => {
  it("matches the exact filename", () => {
    expect(altTextEqualsFilename("photo.png", ["photo.png"])).toBe(true);
  });

  it("matches against any one of several filenames", () => {
    expect(
      altTextEqualsFilename("clip.mp4", ["photo.png", "clip.mp4"]),
    ).toBe(true);
  });

  it("does not match when nothing in the list equals it", () => {
    expect(altTextEqualsFilename("A fox in a field", ["photo.png"])).toBe(
      false,
    );
  });

  it("does not match an empty alt text against anything", () => {
    expect(altTextEqualsFilename("", ["photo.png"])).toBe(false);
    expect(altTextEqualsFilename("   ", ["photo.png"])).toBe(false);
  });

  it("is not a substring match", () => {
    expect(
      altTextEqualsFilename("A photo named photo.png, taken at dawn", [
        "photo.png",
      ]),
    ).toBe(false);
  });

  it("trims both sides before comparing", () => {
    expect(altTextEqualsFilename("  photo.png  ", ["photo.png"])).toBe(true);
    expect(altTextEqualsFilename("photo.png", ["  photo.png  "])).toBe(true);
  });

  it("matches nothing when the filename list is empty", () => {
    expect(altTextEqualsFilename("photo.png", [])).toBe(false);
  });
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

describe("previewId format agreement between runtime and migration", () => {
  // previewId is minted in two places: randomUUID() in mediaPreviewColumns for
  // new uploads, and a SQL expression in the add_media_preview_id migration
  // for rows that already existed. They must produce the same shape.
  //
  // The backfill originally minted `lower(hex(randomblob(16)))` — 32 hex
  // chars, no dashes — against randomUUID()'s 36 with dashes. Two problems:
  // ugcportal-a2l, the preview delivery route, routes on previewId and would
  // reasonably validate a UUID shape, 404-ing every pre-existing row while new
  // uploads worked; and two distinguishable formats let anyone holding a
  // handful of ids sort them into "before the migration" and "after", which is
  // exactly the inference an opaque id exists to deny.
  //
  // This executes the migration's real expression rather than asserting on its
  // text, so the two cannot drift without failing.
  const UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const MIGRATION = path.join(
    process.cwd(),
    "prisma/migrations/20260924190000_add_media_preview_id/migration.sql",
  );

  /** The SET expression from the backfill, lifted out of the migration. */
  function backfillExpression(): string {
    const sql = readFileSync(MIGRATION, "utf8");
    const match = sql.match(
      /UPDATE "Media"\s*\nSET "previewId" = ([\s\S]*?)\nWHERE/,
    );
    if (!match) {
      throw new Error("backfill UPDATE not found in the migration");
    }
    return match[1];
  }

  it("mints a v4 UUID at runtime", () => {
    for (let i = 0; i < 50; i += 1) {
      const { previewId } = mediaPreviewColumns("previews/user-1/a.webp");
      expect(previewId).toMatch(UUID_V4);
    }
  });

  /**
   * Runs the backfill expression `count` times against an in-memory database.
   *
   * Uses @libsql/client rather than node:sqlite because that is the driver
   * this app actually runs on (see @prisma/adapter-libsql in package.json), so
   * the expression is evaluated by the same engine that will execute the
   * migration — and because CI is on Node 20, where node:sqlite does not
   * exist.
   */
  async function runBackfill(count: number): Promise<string[]> {
    const db = createClient({ url: ":memory:" });
    try {
      const sql = `SELECT ${backfillExpression()} AS id`;
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const result = await db.execute(sql);
        ids.push(String(result.rows[0].id));
      }
      return ids;
    } finally {
      db.close();
    }
  }

  it("mints the same shape in the migration backfill", async () => {
    const [id] = await runBackfill(1);
    expect(id).toMatch(UUID_V4);
  });

  it("agrees on format across many rows of both paths", async () => {
    const backfilled = await runBackfill(200);
    const minted = Array.from(
      { length: 200 },
      () => mediaPreviewColumns("previews/user-1/a.webp").previewId as string,
    );

    for (const id of [...backfilled, ...minted]) {
      expect(id).toMatch(UUID_V4);
    }
    // Same length and same dash positions, so a handful of ids cannot be
    // sorted into "backfilled" and "freshly minted" by inspection.
    expect(new Set(backfilled.map((id) => id.length))).toEqual(new Set([36]));
    expect(new Set(minted.map((id) => id.length))).toEqual(new Set([36]));
    // And the backfill is actually random, not one value repeated — which
    // also matters for the UNIQUE index the migration creates on the column.
    expect(new Set(backfilled).size).toBe(backfilled.length);
  });
});
