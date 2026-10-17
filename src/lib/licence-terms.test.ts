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
    "instagram.c​om/p/abc",
  ];

  it("refuses every spelling of the host", () => {
    for (const text of REFUSED) {
      expect(checkLicenceTerms(text), text).toEqual({ ok: false, refusal: "instagram_url" });
      expect(mentionsInstagramHost(text), text).toBe(true);
    }
  });

  it("does not refuse the word Instagram, or another host", () => {
    // The mutation beside the refusals: the rule is about pointing a buyer
    // AT Instagram, not about naming it.
    for (const text of [
      "Not for use on Instagram or any other social network.",
      "See https://example.com/licence for the full text.",
      "instagram com",
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
