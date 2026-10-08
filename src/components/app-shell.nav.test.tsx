import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ugcportal-t0y round 1 medium finding: AppShell must stay a plain
 * synchronous function. React can only start rendering a component's
 * `children` once the component itself has returned, so an `await` in
 * AppShell's own body — the shape round 1 shipped with — serialises the
 * session lookup ahead of the page's own data fetching on every single page,
 * including "/" for an anonymous visitor who will never see the nav link at
 * all. UploadNavLink and AuthStatus are each their own async component
 * instead (covered by their own dedicated test files), rendered here as
 * ordinary sibling elements that AppShell never awaits or otherwise resolves.
 *
 * That is also why this file stubs them out rather than executing them:
 * this repo's `renderToStaticMarkup` cannot resolve a nested async
 * component while walking a parent tree — confirmed empirically, it throws
 * "A component suspended while responding to synchronous input" the moment
 * it meets one — so a *real* UploadNavLink/AuthStatus embedded unresolved
 * inside AppShell's tree cannot be rendered by this test harness at all
 * (and AppShell's own tree still reaches both, transitively, through
 * `<SiteHeader />` - the mocks are still load-bearing here even though
 * neither stub's PLACEMENT is this file's concern any more, see below).
 *
 * These tests are about the shell's OWN static structure - the single
 * <main>, the skip link, AppShell staying synchronous - not nav placement
 * (PR #94 review round 6, finding 5): the wordmark, the nav, and the auth
 * slot all moved into src/components/site-header.tsx wholesale
 * (ugcportal-14k9), and the ordering assertion this file used to carry for
 * them was, by that point, testing SiteHeader's own internal composition
 * through two layers of mocking rather than anything AppShell itself still
 * does. That assertion now lives in site-header.test.tsx, merged with the
 * equivalent check already there rather than kept as two partial,
 * independently-drifting copies.
 */
vi.mock("@/components/upload-nav-link", () => ({
  // ugcportal-i7lr: the real component returns a bare <li> (or null), not
  // its own <nav> landmark, since site-header.tsx now splices it into the
  // end of the shared "Main navigation" <ul> - this stub matches that shape
  // even though this file's own assertions don't look at it either way.
  UploadNavLink: () => (
    <li data-testid="nav-stub">
      <a href="/upload">Upload</a>
    </li>
  ),
}));
vi.mock("@/components/auth-status", () => ({
  AuthStatus: () => <div data-testid="auth-stub">auth widget</div>,
}));
// ugcportal-3wgp: the footer's CookieSettingsLink reads consent context
// (and, as of review round 5, finding 7, renders nothing without a
// ConsentProvider rather than throwing) — out of scope for this file's
// shell-structure-only tests either way, same reasoning as the two stubs
// above.
vi.mock("@/components/consent/cookie-settings-link", () => ({
  CookieSettingsLink: () => <button data-testid="cookie-settings-stub">Cookies</button>,
}));

const { AppShell } = await import("./app-shell");

function renderShell(): string {
  return renderToStaticMarkup(
    AppShell({ children: <div data-testid="page-content" /> }) as ReactElement,
  );
}

describe("AppShell (ugcportal-t0y)", () => {
  it("is a synchronous function, not async", () => {
    // The regression this guards: reintroducing `async function AppShell`
    // with a top-level `await` before `return` makes this call return a
    // Promise instead of a React element.
    const result = AppShell({ children: null });
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("renders exactly one <main>, and keeps the skip link's target", () => {
    // Guards against the nav slot regressing the landmark structure the
    // rest of the app depends on (src/app/upload/page.test.tsx and
    // src/app/page.test.tsx each assert their own page adds no second
    // <main>; this is the shell's own half of that contract).
    const markup = renderShell();

    expect([...markup.matchAll(/<main\b/g)]).toHaveLength(1);
    expect(markup).toContain('href="#main-content"');
  });
});
