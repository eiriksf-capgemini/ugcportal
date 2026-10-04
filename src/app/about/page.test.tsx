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
    expect(markup).toContain('href="/personvern"');
  });

  it("renders a contact form targeting the configured (placeholder, in test) address", () => {
    const markup = renderToStaticMarkup(<AboutPage />);
    expect(markup).toContain('data-contact-form=""');
    expect(markup).toContain(`action="mailto:${CONTACT_EMAIL_PLACEHOLDER}"`);
    expect(markup).toContain(CONTACT_EMAIL_PLACEHOLDER);
  });
});
