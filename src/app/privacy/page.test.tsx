import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRAFT_META_NAME, DRAFT_NOTICE } from "@/components/legal/legal-page";
import { LEGAL_REVIEW_STATUS } from "@/lib/legal/contact";
import { unresolvedPlaceholders } from "@/lib/legal/publishable";
import { PRIVACY_PATH } from "@/lib/routes";

import {
  PRIVACY_CATEGORIES,
  PRIVACY_CONTROLLER,
  PRIVACY_COOKIES,
  PRIVACY_NOT_DONE,
  PRIVACY_RIGHTS,
  PRIVACY_TRANSFERS,
  UNDETERMINED_RETENTION_TEXT,
  privacyTexts,
} from "./content";
import PrivacyPage, { metadata } from "./page";

/**
 * ugcportal-qnq9.4, K1: /privacy renders — the server-component equivalent
 * of "returns 200" — with one section per category, findable by a stable
 * test id, and reads nothing it would need a session or a database for.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

function render(): string {
  return renderToStaticMarkup(PrivacyPage());
}

describe("/privacy", () => {
  it("renders without a session or a database", () => {
    expect(render()).toContain("<h1");
  });

  it("has a section per data category, by test id", () => {
    const markup = render();
    for (const category of PRIVACY_CATEGORIES) {
      expect(markup).toContain(`data-testid="privacy-category-${category.id}"`);
      expect(markup).toContain(`id="${category.id}"`);
    }
    // The control: an id that is not a category is not there.
    expect(markup).not.toContain('data-testid="privacy-category-nope"');
  });

  it("has the controller, transfers, cookies, not-done and rights sections", () => {
    const markup = render();
    for (const section of [
      PRIVACY_CONTROLLER,
      PRIVACY_TRANSFERS,
      PRIVACY_COOKIES,
      PRIVACY_NOT_DONE,
      PRIVACY_RIGHTS,
    ]) {
      expect(markup).toContain(`data-testid="privacy-section-${section.id}"`);
    }
    expect(markup).toContain("Datatilsynet");
  });

  it("renders every string the placeholder guard is shown", () => {
    // privacyTexts() is what production checks for placeholders. If the
    // page rendered a string the list did not include, a placeholder could
    // hide there — so every text must appear in the markup (modulo React's
    // escaping of quotes and ampersands, undone here).
    const markup = render()
      .replaceAll("&#x27;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&");
    for (const text of privacyTexts()) {
      expect(markup, text.slice(0, 60)).toContain(text);
    }
  });

  it("K3: an undetermined retention shows the fixed sentence in its own cell", () => {
    const markup = render();
    for (const category of PRIVACY_CATEGORIES) {
      const cell = new RegExp(
        `data-testid="privacy-retention-${category.id}"[^>]*>([^<]*)<`,
      ).exec(markup);
      expect(cell, category.id).not.toBeNull();
      const shown = (cell as RegExpExecArray)[1];
      if (category.retention.kind === "undetermined") {
        expect(shown.startsWith(UNDETERMINED_RETENTION_TEXT)).toBe(true);
      } else {
        expect(shown.startsWith(UNDETERMINED_RETENTION_TEXT)).toBe(false);
      }
    }
  });

  it("carries the draft marker exactly while the text is a draft", () => {
    const markup = render();
    const isDraft = LEGAL_REVIEW_STATUS === "draft";
    expect(markup.includes(DRAFT_NOTICE)).toBe(isDraft);
    expect(metadata.other?.[DRAFT_META_NAME] === "true").toBe(isDraft);
    expect(metadata.title).toBe("Privacy");
  });

  it("in production, renders if and only if no placeholder remains", () => {
    // Ties the page to the guard in both states: today (placeholders
    // present) it must throw; after the operator fills them in it must not.
    // Either way the assertion is about the page calling assertPublishable,
    // not about which state the repository happens to be in.
    const remaining = unresolvedPlaceholders({ path: PRIVACY_PATH, texts: privacyTexts() });
    vi.stubEnv("NODE_ENV", "production");
    if (remaining.length > 0) {
      expect(() => render()).toThrow(/\[CONTROLLER NAME\]/);
    } else {
      expect(() => render()).not.toThrow();
    }
  });

  it("outside production, renders with the placeholders visible", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => render()).not.toThrow();
  });

  it("leaks no undefined into the prose", () => {
    const markup = render();
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain("[object");
  });
});
