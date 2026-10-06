import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PORTFOLIO_PATH, UPLOAD_PATH } from "@/lib/routes";

import { Hero } from "./hero";

/**
 * ugcportal-qqnt.4 K2: the hero's one call to action tracks the CURRENT
 * visitor's session state, nothing else — signed out, straight to the
 * portfolio (PORTFOLIO_PATH); signed in, straight to /upload. There is no
 * sign-in link in the hero any more (that control lives in the header only,
 * ugcportal-qqnt.3), so unlike the version this replaces there is no third
 * href to distinguish.
 *
 * `Hero` is a plain, synchronous component taking `signedIn` as a prop (see
 * its own comment for why), so this is a trivial, un-mocked render — no
 * `vi.mock("@/lib/auth", ...)` needed at all, unlike
 * src/components/upload-nav-link.test.tsx and
 * src/components/auth-status.test.tsx, which test components that resolve
 * the session themselves.
 */
function render(signedIn: boolean): string {
  return renderToStaticMarkup(<Hero signedIn={signedIn} />);
}

/** Every `href="..."` value in a markup string, in order of appearance. */
function hrefsOf(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
}

describe("Hero (ugcportal-qqnt.4)", () => {
  it("K2: signed out, the only link in the hero points to the portfolio", () => {
    const markup = render(false);

    expect(hrefsOf(markup)).toEqual([PORTFOLIO_PATH]);
    expect(markup).toContain("See the portfolio");
    expect(markup).not.toContain(`href="${UPLOAD_PATH}"`);
    expect(markup).not.toMatch(/sign in/i);
  });

  it("K2: signed in, the only link in the hero points to /upload", () => {
    const markup = render(true);

    expect(hrefsOf(markup)).toEqual([UPLOAD_PATH]);
    expect(markup).toContain("Upload");
    expect(markup).not.toContain(`href="${PORTFOLIO_PATH}"`);
    expect(markup).not.toMatch(/sign in/i);
  });

  it("renders a title and a lead paragraph", () => {
    const markup = render(false);

    expect(markup).toContain("Real photos of the things you actually use.");
    expect(markup).toMatch(/<p[^>]*>[^<]*growing gallery/);
  });

  /*
   * K2: "at most 25 words" and "no em-dash" — checked against the lead
   * paragraph's own visible text, stripped of markup, not the whole page
   * (which also carries the title and the CTA label).
   */
  function leadText(markup: string): string {
    const match = /<p[^>]*>([^<]*)<\/p>/.exec(markup);
    if (!match) throw new Error(`no <p> lead paragraph found in: ${markup}`);
    return match[1].replace(/\s+/g, " ").trim();
  }

  it("K2: the lead has at most 25 words and contains no em-dash, for both session states", () => {
    for (const signedIn of [false, true]) {
      const lead = leadText(render(signedIn));
      const wordCount = lead.split(" ").filter(Boolean).length;
      expect(wordCount, `lead ("${lead}") has ${wordCount} words`).toBeLessThanOrEqual(25);
      expect(lead).not.toContain("—");
      expect(lead).not.toContain("--");
    }
  });

  /*
   * K4: no stock photo or third-party image in the hero. Checks for the
   * absence of an <img> element AND of any `url(...)` reference inside a
   * `style` attribute or class name that points outside this app's own
   * origin — a background image set via inline style would not show up as
   * an <img> at all.
   */
  it("K4: renders no <img>, and no background-image url() pointing outside the app's own origin", () => {
    const markup = render(false);

    expect(markup).not.toMatch(/<img\b/i);

    const urls = [...markup.matchAll(/url\(([^)]+)\)/g)].map((match) =>
      match[1].replace(/^['"]|['"]$/g, ""),
    );
    for (const url of urls) {
      expect(
        /^(data:|#|\/(?!\/))/.test(url) || url.startsWith("var("),
        `unexpected external-looking url(): ${url}`,
      ).toBe(true);
    }
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand while writing this test, not
   * left in the suite): temporarily changed `signedIn` to always route to
   * UPLOAD_PATH regardless of the prop, confirmed the "signed out" test
   * above failed with the real assertion message, then reverted. See the PR
   * description for the full list of these checks across this bead.
   */

  /*
   * ugcportal-oavb: the forced-colors focus-outline fix moved from a scoped
   * `FORCED_COLORS_FOCUS_OUTLINE` override on this component to
   * `buttonVariants`' own shared base (src/components/ui/button.tsx), so
   * there is no longer anything CTA-specific to assert here — the base-level
   * guard (src/components/ui/button.test.ts's "no bare outline-none without
   * a forced-colors-visible outline") and the real e2e coverage
   * (e2e/front-page.spec.ts's "forced colors: focus stays visible..." suite)
   * are what actually prove this now, for every button-like control,
   * including this one. A per-component unit test duplicating that same
   * base-level fact would just be testing `buttonVariants` a second time
   * through an extra layer, not this component.
   */
});
