// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactSection } from "@/components/site/contact-section";
import { SiteFooter } from "@/components/site-footer";
import { FILLED_LEGAL_ENV, stubLegalEnv } from "@/lib/legal/legal-page.test-support";
import { PRIVACY_PATH } from "@/lib/routes";

/**
 * ugcportal-nf9l K2: "Following should never happen: the footer and the
 * contact notice disagreeing about whether a legal page may be linked."
 *
 * Both components now read the SAME decision for PRIVACY_PATH —
 * `legalLinkBlocked` (src/lib/legal/pages.ts), which both
 * src/components/site-footer.tsx and src/components/site/
 * contact-section.tsx call — rather than each computing its own opinion.
 * This file drives BOTH components from the same stubbed readiness and
 * asserts they make the same decision in each of the four
 * draft/signed-off x production/development combinations, as BEHAVIOUR
 * (whether an `<a href="/privacy">` is present) rather than an import grep
 * that would only prove both files mention the same function name.
 *
 * "draft" here uses UNSET_LEGAL_ENV (via `stubLegalEnv` with no values),
 * which forces `blocked`/`draft` true regardless of today's real
 * LEGAL_SIGN_OFF — same reasoning as site-footer.test.tsx's own "SiteFooter
 * wiring" block. "configured" uses FILLED_LEGAL_ENV against today's real
 * sign-off (not injected), the same "real fact, not a fixture" choice that
 * block's positive-path case makes.
 *
 * Between ugcportal-fsdf (PR #204) and ugcportal-xh4j (2026-10-12), full
 * configuration alone was not enough to unblock /privacy in production:
 * its authored prose had changed (the uploader's own rights attestation,
 * src/lib/attestation.ts, now described in the rights-clearance category),
 * so its digest no longer matched LEGAL_SIGN_OFF and it read as a draft
 * until a human re-approved it. The "configured"+"production" row below
 * read `true` (linked) before ugcportal-fsdf, flipped to `false` (blocked)
 * once that PR landed, and flips back to `true` now that Eirik has
 * reviewed the new wording and re-recorded the sign-off (ugcportal-xh4j,
 * 2026-10-12) — each flip the correct, expected consequence of the real
 * sign-off state, not a weakening of this file's own "never happen"
 * guarantee, which is about the footer and the contact notice always
 * agreeing with EACH OTHER, whatever the real sign-off currently says.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

function privacyLinked(markup: string): boolean {
  return markup.includes(`href="${PRIVACY_PATH}"`);
}

describe.each([
  ["draft", "production", false],
  ["draft", "development", true],
  ["configured", "production", true],
  ["configured", "development", true],
] as const)(
  "legal config=%s, NODE_ENV=%s",
  (configuration, nodeEnv, expectLinked) => {
    it(`footer and contact notice both ${expectLinked ? "link" : "block"} /privacy`, () => {
      stubLegalEnv(nodeEnv, configuration === "configured" ? FILLED_LEGAL_ENV : {});

      const footerMarkup = renderToStaticMarkup(<SiteFooter />);
      const contactMarkup = renderToStaticMarkup(
        <ContactSection defaultSubject="Hello" />,
      );

      expect(privacyLinked(footerMarkup)).toBe(expectLinked);
      expect(privacyLinked(contactMarkup)).toBe(expectLinked);
      // The property K2 actually names: whatever each one decided, they
      // decided the SAME thing.
      expect(privacyLinked(contactMarkup)).toBe(privacyLinked(footerMarkup));
    });
  },
);
