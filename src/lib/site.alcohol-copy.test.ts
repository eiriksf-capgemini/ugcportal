import { describe, expect, it } from "vitest";

import * as site from "@/lib/site";

/**
 * ugcportal-qnq9.3 K5: no public copy on this site promotes alcoholic drink.
 *
 * WHY A TEST AND NOT A CODE REVIEW. src/lib/site.ts's SITE_DESCRIPTION said
 * "Food, wine and drink, technology and books, photographed." on a site that
 * will take money, and nothing noticed for four months. alkoholloven § 9-2
 * bans alcohol from appearing in advertising for other products, and a meta
 * description is the site's own advertisement for itself — so the sentence
 * was a breach sitting in a file nobody had reason to open. The site's chosen
 * subject is the ACCESSORY (docs/ugc-research.md Decisions table, §3.1a:
 * empty glasses, coolers, wine-tool apps), which is monetisable precisely
 * because it is not the drink.
 *
 * THE DENYLIST IS THE BEAD'S OWN, copied rather than invented: wine, vin,
 * beer, øl, drink, alkohol, spirits, bobler. Note what is NOT on it —
 * "alcohol", the English word — and that absence is deliberate rather than an
 * oversight. The copy is allowed to SAY it never features alcohol, which is
 * the opposite of promoting it; a list that caught the disclaimer along with
 * the promotion would be a list the next author deletes.
 *
 * MATCHED AS WHOLE WORDS, not substrings. "vin" as a substring is inside
 * "vintage" and "inviting"; "øl" is inside Norwegian words that have nothing
 * to do with beer. The tokeniser is `\\p{L}`-based for the reason
 * src/lib/advertising-disclosure.ts states at length about the same problem:
 * JavaScript's `\\b` treats a Norwegian letter as a word separator, so a
 * boundary regex would match inside words it has no business matching.
 */

/** docs/ugc-research.md §3.1a, via ugcportal-qnq9.3 K5. */
const DENIED_TERMS = [
  "wine",
  "vin",
  "beer",
  "øl",
  "drink",
  "alkohol",
  "spirits",
  "bobler",
] as const;

/**
 * Phrases in which a denied word names the ACCESSORY rather than the drink.
 *
 * Consumed out of the text before it is tokenised, so "wine accessories"
 * removes its own "wine" and leaves any other occurrence to be caught. That
 * is the whole reason this is a phrase list rather than a per-word exemption:
 * exempting "wine" outright would permit "a glass of wine", which is the
 * sentence the rule exists for ("does not swallow the drink along with the
 * accessory" below is the case that pins it).
 */
const ACCESSORY_PHRASES = [
  "wine accessories",
  "wine accessory",
  "wine glasses",
  "wine glass",
  "wine cooler",
  "wine coolers",
  "wine app",
  "wine apps",
  "wine-tool",
] as const;

/** The words of a string, lower-cased, punctuation and spacing dropped. */
function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Every denied term `value` promotes, after the accessory phrases are taken
 * out of it. Empty means the copy is clean. */
export function promotedDrinkTerms(value: string): string[] {
  let remaining = value.toLowerCase();
  for (const phrase of ACCESSORY_PHRASES) {
    remaining = remaining.split(phrase).join(" ");
  }
  const tokens = new Set(words(remaining));
  return DENIED_TERMS.filter((term) => tokens.has(term));
}

/**
 * Every public string src/lib/site.ts exports, flattened, with the export
 * name each came from.
 *
 * WALKED OFF THE MODULE rather than hand-listed. That file's own docstring is
 * "site-level strings, in one place", and ugcportal-qnq9.7 folded the About
 * and Portfolio copy into it on exactly that argument — so a copy constant
 * added later is covered here the moment it exists, which a hand-list is how
 * this bead's own defect got in. `WHAT_WE_OFFER`'s objects are walked a level
 * deeper for the same reason.
 */
function publicCopy(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const push = (name: string, value: unknown) => {
    if (typeof value === "string") {
      out.push({ name, text: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => push(`${name}[${index}]`, entry));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        push(`${name}.${key}`, nested);
      }
    }
  };
  for (const [name, value] of Object.entries(site)) {
    push(name, value);
  }
  return out;
}

describe("ugcportal-qnq9.3 K5: the public copy does not promote the drink", () => {
  it("finds strings to check, so the assertions below are not vacuous", () => {
    // Without this, deleting every export from src/lib/site.ts would make
    // this file pass. Named exports specifically, so the count cannot be
    // reached by one long string either.
    const copy = publicCopy();
    expect(copy.length).toBeGreaterThan(5);
    expect(copy.map((entry) => entry.name)).toContain("SITE_DESCRIPTION");
    expect(copy.map((entry) => entry.name)).toContain("SITE_TAGLINE");
    expect(copy.map((entry) => entry.name)).toContain("INTRO_PARAGRAPHS[0]");
  });

  it("clears the meta description specifically", () => {
    // K5 names this string, so it is asserted by name as well as through the
    // sweep below — which would still pass if the export were renamed.
    expect(promotedDrinkTerms(site.SITE_DESCRIPTION)).toEqual([]);
    // And it still names the subject: a description reworded to say nothing
    // would clear the denylist perfectly.
    expect(site.SITE_DESCRIPTION).toContain("wine accessories");
  });

  it("clears every string the site module exports", () => {
    for (const { name, text } of publicCopy()) {
      expect(
        promotedDrinkTerms(text),
        `${name} promotes alcoholic drink: "${text}"`,
      ).toEqual([]);
    }
  });

  it("would have caught the wording this bead replaced", () => {
    // The mutation, committed as a case rather than run by hand: the exact
    // sentence SITE_DESCRIPTION held before K5, which is what makes every
    // assertion above a claim about the denylist working rather than about
    // the strings happening to be short.
    expect(
      promotedDrinkTerms(
        "Food, wine and drink, technology and books, photographed.",
      ),
    ).toEqual(["wine", "drink"]);
  });

  it("does not swallow the drink along with the accessory", () => {
    // The allowlist's own failure mode. If "wine accessories" exempted the
    // word rather than the phrase, each of these would pass.
    expect(promotedDrinkTerms("A glass of wine on a windowsill")).toEqual([
      "wine",
    ]);
    expect(
      promotedDrinkTerms("Wine accessories, and a glass of wine beside them"),
    ).toEqual(["wine"]);
    expect(promotedDrinkTerms("Øl, vin og bobler")).toEqual([
      "vin",
      "øl",
      "bobler",
    ]);
  });

  it("matches whole words, so ordinary copy is not flagged", () => {
    // The other direction, and the reason for the tokeniser: a denylist that
    // matched substrings would refuse these, and a reviewer who hit that
    // would widen the exemptions rather than fix the matching.
    expect(promotedDrinkTerms("A vintage lens, inviting light")).toEqual([]);
    expect(promotedDrinkTerms("Drinking fountains and beermats")).toEqual([]);
  });
});
