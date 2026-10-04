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
  unsetMarker,
} from "@/lib/legal/contact";

/**
 * Shared test support for the legal pages (ugcportal-qnq9.4; one helper
 * rather than two copies, PR #90 round 2). Not collected by vitest (the
 * include glob wants `.test.` or `.spec.`) and not scanned as shipped UI by
 * src/lib/design/scan-source.ts (`isTestFile` wants the same) — it only
 * ever runs when a test imports it.
 */

export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** A fully configured deployment, for fixtures. */
export const FILLED_LEGAL_ENV: Record<LegalContactVar, string> = {
  LEGAL_CONTROLLER_NAME: "Kari Nordmann",
  LEGAL_CONTACT_EMAIL: "kari@example.com",
  LEGAL_HOSTING_PROVIDER: "Example Hosting AS, Norway",
  LEGAL_STORAGE_PROVIDER: "Example Objects GmbH, Germany",
};

/** The same deployment as a contact object, for content-module unit tests. */
export const FILLED_CONTACT: LegalContact = {
  controllerName: FILLED_LEGAL_ENV.LEGAL_CONTROLLER_NAME,
  contactEmail: FILLED_LEGAL_ENV.LEGAL_CONTACT_EMAIL,
  hostingProvider: FILLED_LEGAL_ENV.LEGAL_HOSTING_PROVIDER,
  storageProvider: FILLED_LEGAL_ENV.LEGAL_STORAGE_PROVIDER,
};

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
 * The visible text of static markup: tags removed, every entity React can
 * emit decoded (it escapes & < > " ' as named or numeric references). One
 * pass, so a literal "&lt;" in the source — emitted as "&amp;lt;" — decodes
 * to "&lt;" and not further. Complete rather than a hand-picked list (PR #90
 * round 2).
 */
export function textContent(markup: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        return String.fromCodePoint(parseInt(body.slice(2), 16));
      }
      if (body.startsWith("#")) {
        return String.fromCodePoint(parseInt(body.slice(1), 10));
      }
      return named[body.toLowerCase()] ?? whole;
    });
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
