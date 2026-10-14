import { describe, expect, it } from "vitest";

import {
  type AlcoholDepiction,
  alcoholDepiction,
  alcoholLinkedBrandRefusal,
  alcoholReclassificationRefusal,
  benefitAttachmentRefusal,
  carriesCommercialLink,
  commercialPublishRefusal,
  effectiveBrandAlcoholAnswer,
  isAlcoholUnclearedAdvertisement,
  isWithheldFromPublicRead,
} from "@/lib/alcohol-commerce";
import {
  carriesUnlabelledCommercialLink,
  MAX_COMMERCIAL_LINKS_PER_ITEM,
} from "@/lib/commercial-link";

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
    // § 9-2 is about ADVERTISING, so this PUBLISH gate says nothing about an
    // item that carries nothing commercial. Whether such an item is then
    // served is the read scope's question, not this one's (since
    // ugcportal-qnq9.11 a recorded `depictsAlcohol = true` is withheld from
    // every public surface), and every item that existed before
    // ugcportal-qnq9.1's migration is in one of these states.
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

    it.each([
      [0, false],
      [1, true],
      [2, true],
      [MAX_COMMERCIAL_LINKS_PER_ITEM, true],
      /*
       * NOT A COUNT AT ALL, and the row this table exists for. Every reading
       * below has to land on the SAME side for it, and that side has to be
       * the refusing one: `NaN >= 1` is `false`, so a gate written the
       * obvious way would be told an item carries no link and would wave it
       * through — a rights gate failing open on a caller's arithmetic bug.
       * `carriesCommercialLink` is written `!(count < 1)` for exactly this
       * row, which is also the direction `alcoholReclassificationRefusal`
       * already fails in. Unreachable from either production caller (both
       * pass a Prisma count), which is why it is a direction choice rather
       * than a live defect — and why it is pinned here rather than left to
       * a comment.
       */
      [Number.NaN, true],
    ])(
      "reads a count of %s the way the reclassification gate reads it",
      (commercialLinkCount, carries) => {
        // THREE READINGS OF ONE DATUM (`CommercialLinkFacts`), asserted
        // together because any two of them disagreeing is a silent split in
        // what "carries a link" means. `carriesUnlabelledCommercialLink`
        // (src/lib/commercial-link.ts) is in the list because its own
        // docstring claims to be pinned here; an earlier version of that
        // claim named this test while this test never called the function,
        // so mutating its link half left this green.
        const links = { commercialLinkCount };

        expect(carriesCommercialLink(links)).toBe(carries);
        expect(carriesUnlabelledCommercialLink(null, links)).toBe(carries);
        expect(
          commercialPublishRefusal({
            disclosure: null,
            listing: { depictsAlcohol: true },
            commercialLinks: links,
          }) !== null,
        ).toBe(carries);
        expect(
          alcoholReclassificationRefusal({
            listing: { depictsAlcohol: true },
            commercialLinks: links,
          }) !== null,
        ).toBe(carries);
      },
    );
  });
});

describe("isAlcoholUnclearedAdvertisement (the pair, ugcportal-pgpq)", () => {
  /**
   * The § 9-2 pair on its own, extracted from `commercialPublishRefusal` so
   * that the publish gate and the read-side withholding
   * (`isWithheldFromPublicRead`, which adds a recorded `true` as a second
   * reason) share ONE definition of the pair rather than two that could
   * drift. The table here is this predicate's whole truth table; the
   * `where` (`PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE`) is the complement of the
   * wider `isWithheldFromPublicRead`, and
   * src/lib/alcohol-commerce.scope-agreement.test.ts compares those two on a
   * real database, row by row.
   */
  const NO_LINKS = { commercialLinkCount: 0 };
  const ONE_LINK = { commercialLinkCount: 1 };

  /** Every state of `depictsAlcohol` that is not a recorded `no`, including
   * the two no database column can hold: a relation that loaded as
   * `undefined`, and a value that is not a boolean at all. */
  const NOT_ANSWERED_NO = [
    ["a listing that does not exist", null],
    ["a relation that loaded as undefined", undefined],
    ["a null answer", { depictsAlcohol: null }],
    ["an undefined field", { depictsAlcohol: undefined }],
    ["a value that is not a boolean", { depictsAlcohol: "maybe" }],
    ["a recorded yes", { depictsAlcohol: true }],
  ] as const;

  it.each(NOT_ANSWERED_NO)(
    "refuses a DECLARED BENEFIT beside %s",
    (_label, listing) => {
      expect(
        isAlcoholUnclearedAdvertisement({
          disclosure: { benefitReceived: true },
          listing: listing as { depictsAlcohol: boolean | null } | null,
          commercialLinks: NO_LINKS,
        }),
      ).toBe(true);
    },
  );

  it.each(NOT_ANSWERED_NO)(
    "refuses a COMMERCIAL LINK beside %s, with the benefit withdrawn",
    (_label, listing) => {
      expect(
        isAlcoholUnclearedAdvertisement({
          disclosure: { benefitReceived: false },
          listing: listing as { depictsAlcohol: boolean | null } | null,
          commercialLinks: ONE_LINK,
        }),
      ).toBe(true);
    },
  );

  it.each(NOT_ANSWERED_NO)(
    "permits an item carrying NOTHING commercial beside %s",
    (_label, listing) => {
      // The other arm, and the one a careless fix loses: §9-2 is about
      // advertising. A photograph of a glass of wine with no benefit, no
      // label and no link is personal content.
      expect(
        isAlcoholUnclearedAdvertisement({
          disclosure: null,
          listing: listing as { depictsAlcohol: boolean | null } | null,
          commercialLinks: NO_LINKS,
        }),
      ).toBe(false);
    },
  );

  it("permits the lawful advertisement: something commercial, alcohol answered `no`", () => {
    // Without this the three tables above would all pass against a
    // predicate that returned `true` for everything commercial.
    for (const commercialLinks of [NO_LINKS, ONE_LINK]) {
      for (const benefitReceived of [true, false]) {
        expect(
          isAlcoholUnclearedAdvertisement({
            disclosure: { benefitReceived },
            listing: { depictsAlcohol: false },
            commercialLinks,
          }),
          `benefitReceived ${benefitReceived}, ${commercialLinks.commercialLinkCount} link(s)`,
        ).toBe(false);
      }
    }
  });

  it("is exactly the alcohol half of `commercialPublishRefusal`, for every state of both", () => {
    /*
     * THE EXTRACTION, PINNED. `commercialPublishRefusal` used to spell this
     * pair inline and now calls this function; nothing else would notice if
     * the two came apart, because the publish route only ever sees the
     * refusal. So: over every combination of the three inputs, with a CLEAN
     * brand so the brand half never fires, the refusal is non-null exactly
     * when this predicate is true, and names `depictsAlcohol` when it does.
     */
    const listings = NOT_ANSWERED_NO.map(([, listing]) => listing).concat([
      { depictsAlcohol: false },
    ] as never);
    let refusals = 0;
    for (const listing of listings) {
      for (const benefitReceived of [true, false, null]) {
        for (const commercialLinks of [NO_LINKS, ONE_LINK]) {
          const item = {
            disclosure: { benefitReceived, benefitSource: { alcoholLinked: false } },
            listing: listing as { depictsAlcohol: boolean | null } | null,
            commercialLinks,
          };
          const refusal = commercialPublishRefusal(item);
          const predicate = isAlcoholUnclearedAdvertisement(item);
          expect(
            refusal !== null,
            `${JSON.stringify({ listing, benefitReceived, commercialLinks })}`,
          ).toBe(predicate);
          if (refusal) {
            expect(refusal.field).toBe("depictsAlcohol");
            refusals += 1;
          }
        }
      }
    }
    // Both outcomes occurred, so the comparison above is not agreeing with
    // two functions that both always answer the same thing.
    expect(refusals).toBeGreaterThan(0);
    expect(refusals).toBeLessThan(listings.length * 3 * 2);
  });
});

describe("isWithheldFromPublicRead (option (a), true-only, ugcportal-qnq9.11)", () => {
  const NO_LINKS = { commercialLinkCount: 0 };
  const ONE_LINK = { commercialLinkCount: 1 };
  const cast = (listing: unknown) =>
    listing as { depictsAlcohol: boolean | null } | null | undefined;

  it.each([
    ["a recorded yes, nothing commercial", true, { depictsAlcohol: true }, null, NO_LINKS],
    ["a recorded yes, a link", true, { depictsAlcohol: true }, null, ONE_LINK],
    ["a recorded yes, a benefit", true, { depictsAlcohol: true }, { benefitReceived: true }, NO_LINKS],
    ["a recorded no, nothing commercial", false, { depictsAlcohol: false }, null, NO_LINKS],
    ["a recorded no, a link", false, { depictsAlcohol: false }, null, ONE_LINK],
    ["a null answer, nothing commercial", false, { depictsAlcohol: null }, null, NO_LINKS],
    ["no listing, nothing commercial", false, null, null, NO_LINKS],
    ["undefined listing, nothing commercial", false, undefined, null, NO_LINKS],
    ["a null answer, a link", true, { depictsAlcohol: null }, null, ONE_LINK],
    ["no listing, a benefit", true, null, { benefitReceived: true }, NO_LINKS],
  ])("%s -> withheld %s", (_label, expected, listing, disclosure, commercialLinks) => {
    expect(
      isWithheldFromPublicRead({ disclosure, listing: cast(listing), commercialLinks }),
    ).toBe(expected);
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
