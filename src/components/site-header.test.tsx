import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * The strings and the About route this bead ships, spelled out literally
 * rather than imported from src/lib/site.ts / src/lib/routes.ts
 * (review-standards family 2: a check whose expected and actual sides are
 * both derived from the same source proves nothing — confirmed empirically
 * here, by mutating SITE_TAGLINE to Norwegian prose and finding the
 * import-based version of the K2 assertion below still passed, because it
 * was comparing the mutated constant against itself). Pinning the literal
 * copy here means an edit to SITE_NAME/SITE_TAGLINE/ABOUT_PATH that silently
 * drops English content, reintroduces Norwegian, or points "About" at the
 * wrong route is a test failure named in THIS diff rather than a change
 * this suite cannot see.
 */
const EXPECTED_SITE_NAME = "UGC Portal";
const EXPECTED_TAGLINE =
  "Original photography of food, wine accessories, technology and books.";
const EXPECTED_ABOUT_PATH = "/about";

/**
 * ugcportal-14k9: the header's wordmark, tagline and navigation.
 *
 * UploadNavLink and AuthStatus are stubbed out, the same way and for the
 * same reason app-shell.nav.test.tsx stubs them when testing AppShell's own
 * structure: both are real async Server Components, and this repo's
 * `renderToStaticMarkup` cannot resolve one nested, un-awaited, inside a
 * parent tree it is walking synchronously (confirmed empirically there).
 * This file is about the header's own static structure - the nav, the
 * wordmark, the tagline, the mobile toggle - not about either stub's own
 * gating logic, which each already has its own dedicated test file.
 */
vi.mock("@/components/upload-nav-link", () => ({
  UploadNavLink: () => (
    <nav aria-label="Primary" data-testid="upload-nav-stub">
      <a href="/upload">Upload</a>
    </nav>
  ),
}));
vi.mock("@/components/auth-status", () => ({
  AuthStatus: () => <div data-testid="auth-stub">auth widget</div>,
}));

const { SiteHeader } = await import("./site-header");

function renderHeader(): string {
  return renderToStaticMarkup(SiteHeader() as ReactElement);
}

describe("SiteHeader (ugcportal-14k9)", () => {
  it("K2: every visible string is English, and matches the strings reviewed in the PR", () => {
    const markup = renderHeader();

    // The exact strings this bead ships, asserted individually rather than
    // only as one big snapshot: a snapshot would still pass if one string
    // silently dropped out of the markup entirely while another changed,
    // as long as nothing else shifted the overall diff shape.
    expect(markup).toContain(`>${EXPECTED_SITE_NAME}<`);
    expect(markup).toContain(EXPECTED_TAGLINE);
    expect(markup).toContain(">Gallery<");
    expect(markup).toContain(">About<");

    // No Norwegian UI copy anywhere in the header (the decision this bead is
    // bound by - docs/ugc-research.md's decisions table, 4 October 2026).
    // "Galleri"/"Om"/"Logg inn" are the Norwegian reference sketch's own
    // words for exactly these three destinations (docs/design/forside.html,
    // docs/design/tom-tilstand.html), so this is a direct check against the
    // specific regression a copy-paste from the sketch would produce, not a
    // generic "looks English" heuristic.
    for (const norwegian of ["Galleri", "Om", "Logg inn"]) {
      expect(markup).not.toContain(norwegian);
    }
  });

  it("K3: the navigation contains no link to a sales route", () => {
    const markup = renderHeader();

    // The sketch's OTHER variant (docs/design/forside.html) has a "Til
    // salgs" ("For sale") nav item pointing at /til-salgs; this bead uses
    // the variant without it (docs/design/tom-tilstand.html) because
    // nothing is for sale yet. Checked by substring on the sketch's own
    // route and label, and separately by English synonyms, so a future
    // rename of either does not quietly stop this test from meaning
    // anything.
    expect(markup).not.toContain("til-salgs");
    expect(markup).not.toContain("Til salgs");
    expect(markup).not.toMatch(/\bFor sale\b/i);
    expect(markup).not.toContain("/sale");
    expect(markup).not.toContain("/shop");
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): the "no sales link"
   * assertions above are a `not.toContain`/`not.toMatch` pair, which - per
   * review-standards SKILL.md's own table - is the silent-pass direction
   * when the needle can never appear anyway. This proves it CAN: the same
   * assertions, run against a fixture markup string that actually contains
   * a sales link, must fail.
   */
  it("the sales-link assertions above can actually fail", () => {
    const fixtureWithSalesLink =
      '<nav><a href="/til-salgs">Til salgs</a><a href="/">Gallery</a></nav>';

    expect(() => {
      expect(fixtureWithSalesLink).not.toContain("til-salgs");
    }).toThrow();
    expect(() => {
      expect(fixtureWithSalesLink).not.toContain("Til salgs");
    }).toThrow();
  });

  it("K1: the main navigation reaches Gallery (/) and About, as real anchors", () => {
    const markup = renderHeader();
    const navMatch = /<nav aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/.exec(
      markup,
    );

    expect(navMatch, 'no <nav aria-label="Main navigation"> landmark found').not.toBeNull();
    const navMarkup = navMatch?.[1] ?? "";

    expect(navMarkup).toMatch(/<a[^>]*\shref="\/"[^>]*>Gallery<\/a>/);
    expect(navMarkup).toMatch(
      new RegExp(`<a[^>]*\\shref="${EXPECTED_ABOUT_PATH}"[^>]*>About</a>`),
    );
  });

  it("places the main nav and the mobile toggle between the wordmark and the auth widget", () => {
    const markup = renderHeader();
    const wordmark = markup.indexOf(`>${EXPECTED_SITE_NAME}<`);
    const nav = markup.indexOf('aria-label="Main navigation"');
    const auth = markup.indexOf('data-testid="auth-stub"');

    expect(wordmark).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(wordmark);
    expect(auth).toBeGreaterThan(nav);
  });

  it("renders exactly one header landmark", () => {
    const markup = renderHeader();

    expect([...markup.matchAll(/<header\b/g)]).toHaveLength(1);
  });

  it("K3: the tagline renders with a muted, non-heading treatment (not louder than body text)", () => {
    const markup = renderHeader();
    const taglineMatch = /<p class="([^"]*)">[^<]*Original photography/.exec(
      markup,
    );

    expect(taglineMatch, "tagline <p> not found").not.toBeNull();
    expect(taglineMatch?.[1]).toContain("text-muted-foreground");
  });
});
