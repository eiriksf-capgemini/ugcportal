// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FILLED_LEGAL_ENV,
  describeLegalPageContract,
  stubLegalEnv,
  textContent,
} from "@/lib/legal/legal-page.test-support";
import { PRIVACY_PATH } from "@/lib/routes";

import {
  PRIVACY_PAGE,
  UNDETERMINED_RETENTION_TEXT,
  loadPrivacy,
  privacyProseSections,
  privacyTexts,
} from "./content";
import PrivacyPage, { generateMetadata } from "./page";

/**
 * ugcportal-qnq9.4, K1: /privacy renders — the server-component equivalent
 * of "returns 200" — with one section per category, findable by a stable
 * test id. The configuration, draft and production-guard behaviour shared
 * with /licence lives in describeLegalPageContract.
 */

function render(): string {
  return renderToStaticMarkup(PrivacyPage());
}

describeLegalPageContract({
  path: PRIVACY_PATH,
  title: "Privacy",
  page: PRIVACY_PAGE,
  render,
  generateMetadata,
  renderedTexts: () => privacyTexts(loadPrivacy().content),
  filledNeedle: `The data controller is ${FILLED_LEGAL_ENV.LEGAL_CONTROLLER_NAME}`,
});

// Environment stubs are undone by the file-scoped afterEach that
// describeLegalPageContract registers above.
describe("/privacy", () => {
  it("has a section per data category and per prose section, by test id", () => {
    stubLegalEnv("development", FILLED_LEGAL_ENV);
    const markup = render();
    const { content } = loadPrivacy();
    for (const category of content.categories) {
      expect(markup).toContain(`data-testid="privacy-category-${category.id}"`);
      expect(markup).toContain(`id="${category.id}"`);
    }
    for (const section of privacyProseSections(content)) {
      expect(markup).toContain(`data-testid="privacy-section-${section.id}"`);
    }
    // The control: an id that is not a category is not there.
    expect(markup).not.toContain('data-testid="privacy-category-nope"');
    expect(textContent(markup)).toContain("Datatilsynet");
  });

  it("K3: an undetermined retention shows the fixed sentence in its own cell", () => {
    stubLegalEnv("development", FILLED_LEGAL_ENV);
    const markup = render();
    for (const category of loadPrivacy().content.categories) {
      const cell = new RegExp(
        `data-testid="privacy-retention-${category.id}"[^>]*>([^<]*)<`,
      ).exec(markup);
      expect(cell, category.id).not.toBeNull();
      const shown = textContent((cell as RegExpExecArray)[1]);
      expect(shown.startsWith(UNDETERMINED_RETENTION_TEXT)).toBe(
        category.retention.kind === "undetermined",
      );
    }
  });

  it("still needs all four in production: the storage provider alone unset blocks it (round 5)", () => {
    // The counterpart to /licence's two-variable case: the privacy page
    // names the store (uploads, transfers), so it is held to it.
    stubLegalEnv("production", { ...FILLED_LEGAL_ENV, LEGAL_STORAGE_PROVIDER: "" });
    expect(() => render()).toThrow(/LEGAL_STORAGE_PROVIDER/);
  });

  it("renders the not-done list as list items", () => {
    stubLegalEnv("development", FILLED_LEGAL_ENV);
    const markup = render();
    const { notDone } = loadPrivacy().content;
    const section = markup.slice(markup.indexOf(`data-testid="privacy-section-${notDone.id}"`));
    const items = Array.from(section.matchAll(/<li>([^<]*)<\/li>/g), (m) => textContent(m[1]));
    expect(items).toEqual([...notDone.items]);
  });
});
