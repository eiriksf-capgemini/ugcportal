// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FILLED_CONTACT,
  FILLED_LEGAL_ENV,
  describeLegalPageContract,
  itReviewPointersExist,
  stubLegalEnv,
  textContent,
} from "@/lib/legal/legal-page.test-support";
import { LICENCE_PATH } from "@/lib/routes";

import { licenceContent, licenceTexts, loadLicence } from "./content";
import LicencePage, { generateMetadata } from "./page";

/**
 * ugcportal-qnq9.4, K4: /licence renders with, at minimum, the two sections
 * the bead names — what a buyer of an original may do, and what an uploader
 * grants — and every behavioural claim carries a review pointer to a file
 * that exists. The behaviour shared with /privacy lives in
 * describeLegalPageContract.
 */

function render(): string {
  return renderToStaticMarkup(LicencePage());
}

const content = licenceContent(FILLED_CONTACT);

describeLegalPageContract({
  path: LICENCE_PATH,
  title: "Licence",
  render,
  generateMetadata,
  texts: () => loadLicence().page.texts,
  filledNeedle: `The rights-holder for licensing questions is ${FILLED_CONTACT.controllerName}`,
});

describe("/licence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has every section by test id, including buying and uploading", () => {
    stubLegalEnv("development", FILLED_LEGAL_ENV);
    const markup = render();
    for (const section of content.sections) {
      expect(markup).toContain(`data-testid="licence-section-${section.id}"`);
    }
    const ids = content.sections.map((section) => section.id);
    expect(ids).toContain("buying");
    expect(ids).toContain("uploading");
    expect(markup).not.toContain('data-testid="licence-section-nope"');
  });

  it("reserves all rights by default and says how to ask", () => {
    stubLegalEnv("development", FILLED_LEGAL_ENV);
    const text = textContent(render());
    expect(text).toContain("All rights reserved");
    expect(text).toContain("without written permission");
    expect(text).toContain("Nothing is offered for sale yet");
    expect(text).toContain(`E-mail ${FILLED_CONTACT.contactEmail}`);
  });

  it("promises no licence picker that does not exist", () => {
    // ugcportal-74w will add per-item terms; until it lands the page may
    // say an item CAN state its own terms, not that there is a way to set
    // them today.
    expect(licenceTexts(content).join(" ")).not.toMatch(
      /choose a licence|licence picker|select a licence/i,
    );
  });

  itReviewPointersExist(content.sections);
});
