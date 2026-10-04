import { existsSync } from "node:fs";
import path from "node:path";

import type { Metadata } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRAFT_META_NAME, DRAFT_NOTICE } from "@/components/legal/legal-page";
import {
  LEGAL_CONTACT_VARS,
  type LegalContact,
  type LegalContactVar,
  readLegalContact,
  unsetMarker,
} from "@/lib/legal/contact";
import { type LegalPage, legalReadiness } from "@/lib/legal/publishable";

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
  /** The page as the guard sees it: route and authored prose. */
  page: LegalPage;
  /** Renders the page under the current process.env. */
  render: () => string;
  /** The page's generateMetadata, under the current process.env. */
  generateMetadata: () => Metadata;
  /**
   * Every string the page renders under the current process.env — the
   * content module's text function applied to the configured contact. Only
   * the tests want this (round 4): the guard scans `page.authored`, the
   * sentinel-built counterpart, and this is how the tests check that the
   * two trees are the same prose with only the contact substituted.
   */
  renderedTexts: () => readonly string[];
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
  // File-scoped, registered once here for the whole test file (round 5):
  // the page tests' own cases stub the environment too, and this is the one
  // place that undoes it, so neither page test registers its own.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe(`${page.path}: the shared legal-page contract`, () => {
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

    it("in production, needs exactly the variables its own prose renders", () => {
      // Required per page, read off the authored prose (round 5): with only
      // this page's variables set and every other one blank it publishes;
      // blank any one of its own and it does not. Verified by mutation:
      // requiring all four everywhere fails this for /licence.
      const own = new Set(page.page.requires.map((field) => LEGAL_CONTACT_VARS[field]));
      expect(own.size).toBeGreaterThan(0);
      const onlyOwn = Object.fromEntries(
        Object.values(LEGAL_CONTACT_VARS).map((name) => [
          name,
          own.has(name) ? FILLED_LEGAL_ENV[name] : "",
        ]),
      ) as Record<LegalContactVar, string>;
      stubLegalEnv("production", onlyOwn);
      expect(() => page.render()).not.toThrow();

      for (const name of own) {
        stubLegalEnv("production", { ...onlyOwn, [name]: "" });
        expect(() => page.render(), name).toThrow(new RegExp(name));
      }
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

    it("stays a draft after configuration exactly until a sign-off for this prose lands", () => {
      // Configuration is two of the three draft conditions; the third is a
      // LEGAL_SIGN_OFF whose digest matches this page's authored prose.
      // legalReadiness's own tests drive that both ways; this pins the page
      // to it.
      stubLegalEnv("production", FILLED_LEGAL_ENV);
      const { signedOff } = legalReadiness([page.page]);
      expect(page.render().includes(DRAFT_NOTICE)).toBe(!signedOff);
      expect(page.generateMetadata().other?.[DRAFT_META_NAME] === "true").toBe(!signedOff);
    });

    it("renders the configured counterpart of every authored string, as visible text", () => {
      // The guard scans `page.authored` (sentinel-built); the page renders
      // the same prose with the real contact substituted. Two checks pin
      // that the two trees ARE the same prose: same length (so a string
      // present in one cannot be missing from the other — the purity
      // assumption the design rests on), and every rendered string visible
      // in the page's text content (so nothing the scan would see is hidden
      // from a reader, or vice versa).
      stubLegalEnv("development", FILLED_LEGAL_ENV);
      const text = textContent(page.render());
      const rendered = page.renderedTexts();
      expect(rendered.length).toBeGreaterThan(5);
      expect(rendered.length).toBe(page.page.authored.length);
      for (const needle of rendered) {
        expect(text, needle.slice(0, 60)).toContain(needle);
      }
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("[object");
    });

    it("authored and rendered differ only where the contact is substituted", () => {
      // The sentinel is a constant; so every position where the two trees
      // differ must contain a sentinel value on the authored side.
      stubLegalEnv("development", FILLED_LEGAL_ENV);
      const rendered = page.renderedTexts();
      page.page.authored.forEach((authored, index) => {
        if (authored !== rendered[index]) {
          expect(authored, `index ${index}`).toMatch(/-sentinel\b/);
        }
      });
      expect(page.page.authored.some((authored) => /-sentinel\b/.test(authored))).toBe(true);
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
