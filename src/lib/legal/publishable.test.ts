import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LEGAL_CONTACT, findPlaceholders } from "@/lib/legal/contact";
import { legalPages } from "@/lib/legal/pages";
import {
  assertPublishable,
  checkLegalPagesPublishable,
  unresolvedPlaceholders,
} from "@/lib/legal/publishable";
import { LICENCE_PATH, PRIVACY_PATH } from "@/lib/routes";

/**
 * ugcportal-qnq9.4: the production placeholder guard.
 *
 * Fixture-driven in both directions (review-standards family 3): every
 * assertion below has a sibling that flips the fixture and expects the
 * opposite, so a guard that always throws or never throws fails here.
 */

const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: "development" } as NodeJS.ProcessEnv;

const withPlaceholder = {
  path: "/example",
  texts: ["The controller is [CONTROLLER NAME].", "Write to [CONTACT EMAIL]."],
};
const filledIn = {
  path: "/example",
  texts: ["The controller is Kari Nordmann.", "Write to kari@example.com."],
};

describe("findPlaceholders", () => {
  it("finds the bracketed upper-case tokens and nothing else", () => {
    expect(
      findPlaceholders([
        "[CONTROLLER NAME] and [HOSTING PROVIDER, COUNTRY] and [S3-COMPATIBLE STORE]",
        // Not placeholders: a citation marker, lower-case prose, a lone
        // bracket pair.
        "see [1] and [as described above] and []",
      ]),
    ).toEqual([
      "[CONTROLLER NAME]",
      "[HOSTING PROVIDER, COUNTRY]",
      "[S3-COMPATIBLE STORE]",
    ]);
  });

  it("reports each token once however often it appears", () => {
    expect(findPlaceholders(["[X1] [X1]", "[X1]"])).toEqual(["[X1]"]);
  });

  it("matches every value LEGAL_CONTACT ships with as a placeholder", () => {
    // The contract between contact.ts and the guard: the shipped defaults
    // are the tokens the guard looks for. Fill one in and it drops out of
    // this list — which is the point, not a failure.
    for (const value of Object.values(LEGAL_CONTACT)) {
      if (/^\[.*\]$/.test(value)) {
        expect(findPlaceholders([value])).toEqual([value]);
      }
    }
  });
});

describe("assertPublishable", () => {
  it("throws in production while a placeholder remains", () => {
    expect(() => assertPublishable(withPlaceholder, PROD)).toThrow(
      /\[CONTROLLER NAME\], \[CONTACT EMAIL\]/,
    );
  });

  it("names the page and where to fix it", () => {
    expect(() => assertPublishable(withPlaceholder, PROD)).toThrow(
      /\/example .*src\/lib\/legal\/contact\.ts/,
    );
  });

  it("is quiet in production once everything is filled in", () => {
    expect(() => assertPublishable(filledIn, PROD)).not.toThrow();
  });

  it("lets a draft render outside production", () => {
    expect(() => assertPublishable(withPlaceholder, DEV)).not.toThrow();
    expect(() =>
      assertPublishable(withPlaceholder, { NODE_ENV: "test" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe("checkLegalPagesPublishable", () => {
  it("lists every page with a placeholder, one line each", () => {
    const warning = checkLegalPagesPublishable(
      [
        { ...withPlaceholder, path: "/one" },
        filledIn,
        { ...withPlaceholder, path: "/two" },
      ],
      PROD,
    );

    expect(warning).not.toBeNull();
    const lines = (warning as string).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("/one");
    expect(lines[1]).toContain("/two");
    expect(warning).not.toContain("/example");
  });

  it("is null when every page is filled in, and outside production", () => {
    expect(checkLegalPagesPublishable([filledIn], PROD)).toBeNull();
    expect(checkLegalPagesPublishable([withPlaceholder], DEV)).toBeNull();
  });
});

describe("the real legal pages", () => {
  it("carry no placeholder other than the LEGAL_CONTACT ones", () => {
    // A stray "[TODO]" in the prose would otherwise be caught only in
    // production, by a visitor. Every placeholder on either page must be
    // one of the contact fields — and once those are filled in, this
    // expects none at all.
    const allowed = new Set(
      Object.values(LEGAL_CONTACT).filter((value) => /^\[.*\]$/.test(value)),
    );
    for (const page of legalPages()) {
      for (const placeholder of unresolvedPlaceholders(page)) {
        expect(allowed, `${page.path}: ${placeholder}`).toContain(placeholder);
      }
    }
  });

  it("each exist as a page file at the path src/lib/routes.ts names", () => {
    // The route constants are what the footer will link to; a constant with
    // no page behind it is a 404 nobody sees until the crawl.
    const appDir = path.resolve(__dirname, "..", "..", "app");
    for (const route of [PRIVACY_PATH, LICENCE_PATH]) {
      expect(existsSync(path.join(appDir, route.slice(1), "page.tsx")), route).toBe(true);
    }
    expect(legalPages().map((page) => page.path).sort()).toEqual(
      [LICENCE_PATH, PRIVACY_PATH].sort(),
    );
  });
});
