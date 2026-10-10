import { describe, expect, it } from "vitest";

import { CommercialLinkNetwork } from "@/generated/prisma/enums";
import { hasUnsafeText } from "@/lib/media-rules";
import { PERMITTED_ADVERTISING_LABELS } from "@/lib/advertising-disclosure";
import {
  carriesUnlabelledCommercialLink,
  COMMERCIAL_LINK_NETWORKS,
  commercialLinkDisclosureRefusal,
  commercialLinkPublishRefusal,
  disclosureWithdrawalRefusal,
  isCommercialLinkNetwork,
  MAX_COMMERCIAL_LINK_NETWORK_OTHER_LENGTH,
  MAX_COMMERCIAL_LINK_URL_LENGTH,
  MAX_COMMERCIAL_LINKS_PER_ITEM,
  validateCommercialLinkNetwork,
  validateCommercialLinkUrl,
} from "@/lib/commercial-link";

/**
 * src/lib/commercial-link.ts (ugcportal-qnq9.2.1 K4, K5 and the validator half
 * of K3), with no database — the module imports no Prisma client, which is
 * half of why these rules live in a module of their own.
 */

/** A valid destination, already in canonical form, for the cases that are
 * about something other than the URL. */
const CANONICAL = "https://track.adtraction.com/t/t?a=1&url=https%3A%2F%2Fx.no";

/** The shortest host that makes a URL of a predictable length: "https://" (8)
 * + "x.example" (9) + "/" (1). Used to build a destination of EXACTLY the cap
 * rather than approximately it. */
const SHORTEST_CANONICAL = "https://x.example/";

function urlOfLength(length: number): string {
  return (
    SHORTEST_CANONICAL + "a".repeat(length - SHORTEST_CANONICAL.length)
  );
}

describe("validateCommercialLinkUrl: what it accepts", () => {
  it("accepts an affiliate deep link unchanged", () => {
    expect(validateCommercialLinkUrl(CANONICAL)).toEqual({
      ok: true,
      value: CANONICAL,
    });
  });

  it.each([
    // [submitted, stored]
    ["  https://x.example/a  ", "https://x.example/a"],
    // The scheme and host are case-insensitive and come back folded; the PATH
    // is not, and must not be — an affiliate click id is case-sensitive.
    ["HTTPS://X.Example/Path", "https://x.example/Path"],
    // A bare origin gains the empty path. Worth pinning: the stored value is
    // what a renderer puts in an href, so "what came back is not byte-for-byte
    // what went in" is a property of this function rather than a surprise.
    ["https://x.example", "https://x.example/"],
    // The query is preserved verbatim, which is the whole point of an
    // affiliate link.
    [
      "https://x.example/?a=1&b=2#frag",
      "https://x.example/?a=1&b=2#frag",
    ],
  ])("canonicalises %j to %j", (submitted, stored) => {
    expect(validateCommercialLinkUrl(submitted)).toEqual({
      ok: true,
      value: stored,
    });
  });

  it("stores the canonical form, not the string that was submitted", () => {
    // The claim the module's docstring makes, as an assertion that fails if
    // anybody switches the returned value back to the raw input: a literal
    // space is percent-encoded on the way through.
    const result = validateCommercialLinkUrl("https://x.example/?q=a b");

    expect(result).toEqual({ ok: true, value: "https://x.example/?q=a%20b" });
  });

  it("the canonical form of an astral character is ASCII", () => {
    /*
     * The premise behind measuring the cap with `.length` rather than
     * `Array.from(...).length`, pinned rather than asserted in a comment. The
     * URL standard percent-encodes every code point above U+007E, so there is
     * no astral character left in the stored value for a code-point count to
     * differ on. If this ever stops holding, the cap silently becomes a
     * UTF-16-unit cap and this test is what says so.
     */
    const result = validateCommercialLinkUrl("https://x.example/🎉");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("https://x.example/%F0%9F%8E%89");
    expect(result.value.length).toBe(Array.from(result.value).length);
  });

  it("would let a bidi override through if the screen ran after the parse", () => {
    /*
     * The premise the check ORDER rests on, pinned rather than asserted in a
     * comment. `validateCommercialLinkUrl` runs `hasUnsafeText` on the
     * SUBMITTED string, before `new URL`, and the reason given there is that
     * the parser percent-encodes a bidi override instead of rejecting it — so
     * the same screen applied to the canonical form would pass.
     *
     * Both halves are measured here: the character really is still in the
     * canonical form (as `%E2%80%AE`), and `hasUnsafeText` really does say
     * that form is clean. If a future URL implementation started rejecting it
     * outright, or percent-encoding stopped happening, this case says so
     * instead of the ordering quietly becoming arbitrary.
     */
    const canonical = new URL("https://x.example/‮gnp.exe").href;

    expect(canonical).toBe("https://x.example/%E2%80%AEgnp.exe");
    expect(hasUnsafeText(canonical)).toBe(false);
    // And the validator refuses it anyway, because it looks at the input.
    expect(
      validateCommercialLinkUrl("https://x.example/‮gnp.exe").ok,
    ).toBe(false);
  });

  it("accepts a destination of exactly the cap", () => {
    const exact = urlOfLength(MAX_COMMERCIAL_LINK_URL_LENGTH);
    // Guards the boundary pair below against being two tests of the same side
    // of the line: this string has to actually be the cap.
    expect(exact.length).toBe(MAX_COMMERCIAL_LINK_URL_LENGTH);

    expect(validateCommercialLinkUrl(exact)).toEqual({
      ok: true,
      value: exact,
    });
  });
});

describe("validateCommercialLinkUrl: what it refuses (K4)", () => {
  it.each([
    // --- not a string at all -------------------------------------------
    [undefined, "must be a string"],
    [null, "must be a string"],
    [42, "must be a string"],
    [["https://x.example/"], "must be a string"],
    [{ href: "https://x.example/" }, "must be a string"],
    // --- nothing submitted ---------------------------------------------
    ["", "must not be empty"],
    ["   ", "must not be empty"],
    // --- the wrong scheme, which is what rules out the dangerous ones ---
    ["javascript:alert(1)", "must use https, not 'javascript:'"],
    ["JaVaScRiPt:alert(1)", "must use https, not 'javascript:'"],
    ["data:text/html,<script>alert(1)</script>", "must use https, not 'data:'"],
    ["http://x.example/a", "must use https, not 'http:'"],
    ["ftp://x.example/a", "must use https, not 'ftp:'"],
    ["file:///etc/passwd", "must use https, not 'file:'"],
    // --- not absolute, so not parseable at all --------------------------
    ["//x.example/a", "must be an absolute https:// URL"],
    ["/just/a/path", "must be an absolute https:// URL"],
    ["x.example/a", "must be an absolute https:// URL"],
    ["https://", "must be an absolute https:// URL"],
    // --- control and text-direction characters (hasUnsafeText) ----------
    // A right-to-left override: `new URL` percent-encodes this rather than
    // refusing it, so only the pre-parse screen catches it.
    [
      "https://x.example/‮gnp.exe",
      "must not contain control or text-direction characters",
    ],
    [
      "https://x.example/​zero-width",
      "must not contain control or text-direction characters",
    ],
    [
      "https://x.example/control",
      "must not contain control or text-direction characters",
    ],
    [
      "https://x.example/⁦isolate",
      "must not contain control or text-direction characters",
    ],
    // A lone high surrogate: not a control and not bidi, but the libsql
    // driver substitutes U+FFFD on write, so what is echoed and what is later
    // read would disagree (src/lib/media-rules.ts#LONE_SURROGATE).
    [
      "https://x.example/\uD800",
      "must not contain control or text-direction characters",
    ],
    // --- credentials, which read as one host and go to another ----------
    [
      "https://paypal.example@evil.example/pay",
      "must not carry a username or password",
    ],
    [
      "https://user:secret@x.example/a",
      "must not carry a username or password",
    ],
    // --- over the cap ---------------------------------------------------
    [
      `${"https://x.example/"}${"a".repeat(2048)}`,
      `must be at most ${MAX_COMMERCIAL_LINK_URL_LENGTH} characters`,
    ],
  ])("refuses %j", (input, fragment) => {
    const result = validateCommercialLinkUrl(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(fragment);
    // Not a table column, because this validator covers exactly one body
    // field and the answer is the same for every row. The network table
    // below does carry one, because that validator covers two.
    expect(result.field).toBe("url");
  });

  it("refuses a destination one character over the cap", () => {
    // The other side of the boundary accepted above, as its own case so the
    // off-by-one is pinned rather than covered by a string that is wildly
    // too long.
    const oneOver = urlOfLength(MAX_COMMERCIAL_LINK_URL_LENGTH + 1);
    expect(oneOver.length).toBe(MAX_COMMERCIAL_LINK_URL_LENGTH + 1);

    expect(validateCommercialLinkUrl(oneOver).ok).toBe(false);
  });

  it("measures the cap on the canonical form, not on what was submitted", () => {
    /*
     * The consequence of storing the canonical form: a submission AT the cap
     * whose percent-encoded form is OVER it is refused. One literal space
     * inside the path becomes `%20`, three characters, so the same string
     * that was accepted above is refused once one of its characters is a
     * space — same submitted length, two characters longer once stored.
     *
     * The space is INTERIOR, not trailing: a trailing one is removed by the
     * leading `.trim()` and the case would pass for the wrong reason.
     *
     * This is the assertion that fails if the cap is moved back onto the raw
     * input — which would leave the column holding values longer than the
     * number this module promises.
     */
    const exact = urlOfLength(MAX_COMMERCIAL_LINK_URL_LENGTH);
    const withSpace = `${exact.slice(0, 100)} ${exact.slice(101)}`;
    expect(withSpace.length).toBe(MAX_COMMERCIAL_LINK_URL_LENGTH);
    expect(withSpace.trim()).toBe(withSpace);

    expect(validateCommercialLinkUrl(withSpace).ok).toBe(false);
  });
});

describe("validateCommercialLinkNetwork (K5)", () => {
  it("lists exactly the networks the schema enum admits", () => {
    // The direction `satisfies readonly CommercialLinkNetwork[]` cannot catch:
    // a network added to prisma/schema.prisma and not to this list. The same
    // pairing BENEFIT_KINDS uses.
    expect([...COMMERCIAL_LINK_NETWORKS].sort()).toEqual(
      Object.keys(CommercialLinkNetwork).sort(),
    );
  });

  it("names Adtraction, the one §4 weeks 5-8 says to join first", () => {
    // Not a redundant restatement of the equality above: that one would pass
    // on any five names the schema happened to hold. docs/ugc-research.md §2
    // step 5 and §5.7 name these five, and §4 names Adtraction first.
    expect([...COMMERCIAL_LINK_NETWORKS]).toEqual([
      "ADTRACTION",
      "AWIN",
      "PARTNER_ADS",
      "TRADEDOUBLER",
      "ADRECORD",
      "OTHER",
    ]);
  });

  it.each(["ADTRACTION", "AWIN", "PARTNER_ADS", "TRADEDOUBLER", "ADRECORD"])(
    "accepts %s with no free text",
    (network) => {
      expect(validateCommercialLinkNetwork(network, undefined)).toEqual({
        ok: true,
        value: { network, networkOther: null },
      });
      expect(validateCommercialLinkNetwork(network, null)).toEqual({
        ok: true,
        value: { network, networkOther: null },
      });
    },
  );

  it("round-trips a sixth network as OTHER plus its name", () => {
    // K5: a network outside the five named ones, with an explicit marker and
    // free text, is recordable the day it is joined.
    expect(validateCommercialLinkNetwork("OTHER", "  Impact.com  ")).toEqual({
      ok: true,
      value: { network: "OTHER", networkOther: "Impact.com" },
    });
  });

  it("counts the free-text cap in code points, not UTF-16 units", () => {
    // An astral character is one character, not the two UTF-16 units it
    // occupies — the same counting MAX_BENEFIT_SOURCE_NAME_LENGTH uses. With
    // `.length` here, a name of exactly the cap made of astral characters
    // would be refused as if it were twice as long.
    const astral = "𝐀".repeat(MAX_COMMERCIAL_LINK_NETWORK_OTHER_LENGTH);
    expect(astral.length).toBe(MAX_COMMERCIAL_LINK_NETWORK_OTHER_LENGTH * 2);

    expect(validateCommercialLinkNetwork("OTHER", astral)).toEqual({
      ok: true,
      value: { network: "OTHER", networkOther: astral },
    });
  });

  /*
   * THE THIRD COLUMN IS THE `field`, and it is here because this validator is
   * the only one in the module that covers two body fields. The message and
   * the field have to name the SAME one: the field key exists so a caller can
   * find the input to correct: of the fourteen rows below, the first six are
   * about `network` and the remaining eight are about `networkOther`. The route
   * used to report `network` for every one of them, which this column would
   * have caught.
   */
  it.each([
    [undefined, undefined, "'network' must be one of", "network"],
    [null, undefined, "'network' must be one of", "network"],
    ["", undefined, "'network' must be one of", "network"],
    ["adtraction", undefined, "'network' must be one of", "network"],
    ["IMPACT", undefined, "'network' must be one of", "network"],
    [7, undefined, "'network' must be one of", "network"],
    // OTHER with nothing naming it: the marker without the fact is not a
    // recorded network, it is an unanswered question.
    ["OTHER", undefined, "'networkOther' must name the network", "networkOther"],
    ["OTHER", null, "'networkOther' must name the network", "networkOther"],
    ["OTHER", "", "'networkOther' must name the network", "networkOther"],
    ["OTHER", "   ", "'networkOther' must name the network", "networkOther"],
    ["OTHER", 7, "'networkOther' must name the network", "networkOther"],
    // The other half of the contradiction, refused rather than stripped.
    [
      "ADTRACTION",
      "Impact.com",
      "'networkOther' may only be set when 'network' is OTHER",
      "networkOther",
    ],
    // Free text goes through the same denylist as every other user-typed
    // string in this product.
    [
      "OTHER",
      "Impact‮moc.tcapmI",
      "must not contain control or text-direction characters",
      "networkOther",
    ],
    [
      "OTHER",
      "A".repeat(MAX_COMMERCIAL_LINK_NETWORK_OTHER_LENGTH + 1),
      `must be at most ${MAX_COMMERCIAL_LINK_NETWORK_OTHER_LENGTH} characters`,
      "networkOther",
    ],
  ])("refuses network %j with %j", (network, other, fragment, field) => {
    const result = validateCommercialLinkNetwork(network, other);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(fragment);
    expect(result.field).toBe(field);
    // A weaker cross-check than the column above, and deliberately kept
    // beside it: the message must at least quote the field it reports. It
    // only catches the direction where the message says nothing about the
    // reported field at all — `'network'` is a substring of the
    // `'networkOther'` messages too — so the column is what actually pins
    // the mapping, and this is what would survive the column being edited to
    // agree with a future bug.
    expect(result.message).toContain(`'${result.field}'`);
  });
});

describe("isCommercialLinkNetwork", () => {
  it.each([...COMMERCIAL_LINK_NETWORKS])("narrows %s", (network) => {
    expect(isCommercialLinkNetwork(network)).toBe(true);
  });

  it.each([undefined, null, "", "other", "IMPACT", 1, {}, ["AWIN"]])(
    "rejects %j",
    (value) => {
      expect(isCommercialLinkNetwork(value)).toBe(false);
    },
  );
});

describe("commercialLinkDisclosureRefusal (the validator half of K3)", () => {
  const LABEL = "Advertisement / Reklame";

  it("permits an item declaring a benefit under a permitted label", () => {
    expect(
      commercialLinkDisclosureRefusal({ benefitReceived: true, label: LABEL }),
    ).toBeNull();
  });

  it.each([
    // No row at all, and a row that does not declare a benefit: one state
    // said two ways, and both refuse.
    [null, "benefitReceived"],
    [undefined, "benefitReceived"],
    [{ benefitReceived: null, label: null }, "benefitReceived"],
    [{ benefitReceived: false, label: null }, "benefitReceived"],
    // A declared benefit whose label never came from the allowlist. The
    // near-misses matter most: this function reads a stored value and must
    // not accept one the validator would not have written.
    [{ benefitReceived: true, label: null }, "label"],
    [{ benefitReceived: true, label: "" }, "label"],
    [{ benefitReceived: true, label: "Ad" }, "label"],
    [{ benefitReceived: true, label: "reklame" }, "label"],
    [{ benefitReceived: true, label: " Reklame " }, "label"],
    [{ benefitReceived: true, label: "Advertisement" }, "label"],
  ])("refuses %j on field %s", (disclosure, field) => {
    const refusal = commercialLinkDisclosureRefusal(disclosure);

    expect(refusal).not.toBeNull();
    expect(refusal?.field).toBe(field);
  });

  it("is the inverse of the publish gate, not a copy of it", () => {
    /*
     * The one claim worth an assertion rather than a comment, because getting
     * it wrong is silent. `advertisingLabelPublishRefusal` returns null for
     * an item with no disclosure — such an item publishes perfectly well.
     * This one refuses it. If somebody ever "deduplicates" the two, an
     * unlabelled affiliate link becomes attachable (ugcportal-qnq9.2 K6).
     */
    expect(commercialLinkDisclosureRefusal(null)).not.toBeNull();
    expect(
      commercialLinkDisclosureRefusal({
        benefitReceived: false,
        label: null,
      }),
    ).not.toBeNull();
  });

  it("names every permitted label in the label refusal, so the fix is in the message", () => {
    const refusal = commercialLinkDisclosureRefusal({
      benefitReceived: true,
      label: "Ad",
    });

    expect(refusal?.error).toContain("Advertisement / Reklame");
    expect(refusal?.error).toContain("Annonse");
    // And never the one word ugcportal-qnq9.14 forbids everywhere, as a
    // standalone suggestion.
    expect(refusal?.error).not.toMatch(/(^|[\s,])Ad([\s,.]|$)/);
  });
});

/**
 * The § 3.2 rule after the attach (ugcportal-jain), at the level it is
 * decided: a link count and a stored label, no database.
 *
 * EVERY CASE RUNS OVER BOTH GATES, through `each`, rather than over one with
 * the other spot-checked. They share `carriesUnlabelledCommercialLink`
 * precisely so they cannot disagree about what the forbidden pair is, and a
 * test that exercised one would say nothing about whether the other still
 * called it — which is how a sibling guard in this repo passed its own
 * mutation test while covering half of what it claimed.
 */
const LABEL_GATES: [
  string,
  (label: string | null, count: number) => { error: string } | null,
][] = [
  [
    "disclosureWithdrawalRefusal",
    (label, count) =>
      disclosureWithdrawalRefusal(label, { commercialLinkCount: count }),
  ],
  [
    "commercialLinkPublishRefusal",
    (label, count) =>
      commercialLinkPublishRefusal(
        { benefitReceived: true, label },
        { commercialLinkCount: count },
      ),
  ],
];

describe("the label-and-link pair (ugcportal-jain)", () => {
  const PERMITTED = PERMITTED_ADVERTISING_LABELS[0];

  describe.each(LABEL_GATES)("%s", (_name, gate) => {
    it.each([1, 2, MAX_COMMERCIAL_LINKS_PER_ITEM])(
      "refuses %i unlabelled link(s)",
      (count) => {
        expect(gate(null, count)).not.toBeNull();
      },
    );

    it.each(PERMITTED_ADVERTISING_LABELS)(
      "permits a link under the permitted label %s",
      (label) => {
        // OVER THE WHOLE ALLOWLIST, not one member of it: the gate calls
        // `isPermittedAdvertisingLabel`, and a mistake that recognised only
        // the first entry would pass a single-label test while refusing
        // three lawful disclosures.
        expect(gate(label, 1)).toBeNull();
      },
    );

    it.each([
      ["a near-miss of a permitted label", "reklame"],
      ["a permitted label with stray spacing", " Reklame "],
      ["an English-only label", "Advertisement"],
      ["an empty string", ""],
      ["a label nobody validated", "Sponsored"],
    ])("refuses a link under %s", (_name, label) => {
      // RE-VALIDATED against the closed allowlist, not checked for being
      // non-null — the same reading `toAdvertisingLabel` and
      // `listPublicMedia` make, so the gate refuses exactly the rows the
      // renderer would hide. A `!== null` check would pass all five of these.
      expect(gate(label, 1)).not.toBeNull();
    });

    it("says nothing about an item carrying no link at all", () => {
      // The counterweight. Without it every refusal above would hold just as
      // well against a gate that refused every unlabelled item, links or no
      // links — which would make an ordinary undisclosed photograph
      // unpublishable.
      expect(gate(null, 0)).toBeNull();
    });

    it("says nothing about a labelled item carrying no link", () => {
      expect(gate(PERMITTED, 0)).toBeNull();
    });
  });

  it.each([undefined, null])(
    "treats a %j label as unlabelled at the publish gate",
    (label) => {
      // `undefined` is the no-disclosure-row case, which the publish route
      // really does produce (`findUnique` answers null and the parameter is
      // optional). `isPermittedAdvertisingLabel` is a `typeof` check, so both
      // land on the unlabelled side rather than falling through a `=== null`.
      const disclosure =
        label === undefined ? null : { benefitReceived: null, label };
      expect(
        commercialLinkPublishRefusal(disclosure, { commercialLinkCount: 1 }),
      ).not.toBeNull();
    },
  );

  it("ignores benefitReceived at the publish gate", () => {
    // GATED ON THE LABEL ALONE, deliberately, unlike
    // `commercialLinkDisclosureRefusal` above. What a reader of the public
    // page sees is the label column and nothing else (`toAdvertisingLabel`,
    // src/lib/gallery-items.ts), so a row with a permitted label is a
    // labelled page whatever `benefitReceived` says — and a row without one
    // is not, whatever it says. Both directions asserted, because an
    // implementation that read the field would get exactly one of them wrong.
    for (const benefitReceived of [true, false, null]) {
      expect(
        commercialLinkPublishRefusal(
          { benefitReceived, label: PERMITTED },
          { commercialLinkCount: 1 },
        ),
        `a permitted label with benefitReceived ${benefitReceived} was refused`,
      ).toBeNull();
      expect(
        commercialLinkPublishRefusal(
          { benefitReceived, label: null },
          { commercialLinkCount: 1 },
        ),
        `an absent label with benefitReceived ${benefitReceived} was permitted`,
      ).not.toBeNull();
    }
  });

  it("names the detach request in the withdrawal refusal, so the fix is in the message", () => {
    const refusal = disclosureWithdrawalRefusal(null, {
      commercialLinkCount: 1,
    });

    expect(refusal?.error).toContain(
      "DELETE /api/media/[id]/commercial-links",
    );
    // A closed-set code rather than a `field`: no edit to the request body
    // would make it succeed.
    expect(refusal?.blocker).toBe("commercial_links_attached");
  });

  it("names every permitted label in the publish refusal, and the field is not the sibling gate's", () => {
    const refusal = commercialLinkPublishRefusal(
      { benefitReceived: false, label: null },
      { commercialLinkCount: 1 },
    );

    for (const label of PERMITTED_ADVERTISING_LABELS) {
      expect(refusal?.error).toContain(label);
    }
    // `advertisingLabelPublishRefusal` answers `advertisingLabel` on the same
    // route; two gates answering one `field` would be two refusals nothing
    // could tell apart.
    expect(refusal?.field).toBe("commercialLinks");
    expect(refusal?.field).not.toBe("advertisingLabel");
  });

  it("is one predicate, which both gates read", () => {
    // `carriesUnlabelledCommercialLink` is exported so this can be asserted
    // rather than described: both refusals must be exactly its answer over
    // every combination, or the rule has two spellings that can drift.
    for (const label of [null, "", "reklame", PERMITTED]) {
      for (const commercialLinkCount of [0, 1, MAX_COMMERCIAL_LINKS_PER_ITEM]) {
        const expected = carriesUnlabelledCommercialLink(label, {
          commercialLinkCount,
        });
        for (const [name, gate] of LABEL_GATES) {
          expect(
            gate(label, commercialLinkCount) !== null,
            `${name} disagreed about ${JSON.stringify(label)} with ${commercialLinkCount} link(s)`,
          ).toBe(expected);
        }
      }
    }
  });
});
