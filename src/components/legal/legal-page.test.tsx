// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { textContent } from "@/lib/legal/legal-page.test-support";

import { DRAFT_META_NAME, LegalList, LegalProse, legalMetadata } from "./legal-page";

/**
 * ugcportal-qnq9.4: the pieces of the legal frame that take a decision as
 * input. The pages' own tests cover the frame end to end.
 */

describe("legalMetadata", () => {
  it("marks a draft and hides it from indexing", () => {
    const metadata = legalMetadata("Privacy", true);
    expect(metadata.title).toBe("Privacy");
    expect(metadata.other).toEqual({ [DRAFT_META_NAME]: "true" });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("carries neither once the page is no longer a draft", () => {
    // Absence IS the signal ugcportal-akv6's guard will read, so this must be
    // an absent key, not a "false".
    const metadata = legalMetadata("Privacy", false);
    expect(metadata).toEqual({ title: "Privacy" });
    expect(metadata.other).toBeUndefined();
  });
});

describe("LegalList and LegalProse", () => {
  it("renders items as list items, before the paragraphs, under the section's test id", () => {
    const markup = renderToStaticMarkup(
      <LegalProse
        testIdPrefix="t"
        section={{
          id: "s",
          title: "Title <1>",
          items: ["one & two", "three"],
          paragraphs: ["after"],
          reviewAgainst: [],
        }}
      />,
    );
    expect(markup).toContain('data-testid="t-s"');
    const text = textContent(markup);
    expect(text).toContain("Title <1>");
    expect(text.indexOf("three")).toBeLessThan(text.indexOf("after"));
    expect(Array.from(markup.matchAll(/<li>/g))).toHaveLength(2);
  });

  it("renders two identical items without collapsing them", () => {
    // Position keys (PR #90 round 1): a text key would have collided here.
    const markup = renderToStaticMarkup(<LegalList items={["same", "same"]} />);
    expect(Array.from(markup.matchAll(/<li>same<\/li>/g))).toHaveLength(2);
  });
});
