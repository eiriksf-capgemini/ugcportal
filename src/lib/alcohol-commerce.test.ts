import { describe, expect, it } from "vitest";

import {
  type AlcoholDepiction,
  alcoholDepiction,
  alcoholLinkedBrandRefusal,
  alcoholReclassificationRefusal,
  benefitAttachmentRefusal,
  commercialPublishRefusal,
  effectiveBrandAlcoholAnswer,
} from "@/lib/alcohol-commerce";
import { MAX_COMMERCIAL_LINKS_PER_ITEM } from "@/lib/commercial-link";

/**
 * ugcportal-qnq9.3 K4 and K6, at the level the rules are actually decided:
 * three nullable booleans, no database.
 *
 * Every case here is a tuple rather than a sentence, because the whole risk
 * in this module is a `=== true` written where a `!== false` belonged — a
 * shape that reads correctly and is wrong on exactly the third value. So the
 * tables below enumerate all three states of each input rather than the two
 * interesting ones, and the "unanswered" rows are the ones worth reading.
 */

/** Every state a nullable answer can arrive in, including the two that are
 * not values of the column at all: a relation that loaded as null, and a
 * field a hand-built object left off. */
const UNANSWERED = [
  { label: "a null answer", source: { alcoholLinked: null } },
  { label: "no row at all", source: null },
  { label: "an undefined relation", source: undefined },
] as const;

describe("alcoholDepiction", () => {
  it.each([
    ["depicted", { depictsAlcohol: true }, "depicted"],
    ["absent", { depictsAlcohol: false }, "absent"],
    ["unanswered", { depictsAlcohol: null }, "unanswered"],
  ])("reads %s off the listing", (_name, listing, expected) => {
    expect(alcoholDepiction(listing)).toBe(expected as AlcoholDepiction);
  });

  it.each([
    ["a listing that is null", null],
    ["a listing that is undefined", undefined],
  ])("treats %s as unanswered rather than as a `no`", (_name, listing) => {
    // An item nobody has put forward for sale has no MediaListing row, and it
    // arrives here as null. If that read as "absent" it would be the system
    // asserting, about an item nobody has looked at, that there is no alcohol
    // in it.
    expect(alcoholDepiction(listing)).toBe("unanswered");
  });

  it("returns `absent` only for a literal `false`", () => {
    // The property every caller writing `!== "absent"` relies on. Asserted
    // over values the column cannot hold, because the callers that build this
    // object by hand are exactly where one turns up.
    for (const depictsAlcohol of [
      undefined,
      0,
      "",
      "false",
      "no",
      NaN,
    ] as unknown[]) {
      expect(
        alcoholDepiction({ depictsAlcohol } as { depictsAlcohol: boolean | null }),
        `${JSON.stringify(depictsAlcohol)} must not read as a recorded no`,
      ).not.toBe("absent");
    }
  });
});

describe("alcoholLinkedBrandRefusal (K4)", () => {
  it("permits a brand somebody checked and found clean", () => {
    // The only passing input, and the one that makes every refusal below a
    // claim about the answer rather than about the function.
    expect(alcoholLinkedBrandRefusal({ alcoholLinked: false })).toBeNull();
  });

  it("refuses a brand that produces, imports or sells alcohol", () => {
    const refusal = alcoholLinkedBrandRefusal({ alcoholLinked: true });

    expect(refusal?.field).toBe("benefitSource");
    expect(refusal?.error).toMatch(/alkoholloven/);
    // The message names the rule rather than the row, because the operator's
    // next action is to decline the deal.
    expect(refusal?.error).toMatch(/produces, imports or sells alcohol/);
  });

  it.each(UNANSWERED)(
    "refuses a brand with $label, because an unasked question is not a no",
    ({ source }) => {
      const refusal = alcoholLinkedBrandRefusal(source);

      expect(refusal?.field).toBe("benefitSource");
      expect(refusal?.error).toMatch(/Nobody has recorded/);
    },
  );

  it("says something different about unchecked than about alcohol-linked", () => {
    // Not cosmetic: the two states call for opposite actions — go and find
    // out, versus decline the deal — and a single message would tell an
    // operator the deal is off when the answer might be that it is fine. The
    // messages are asserted to DIFFER rather than asserted word for word, so
    // this stays true through a rewording.
    expect(alcoholLinkedBrandRefusal({ alcoholLinked: true })?.error).not.toBe(
      alcoholLinkedBrandRefusal({ alcoholLinked: null })?.error,
    );
  });
});

describe("benefitAttachmentRefusal (the write path's gate)", () => {
  const CLEAN_BRAND = { alcoholLinked: false };
  const CLEAN_LISTING = { depictsAlcohol: false };

  it("permits the accessory: an empty glass from a checked brand (K1)", () => {
    // The criterion this bead was rewritten to add. Without this case every
    // refusal below would also hold for a gate wired to refuse everything.
    expect(
      benefitAttachmentRefusal({
        listing: CLEAN_LISTING,
        benefitSource: CLEAN_BRAND,
      }),
    ).toBeNull();
  });

  it("refuses an item recorded as showing alcohol (K2)", () => {
    const refusal = benefitAttachmentRefusal({
      listing: { depictsAlcohol: true },
      benefitSource: CLEAN_BRAND,
    });

    expect(refusal?.field).toBe("depictsAlcohol");
    expect(refusal?.error).toMatch(/whatever the glass actually holds/);
  });

  it("permits an item nobody has triaged, deliberately", () => {
    // THE ONE ASYMMETRY IN THIS MODULE, pinned so a later tidy-up to
    // `!== "absent"` here fails rather than quietly making the advertising
    // label unrecordable on every untriaged item. The untriaged state is
    // refused at publish instead, which the next describe asserts.
    expect(
      benefitAttachmentRefusal({
        listing: { depictsAlcohol: null },
        benefitSource: CLEAN_BRAND,
      }),
    ).toBeNull();
    expect(
      benefitAttachmentRefusal({ listing: null, benefitSource: CLEAN_BRAND }),
    ).toBeNull();
  });

  it("refuses an alcohol-linked or unchecked brand on a clean picture (K4)", () => {
    for (const alcoholLinked of [true, null]) {
      expect(
        benefitAttachmentRefusal({
          listing: CLEAN_LISTING,
          benefitSource: { alcoholLinked },
        })?.field,
        `brand answer ${alcoholLinked} was permitted`,
      ).toBe("benefitSource");
    }
  });

  it("reports the picture before the brand when both are wrong", () => {
    // Order matters for the one message the operator gets: a photograph
    // showing alcohol cannot carry a benefit from ANY brand, so sending them
    // to check the company first would be sending them on an errand that
    // changes nothing.
    expect(
      benefitAttachmentRefusal({
        listing: { depictsAlcohol: true },
        benefitSource: { alcoholLinked: true },
      })?.field,
    ).toBe("depictsAlcohol");
  });
});

describe("commercialPublishRefusal (K6)", () => {
  const LABELLED = (brand: { alcoholLinked: boolean | null } | null) => ({
    benefitReceived: true,
    benefitSource: brand,
  });

  /**
   * The commercial-link half of the gate's input (ugcportal-jain), held at
   * zero for every case that is about the BENEFIT half.
   *
   * Spelled out rather than defaulted in the function's own signature: the
   * publish route produces this count from a real query, and a parameter with
   * a default would let a future caller forget to pass it and still compile —
   * which is the direction this gate must not fail in.
   */
  const NO_LINKS = { commercialLinkCount: 0 };
  const ONE_LINK = { commercialLinkCount: 1 };

  it("permits the published accessory advertisement (K1)", () => {
    expect(
      commercialPublishRefusal({
        disclosure: LABELLED({ alcoholLinked: false }),
        listing: { depictsAlcohol: false },
        commercialLinks: NO_LINKS,
      }),
    ).toBeNull();
  });

  it.each([
    ["no disclosure row", null],
    ["an undefined disclosure", undefined],
    ["a declared absence of benefit", { benefitReceived: false, benefitSource: null }],
    ["an unanswered benefit question", { benefitReceived: null, benefitSource: null }],
  ])("says nothing about an item with %s", (_name, disclosure) => {
    // § 9-2 is about ADVERTISING. A photograph of a glass of wine is
    // publishable as personal content — which is the distinction the layout
    // separation in ugcportal-qnq9.11 is built on — and every item that
    // existed before ugcportal-qnq9.1's migration is in one of these states.
    // The worst possible listing is supplied, so these pass for the reason
    // they claim rather than for want of an alcohol answer.
    expect(
      commercialPublishRefusal({
        disclosure,
        listing: { depictsAlcohol: true },
        commercialLinks: NO_LINKS,
      }),
    ).toBeNull();
  });

  it.each([
    ["recorded as showing alcohol", { depictsAlcohol: true }],
    ["unanswered", { depictsAlcohol: null }],
    ["absent entirely", null],
  ])("refuses an advertisement whose picture is %s", (_name, listing) => {
    // BOTH refusing states here, unlike at the write. The request being made
    // is to show this to the public with an advertising label on it, and
    // "nobody asked" is not a defence under a rule about what the picture
    // looks like.
    const refusal = commercialPublishRefusal({
      disclosure: LABELLED({ alcoholLinked: false }),
      listing,
      commercialLinks: NO_LINKS,
    });

    expect(refusal?.field).toBe("depictsAlcohol");
    expect(refusal?.error).toMatch(/alkoholloven/);
  });

  it.each([
    ["alcohol-linked", { alcoholLinked: true }],
    ["unchecked", { alcoholLinked: null }],
    ["absent", null],
  ])("refuses an advertisement from a brand that is %s", (_name, brand) => {
    const refusal = commercialPublishRefusal({
      disclosure: LABELLED(brand),
      listing: { depictsAlcohol: false },
      commercialLinks: NO_LINKS,
    });

    expect(refusal?.field).toBe("benefitSource");
  });

  it("reads `benefitReceived` the way the label gate reads it", () => {
    // `!== true`, so a column holding anything other than a real `true` is
    // "not a declared benefit" — the same reading
    // `advertisingLabelPublishRefusal` uses of the same field, in the same
    // request. Two gates disagreeing about what a declared benefit is would
    // be a row that needs a label and is exempt from this.
    for (const benefitReceived of [undefined, 0, "", "true", 1] as unknown[]) {
      expect(
        commercialPublishRefusal({
          disclosure: {
            benefitReceived,
            benefitSource: null,
          } as unknown as { benefitReceived: boolean | null; benefitSource: null },
          listing: { depictsAlcohol: true },
          commercialLinks: NO_LINKS,
        }),
        `${JSON.stringify(benefitReceived)} was treated as a declared benefit`,
      ).toBeNull();
    }
  });

  describe("the commercial-link half (ugcportal-jain)", () => {
    /**
     * Every disclosure state that is NOT a declared benefit. Before this
     * bead the gate returned null outright for all four, so an item whose
     * disclosure had been withdrawn carried its links past § 9-2 entirely.
     */
    const NOT_A_DECLARED_BENEFIT: [
      string,
      { benefitReceived: boolean | null; benefitSource: null } | null | undefined,
    ][] = [
      ["no disclosure row", null],
      ["an undefined disclosure", undefined],
      ["a withdrawn benefit", { benefitReceived: false, benefitSource: null }],
      ["an unanswered benefit question", { benefitReceived: null, benefitSource: null }],
    ];

    const REFUSING_LISTINGS: [string, { depictsAlcohol: boolean | null } | null][] = [
      ["recorded as showing alcohol", { depictsAlcohol: true }],
      ["unanswered", { depictsAlcohol: null }],
      ["absent entirely", null],
    ];

    it.each(
      NOT_A_DECLARED_BENEFIT.flatMap(([benefitName, disclosure]) =>
        REFUSING_LISTINGS.map(
          ([listingName, listing]) =>
            [benefitName, listingName, disclosure, listing] as const,
        ),
      ),
    )(
      "refuses a link-carrying item with %s whose picture is %s",
      (_benefitName, _listingName, disclosure, listing) => {
        // PARAMETERISED OVER THE WHOLE PRODUCT of both inputs rather than
        // over one representative pair: "a link makes an item commercial" is
        // a claim about every disclosure state the benefit half rejects, and
        // a single instance would prove it for one of the four.
        const refusal = commercialPublishRefusal({
          disclosure,
          listing,
          commercialLinks: ONE_LINK,
        });

        expect(refusal?.field).toBe("depictsAlcohol");
        expect(refusal?.error).toMatch(/alkoholloven/);
      },
    );

    it.each(NOT_A_DECLARED_BENEFIT)(
      "permits a link-carrying item with %s on a picture recorded free of alcohol",
      (_name, disclosure) => {
        // The counterweight to the case above: carrying a link is not itself
        // refusable here. § 9-2 is about the PICTURE and the BRAND, and this
        // module has no opinion about the label — that is
        // `commercialLinkPublishRefusal`'s (src/lib/commercial-link.ts).
        // Without this, the block above would pass just as well against a
        // gate that refused every item carrying a link.
        expect(
          commercialPublishRefusal({
            disclosure,
            listing: { depictsAlcohol: false },
            commercialLinks: ONE_LINK,
          }),
        ).toBeNull();
      },
    );

    it("does not ask the brand question of a link-carrying item with no declared benefit", () => {
      // `benefitSource` on this parameter is the DISCLOSURE's brand, and a
      // CommercialLink row carries its own, which can name a different
      // company. Asking `alcoholLinkedBrandRefusal` about an absent
      // disclosure brand would refuse with `field: "benefitSource"`, naming a
      // brand that is not the link's. The listing is clean, so the only
      // refusal this could produce is the brand one.
      expect(
        commercialPublishRefusal({
          disclosure: { benefitReceived: false, benefitSource: null },
          listing: { depictsAlcohol: false },
          commercialLinks: ONE_LINK,
        }),
      ).toBeNull();
    });

    it("still asks the brand question of a DECLARED benefit that also carries links", () => {
      // The other side of the branch above: widening the gate must not have
      // dropped the brand check for the items it already covered.
      expect(
        commercialPublishRefusal({
          disclosure: LABELLED({ alcoholLinked: true }),
          listing: { depictsAlcohol: false },
          commercialLinks: ONE_LINK,
        })?.field,
      ).toBe("benefitSource");
    });

    it.each([0, 1, 2, MAX_COMMERCIAL_LINKS_PER_ITEM])(
      "reads a count of %i the way the reclassification gate reads it",
      (commercialLinkCount) => {
        // The two gates share one datum (`CommercialLinkFacts`) and must not
        // come to disagree about what "carries a link" means: one reading
        // `>= 1` and the other `< 1` of the same number is the only way they
        // stay inverses. Run over the whole range a real item can hold, not
        // over the boundary alone.
        const links = { commercialLinkCount };
        const publishSaysCommercial =
          commercialPublishRefusal({
            disclosure: null,
            listing: { depictsAlcohol: true },
            commercialLinks: links,
          }) !== null;
        const reclassificationSaysCommercial =
          alcoholReclassificationRefusal({
            listing: { depictsAlcohol: true },
            commercialLinks: links,
          }) !== null;

        expect(publishSaysCommercial).toBe(reclassificationSaysCommercial);
        expect(publishSaysCommercial).toBe(commercialLinkCount >= 1);
      },
    );
  });
});

describe("effectiveBrandAlcoholAnswer", () => {
  it.each([
    // recorded, submitted, effective
    [null, undefined, null],
    [null, false, false],
    [null, true, true],
    [false, undefined, false],
    [false, false, false],
    [false, true, true],
    [true, undefined, true],
    [true, false, true],
    [true, true, true],
  ])(
    "recorded %j plus submitted %j gives %j",
    (recorded, submitted, expected) => {
      expect(effectiveBrandAlcoholAnswer(recorded, submitted)).toBe(expected);
    },
  );

  it("never lets a recorded `yes` be talked back down", () => {
    // THE ROW THAT MATTERS in the table above, stated as its own claim: the
    // only person who ever answers this question is the person who wants the
    // deal to go through, so a resubmitted `no` must not overwrite a `yes`.
    // Without this the K4 check is bypassable by sending the request twice.
    expect(effectiveBrandAlcoholAnswer(true, false)).toBe(true);
    expect(effectiveBrandAlcoholAnswer(true, undefined)).toBe(true);
  });

  it("lets an unanswered brand be answered, which is the only write there is", () => {
    // And the pair that makes the rule monotone rather than frozen: `null` is
    // answerable in either direction, `false` can still be tightened to
    // `true`, and nothing goes the other way.
    expect(effectiveBrandAlcoholAnswer(null, false)).toBe(false);
    expect(effectiveBrandAlcoholAnswer(false, true)).toBe(true);
  });
});
