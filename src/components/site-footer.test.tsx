// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsentProvider } from "@/components/consent/consent-context";
import {
  FILLED_LEGAL_ENV,
  textContent,
} from "@/lib/legal/legal-page.test-support";
import {
  ABOUT_CONTACT_PATH,
  ABOUT_PATH,
  LICENCE_PATH,
  LLMS_TXT_PATH,
  PORTFOLIO_PATH,
  PRIVACY_PATH,
} from "@/lib/routes";
import { SITE_NAME } from "@/lib/site";

import { SiteFooter } from "./site-footer";

/**
 * ugcportal-akv6.
 *
 * K1: every link the footer carries, in both variants.
 * K2: a reviewable snapshot of every visible string (see
 * "K2: every visible string, for review" below) — Eirik should read this
 * list in the PR diff, not just trust that the component compiles.
 * K3: the production draft-link guard, at the integration level — this
 * file proves SiteFooter actually wires `linkBlockedInProduction` (the
 * pure rule itself, round-1 review moved it to
 * src/lib/legal/publishable.ts and unit-tests it there) to the real
 * `LEGAL_PAGES` readiness. The real e2e coverage (an actual production
 * server, the meta tag read from the rendered page) lives in
 * e2e/production/site-footer-draft.spec.ts.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

const EXPECTED_LINKS = [
  ["About", ABOUT_PATH],
  ["Portfolio", PORTFOLIO_PATH],
  ["Licence and rights", LICENCE_PATH],
  ["Privacy", PRIVACY_PATH],
  ["Contact", ABOUT_CONTACT_PATH],
  ["llms.txt", LLMS_TXT_PATH],
] as const;

function render(compact: boolean): string {
  return renderToStaticMarkup(<SiteFooter compact={compact} />);
}

describe.each([
  ["full", false],
  ["compact", true],
] as const)("SiteFooter (%s variant)", (_name, compact) => {
  it("K1: carries every footer link, each to its real route constant", () => {
    const markup = render(compact);
    for (const [, href] of EXPECTED_LINKS) {
      expect(markup, href).toContain(`href="${href}"`);
    }
  });

  it("shows a copyright line with the current year and the site name", () => {
    const markup = render(compact);
    const year = new Date().getFullYear();
    expect(textContent(markup)).toContain(`© ${year}`);
    expect(textContent(markup)).toContain(SITE_NAME);
  });

  it("MUTATION CHECK: a wrong year is not what's rendered", () => {
    const markup = render(compact);
    expect(textContent(markup)).not.toContain(`© ${new Date().getFullYear() + 1}`);
  });

  it("renders without a ConsentProvider above it (CookieSettingsLink degrades gracefully)", () => {
    // No ConsentProvider in this render, so CookieSettingsLink renders
    // nothing rather than throwing (its own documented behaviour) — this
    // only proves SiteFooter still asks for it and does not crash without
    // one, the same shell-structure-only scope app-shell.nav.test.tsx uses
    // for its own CookieSettingsLink stub.
    expect(() => render(compact)).not.toThrow();
  });
});

describe("K2: every visible string, for review", () => {
  /**
   * Every string a visitor reading the footer would see, deduplicated
   * across both variants. Reviewed in the PR description as the K2
   * acceptance criterion asks ("a snapshot of the footer strings reviewed
   * by Eirik") — this is that snapshot, in a form a diff actually shows.
   */
  function renderWithConsent(compact: boolean): string {
    return renderToStaticMarkup(
      <ConsentProvider initialConsent="granted">
        <SiteFooter compact={compact} />
      </ConsentProvider>,
    );
  }

  it("full variant", () => {
    const text = textContent(renderWithConsent(false));
    for (const needle of [
      SITE_NAME,
      "Food, wine and drink, technology and books, photographed.",
      "Pages",
      "About",
      "Portfolio",
      "Licence and rights",
      "Privacy",
      "Contact",
      "llms.txt",
      "Legal",
      "Cookies",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("compact variant", () => {
    const text = textContent(renderWithConsent(true));
    expect(text).toContain(`${SITE_NAME} ·`);
    for (const needle of ["About", "Portfolio", "Licence and rights", "Privacy", "Contact", "llms.txt", "Cookies"]) {
      expect(text, needle).toContain(needle);
    }
  });
});

describe.each([
  ["full", false],
  ["compact", true],
] as const)(
  "K3: a draft legal page is never linked once NODE_ENV is production (%s variant)",
  (_name, compact) => {
    // Review-standards family 4 (sibling omission): FooterNavLink and the
    // `blocked` flags it is given are shared, unparameterised, by both
    // variants — but a guard that is only ever exercised against one
    // variant and assumed to hold for its sibling is exactly the shape that
    // family names, so both are driven through this same suite rather than
    // trusting that shared code implies shared coverage.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("replaces Privacy and Licence with inert, non-link text in production while they are drafts", () => {
      // LEGAL_SIGN_OFF is null today (src/lib/legal/contact.ts), so both
      // pages are a draft regardless of these values — filled on purpose,
      // to prove this is the sign-off gate and not a missing-variable one.
      vi.stubEnv("NODE_ENV", "production");
      for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
        vi.stubEnv(name, value);
      }

      const markup = render(compact);
      expect(markup).not.toContain(`href="${PRIVACY_PATH}"`);
      expect(markup).not.toContain(`href="${LICENCE_PATH}"`);
      expect(markup).toContain(`data-footer-draft-link="${PRIVACY_PATH}"`);
      expect(markup).toContain(`data-footer-draft-link="${LICENCE_PATH}"`);
      // Still named, so a visitor learns the page exists rather than seeing
      // it vanish — and annotated as plain, assistive-tech-readable text
      // (not merely a muted colour, which an inconsistent screen reader or
      // a colour-blind visitor would miss entirely), so it's clear it
      // isn't simply a broken link.
      const text = textContent(markup);
      expect(text).toContain("Privacy (coming soon)");
      expect(text).toContain("Licence and rights (coming soon)");
    });

    it("MUTATION CHECK: links Privacy and Licence normally outside production, even though they're still drafts", () => {
      vi.stubEnv("NODE_ENV", "development");
      for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
        vi.stubEnv(name, value);
      }

      const markup = render(compact);
      expect(markup).toContain(`href="${PRIVACY_PATH}"`);
      expect(markup).toContain(`href="${LICENCE_PATH}"`);
      expect(markup).not.toContain("data-footer-draft-link");
      expect(markup).not.toContain("coming soon");
    });
  },
);
