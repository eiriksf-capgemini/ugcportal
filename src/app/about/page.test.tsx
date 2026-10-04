import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AboutPage from "@/app/about/page";
import { CONTACT_EMAIL_PLACEHOLDER } from "@/lib/contact";

/**
 * /about (ugcportal-qnq9.7), K1 and K5.
 *
 * No database here at all — unlike /portfolio, this page reads nothing from
 * Prisma, so there is nothing below the render worth standing up a temporary
 * database for.
 */

describe("/about", () => {
  it("K1: returns a page containing the intro, what-we-offer and contact sections", () => {
    const markup = renderToStaticMarkup(<AboutPage />);
    expect(markup).toContain('data-page-section="intro"');
    expect(markup).toContain('data-page-section="offer"');
    expect(markup).toContain('data-page-section="contact"');
  });

  it("K5: states what is collected and why before submission, and links to the privacy statement", () => {
    const markup = renderToStaticMarkup(<AboutPage />);
    expect(markup).toContain('data-contact-notice=""');
    expect(markup).toMatch(/collect|store|receive/i);
    expect(markup).toContain('href="/privacy"');
  });

  it("renders a contact form targeting the configured (placeholder, in test) address, with its own default subject", () => {
    const markup = renderToStaticMarkup(<AboutPage />);
    expect(markup).toContain('data-contact-form=""');
    expect(markup).toContain(CONTACT_EMAIL_PLACEHOLDER);
    // Round-1 review: the subject must name THIS page, not "portfolio page".
    expect(markup).toContain("Hello from your about page");
    expect(markup).not.toContain("Hello from your portfolio page");
  });

  it("encodes the default subject's spaces as %20, never as + (round-1 review)", () => {
    const markup = renderToStaticMarkup(<AboutPage />);
    expect(markup).toContain("Hello%20from%20your%20about%20page");
  });

  it("percent-encodes the @ in the mailto href (round-2 review)", () => {
    const markup = renderToStaticMarkup(<AboutPage />);
    expect(markup).toContain("mailto:REPLACE-BEFORE-LAUNCH%40example.invalid");
  });
});
