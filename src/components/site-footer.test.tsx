// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsentProvider } from "@/components/consent/consent-context";
import {
  FILLED_LEGAL_ENV,
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
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

import { FooterNavLink, SiteFooter } from "./site-footer";

/**
 * ugcportal-akv6.
 *
 * K1: every link the footer carries, in both variants.
 * K2: a reviewable snapshot of every visible string (see
 * "K2: every visible string, for review" below) — Eirik should read this
 * list in the PR diff, not just trust that the component compiles.
 * K3: the production draft-link guard, split across four cases (round-3
 * review: an earlier version of this comment claimed NONE of them render a
 * live SiteFooter against the real src/lib/legal/contact.ts LEGAL_SIGN_OFF
 * — false, the fourth one below does, deliberately):
 *
 *  1. the pure "is this readiness blocked from linking" rule
 *     (`linkBlockedInProduction`, fully fixture-injectable — including a
 *     STALE sign-off, draft=true/blocked=false) is unit-tested in
 *     src/lib/legal/publishable.ts's own test file;
 *  2. "what does FooterNavLink DO with a `blocked` flag" is unit-tested
 *     directly below, independent of how that flag was computed;
 *  3. "does SiteFooter actually wire the two together" is tested below
 *     that, with a deliberately-incomplete configuration fixture that
 *     forces a blocked outcome deterministically regardless of the real
 *     sign-off (missing config alone is enough — see that describe
 *     block's own comment);
 *  4. the fully-configured path, in production, is ALSO tested below that
 *     against today's REAL LEGAL_SIGN_OFF rather than a fixture
 *     (ugcportal-alg signed off the real pages after this component was
 *     first written; this case exists precisely because that is a fact
 *     that changes over time and the other three cases cannot exercise it
 *     at all). THE REAL FACT TODAY IS THAT BOTH PAGES ARE IN DRAFT:
 *     ugcportal-yzo7 edited /licence's authored prose and ugcportal-fsdf
 *     edited /privacy's, so neither digest matches LEGAL_SIGN_OFF until a
 *     human re-approves. Point 4 therefore currently exercises the BLOCKED
 *     path for both; the positive path it was written for returns when a
 *     sign-off lands (ugcportal-44qs). An earlier version of this sentence
 *     said /licence was signed off and /privacy was not — true when it was
 *     written, false one merge later, which is the hazard this whole
 *     docblock is about.
 *
 * The real e2e coverage (an actual production server, today's REAL
 * readiness, the meta tag read from the rendered page) lives in
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
   *
   * ugcportal-6uxr K1: this used to be a `for (needle of [...]) expect(text,
   * needle).toContain(needle)` loop, which is inclusion-only — it can never
   * fail on an ADDITION. Re-adding a line the PR already removed (or
   * appending a brand-new one) leaves every `toContain` green, because
   * `toContain` only asks "is this substring present somewhere", never "is
   * there anything else". The literal `EXPECTED_FULL_TEXT`/
   * `EXPECTED_COMPACT_TEXT` strings below are an exact equality check on the
   * footer's full `textContent` instead, which makes the claim
   * "every visible string" hold in BOTH directions (an omission still fails
   * equality, same as before; now an addition fails it too). Spelled out
   * literally here rather than built by concatenating the imported
   * `SITE_NAME`/`SITE_TAGLINE` constants with the other literal labels: a
   * `textContent === SITE_NAME + ...` comparison would still pass if
   * `SITE_TAGLINE`'s own value changed, since both sides would change
   * together — the same self-reference flaw site-header.test.tsx's own
   * EXPECTED_SITE_NAME comment names and rejects for the header's strings.
   *
   * MUTATION (performed once per variant, verified, and reverted — not left
   * in the tree): for the full variant, appended an extra sentence to the
   * rendered tagline paragraph in site-footer.tsx (simulating "a string is
   * added to the footer"). Before this change, the old `toContain`-loop
   * stayed green under that mutation (every original needle is still
   * present; the loop never notices the addition). After this change,
   * `expect(text).toBe(EXPECTED_FULL_TEXT)` failed immediately, reporting
   * the actual string with the extra sentence appended vs. the expected
   * literal. The compact variant renders no tagline at all (see its own
   * branch below), so that mutation alone would never exercise its
   * assertion — checked separately by appending a word to the compact
   * variant's own `<span>` instead; `expect(text).toBe(EXPECTED_COMPACT_TEXT)`
   * failed the same way. Both confirm the exact-equality assertion catches
   * an addition, not just a removal. Reverted immediately after.
   */
  function renderWithConsent(compact: boolean): string {
    return renderToStaticMarkup(
      <ConsentProvider initialConsent="granted">
        <SiteFooter compact={compact} />
      </ConsentProvider>,
    );
  }

  const EXPECTED_FULL_TEXT =
    `${SITE_NAME}${SITE_TAGLINE}© ${new Date().getFullYear()} ${SITE_NAME}` +
    "PagesAboutPortfolioLicence and rightsPrivacyContactllms.txtLegalCookies";

  const EXPECTED_COMPACT_TEXT =
    `${SITE_NAME} · © ${new Date().getFullYear()}` +
    "AboutPortfolioLicence and rightsPrivacyContactllms.txtCookies";

  it("full variant", () => {
    const text = textContent(renderWithConsent(false));
    expect(text).toBe(EXPECTED_FULL_TEXT);
  });

  it("compact variant", () => {
    const text = textContent(renderWithConsent(true));
    expect(text).toBe(EXPECTED_COMPACT_TEXT);
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
  "SiteFooter wiring: blocked while incomplete or unsigned, linked once real and signed off (%s variant)",
  (_name, compact) => {
    // Review-standards family 4 (sibling omission): the same wiring and the
    // `blocked` flags it produces are shared, unparameterised, by both
    // variants — but a guard only ever exercised against one variant and
    // assumed to hold for its sibling is exactly the shape that family
    // names, so both are driven through this same suite.
    //
    // Three cases below, not one (round-3 review — an earlier version of
    // this comment, and this describe block's own title, implied the
    // first two were the whole story and that no test here renders a live
    // SiteFooter against the real sign-off; the third does, deliberately):
    //
    //  - UNSET_LEGAL_ENV, not a filled-in fixture: with every LEGAL_*
    //    variable blank, `legalReadiness` reports `missing.length > 0`,
    //    which makes `blocked` — and therefore `draft` — true REGARDLESS
    //    of src/lib/legal/contact.ts's real LEGAL_SIGN_OFF (`draft =
    //    blocked || !signedOff`; `blocked` alone is enough). That makes
    //    the first two tests' outcome depend only on NODE_ENV, the one
    //    axis they mean to exercise, rather than on whatever the real
    //    sign-off currently says about the real prose;
    //  - the third test is the case those two cannot reach: fully
    //    configured (FILLED_LEGAL_ENV), against today's real
    //    LEGAL_SIGN_OFF rather than a fixture. As of ugcportal-fsdf that
    //    real fact is no longer "both pages signed off": /privacy's
    //    authored prose changed (the uploader's own rights attestation,
    //    src/lib/attestation.ts, now described in the rights-clearance
    //    category), so its digest no longer matches LEGAL_SIGN_OFF and it
    //    reads as a draft until a human re-approves it — the same sequence
    //    ugcportal-mj50 and ugcportal-qnq9.2.2 each went through. /licence,
    //    whose prose this change does not touch, is unaffected and is
    //    still really signed off. The test below asserts exactly that
    //    split rather than "both link".
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

    // Round-2 review, MEDIUM: the positive path — configured AND signed
    // off, in production — was untested; every test above exercises a
    // BLOCKED outcome. FILLED_LEGAL_ENV makes `missing.length === 0`; the
    // real `LEGAL_SIGN_OFF` (src/lib/legal/contact.ts, set by ugcportal-alg
    // in PR #99) is left to its default rather than injected, so these tests
    // read the real fact rather than a synthetic one.
    //
    // TODAY'S REAL FACT IS THAT BOTH PAGES ARE IN DRAFT, and this is the
    // merge of two changes that each put one of them there:
    //   /licence — ugcportal-yzo7 (PR #203) removed the now-false sentence
    //     "Nothing is offered for sale yet." from src/app/licence/content.ts.
    //   /privacy — ugcportal-fsdf (PR #204) added the uploader-attestation
    //     paragraph to src/app/privacy/content.ts.
    // Each edit changed that page's authored digest, which by the mechanism
    // LEGAL_SIGN_OFF's own comment describes returns the page to draft until
    // Eirik reviews the new wording and re-records the digest. Both are the
    // correct, expected outcome of their edit, not regressions to paper over.
    //
    // CONSEQUENCE FOR COVERAGE, stated rather than quietly dropped: with no
    // page currently both configured and signed off, the POSITIVE path the
    // round-2 MEDIUM added cannot be exercised against the real constants.
    // It is not lost — it returns the moment either digest is re-recorded,
    // and whoever applies that sign-off should restore an assertion here
    // that the signed-off page links normally. Do not substitute a synthetic
    // sign-off to keep a green positive case: that would re-create exactly
    // the "reads a synthetic fact" problem this block was written to avoid.
    it("shows both /privacy and /licence as drafts in production while their edited prose awaits sign-off (ugcportal-yzo7, ugcportal-fsdf)", () => {
      vi.stubEnv("NODE_ENV", "production");
      for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
        vi.stubEnv(name, value);
      }

      const markup = render(compact);
      expect(markup).not.toContain(`href="${PRIVACY_PATH}"`);
      expect(markup).toContain(`data-footer-draft-link="${PRIVACY_PATH}"`);
      expect(markup).not.toContain(`href="${LICENCE_PATH}"`);
      expect(markup).toContain(`data-footer-draft-link="${LICENCE_PATH}"`);
      expect(markup).toContain("coming soon");
    });
  },
);
