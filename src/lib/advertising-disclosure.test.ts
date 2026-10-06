import { describe, expect, it } from "vitest";

import { BenefitKind } from "@/generated/prisma/enums";
import {
  advertisingLabelPublishRefusal,
  BENEFIT_KINDS,
  ENGLISH_ONLY_ADVERTISING_LABELS,
  FORBIDDEN_ADVERTISING_LABEL_TERMS,
  isBenefitKind,
  isPermittedAdvertisingLabel,
  MAX_ADVERTISING_LABEL_INPUT_LENGTH,
  PERMITTED_ADVERTISING_LABELS,
  validateAdvertisingLabel,
} from "@/lib/advertising-disclosure";

/**
 * ugcportal-qnq9.1 K3 (the two label lists) and K2/K5's storage half (the
 * publish refusal), against the real validator.
 *
 * TABLE-DRIVEN, AND THE TABLES ARE CHECKED AGAINST THE LISTS THEY COVER.
 * K3's own verification note asks for "one case per value in both lists, so
 * adding a word to either list forces a test row" — a table that merely
 * happens to agree with the module today does not do that, because a
 * fourteenth forbidden word would simply go untested and the suite would stay
 * green. The three `covers every entry` tests below are what turn that into a
 * failure: each compares its table's values against the exported list as a
 * set, so a word added to either side with no matching row fails here.
 */

/** Every permitted label, as the bead names them. Spelled out rather than
 * iterated off the export, so a label REMOVED from the module also fails. */
const PERMITTED_CASES = [
  "Advertisement / Reklame",
  "Advertisement / Annonse",
  "Reklame",
  "Annonse",
] as const;

/** Every wording Forbrukertilsynet rejects (§3.2), plus the English
 * equivalents the bead adds because the site is written in English. */
const FORBIDDEN_CASES = [
  "sponset",
  "i samarbeid med",
  "affiliatelenke",
  "gifted",
  "gave",
  "ambassadør",
  "invitert",
  "sponsored",
  "in collaboration with",
  "affiliate link",
  "gift",
  "ambassador",
  "invited",
] as const;

/** The bare English labels §3.1's warning rules out on their own. */
const ENGLISH_ONLY_CASES = ["Ad", "Advertisement"] as const;

describe("permitted advertising labels (K3)", () => {
  it("covers every entry in PERMITTED_ADVERTISING_LABELS", () => {
    expect([...PERMITTED_CASES].sort()).toEqual(
      [...PERMITTED_ADVERTISING_LABELS].sort(),
    );
  });

  it.each(PERMITTED_CASES)("accepts %j and stores it verbatim", (label) => {
    const result = validateAdvertisingLabel(label);
    expect(result).toEqual({ ok: true, value: label });
  });

  it.each(PERMITTED_CASES)(
    "accepts %j said in a different case, and canonicalises it",
    (label) => {
      const result = validateAdvertisingLabel(label.toUpperCase());
      expect(result).toEqual({ ok: true, value: label });
    },
  );

  it.each(PERMITTED_CASES)(
    "accepts %j with stray spacing, and canonicalises it",
    (label) => {
      const result = validateAdvertisingLabel(
        `  ${label.replace(" / ", "/")}  `,
      );
      expect(result).toEqual({ ok: true, value: label });
    },
  );
});

describe("forbidden advertising labels (K3)", () => {
  it("covers every entry in FORBIDDEN_ADVERTISING_LABEL_TERMS", () => {
    expect([...FORBIDDEN_CASES].sort()).toEqual(
      [...FORBIDDEN_ADVERTISING_LABEL_TERMS].sort(),
    );
  });

  it.each(FORBIDDEN_CASES)("rejects %j, naming the word", (term) => {
    const result = validateAdvertisingLabel(term);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(term);
    // The refusal still tells the operator what they CAN use, or the message
    // is a dead end.
    expect(result.message).toContain("Advertisement / Reklame");
  });

  it.each(FORBIDDEN_CASES)(
    "rejects %j when it is only part of a longer label",
    (term) => {
      // The failure this guards is a label that slips a rejected word past an
      // exact-match check by padding it: "Reklame (gifted)" is still a
      // disclosure using a word Forbrukertilsynet named as unacceptable.
      const result = validateAdvertisingLabel(`Reklame (${term})`);
      expect(result.ok).toBe(false);
    },
  );

  it.each(FORBIDDEN_CASES)("rejects %j in a different case", (term) => {
    expect(validateAdvertisingLabel(term.toUpperCase()).ok).toBe(false);
  });

  it("the \\b trap: tolerates phrase spacing and does not split Norwegian words", () => {
    /*
     * THE TWO REGRESSIONS THIS PINS, both of which a tidy-up to `\b`-anchored
     * regexes would reintroduce while every other row in this file still
     * passed. Each is asserted against the boundary regex FIRST, so the
     * comparison is in the test rather than only in a comment.
     *
     * 1. A phrase with doubled whitespace. `\b`-anchored literal spacing is
     *    exact about spacing that carries no meaning.
     */
    expect(/\bi samarbeid med\b/u.test("i  samarbeid med")).toBe(false);
    expect(validateAdvertisingLabel("i  samarbeid med").ok).toBe(false);

    /*
     * 2. A Norwegian letter as a false word boundary. `\b` is ASCII-only even
     *    under /u, so "å" reads as a separator and "ågave" looks like it
     *    contains "gave" — a refusal naming a word the operator did not use.
     *    Tokenising on \p{L} makes it one word, so it falls through to the
     *    allowlist and is refused as "not a permitted label" instead.
     */
    expect(/\bgave\b/u.test("ågave")).toBe(true);
    const result = validateAdvertisingLabel("ågave");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('"gave"');
  });

  it("does not mistake a permitted label for a forbidden word", () => {
    // The trap this guards: "ad" as a substring of "Advertisement", or "gave"
    // inside some longer word. A substring-based denylist refuses every
    // permitted label here; the word-sequence match does not.
    for (const label of PERMITTED_ADVERTISING_LABELS) {
      expect(validateAdvertisingLabel(label).ok).toBe(true);
    }
  });
});

describe("English-only labels (K3, §3.1)", () => {
  it("covers every entry in ENGLISH_ONLY_ADVERTISING_LABELS", () => {
    expect([...ENGLISH_ONLY_CASES].sort()).toEqual(
      [...ENGLISH_ONLY_ADVERTISING_LABELS].sort(),
    );
  });

  it.each(ENGLISH_ONLY_CASES)(
    "rejects a bare %j and says why the Norwegian word is needed",
    (label) => {
      const result = validateAdvertisingLabel(label);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain("Norway");
    },
  );

  it("rejects 'Ad / Reklame' — 'Ad' is not permitted in any combination", () => {
    // ugcportal-qnq9.14: the English word is "Advertisement", never "Ad".
    expect(validateAdvertisingLabel("Ad / Reklame").ok).toBe(false);
  });
});

describe("validateAdvertisingLabel, other input", () => {
  it.each([null, undefined, 42, {}, ["Reklame"]])(
    "rejects the non-string %j",
    (value) => {
      expect(validateAdvertisingLabel(value).ok).toBe(false);
    },
  );

  it.each(["", "   ", "\t\n "])("rejects the blank %j", (value) => {
    const result = validateAdvertisingLabel(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("required");
  });

  it("rejects a label longer than the input cap without scanning it", () => {
    const result = validateAdvertisingLabel(
      "Reklame".padEnd(MAX_ADVERTISING_LABEL_INPUT_LENGTH + 1, " "),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(
      String(MAX_ADVERTISING_LABEL_INPUT_LENGTH),
    );
  });

  it("rejects a permitted label with extra words appended", () => {
    expect(validateAdvertisingLabel("Advertisement / Reklame, maybe").ok).toBe(
      false,
    );
  });

  it("rejects a permitted label's words in the wrong order", () => {
    expect(validateAdvertisingLabel("Reklame / Advertisement").ok).toBe(false);
  });
});

describe("isPermittedAdvertisingLabel", () => {
  it.each(PERMITTED_CASES)("accepts the stored value %j", (label) => {
    expect(isPermittedAdvertisingLabel(label)).toBe(true);
  });

  it.each([null, undefined, "", "reklame", "  Reklame  ", "Sponset"])(
    "rejects %j",
    (value) => {
      expect(isPermittedAdvertisingLabel(value)).toBe(false);
    },
  );
});

describe("benefit kinds", () => {
  it("lists exactly the kinds the schema declares", () => {
    // Against the GENERATED enum, not a second hand-written copy: this is
    // what fails when prisma/schema.prisma grows a seventh kind and nobody
    // updates the parser the route validates against.
    expect([...BENEFIT_KINDS].sort()).toEqual(Object.keys(BenefitKind).sort());
  });

  it.each(BENEFIT_KINDS)("narrows %s", (kind) => {
    expect(isBenefitKind(kind)).toBe(true);
  });

  it.each([null, undefined, "", "payment", "CASH", 1, {}])(
    "rejects %j",
    (value) => {
      expect(isBenefitKind(value)).toBe(false);
    },
  );
});

describe("advertisingLabelPublishRefusal (K2, and the storage half of K5)", () => {
  it("refuses a declared benefit with no label", () => {
    const refusal = advertisingLabelPublishRefusal({
      benefitReceived: true,
      label: null,
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.field).toBe("advertisingLabel");
  });

  it.each(["", "   ", "Sponsored", "reklame", " Reklame"])(
    "refuses a declared benefit whose stored label is %j",
    (label) => {
      // Not merely "non-empty": a row written outside PUT
      // /api/media/[id]/disclosure can carry anything, and a near-miss
      // ("reklame", "  Reklame") is exactly what a hand-edited row looks
      // like. The gate re-checks against the allowlist rather than trusting
      // the writer.
      expect(
        advertisingLabelPublishRefusal({ benefitReceived: true, label }),
      ).not.toBeNull();
    },
  );

  it.each(PERMITTED_CASES)(
    "allows a declared benefit labelled %j",
    (label) => {
      expect(
        advertisingLabelPublishRefusal({ benefitReceived: true, label }),
      ).toBeNull();
    },
  );

  it("allows an item with no disclosure row at all", () => {
    // Every item that existed when this bead's migration ran is in this
    // state. If this ever starts refusing, every pre-existing draft becomes
    // unpublishable with nothing in the product able to clear it.
    expect(advertisingLabelPublishRefusal(null)).toBeNull();
    expect(advertisingLabelPublishRefusal(undefined)).toBeNull();
  });

  it("allows an unanswered disclosure, and treats it as the absent row does", () => {
    // The two representations of "unanswered" must not drift apart — this
    // function is the only place they are collapsed.
    expect(
      advertisingLabelPublishRefusal({ benefitReceived: null, label: null }),
    ).toBeNull();
  });

  it("allows a declared absence of benefit", () => {
    expect(
      advertisingLabelPublishRefusal({ benefitReceived: false, label: null }),
    ).toBeNull();
  });
});
