import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stripComments } from "@/lib/design/scan-source";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_HEADER_PATH = path.join(HERE, "site-header.tsx");

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
 * which each already has its own dedicated test file (upload-nav-link.test.tsx
 * covers UploadNavLink's real session gate; this file only needs it to stand
 * in for "signed in" or "signed out" deterministically).
 *
 * `uploadNavStubShowsItem` (ugcportal-i7lr): toggled per test so this one
 * stub can stand in for both of UploadNavLink's real, all-or-nothing outputs
 * - the real component's own contract (upload-nav-link.tsx's doc comment,
 * and upload-nav-link.test.tsx's K1/K2) - without this file needing to mock
 * a session at all.
 */
let uploadNavStubShowsItem = true;
vi.mock("@/components/upload-nav-link", () => ({
  UploadNavLink: () =>
    uploadNavStubShowsItem ? (
      <li data-testid="upload-nav-stub">
        <a href="/upload">Upload</a>
      </li>
    ) : null,
}));
vi.mock("@/components/auth-status", () => ({
  AuthStatus: () => <div data-testid="auth-stub">auth widget</div>,
}));

const { SiteHeader } = await import("./site-header");

function renderHeader(): string {
  return renderToStaticMarkup(SiteHeader() as ReactElement);
}

beforeEach(() => {
  uploadNavStubShowsItem = true;
});

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
   *
   * ugcportal-0sdf K1: the description above has named "the mobile toggle"
   * since PR #94 review round 6, but nothing below actually located it in
   * the markup — the toggle could move anywhere in the row (including after
   * AuthStatus) without this test noticing. The toggle itself carries no
   * `data-testid`; its accessible, sr-only "Open menu" label (see
   * mobile-nav-toggle.tsx) is the one static-markup marker that is already
   * part of this component's real contract (e2e/header.spec.ts's
   * `getByRole("button", { name: "Open menu" })` depends on the same text),
   * so it is used here the same way the wordmark and auth stub already are.
   *
   * MUTATION (performed once, verified, and reverted — not left in the
   * tree): moved `<MobileNavToggle items={NAV_ITEMS} />` in site-header.tsx
   * to just before `<AuthStatus />` (after `<UploadNavLink />`, inside the
   * `ml-auto` wrapper) — i.e. "moving MobileNavToggle after AuthStatus" per
   * ugcportal-0sdf's own premise note. Confirmed this `toggle`/`nav`
   * assertion is the one that catches it: with the toggle relocated,
   * `expect(nav).toBeGreaterThan(toggle)` failed with
   * "expected 541 to be greater than 2765" (the nav landmark now renders at
   * markup index 541, before the relocated toggle at 2765), while the rest
   * of the suite (8/9 tests, none referencing the toggle's own position)
   * stayed green. Separately, the `toggle` lookup's own "not found" guard
   * was checked by renaming mobile-nav-toggle.tsx's closed-state label from
   * "Open menu" to "Open navigation menu": this test failed with
   * `mobile toggle (sr-only "Open menu" label) not found`, as expected for
   * an indexOf-based marker whose text changed. Both mutations reverted
   * immediately after.
   */
  it("places the mobile toggle (right after the wordmark), the main nav, and the upload link between the wordmark and the auth widget", () => {
    const markup = renderHeader();
    const wordmark = markup.indexOf(`>${EXPECTED_SITE_NAME}<`);
    const toggle = markup.indexOf(">Open menu<");
    const nav = markup.indexOf('aria-label="Main navigation"');
    const uploadNav = markup.indexOf('data-testid="upload-nav-stub"');
    const auth = markup.indexOf('data-testid="auth-stub"');

    expect(wordmark, "wordmark not found").toBeGreaterThan(-1);
    expect(toggle, "mobile toggle (sr-only \"Open menu\" label) not found").toBeGreaterThan(-1);
    expect(nav, "main nav not found").toBeGreaterThan(-1);
    expect(uploadNav, "upload nav stub not found").toBeGreaterThan(-1);
    expect(auth, "auth stub not found").toBeGreaterThan(-1);

    // ugcportal-0sdf K1: the toggle's own position, relative to the brand
    // mark (wordmark) and the nav it stands in for below `md` — not just
    // the landmarks on either side of the whole cluster.
    expect(toggle).toBeGreaterThan(wordmark);
    expect(nav).toBeGreaterThan(toggle);

    expect(nav).toBeGreaterThan(wordmark);
    expect(uploadNav).toBeGreaterThan(nav);
    expect(auth).toBeGreaterThan(uploadNav);
  });

  /**
   * ugcportal-i7lr K1: a signed-in visitor's header used to expose TWO nav
   * landmarks - this file's own "Main navigation" and UploadNavLink's own
   * "Primary", holding only the Upload link (see upload-nav-link.tsx's old
   * shape, and this file's own pre-merge mock, which wrapped the stub in
   * exactly that second `<nav>`). UploadNavLink now returns a bare `<li>`
   * instead (upload-nav-link.test.tsx covers that contract on the real
   * component directly); this is the other half - that site-header.tsx's own
   * markup never wraps a second `<nav>` around it, so there is exactly one
   * landmark, with the stub's "Upload" anchor nested inside it as an
   * ordinary list item.
   *
   * THE FIXTURE MUTATION: re-wrapped this file's own stub back in its old
   * `<nav aria-label="Primary">...</nav>` (reverting this bead's change to
   * the mock above) and reran this test by hand: `navTags` had length 2, so
   * `toHaveLength(1)` failed before the descendant checks were even reached.
   * Reverted immediately after.
   */
  it("K1: exactly one nav landmark in the header, with Upload a descendant of it", () => {
    const markup = renderHeader();
    const navTags = [...markup.matchAll(/<nav\b[^>]*>/g)];

    expect(navTags).toHaveLength(1);

    const navOpenIndex = navTags[0].index ?? -1;
    const navCloseIndex = markup.indexOf("</nav>", navOpenIndex);
    expect(navOpenIndex).toBeGreaterThan(-1);
    expect(navCloseIndex).toBeGreaterThan(navOpenIndex);

    const uploadEntryIndex = markup.indexOf('data-testid="upload-nav-stub"');
    expect(uploadEntryIndex, "Upload entry not found").toBeGreaterThan(-1);
    expect(uploadEntryIndex).toBeGreaterThan(navOpenIndex);
    expect(uploadEntryIndex).toBeLessThan(navCloseIndex);
  });

  /**
   * ugcportal-i7lr K2: a signed-out visitor must see no Upload entry AND no
   * stray empty `<li>` left in its place - the all-or-nothing contract
   * upload-nav-link.tsx's own comment describes, and that file's own test
   * suite's K2 covers for the real component resolving to `null`. This is
   * the other half: that site-header.tsx splices in whatever UploadNavLink
   * actually returns rather than always rendering a wrapper `<li>` around it
   * regardless.
   *
   * THE FIXTURE MUTATION, on the guard itself: `/<li>\s*<\/li>/` must match
   * a genuinely empty list item, confirmed inline below against a literal
   * `"<li></li>"` fixture, so the "no empty <li>" assertion above it is not
   * vacuously true against markup that could never contain one.
   */
  it("K2: signed out - no Upload entry, and no empty <li> in its place", () => {
    uploadNavStubShowsItem = false;
    const markup = renderHeader();

    expect(markup).not.toContain('href="/upload"');
    expect(markup).not.toContain('data-testid="upload-nav-stub"');
    expect(markup).not.toMatch(/<li>\s*<\/li>/);
    expect([...markup.matchAll(/<nav\b[^>]*>/g)]).toHaveLength(1);

    expect("<li></li>").toMatch(/<li>\s*<\/li>/);
  });

  /**
   * ugcportal-i7lr K3: "the mobile toggle loses its items, or the desktop
   * and mobile lists drift apart, because the merge touched one and not the
   * other." Neither half of that is observable through renderToStaticMarkup
   * here - MobileNavToggle's own popover panel is unmounted while closed
   * (confirmed by mobile-nav-toggle.test.tsx's own "starts closed" test), so
   * a static render of this header never shows the mobile panel's contents
   * at all. This checks the one thing that actually prevents the drift: that
   * site-header.tsx's own SOURCE passes the identical `NAV_ITEMS` binding to
   * both the desktop `.map()` and `<MobileNavToggle items={NAV_ITEMS}>`, and
   * the identical `<UploadNavLink />` element - written once per call site,
   * not two independently-maintained copies that merely happen to agree
   * today - to both the desktop `<ul>` and MobileNavToggle's own `children`
   * slot. Whether that `children` slot itself actually renders what it's
   * given, after the mapped items, once the panel opens, is that
   * component's own dedicated test file's job, with a real DOM and a real
   * click - this file cannot open anything.
   *
   * THE FIXTURE MUTATION: performed by hand against two separate copies of
   * site-header.tsx. First, a SECOND, independently-defined
   * `const MOBILE_NAV_ITEMS = [{ href: "/", label: "Gallery" }];` (dropping
   * About) passed to `<MobileNavToggle items={MOBILE_NAV_ITEMS}>` instead of
   * `NAV_ITEMS` - exactly the "merge touched one and not the other" drift
   * K3 names. The `items={NAV_ITEMS}` assertion below failed against that
   * copy (the source reads `items={MOBILE_NAV_ITEMS}` instead). Second,
   * reverted that and instead removed the `<UploadNavLink />` child from
   * `<MobileNavToggle>` entirely (reverting to the pre-merge shape, where
   * only the desktop `<ul>` carried Upload): the two-occurrences assertion
   * failed, finding 1, not 2. Both reverted immediately after.
   */
  it("K3: the desktop nav and MobileNavToggle read from the same NAV_ITEMS and the same UploadNavLink", () => {
    const source = stripComments(
      readFileSync(SITE_HEADER_PATH, "utf8"),
      SITE_HEADER_PATH,
    );

    expect(source).toContain("NAV_ITEMS.map(");
    expect(source).toContain("items={NAV_ITEMS}");

    const uploadNavLinkUsages = [...source.matchAll(/<UploadNavLink\s*\/>/g)];
    expect(uploadNavLinkUsages).toHaveLength(2);
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
