// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsentProvider } from "@/components/consent/consent-context";
import {
  UNSET_LEGAL_ENV,
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

import { FooterNavLink, SiteFooter } from "./site-footer";

/**
 * ugcportal-akv6.
 *
 * K1: every link the footer carries, in both variants.
 * K2: a reviewable snapshot of every visible string (see
 * "K2: every visible string, for review" below) — Eirik should read this
 * list in the PR diff, not just trust that the component compiles.
 * K3: the production draft-link guard, split across three layers so no one
 * of them has to assume a value for src/lib/legal/contact.ts's real
 * LEGAL_SIGN_OFF (a fact about this repo's actual legal text, which
 * changes over time — ugcportal-alg signed off the real pages after this
 * component was first written, which is exactly the kind of change this
 * split is meant to survive): the pure "is this page blocked" rule
 * (`linkBlockedInProduction`, fully fixture-injectable) is unit-tested in
 * src/lib/legal/publishable.ts's own test file; "what does FooterNavLink
 * DO with a `blocked` flag" is unit-tested directly below; "does SiteFooter
 * actually wire the two together" is tested below that, with a
 * deliberately-incomplete configuration fixture that forces the outcome
 * deterministically regardless of the real sign-off. The real e2e coverage
 * (an actual production server, today's REAL readiness, the meta tag read
 * from the rendered page) lives in e2e/production/site-footer-draft.spec.ts.
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
      "Food, books and home technology — including wine accessories, never alcohol itself.",
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

describe("FooterNavLink: the rendering rule for a given `blocked` flag", () => {
  // Deliberately decoupled from WHETHER a real page is currently blocked —
  // that depends on src/lib/legal/contact.ts's real LEGAL_SIGN_OFF, which
  // is a fact about this repo's actual legal text (ugcportal-alg signed
  // off the real /privacy and /licence after this component was first
  // written) and not a thing a component test should assume a value for.
  // The pure "is a page blocked" computation is unit-tested with fully
  // injectable fixtures in src/lib/legal/publishable.test.ts
  // (linkBlockedInProduction); this only tests what FooterNavLink DOES
  // with that boolean once it has it.
  function renderLink(blocked: boolean): string {
    return renderToStaticMarkup(
      <FooterNavLink label="Privacy" href={PRIVACY_PATH} blocked={blocked} />,
    );
  }

  it("blocked=true: inert, non-link text with a visible, assistive-tech-readable annotation", () => {
    const markup = renderLink(true);
    expect(markup).not.toContain(`href="${PRIVACY_PATH}"`);
    expect(markup).toContain(`data-footer-draft-link="${PRIVACY_PATH}"`);
    // Plain text content, not merely a muted colour (which an inconsistent
    // screen reader or a colour-blind visitor would miss) and not an
    // aria-hidden decoration (which would HIDE it from assistive tech).
    expect(textContent(markup)).toContain("Privacy (coming soon)");
  });

  it("MUTATION CHECK: blocked=false renders a real link instead, with no draft annotation", () => {
    const markup = renderLink(false);
    expect(markup).toContain(`href="${PRIVACY_PATH}"`);
    expect(markup).not.toContain("data-footer-draft-link");
    expect(markup).not.toContain("coming soon");
  });
});

describe.each([
  ["full", false],
  ["compact", true],
] as const)(
  "SiteFooter wiring: the production guard is NODE_ENV-gated, not draft-gated (%s variant)",
  (_name, compact) => {
    // Review-standards family 4 (sibling omission): the same wiring and the
    // `blocked` flags it produces are shared, unparameterised, by both
    // variants — but a guard only ever exercised against one variant and
    // assumed to hold for its sibling is exactly the shape that family
    // names, so both are driven through this same suite.
    //
    // UNSET_LEGAL_ENV, not a filled-in fixture (round-1 review follow-up):
    // with every LEGAL_* variable blank, `legalReadiness` reports
    // `missing.length > 0`, which makes `blocked` — and therefore `draft`
    // — true REGARDLESS of src/lib/legal/contact.ts's real LEGAL_SIGN_OFF
    // (`draft = blocked || !signedOff`; `blocked` alone is enough). That
    // makes this test's outcome depend only on NODE_ENV, the one axis it
    // means to exercise, rather than on whatever the real sign-off
    // currently says about the real prose — which is a fact about this
    // repo's legal text, not a fixture this test should assume.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("blocks Privacy and Licence in production while configuration is incomplete", () => {
      vi.stubEnv("NODE_ENV", "production");
      for (const [name, value] of Object.entries(UNSET_LEGAL_ENV)) {
        vi.stubEnv(name, value);
      }

      const markup = render(compact);
      expect(markup).not.toContain(`href="${PRIVACY_PATH}"`);
      expect(markup).not.toContain(`href="${LICENCE_PATH}"`);
      expect(markup).toContain(`data-footer-draft-link="${PRIVACY_PATH}"`);
      expect(markup).toContain(`data-footer-draft-link="${LICENCE_PATH}"`);
    });

    it("MUTATION CHECK: links Privacy and Licence normally outside production, with the SAME incomplete configuration", () => {
      vi.stubEnv("NODE_ENV", "development");
      for (const [name, value] of Object.entries(UNSET_LEGAL_ENV)) {
        vi.stubEnv(name, value);
      }

      const markup = render(compact);
      expect(markup).toContain(`href="${PRIVACY_PATH}"`);
      expect(markup).toContain(`href="${LICENCE_PATH}"`);
      expect(markup).not.toContain("data-footer-draft-link");
    });
  },
);
