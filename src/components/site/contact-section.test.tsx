import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactSection } from "@/components/site/contact-section";
import { stubLegalEnv } from "@/lib/legal/legal-page.test-support";
import { ABOUT_CONTACT_PATH, PRIVACY_PATH, pathFragment } from "@/lib/routes";

/**
 * Round-5 review: when `CONTACT_EMAIL` fails
 * `checkContactEmailConfiguration`'s own shape test (src/instrumentation.ts
 * only WARNS about this at boot; it does not block `resolveContactEmail`
 * from returning the value anyway), the "email us directly" link must not
 * show the raw, possibly malformed value as its visible text — a visitor
 * reading `"Jane Doe <jane@example.com>"` learns nothing useful and sees an
 * internal misconfiguration verbatim.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ContactSection — the footer's anchor target (ugcportal-akv6)", () => {
  it("carries the id ABOUT_CONTACT_PATH's fragment names, not a separately hand-typed literal", () => {
    const markup = renderToStaticMarkup(
      <ContactSection defaultSubject="Hello" />,
    );
    // Derived from the SAME route constant the footer's Contact link
    // builds its href from (round-3 review), rather than asserting the
    // literal "contact" independently of it — the two could otherwise
    // drift apart without either assertion noticing.
    expect(markup).toContain(`id="${pathFragment(ABOUT_CONTACT_PATH)}"`);
  });
});

describe("ContactSection — the direct-email link label", () => {
  it("shows the real address when it is shaped like one", () => {
    vi.stubEnv("CONTACT_EMAIL", "owner@example.com");
    const markup = renderToStaticMarkup(
      <ContactSection defaultSubject="Hello" />,
    );
    expect(markup).toContain(">owner@example.com<");
  });

  it("shows a neutral label, not the raw value, when CONTACT_EMAIL is malformed", () => {
    vi.stubEnv("CONTACT_EMAIL", "Jane Doe <jane@example.com>");
    const markup = renderToStaticMarkup(
      <ContactSection defaultSubject="Hello" />,
    );
    expect(markup).not.toContain("Jane Doe");
    // The raw value is still encoded into the href as a (best-effort)
    // defence in depth — see contactMailtoHref's own comment — just not
    // shown as the link's visible text.
    expect(markup).toContain("our email address");
  });

  it("still builds a usable href even when the label falls back", () => {
    vi.stubEnv("CONTACT_EMAIL", "Jane Doe <jane@example.com>");
    const markup = renderToStaticMarkup(
      <ContactSection defaultSubject="Hello" />,
    );
    expect(markup).toContain('data-contact-direct-link=""');
    expect(markup).toMatch(/href="mailto:[^"]+"/);
  });
});

describe("ContactSection — the privacy link (ugcportal-nf9l K1)", () => {
  // Same reasoning as site-footer.test.tsx's own "SiteFooter wiring"
  // block: UNSET_LEGAL_ENV (via stubLegalEnv) forces `blocked`/`draft`
  // true regardless of today's real LEGAL_SIGN_OFF, so these two cases
  // depend only on NODE_ENV, the one axis they mean to exercise.
  it("K1: renders no anchor to /privacy in production while the statement is still a draft, with the label still present", () => {
    stubLegalEnv("production");
    const markup = renderToStaticMarkup(<ContactSection defaultSubject="Hello" />);
    expect(markup).not.toContain(`href="${PRIVACY_PATH}"`);
    expect(markup).toContain("Read our privacy statement");
    expect(markup).toContain(`data-contact-privacy-draft="${PRIVACY_PATH}"`);
    // Round-1 review, LOW: an earlier version claimed "the same treatment
    // FooterNavLink gives" without sharing the rendering, so it silently
    // had neither FooterNavLink's muted colour nor its "(coming soon)"
    // suffix. Now routed through the SAME DraftLegalLabel
    // (src/components/site-footer.tsx) — this pins that the suffix (and
    // so the shared component) is actually what rendered, not a
    // same-looking span reimplemented in each file.
    expect(markup).toContain("text-muted-foreground italic");
    expect(markup).toContain("Read our privacy statement (coming soon)");
  });

  it("MUTATION CHECK: links /privacy normally outside production, with the SAME draft configuration", () => {
    stubLegalEnv("development");
    const markup = renderToStaticMarkup(<ContactSection defaultSubject="Hello" />);
    expect(markup).toContain(`href="${PRIVACY_PATH}"`);
    expect(markup).not.toContain("data-contact-privacy-draft");
  });
});
