import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * ugcportal-14k9. `aria-current="page"` is derived from `usePathname()`, the
 * same mechanism and the same reasoning as src/components/upload-link.tsx
 * (see that file's own comment for why this cannot be computed server-side).
 * This file only needs a static render per case, unlike upload-link.test.tsx,
 * because it is not asserting anything about re-rendering across a
 * CLIENT-SIDE navigation - only that the attribute is correct for a given
 * `usePathname()` answer.
 */
const pathnameMock = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

const { PrimaryNavLink } = await import("./primary-nav-link");

describe("PrimaryNavLink (ugcportal-14k9)", () => {
  it('marks the link aria-current="page" when usePathname() matches its href', () => {
    pathnameMock.mockReturnValue("/about");

    const markup = renderToStaticMarkup(
      <PrimaryNavLink href="/about">About</PrimaryNavLink>,
    );

    expect(markup).toMatch(/<a[^>]*\saria-current="page"[^>]*>About<\/a>/);
  });

  it("omits aria-current for a different page, rather than rendering aria-current=\"false\"", () => {
    pathnameMock.mockReturnValue("/about");

    const markup = renderToStaticMarkup(
      <PrimaryNavLink href="/">Gallery</PrimaryNavLink>,
    );

    // Not just `not.toContain('aria-current="page"')` - also rules out the
    // ARIA-legal-but-wrong `aria-current="false"` React renders for a bare
    // `false` prop (see upload-link.tsx's own comment on this exact
    // footgun), which a looser assertion would miss entirely.
    expect(markup).not.toContain("aria-current");
  });
});

/*
 * `onNavigate` itself (the mobile panel closing when a link is actually
 * activated) is exercised for real, against a mounted DOM and a real click,
 * in mobile-nav-toggle.test.tsx - not re-tested here against a static
 * render, which never fires onClick at all and so could only assert the
 * callback was NOT called, a tautology rather than coverage.
 */
