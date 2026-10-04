import { existsSync } from "node:fs";
import path from "node:path";

import type { Metadata } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRAFT_META_NAME, DRAFT_NOTICE } from "@/components/legal/legal-page";
import {
  LEGAL_CONTACT_VARS,
  LEGAL_SIGN_OFF,
  type LegalContact,
  type LegalContactVar,
  readLegalContact,
  unsetMarker,
} from "@/lib/legal/contact";

/**
 * Shared test support for the legal pages (ugcportal-qnq9.4; one helper
 * rather than two copies, PR #90 round 2). Not collected by vitest (the
 * include glob wants `.test.` or `.spec.`) and not scanned as shipped UI by
 * src/lib/design/scan-source.ts (`isTestFile` wants the same) — it only
 * ever runs when a test imports it.
 *
 * `textContent` and `describeLegalPageContract` need a DOM: put
 * `// @vitest-environment jsdom` at the top of any test file that uses them.
 */

export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** A fully configured deployment, for fixtures. */
export const FILLED_LEGAL_ENV: Record<LegalContactVar, string> = {
  LEGAL_CONTROLLER_NAME: "Kari Nordmann",
  LEGAL_CONTACT_EMAIL: "kari@example.com",
  LEGAL_HOSTING_PROVIDER: "Example Hosting AS, Norway",
  LEGAL_STORAGE_PROVIDER: "Example Objects GmbH, Germany",
};

/**
 * A deployment whose operator values happen to contain the characters the
 * placeholder scan looks for. Every variable IS set; nothing here is a
 * placeholder, and the pages must publish (PR #90 round 3).
 */
export const BRACKETED_LEGAL_ENV: Record<LegalContactVar, string> = {
  ...FILLED_LEGAL_ENV,
  LEGAL_CONTROLLER_NAME: "Kari Nordmann [Oslo]",
  LEGAL_HOSTING_PROVIDER: "Acme Hosting [Oslo], Norway (region TBD)",
};

/**
 * The same deployment as a contact object, through the real reader rather
 * than a second copy of the env-to-field mapping (PR #90 round 3).
 */
export const FILLED_CONTACT: LegalContact = readLegalContact({
  NODE_ENV: "test",
  ...FILLED_LEGAL_ENV,
} as NodeJS.ProcessEnv).contact;

/** All four variables blank, which readLegalContact treats as unset. */
export const UNSET_LEGAL_ENV: Record<LegalContactVar, string> = {
  LEGAL_CONTROLLER_NAME: "",
  LEGAL_CONTACT_EMAIL: "",
  LEGAL_HOSTING_PROVIDER: "",
  LEGAL_STORAGE_PROVIDER: "",
};

/**
 * Stubs every LEGAL_* variable (blank for any not given, so a developer's
 * own .env.local cannot leak into a test) plus NODE_ENV. Undo with
 * vi.unstubAllEnvs().
 */
export function stubLegalEnv(
  nodeEnv: "production" | "development" | "test",
  values: Partial<Record<LegalContactVar, string>> = {},
): void {
  vi.stubEnv("NODE_ENV", nodeEnv);
  for (const name of Object.values(LEGAL_CONTACT_VARS)) {
    vi.stubEnv(name, values[name] ?? "");
  }
}

/**
 * The visible text of static markup, as the browser would read it: parsed
 * by jsdom and read back through the real `textContent`, rather than a
 * hand-rolled tag stripper and entity table (PR #90 round 3).
 */
export function textContent(markup: string): string {
  if (typeof document === "undefined") {
    throw new Error(
      "textContent needs a DOM: add `// @vitest-environment jsdom` at the top of this test file.",
    );
  }
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host.textContent ?? "";
}

export type LegalPageUnderTest = {
  path: string;
  title: string;
  /** Renders the page under the current process.env. */
  render: () => string;
  /** The page's generateMetadata, under the current process.env. */
  generateMetadata: () => Metadata;
  /** Every string the page can render, under the current process.env. */
  texts: () => readonly string[];
  /** A string the page is known to render under FILLED_LEGAL_ENV. */
  filledNeedle: string;
};

/**
 * The contract both legal pages meet: readable in development with the gap
 * visible, a draft while unconfigured, refused in production while
 * unconfigured, served in production once configured, every text the guard
 * sees actually rendered. Registers the cases; call from inside a test file.
 */
export function describeLegalPageContract(page: LegalPageUnderTest): void {
  describe(`${page.path}: the shared legal-page contract`, () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("renders in development with each unset variable shown by name", () => {
      stubLegalEnv("development");
      const text = textContent(page.render());
      expect(text).toContain(unsetMarker("LEGAL_CONTACT_EMAIL"));
      expect(text).toContain(unsetMarker("LEGAL_CONTROLLER_NAME"));
    });

    it("is a draft, with notice and meta marker, while a variable is unset", () => {
      stubLegalEnv("development", {
        ...FILLED_LEGAL_ENV,
        LEGAL_CONTACT_EMAIL: "   ",
      });
      expect(page.render()).toContain(DRAFT_NOTICE);
      const metadata = page.generateMetadata();
      expect(metadata.title).toBe(page.title);
      expect(metadata.other?.[DRAFT_META_NAME]).toBe("true");
      expect(metadata.robots).toEqual({ index: false, follow: false });
    });

    it("in production, refuses to render while a variable is unset", () => {
      stubLegalEnv("production", {
        ...FILLED_LEGAL_ENV,
        LEGAL_CONTACT_EMAIL: "",
      });
      expect(() => page.render()).toThrow(/LEGAL_CONTACT_EMAIL/);
      expect(() => page.render()).toThrow(new RegExp(page.path.replace("/", "\\/")));
    });

    it("in production, renders once every variable is set", () => {
      stubLegalEnv("production", FILLED_LEGAL_ENV);
      const text = textContent(page.render());
      expect(text).toContain(page.filledNeedle);
      expect(text).not.toContain("[LEGAL_");
    });

    it("in production, serves an operator value that contains brackets or TBD", () => {
      // The scan reads the authored prose, not the interpolated page, so a
      // set variable can never be mistaken for a placeholder (round 3).
      // Verified by mutation: scanning `page.texts` instead makes this throw.
      stubLegalEnv("production", BRACKETED_LEGAL_ENV);
      const text = textContent(page.render());
      expect(text).toContain(BRACKETED_LEGAL_ENV.LEGAL_CONTROLLER_NAME);
      expect(page.generateMetadata().title).toBe(page.title);
    });

    it("stays a draft after configuration exactly until the sign-off lands", () => {
      // Configuration is two of the three draft conditions; the third is
      // LEGAL_SIGN_OFF in src/lib/legal/contact.ts. legalReadiness's own
      // test drives that parameter both ways; this pins the page to it.
      stubLegalEnv("production", FILLED_LEGAL_ENV);
      const signedOff = LEGAL_SIGN_OFF !== null;
      expect(page.render().includes(DRAFT_NOTICE)).toBe(!signedOff);
      expect(page.generateMetadata().other?.[DRAFT_META_NAME] === "true").toBe(!signedOff);
    });

    it("renders every string the placeholder scan is shown, as visible text", () => {
      // texts() is what the guard checks. If the page rendered a string the
      // list did not include, a placeholder could hide there — so every
      // text must appear in the page's text content.
      stubLegalEnv("development", FILLED_LEGAL_ENV);
      const text = textContent(page.render());
      const texts = page.texts();
      expect(texts.length).toBeGreaterThan(5);
      for (const needle of texts) {
        expect(text, needle.slice(0, 60)).toContain(needle);
      }
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("[object");
    });
  });
}

/**
 * Registers one case per section asserting its review pointers still name
 * files that exist — a rename re-prompts review of the sentence; existence
 * proves nothing more (see LegalProseSection.reviewAgainst).
 */
export function itReviewPointersExist(
  sections: readonly { id: string; reviewAgainst: readonly string[] }[],
): void {
  it.each(sections.map((section) => [section.id, section.reviewAgainst] as const))(
    "%s: every review pointer names an existing file",
    (_id, reviewAgainst) => {
      for (const file of reviewAgainst) {
        expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(true);
      }
    },
  );

  it("would notice a pointer at a file that is gone", () => {
    expect(existsSync(path.join(REPO_ROOT, "src/lib/does-not-exist.ts"))).toBe(false);
  });
}
