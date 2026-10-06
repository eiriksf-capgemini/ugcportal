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
 * copy here means an edit to SITE_NAME/ABOUT_PATH that silently drops
 * English content, reintroduces Norwegian, or points "About" at the wrong
 * route is a test failure named in THIS diff rather than a change this
 * suite cannot see. SITE_TAGLINE no longer renders in the header
 * (ugcportal-qqnt.3 moved it to the footer - see site-footer.test.tsx) so it
 * is not pinned here any more either.
 */
const EXPECTED_SITE_NAME = "UGC Portal";
const EXPECTED_ABOUT_PATH = "/about";

/**
 * ugcportal-14k9: the header's wordmark and navigation (one row, no tagline,
 * since ugcportal-qqnt.3).
 *
 * UploadNavLink and AuthStatus are stubbed out, the same way and for the
 * same reason app-shell.nav.test.tsx stubs them when testing AppShell's own
 * structure: both are real async Server Components, and this repo's
 * `renderToStaticMarkup` cannot resolve one nested, un-awaited, inside a
 * parent tree it is walking synchronously (confirmed empirically there).
 * This file is about the header's own static structure - the nav, the
 * wordmark, the mobile toggle - not about either stub's own gating logic,
 * which each already has its own dedicated test file.
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

  /**
   * PR #94 review round 6, finding 5: this absorbs app-shell.nav.test.tsx's
   * own former "places the nav slot between the wordmark and the auth
   * widget" test, which checked the SAME ordering relationship but via two
   * layers of indirection (AppShell renders `<SiteHeader />`, which is what
   * actually produces this order) and a narrower middle element (only
   * `UploadNavLink`'s own "Primary" landmark, not the main nav this bead
   * added). That file no longer asserts anything about header-internal
   * ordering at all; this is the one place it is checked now, for every
   * landmark in the row, not just two of them.
   */
  it("places the main nav, the mobile toggle, and the upload link between the wordmark and the auth widget", () => {
    const markup = renderHeader();
    const wordmark = markup.indexOf(`>${EXPECTED_SITE_NAME}<`);
    const nav = markup.indexOf('aria-label="Main navigation"');
    const uploadNav = markup.indexOf('data-testid="upload-nav-stub"');
    const auth = markup.indexOf('data-testid="auth-stub"');

    expect(wordmark, "wordmark not found").toBeGreaterThan(-1);
    expect(nav, "main nav not found").toBeGreaterThan(-1);
    expect(uploadNav, "upload nav stub not found").toBeGreaterThan(-1);
    expect(auth, "auth stub not found").toBeGreaterThan(-1);

    expect(nav).toBeGreaterThan(wordmark);
    expect(uploadNav).toBeGreaterThan(nav);
    expect(auth).toBeGreaterThan(uploadNav);
  });

  it("renders exactly one header landmark", () => {
    const markup = renderHeader();

    expect([...markup.matchAll(/<header\b/g)]).toHaveLength(1);
  });

  /**
   * K1 (ugcportal-qqnt.3): the wordmark's own class list carries a bigger,
   * display-leaning treatment than the nav links - `font-heading`/`text-lg`,
   * neither of which HEADER_NAV_LINK_CLASS (the nav links' shared base
   * class) sets. The wordmark's own `<a>` is the FIRST anchor in the whole
   * markup (it renders before the main nav), so matching the opening tag of
   * the first `<a>` in document order reaches it without needing a more
   * complex extraction.
   */
  it("K1: the wordmark carries font-heading and a larger text size than the nav links", () => {
    const markup = renderHeader();
    const firstAnchorMatch = /<a\b([^>]*)>/.exec(markup);

    expect(firstAnchorMatch, "no <a> found in the header markup").not.toBeNull();
    const wordmarkAttrs = firstAnchorMatch?.[1] ?? "";
    expect(wordmarkAttrs).toContain("font-heading");
    expect(wordmarkAttrs).toContain("text-lg");

    const navMatch = /<nav aria-label="Main navigation"[^>]*>([\s\S]*?)<\/nav>/.exec(markup);
    const navLinkMatch = /<a([^>]*)>Gallery<\/a>/.exec(navMatch?.[1] ?? "");
    expect(navLinkMatch, "Gallery nav link not found").not.toBeNull();
    const navLinkAttrs = navLinkMatch?.[1] ?? "";
    expect(navLinkAttrs).not.toContain("font-heading");
    expect(navLinkAttrs).toContain("text-sm");
  });

  /**
   * K1: the mockup's petrol brand mark (docs/design/forside.html's
   * `.brand-mark`), decorative. The exact 28px figure is compiled and
   * checked in src/components/site-header.height.test.ts, not here - this
   * test only pins that the decorative, petrol-filled span exists.
   */
  it("K1: a decorative brand mark renders beside the wordmark", () => {
    const markup = renderHeader();

    expect(markup).toMatch(/<span aria-hidden="true" class="[^"]*\bbg-primary\b[^"]*"/);
  });

  /** ugcportal-qqnt.3: the tagline row is gone - SITE_TAGLINE moved to the footer. */
  it("no longer renders the tagline - SITE_TAGLINE moved to the footer", () => {
    const markup = renderHeader();

    expect(markup).not.toContain("Original photography");
  });
});
