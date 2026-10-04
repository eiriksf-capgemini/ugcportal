import { existsSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRAFT_META_NAME, DRAFT_NOTICE } from "@/components/legal/legal-page";
import { LEGAL_REVIEW_STATUS } from "@/lib/legal/contact";
import { unresolvedPlaceholders } from "@/lib/legal/publishable";
import { LICENCE_PATH } from "@/lib/routes";

import { LICENCE_SECTIONS, licenceTexts } from "./content";
import LicencePage, { metadata } from "./page";

/**
 * ugcportal-qnq9.4, K4: /licence renders with, at minimum, the two sections
 * the bead names — what a buyer of an original may do, and what an uploader
 * grants — and every behavioural claim points at a file that exists.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

afterEach(() => {
  vi.unstubAllEnvs();
});

function render(): string {
  return renderToStaticMarkup(LicencePage());
}

describe("/licence", () => {
  it("renders without a session or a database", () => {
    expect(render()).toContain("<h1");
  });

  it("has every section by test id, including buying and uploading", () => {
    const markup = render();
    for (const section of LICENCE_SECTIONS) {
      expect(markup).toContain(`data-testid="licence-section-${section.id}"`);
    }
    const ids = LICENCE_SECTIONS.map((section) => section.id);
    expect(ids).toContain("buying");
    expect(ids).toContain("uploading");
    expect(markup).not.toContain('data-testid="licence-section-nope"');
  });

  it("reserves all rights by default and says how to ask", () => {
    const markup = render();
    expect(markup).toContain("All rights reserved");
    expect(markup).toContain("without written permission");
    expect(markup).toContain("Nothing is offered for sale yet");
  });

  it("promises no licence picker that does not exist", () => {
    // ugcportal-74w will add per-item terms; until it lands the page may
    // say an item CAN state its own terms, not that there is a way to set
    // them today.
    const text = licenceTexts().join(" ");
    expect(text).not.toMatch(/choose a licence|licence picker|select a licence/i);
  });

  it("renders every string the placeholder guard is shown", () => {
    const markup = render()
      .replaceAll("&#x27;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&");
    for (const text of licenceTexts()) {
      expect(markup, text.slice(0, 60)).toContain(text);
    }
  });

  it.each(LICENCE_SECTIONS.map((section) => [section.id, section.backedBy] as const))(
    "%s: every backing file exists",
    (_id, backedBy) => {
      for (const file of backedBy) {
        expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
      }
    },
  );

  it("carries the draft marker exactly while the text is a draft", () => {
    const markup = render();
    const isDraft = LEGAL_REVIEW_STATUS === "draft";
    expect(markup.includes(DRAFT_NOTICE)).toBe(isDraft);
    expect(metadata.other?.[DRAFT_META_NAME] === "true").toBe(isDraft);
    expect(metadata.title).toBe("Licence");
  });

  it("in production, renders if and only if no placeholder remains", () => {
    const remaining = unresolvedPlaceholders({ path: LICENCE_PATH, texts: licenceTexts() });
    vi.stubEnv("NODE_ENV", "production");
    if (remaining.length > 0) {
      expect(() => render()).toThrow(/\[CONTACT EMAIL\]/);
    } else {
      expect(() => render()).not.toThrow();
    }
  });

  it("outside production, renders with the placeholders visible", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => render()).not.toThrow();
  });
});
