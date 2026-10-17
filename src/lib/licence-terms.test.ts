import { describe, expect, it } from "vitest";

import {
  MAX_LICENCE_TERMS_LENGTH,
  checkLicenceTerms,
  mentionsInstagramHost,
} from "@/lib/licence-terms";

/**
 * ugcportal-74w.1: the text rules a licence grant is held to, as a pure
 * function. The write that applies them is asserted against a real database
 * in src/lib/curation-price-write.test.ts; this file pins the rule itself,
 * every refusal beside the nearest input that passes.
 */

describe("blank is no grant (K2)", () => {
  it("reads empty and whitespace-only as null, and keeps real text", () => {
    for (const blank of ["", "   ", "\n\t \r\n"]) {
      expect(checkLicenceTerms(blank), JSON.stringify(blank)).toEqual({ ok: true, value: null });
    }
    expect(checkLicenceTerms("  Web use only.  ")).toEqual({ ok: true, value: "Web use only." });
  });

  it("reads a grant of nothing but invisible code points as null, on the skeleton the Instagram check reads", () => {
    // `trim()` keeps every one of these; stored as text, each would render
    // the grant heading over an empty block. Bidi controls alone are blank
    // too: blankness is decided before the bidi refusal.
    for (const blank of [
      "\u200B",
      "\u200B\u200C\u200D\u2060\uFEFF",
      "\u200E\u200F",
      "\u202A\u202E\u2066\u2069",
      "  \u00AD \n",
      "\u3164\uFE0F\u{E0020}",
    ]) {
      expect(checkLicenceTerms(blank), JSON.stringify(blank)).toEqual({ ok: true, value: null });
    }
    // The mutation beside them: one visible letter among the invisibles is a
    // grant, stored as written (trimmed of whitespace only).
    expect(checkLicenceTerms("\u200Bx\u200B")).toEqual({ ok: true, value: "\u200Bx\u200B" });
  });

  it("normalises CRLF to LF and keeps interior line breaks", () => {
    expect(checkLicenceTerms("One.\r\nTwo.\rThree.")).toEqual({
      ok: true,
      value: "One.\nTwo.\nThree.",
    });
  });
});

describe("the length bound", () => {
  it("accepts exactly the bound and refuses one past it, counted after normalising", () => {
    expect(checkLicenceTerms("x".repeat(MAX_LICENCE_TERMS_LENGTH))).toMatchObject({ ok: true });
    expect(checkLicenceTerms("x".repeat(MAX_LICENCE_TERMS_LENGTH + 1))).toEqual({
      ok: false,
      refusal: "too_long",
    });
    // Surrounding whitespace is trimmed before counting, and a CRLF counts
    // as the one character a browser's maxLength counts it as.
    expect(checkLicenceTerms(`  ${"x".repeat(MAX_LICENCE_TERMS_LENGTH)}  `)).toMatchObject({
      ok: true,
    });
    expect(
      checkLicenceTerms(`${"x".repeat(MAX_LICENCE_TERMS_LENGTH - 2)}\r\nx`),
    ).toMatchObject({ ok: true });
  });
});

describe("no Instagram host (K4)", () => {
  const REFUSED = [
    "instagram.com",
    "See instagram.com/p/abc for the shot.",
    "https://instagram.com/p/abc",
    "http://www.instagram.com/p/abc",
    "WWW.INSTAGRAM.COM/eirik",
    "Credit: Instagram.Com/gry",
    "https://help.instagram.com/terms",
    "instagr.am/p/abc",
    // Read the same by a buyer, spelled differently for a regex.
    "ｉｎｓｔａｇｒａｍ．ｃｏｍ/p/abc",
    "instagram.c\u200Bom/p/abc",
    // Any separator, not a list of dots: U+FF61 folds to U+3002 under
    // NFKC/NFKD, not to ".", and both are label separators to IDNA.
    "instagram\uFF61com/p/abc",
    "instagram\u3002com",
    "instagram/com",
    "instagr\uFF0Eam/p/abc",
    "Ínstagram.com",
    // A line break or tab after the host separates it from the next word;
    // it is not glued over like an invisible (that would read "comfor").
    "Credit instagram.com\nfor the original.",
    "instagram.com\tfor the original.",
    // Stated false positives the rule accepts (see INSTAGRAM_HOST).
    "notinstagram.com",
    "instagram com",
    "instagramcom",
  ];

  it("refuses every spelling of the host", () => {
    for (const text of REFUSED) {
      expect(checkLicenceTerms(text), text).toEqual({ ok: false, refusal: "instagram_url" });
      expect(mentionsInstagramHost(text), text).toBe(true);
    }
  });

  /**
   * One code point per kind of invisible the strip must catch, and one per
   * class it is built from, each inserted at two places inside
   * `instagram.com` — inside the second-level name and inside the top-level
   * one. Grouped by the class that catches it, so a class dropped from
   * INVISIBLE fails its own rows by name. The bidi controls among them are
   * also refused on their own (see "no bidi control" below); the host check
   * runs first and names the address, and these rows pin that the skeleton
   * still finds it.
   */
  const INVISIBLE_ROWS: ReadonlyArray<readonly [string, number]> = [
    // Bidi marks, embeddings, isolates (Cf, Default_Ignorable).
    ["LRM", 0x200e],
    ["RLM", 0x200f],
    ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e].map((cp) => ["bidi embedding", cp] as const),
    ...[0x2066, 0x2067, 0x2068, 0x2069].map((cp) => ["bidi isolate", cp] as const),
    // Invisible operators (Cf, Default_Ignorable).
    ...[0x2061, 0x2062, 0x2063, 0x2064].map((cp) => ["invisible operator", cp] as const),
    // The original six (Cf, Default_Ignorable).
    ["zero-width space", 0x200b],
    ["zero-width non-joiner", 0x200c],
    ["zero-width joiner", 0x200d],
    ["word joiner", 0x2060],
    ["byte-order mark", 0xfeff],
    ["soft hyphen", 0x00ad],
    // Combining grapheme joiner (Mn, Default_Ignorable).
    ["combining grapheme joiner", 0x034f],
    // Mongolian vowel separator (Cf, Default_Ignorable).
    ["Mongolian vowel separator", 0x180e],
    // Variation selectors (Mn, Default_Ignorable, Variation_Selector).
    ["variation selector 1", 0xfe00],
    ["variation selector 16", 0xfe0f],
    ["variation selector 17", 0xe0100],
    // Tag characters (Cf, Default_Ignorable).
    ["language tag", 0xe0001],
    ["tag space", 0xe0020],
    ["cancel tag", 0xe007f],
    // Hangul fillers: LETTERS (Lo) by category, caught only by Default_Ignorable.
    ["Hangul filler", 0x3164],
    ["half-width Hangul filler", 0xffa0],
    ["Hangul choseong filler", 0x115f],
    ["Hangul jungseong filler", 0x1160],
    // Cf but not Default_Ignorable: caught only by \p{Cf}.
    ["interlinear annotation anchor", 0xfff9],
    // Mn but not Default_Ignorable: caught only by \p{Mn}.
    ["combining acute accent", 0x0301],
    // Me: caught only by \p{Me}.
    ["combining enclosing circle", 0x20dd],
    // Cc that is not white space: caught only by \p{Cc}.
    ["start of heading", 0x0001],
  ];

  it.each(INVISIBLE_ROWS)("refuses instagram.com with a %s (code point %d) inside it, at two places", (_name, cp) => {
    const c = String.fromCodePoint(cp);
    for (const text of [`insta${c}gram.com/p/x`, `instagram.c${c}om/p/x`]) {
      expect(checkLicenceTerms(text), JSON.stringify(text)).toEqual({
        ok: false,
        refusal: "instagram_url",
      });
    }
  });

  it("does not refuse the word Instagram, or another host", () => {
    // The mutation beside the refusals: the rule is about pointing a buyer
    // AT Instagram, not about naming it.
    for (const text of [
      "Not for use on Instagram or any other social network.",
      "See https://example.com/licence for the full text.",
      // `com` running on into a letter is a word, not a host.
      "Not for Instagram, commercial or editorial use.",
      "instagram.community",
      // A percent-escape is not decoded: the "2E" is a digit and a letter,
      // and a buyer does not read it as a dot. Accepted, deliberately.
      "instagram%2Ecom",
      // A handle names no host.
      "Credit @gry on Instagram.",
      // White space separates words; it is not glued over like an
      // invisible, so "insta gram" is two words.
      "insta gram.com",
    ]) {
      expect(checkLicenceTerms(text), text).toMatchObject({ ok: true });
    }
  });

  it("checks the bound before the host, so an over-long grant is told it is too long", () => {
    expect(
      checkLicenceTerms(`instagram.com ${"x".repeat(MAX_LICENCE_TERMS_LENGTH)}`),
    ).toEqual({ ok: false, refusal: "too_long" });
  });
});

describe("no bidi control (K4: what a buyer SEES never names instagram.com)", () => {
  /**
   * Each of these is stored in an order with no Instagram host in it, and a
   * browser DISPLAYS it as "instagram.com": a bidi override reverses the
   * letters, or an embedding or isolate with right-to-left marks reorders
   * the labels. The skeleton compares stored order, so only the refusal of
   * the controls themselves catches them.
   */
  const DISPLAYED_AS_INSTAGRAM = [
    "See \u202Emoc.margatsni\u202C for the original.",
    "See instagram.\u202Emoc\u202C now",
    "See \u202Bcom\u200F.\u200Finstagram\u202C now",
    "See \u2067com\u200F.\u200Finstagram\u2069 now",
  ];

  it("refuses every grant a browser displays as instagram.com", () => {
    for (const text of DISPLAYED_AS_INSTAGRAM) {
      // The skeleton alone does not see the host, which is why the second
      // refusal exists.
      expect(mentionsInstagramHost(text), JSON.stringify(text)).toBe(false);
      expect(checkLicenceTerms(text), JSON.stringify(text)).toEqual({
        ok: false,
        refusal: "bidi_control",
      });
    }
  });

  /** Every code point with the Bidi_Control property, measured over all of Unicode. */
  const BIDI_CONTROLS = [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];

  it("lists exactly the Bidi_Control code points", () => {
    // So a row missing from the table below cannot pass unnoticed.
    const measured: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (/\p{Bidi_Control}/u.test(String.fromCodePoint(cp))) measured.push(cp);
    }
    expect(measured).toEqual(BIDI_CONTROLS);
  });

  it.each(
    BIDI_CONTROLS.map((cp) => [cp.toString(16).toUpperCase().padStart(4, "0"), cp] as const),
  )("refuses a grant with U+%s at the start of a word and inside one", (_hex, cp) => {
    const c = String.fromCodePoint(cp);
    for (const text of [`Web use ${c}only.`, `Web us${c}e only.`]) {
      expect(checkLicenceTerms(text), JSON.stringify(text)).toEqual({
        ok: false,
        refusal: "bidi_control",
      });
    }
  });

  it("accepts right-to-left script with no control in it: the rule refuses controls, not scripts", () => {
    for (const text of [
      "\u05E9\u05D9\u05DE\u05D5\u05E9 \u05D1\u05E8\u05E9\u05EA \u05D1\u05DC\u05D1\u05D3",
      "\u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u0639\u0644\u0649 \u0627\u0644\u0648\u064A\u0628 \u0641\u0642\u0637",
      "Web use only. \u05E9\u05D9\u05DE\u05D5\u05E9 \u05D1\u05E8\u05E9\u05EA \u05D1\u05DC\u05D1\u05D3.",
    ]) {
      expect(checkLicenceTerms(text), JSON.stringify(text)).toEqual({ ok: true, value: text });
    }
  });

  it("names the host, not the control, when a grant has both", () => {
    expect(checkLicenceTerms("instagram.c\u200Eom/p/x")).toEqual({
      ok: false,
      refusal: "instagram_url",
    });
  });
});
