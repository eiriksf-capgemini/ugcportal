import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * K2 (ugcportal-14k9): "the document language is en", verified directly
 * against the real root layout rather than asserted about a copy.
 *
 * `next/font/google`'s `Geist`/`Geist_Mono`/`Fraunces` calls are mocked, not
 * the modules under test: those three are the one thing in src/app/layout.tsx
 * this suite genuinely cannot exercise outside Next's own build pipeline — a
 * plain `vitest run` confirmed empirically that calling the real export
 * throws `(0 , Geist) is not a function`, because next/font's Google loaders
 * are rewritten by Next's SWC/webpack compiler at build time, not plain
 * functions a Node test runner can call. Mocking them to return a harmless
 * `{ variable }` shape — the only part layout.tsx actually reads off the
 * result — leaves everything this file DOES claim about (the real
 * `RootLayout`, the real `className`, the real `lang` attribute) genuinely
 * exercised.
 *
 * UploadNavLink and AuthStatus are mocked for the same reason app-shell.nav.
 * test.tsx mocks them: both are async Server Components, and this repo's
 * `renderToStaticMarkup` cannot resolve a nested async component while
 * walking a parent tree (confirmed there empirically too). This file has
 * nothing to say about either's gating logic - only about the document they
 * render inside.
 */
vi.mock("@/components/upload-nav-link", () => ({
  UploadNavLink: () => null,
}));
vi.mock("@/components/auth-status", () => ({
  AuthStatus: () => null,
}));
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "mock-geist-sans" }),
  Geist_Mono: () => ({ variable: "mock-geist-mono" }),
  Fraunces: () => ({ variable: "mock-fraunces" }),
}));

const { default: RootLayout } = await import("./layout");

function renderLayout(): string {
  const element = RootLayout({
    children: <div data-testid="page-content" />,
    params: Promise.resolve({}),
  } as Parameters<typeof RootLayout>[0]);
  return renderToStaticMarkup(element);
}

describe("RootLayout (ugcportal-14k9 K2)", () => {
  it('renders <html lang="en">', () => {
    const markup = renderLayout();

    expect(markup).toMatch(/^<html[^>]*\blang="en"/);
  });

  /*
   * THE FIXTURE MUTATION (review-standards family 3): confirms the assertion
   * above can actually fail, not just that it currently passes. A `toMatch`
   * against a real render could pass vacuously if the regex were loose
   * enough to match unrelated markup; this proves it is anchored to the
   * `<html>` tag specifically by running the same regex against a string
   * that has an English document but NOT on the html element itself.
   */
  it("sanity: the lang assertion's regex does not match an unrelated lang attribute", () => {
    const decoy = '<html><body lang="en">decoy</body></html>';

    expect(decoy).not.toMatch(/^<html[^>]*\blang="en"/);
  });

  it("renders the page content passed as children, inside the single AppShell main landmark", () => {
    const markup = renderLayout();

    expect(markup).toContain('data-testid="page-content"');
    expect([...markup.matchAll(/<main\b/g)]).toHaveLength(1);
  });
});
