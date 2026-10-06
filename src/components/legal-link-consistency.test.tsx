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
 * wiring" block. "signed-off" uses FILLED_LEGAL_ENV against today's real
 * sign-off (not injected), the same "real fact, not a fixture" choice that
 * block's positive-path case makes, since the real /privacy page is
 * genuinely signed off today.
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
  ["signed-off", "production", true],
  ["signed-off", "development", true],
] as const)(
  "legal config=%s, NODE_ENV=%s",
  (configuration, nodeEnv, expectLinked) => {
    it(`footer and contact notice both ${expectLinked ? "link" : "block"} /privacy`, () => {
      stubLegalEnv(nodeEnv, configuration === "signed-off" ? FILLED_LEGAL_ENV : {});

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
