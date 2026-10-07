import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_LINK_MARKER_TEXT,
  COMMERCIAL_LINK_REL,
  commercialLinkRel,
  commercialLinkText,
} from "@/lib/commercial-link-render";

/**
 * src/lib/commercial-link-render.ts (ugcportal-qnq9.2.2 K1/K2), with no
 * database — the module imports no Prisma client, the same claim
 * src/lib/commercial-link.ts makes for itself.
 */

describe("commercialLinkRel (K2)", () => {
  it("is exactly 'sponsored nofollow noopener noreferrer'", () => {
    expect(commercialLinkRel()).toBe("sponsored nofollow noopener noreferrer");
  });

  it("the exported constant and the function agree — one source, not two", () => {
    expect(COMMERCIAL_LINK_REL).toBe(commercialLinkRel());
  });

  it("carries every required token, and nothing else", () => {
    expect(commercialLinkRel().split(" ").sort()).toEqual(
      ["nofollow", "noopener", "noreferrer", "sponsored"].sort(),
    );
  });
});

describe("COMMERCIAL_LINK_MARKER_TEXT", () => {
  it("is the exact bilingual string the bead names", () => {
    expect(COMMERCIAL_LINK_MARKER_TEXT).toBe("Advertisement link / Annonselenke");
  });
});

describe("commercialLinkText", () => {
  it.each([
    ["ADTRACTION", "Adtraction"],
    ["AWIN", "Awin"],
    ["PARTNER_ADS", "Partner-Ads"],
    ["TRADEDOUBLER", "Tradedoubler"],
    ["ADRECORD", "Adrecord"],
  ])("renders %s as %s", (network, expected) => {
    expect(commercialLinkText({ network, networkOther: null })).toBe(expected);
  });

  it("renders OTHER's own free-text name", () => {
    expect(
      commercialLinkText({ network: "OTHER", networkOther: "Lokalbutikken AS" }),
    ).toBe("Lokalbutikken AS");
  });

  it("falls back to a generic noun for OTHER with a blank name", () => {
    expect(commercialLinkText({ network: "OTHER", networkOther: "   " })).toBe(
      "Shop this link",
    );
    expect(commercialLinkText({ network: "OTHER", networkOther: null })).toBe(
      "Shop this link",
    );
  });

  it("falls back to a generic noun for an unrecognised network — a row that did not pass the validator", () => {
    expect(commercialLinkText({ network: "NOT_A_NETWORK", networkOther: null })).toBe(
      "Shop this link",
    );
    expect(commercialLinkText({ network: undefined, networkOther: null })).toBe(
      "Shop this link",
    );
  });

  it("re-screens networkOther for unsafe text, the same denylist the write path used", () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) would otherwise reverse the reading
    // order of whatever text follows it on the page.
    expect(
      commercialLinkText({ network: "OTHER", networkOther: "Acme‮gnip" }),
    ).toBe("Shop this link");
  });
});
