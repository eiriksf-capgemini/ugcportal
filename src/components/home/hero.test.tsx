import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UPLOAD_PATH, signInPath } from "@/lib/routes";

import { Hero } from "./hero";

/**
 * ugcportal-6dvg K1: the hero's one call to action tracks the CURRENT
 * visitor's session state, nothing else.
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

const SIGN_IN_HREF = signInPath(UPLOAD_PATH);

describe("Hero (ugcportal-6dvg)", () => {
  it("K1: signed out, the call to action leads to sign-in (with an upload callback)", () => {
    const markup = render(false);

    expect(markup).toContain(`href="${SIGN_IN_HREF}"`);
    expect(markup).toContain("Sign in to upload");
    expect(markup).not.toContain(`href="${UPLOAD_PATH}"`);
  });

  it("K1: signed in, the call to action leads straight to /upload", () => {
    const markup = render(true);

    expect(markup).toContain(`href="${UPLOAD_PATH}"`);
    expect(markup).not.toContain(SIGN_IN_HREF);
    expect(markup).not.toContain("Sign in to upload");
  });

  it("renders a title and a lead paragraph", () => {
    const markup = render(false);

    expect(markup).toContain("Real photos of the things you actually use.");
    expect(markup).toMatch(/<p[^>]*>[^<]*growing gallery/);
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
});
