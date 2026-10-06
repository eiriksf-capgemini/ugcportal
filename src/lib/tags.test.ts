import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { hasUnsafeText } from "@/lib/media-rules";
import {
  MAX_TAGS_PER_ITEM,
  MAX_TAG_NAME_LENGTH,
  parseTagNames,
  tagSlug,
  validateTagName,
} from "@/lib/tags";

/**
 * What a tag name may be (ugcportal-jsc).
 *
 * K5 lives here in its WRITE half: a name carrying a bidi override or a
 * control character never reaches the database, so there is nothing for the
 * gallery to render. The READ half — what the markup does if one is in the
 * database anyway — is in src/app/page.tags.test.tsx, because that is a claim
 * about the rendered page rather than about this function.
 *
 * Nothing here touches Prisma. `resolveTagRows` is the only part of the module
 * that does, and it is exercised through the two routes that call it against a
 * real database rather than against a mock that would agree with whatever this
 * file expected.
 */

/*
 * The awkward characters, built from their code points rather than pasted in.
 *
 * Deliberate, and not fussiness: U+202E is INVISIBLE in an editor and reverses
 * everything after it, so a literal one would make this file unreadable and
 * the next person's diff a puzzle — which is the very property that makes it
 * worth denying in a tag name. Naming them also means a reader does not have
 * to recognise an escape sequence to know what is being tested.
 */
/** RIGHT-TO-LEFT OVERRIDE: the "invoice.exe renders as invoice.png" character. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);
/** ZERO WIDTH SPACE: invisible, and not removed by `trim()`. */
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
/** BEL, an ordinary C0 control. */
const BELL = String.fromCodePoint(0x0007);
/**
 * One astral LETTER — U+1D400 MATHEMATICAL BOLD CAPITAL A. Two UTF-16 units,
 * which is the whole point below.
 *
 * A letter rather than an emoji on purpose: an emoji is not `\p{L}`, so a
 * name made of emoji slugs to the empty string and is refused for a
 * completely different reason — which would have made the length test pass
 * against every implementation, including the broken one.
 */
const ASTRAL_LETTER = String.fromCodePoint(0x1d400);

describe("tagSlug", () => {
  it("case-folds, so Food and food are one tag rather than two", () => {
    expect(tagSlug("Food")).toBe("food");
    expect(tagSlug("FOOD")).toBe("food");
    expect(tagSlug("food")).toBe("food");
  });

  it("collapses punctuation and whitespace runs into single hyphens", () => {
    expect(tagSlug("Wine & drink")).toBe("wine-drink");
    expect(tagSlug("  wine   &&&   drink  ")).toBe("wine-drink");
  });

  it("keeps non-ASCII letters instead of hollowing the word out", () => {
    /*
     * THE FIXTURE IS THE POINT. The usual ASCII-only slugger (`[^a-z0-9]+`)
     * turns this into "b-ker", which reads as nonsense to anyone debugging
     * the table and collides with anything else that lost a middle character.
     * Norwegian is the first language after English this product will see, so
     * the case is real rather than theoretical.
     */
    expect(tagSlug("Bøker")).toBe("bøker");
    expect(tagSlug("Teknologi")).toBe("teknologi");
  });

  it("does not merge tags that merely mean the same thing", () => {
    // It normalises SPELLING, not meaning — said in the doc comment, and
    // pinned here so a later "improvement" that stems or strips stop-words
    // has to change this test on purpose rather than by accident.
    expect(tagSlug("wine and drink")).not.toBe(tagSlug("Wine & drink"));
  });

  it("is empty for a name with no letters or digits at all", () => {
    // Which is what makes validateTagName's refusal below reachable.
    expect(tagSlug("---")).toBe("");
    expect(tagSlug("!!!")).toBe("");
  });

  /**
   * Combining marks (round-2 review finding).
   *
   * The regex used to keep only `\p{L}` and `\p{N}`, which treats every
   * combining mark as punctuation. Latin hides that, because NFC composes
   * its accents into single code points — so a suite built from "Bøker" and
   * "Café" passed while the function mangled every script whose vowels,
   * tones or niqqud are separate code points. The fixtures below are chosen
   * to be the ones that can fail.
   */
  describe("scripts whose marks are separate code points", () => {
    /*
     * Spelled from code points rather than pasted, for the same reason the
     * bidi override is: a reader cannot tell "\u0915\u092b\u0940" from
     * "\u0915\u092b" by looking, and the whole point of these cases is
     * that the difference is one invisible-ish mark.
     */
    /** कफ — Devanagari KA + PHA. */
    const KAPH = String.fromCodePoint(0x915, 0x92b);
    /** कफी — the same, plus the vowel sign II (U+0940, category Mc). */
    const KAPHI = KAPH + String.fromCodePoint(0x940);
    /** ขาว — Thai, no tone mark. */
    const KHAO_PLAIN = String.fromCodePoint(0xe02, 0xe32, 0xe27);
    /** ข้าว — the same with MAI THO (U+0E49, category Mn). */
    const KHAO_TONE =
      String.fromCodePoint(0xe02, 0xe49) + String.fromCodePoint(0xe32, 0xe27);
    /** עברית — Hebrew, unpointed. */
    const HEBREW = String.fromCodePoint(0x5e2, 0x5d1, 0x5e8, 0x5d9, 0x5ea);

    it("does not collide two different names onto one tag", () => {
      /*
       * THE ONE WITH TEETH. `resolveTagRows` upserts on the slug with
       * `update: {}`, so a collision means the second uploader's photograph
       * renders the FIRST uploader's spelling — the failure the
       * "Food"/"food" unification exists to prevent, arriving for names
       * that are genuinely different.
       *
       * Put `\p{M}` back into NON_ALPHANUMERIC and this fails: both sides
       * become "कफ".
       */
      expect(tagSlug(KAPHI)).not.toBe(tagSlug(KAPH));
      expect(tagSlug(KHAO_TONE)).not.toBe(tagSlug(KHAO_PLAIN));
    });

    it("keeps the marks rather than cutting the word into pieces", () => {
      // Not merely "different": the slug has to be a faithful lowercase of
      // the name. `not.toBe` above would also pass for "ข-าว", which is the
      // old, mangled output.
      expect(tagSlug(KAPHI)).toBe(KAPHI);
      expect(tagSlug(KHAO_TONE)).toBe(KHAO_TONE);
      expect(tagSlug(HEBREW)).toBe(HEBREW);
      // And no hyphen was inserted anywhere a mark used to be.
      for (const slug of [tagSlug(KAPHI), tagSlug(KHAO_TONE)]) {
        expect(slug).not.toContain("-");
      }
    });

    it("does not cut a name apart at a mark case-folding introduced", () => {
      /*
       * `"İ".toLowerCase()` is "i" followed by COMBINING DOT ABOVE, so the
       * mark appears during lowercasing rather than in the input. Stripping
       * marks turned this into "i-stanbul".
       *
       * What it slugs to is NOT "istanbul", and that is deliberate rather
       * than a remaining bug: dotted-vs-dotless i is a locale question, and
       * this function has no locale. Asserted as a distinct value from the
       * plain spelling so the choice is recorded rather than assumed.
       */
      const turkish = tagSlug("\u0130stanbul");

      expect(turkish).not.toContain("-");
      expect(turkish.startsWith("i")).toBe(true);
      expect(turkish).not.toBe(tagSlug("Istanbul"));
    });

    it("still collapses punctuation, which is the whole job", () => {
      // Guards the fix from over-reaching: keeping marks must not have
      // turned the strip off.
      expect(tagSlug("Wine & drink")).toBe("wine-drink");
      expect(tagSlug("Café")).toBe("café");
      expect(tagSlug("Bøker")).toBe("bøker");
    });
  });
});

describe("validateTagName", () => {
  it("accepts an ordinary name and reports its slug", () => {
    expect(validateTagName("Wine & drink")).toEqual({
      ok: true,
      value: { name: "Wine & drink", slug: "wine-drink" },
    });
  });

  it("trims, and keeps the trimmed name rather than the submitted one", () => {
    const result = validateTagName("  Food  ");
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.name).toBe("Food");
  });

  it("refuses a non-string, including a File posing as a form field", () => {
    // `getAll` on a multipart form returns a File for a file part, and
    // String(file) is "[object File]" — a perfectly valid-looking tag name.
    // POST /api/media hands what getAll returned straight to parseTagNames,
    // so this branch is what stops that becoming a tag.
    expect(validateTagName(new File(["x"], "tags.txt")).ok).toBe(false);
    expect(validateTagName(42).ok).toBe(false);
    expect(validateTagName(null).ok).toBe(false);
    expect(validateTagName(undefined).ok).toBe(false);
  });

  it("refuses an empty or whitespace-only name", () => {
    expect(validateTagName("").ok).toBe(false);
    expect(validateTagName("   ").ok).toBe(false);
  });

  it("refuses a name made only of invisible characters", () => {
    // Not empty by length, and `trim()` does not touch it, so without the
    // denylist this would be stored and render as a blank chip.
    expect(validateTagName(ZERO_WIDTH_SPACE.repeat(4)).ok).toBe(false);
  });

  it("counts the length cap in code points, not UTF-16 units", () => {
    const atCap = ASTRAL_LETTER.repeat(MAX_TAG_NAME_LENGTH);
    const overCap = ASTRAL_LETTER.repeat(MAX_TAG_NAME_LENGTH + 1);

    /*
     * THE FIXTURE MUTATION THAT MATTERS. Against `name.length` instead of
     * `Array.from(name).length`, `atCap` measures twice the cap and is
     * refused — so this fails. A fixture built from ASCII would pass against
     * both implementations and prove nothing about which one is there.
     */
    expect(validateTagName(atCap).ok).toBe(true);
    expect(validateTagName(overCap).ok).toBe(false);
  });

  it("refuses a name carrying a bidi override (K5, write half)", () => {
    const deceptive = `Food${RTL_OVERRIDE}ygolonhcet`;

    const result = validateTagName(deceptive);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("text-direction");
  });

  it("refuses control characters, including a newline", () => {
    expect(validateTagName("Food\nBooks").ok).toBe(false);
    expect(validateTagName(`Food${BELL}`).ok).toBe(false);
  });

  it("uses the SAME denylist the rename path does, not a second copy", () => {
    /*
     * Guards the guard, and pins the bead's "reusing the character denylist
     * already in src/lib/media.ts rather than writing a second one". Both
     * halves have to hold together: the shared predicate must flag the
     * string, AND the validator must act on it. A validator with its own
     * private regex would satisfy the second and fail the first.
     */
    for (const name of [
      `Food${RTL_OVERRIDE}x`,
      `Food${ZERO_WIDTH_SPACE}x`,
      `Food${BELL}`,
    ]) {
      expect(hasUnsafeText(name)).toBe(true);
      expect(validateTagName(name).ok).toBe(false);
    }
    // And the same predicate finds nothing wrong with an ordinary name, so
    // the loop above is not passing because everything fails.
    expect(hasUnsafeText("Wine & drink")).toBe(false);
    expect(validateTagName("Wine & drink").ok).toBe(true);
  });

  it("does NOT escape markup, because escaping is the renderer's job", () => {
    /*
     * A name containing HTML is stored verbatim, and React escapes it on the
     * way out (asserted in src/app/page.tags.test.tsx). A validator that
     * stored the escaped form would put the escaping in the database for the
     * next consumer to double-apply, and would change the name the uploader
     * typed into one they did not.
     */
    const markup = '<img src=x onerror="alert(1)">';
    const result = validateTagName(markup);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.name).toBe(markup);
  });

  it("refuses a name that is only punctuation, since it has no identity", () => {
    const result = validateTagName("!!!");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("letter or number");
  });

  it("refuses a name that is only combining marks", () => {
    /*
     * THE CASE THE ROUND-2 FIX OPENED, and the reason the emptiness check
     * is no longer the whole of the rule.
     *
     * Before combining marks were kept, this slugged to "" and the check
     * below caught it. Keeping them makes the slug non-empty, so a name
     * that renders as a row of dotted circles — nothing to attach to —
     * became storable. The message always claimed "at least one letter or
     * number"; now the code asserts it.
     *
     * COMBINING ACUTE and COMBINING CIRCUMFLEX, with no base character.
     */
    const marksOnly = String.fromCodePoint(0x301, 0x302);

    // The fixture really is what the test says it is: non-empty, and made
    // of characters the strip now keeps.
    expect(tagSlug(marksOnly)).not.toBe("");

    const result = validateTagName(marksOnly);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("letter or number");
  });

  it("still accepts a name whose marks sit on a real letter", () => {
    // The other side of it: the refusal above must not catch ordinary
    // pointed or toned text.
    const devanagari = String.fromCodePoint(0x915, 0x92b, 0x940);
    expect(validateTagName(devanagari).ok).toBe(true);
  });
});

describe("parseTagNames", () => {
  it("refuses anything that is not an array", () => {
    expect(parseTagNames("Food").ok).toBe(false);
    expect(parseTagNames({ 0: "Food" }).ok).toBe(false);
    expect(parseTagNames(null).ok).toBe(false);
  });

  it("accepts an empty list, which is how every tag is removed", () => {
    expect(parseTagNames([])).toEqual({ ok: true, value: [] });
  });

  it("collapses spellings of one tag and keeps the first", () => {
    const result = parseTagNames(["Food", "food", "FOOD"]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual([{ name: "Food", slug: "food" }]);
  });

  it("caps the count AFTER collapsing, not before", () => {
    // Seven spellings of one tag is one tag, not a refusal. A cap applied to
    // the raw list would reject this.
    const repeated = Array.from({ length: MAX_TAGS_PER_ITEM + 1 }, () => "Food");
    expect(parseTagNames(repeated).ok).toBe(true);
  });

  it("refuses more than MAX_TAGS_PER_ITEM distinct tags", () => {
    const distinct = Array.from(
      { length: MAX_TAGS_PER_ITEM + 1 },
      (_, index) => `subject-${index}`,
    );

    // Both sides of the boundary, so what is pinned is the cap rather than
    // the direction of the comparison.
    expect(parseTagNames(distinct.slice(0, MAX_TAGS_PER_ITEM)).ok).toBe(true);
    expect(parseTagNames(distinct).ok).toBe(false);
  });

  it("refuses the whole list when one entry is bad", () => {
    // Not "drops the bad one": a caller who sent three tags, got a 200, and
    // has two has no way to find out which.
    const result = parseTagNames(["Food", `x${RTL_OVERRIDE}y`, "Books"]);
    expect(result.ok).toBe(false);
  });

  it("keeps the order the caller sent", () => {
    const result = parseTagNames(["Wine & drink", "Books", "Food"]);
    expect(result.ok && result.value.map((tag) => tag.slug)).toEqual([
      "wine-drink",
      "books",
      "food",
    ]);
  });

  /** ugcportal-oejb K1: adopts the shared `dedupeBy` (src/lib/dedupe.ts). */
  it("calls the shared dedupeBy rather than its own Map-based loop", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./tags.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("export function parseTagNames(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    expect(body).toContain("dedupeBy(");
    expect(body).not.toMatch(/bySlug\.has\(|bySlug\.set\(/);
  });
});
