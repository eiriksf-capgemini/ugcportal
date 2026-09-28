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
 * inside AppShell's tree cannot be rendered by this test harness at all.
 * These tests are about the shell's own static structure (nav placement, the
 * single <main>, the skip link), not about either child's gating logic.
 */
vi.mock("@/components/upload-nav-link", () => ({
  UploadNavLink: () => (
    <nav aria-label="Primary" data-testid="nav-stub">
      <a href="/upload">Upload</a>
    </nav>
  ),
}));
vi.mock("@/components/auth-status", () => ({
  AuthStatus: () => <div data-testid="auth-stub">auth widget</div>,
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

  it("places the nav slot between the wordmark and the auth widget", () => {
    const markup = renderShell();
    const wordmark = markup.indexOf(">UGC Portal<");
    const nav = markup.indexOf('data-testid="nav-stub"');
    const auth = markup.indexOf('data-testid="auth-stub"');

    expect(wordmark).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(wordmark);
    expect(auth).toBeGreaterThan(nav);
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
