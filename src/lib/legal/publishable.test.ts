import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LEGAL_CONTACT_VARS, readLegalContact, unsetMarker } from "@/lib/legal/contact";
import {
  FILLED_LEGAL_ENV,
  REPO_ROOT,
  UNSET_LEGAL_ENV,
} from "@/lib/legal/legal-page.test-support";
import { legalPages } from "@/lib/legal/pages";
import {
  assertPublishable,
  checkLegalPagesPublishable,
  findPlaceholders,
  legalReadiness,
} from "@/lib/legal/publishable";
import { LICENCE_PATH, PRIVACY_PATH } from "@/lib/routes";

/**
 * ugcportal-qnq9.4: configuration, readiness and the production guard.
 *
 * Fixture-driven in both directions (review-standards family 3): every
 * assertion below has a sibling that flips the fixture and expects the
 * opposite, so a guard that always throws or never throws fails here.
 */

const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
const filled = { ...PROD, ...FILLED_LEGAL_ENV };
const unset = { ...PROD, ...UNSET_LEGAL_ENV };

const SIGNED = { by: "test", date: "2026-10-04", bead: "ugcportal-alg" };

const cleanPage = { path: "/example", texts: ["Write to kari@example.com."] };
const strayPage = { path: "/example", texts: ["Retention: [fill in later]."] };

describe("readLegalContact", () => {
  it("reads all four variables", () => {
    const { contact, missing } = readLegalContact(filled);
    expect(contact).toEqual({
      controllerName: "Kari Nordmann",
      contactEmail: "kari@example.com",
      hostingProvider: "Example Hosting AS, Norway",
      storageProvider: "Example Objects GmbH, Germany",
    });
    expect(missing).toEqual([]);
  });

  it("substitutes a bracketed variable name for each unset or blank one", () => {
    const { contact, missing } = readLegalContact({
      ...filled,
      LEGAL_CONTACT_EMAIL: undefined,
      LEGAL_STORAGE_PROVIDER: "   ",
    });
    expect(contact.contactEmail).toBe("[LEGAL_CONTACT_EMAIL]");
    expect(contact.storageProvider).toBe("[LEGAL_STORAGE_PROVIDER]");
    expect(contact.controllerName).toBe("Kari Nordmann");
    expect(missing).toEqual(["LEGAL_CONTACT_EMAIL", "LEGAL_STORAGE_PROVIDER"]);
  });

  it("trims a value rather than reporting it", () => {
    expect(readLegalContact({ ...filled, LEGAL_CONTACT_EMAIL: " a@b.no " }).contact.contactEmail).toBe(
      "a@b.no",
    );
  });

  it("names every variable in LEGAL_CONTACT_VARS when nothing is set", () => {
    expect(readLegalContact({} as NodeJS.ProcessEnv).missing).toEqual(
      Object.values(LEGAL_CONTACT_VARS),
    );
  });
});

describe("findPlaceholders", () => {
  it("finds every bracketed token, whatever its case", () => {
    // PR #90 review round 1: the first pattern was upper-case only, so a
    // reminder like "[fill in later]" shipped. Verified by mutation: with
    // the old pattern restored, this test fails on the last two tokens.
    expect(
      findPlaceholders([
        "[LEGAL_CONTROLLER_NAME] and [HOSTING PROVIDER, COUNTRY]",
        "then [fill in later] and [Todo: confirm with counsel]",
      ]),
    ).toEqual([
      "[LEGAL_CONTROLLER_NAME]",
      "[HOSTING PROVIDER, COUNTRY]",
      "[fill in later]",
      "[Todo: confirm with counsel]",
    ]);
  });

  it("finds the bare words TODO and TBD as whole words only", () => {
    expect(findPlaceholders(["Retention: TBD.", "todo: ask Eirik"])).toEqual(["TBD", "todo"]);
    expect(findPlaceholders(["her todos; a stbd sentence; the methodology"])).toEqual([]);
  });

  it("ignores an empty bracket pair and reports each token once", () => {
    expect(findPlaceholders(["an empty [] pair"])).toEqual([]);
    expect(findPlaceholders(["[X1] [X1]", "[X1]"])).toEqual(["[X1]"]);
  });
});

describe("legalReadiness", () => {
  it("is blocked and draft while a variable is unset", () => {
    const readiness = legalReadiness([cleanPage], unset, SIGNED);
    expect(readiness.missing).toEqual(Object.values(LEGAL_CONTACT_VARS));
    expect(readiness.blocked).toBe(true);
    expect(readiness.draft).toBe(true);
  });

  it("is blocked and draft while stray placeholder text remains", () => {
    const readiness = legalReadiness([strayPage], filled, SIGNED);
    expect(readiness.strayPlaceholders).toEqual([
      { path: "/example", tokens: ["[fill in later]"] },
    ]);
    expect(readiness.blocked).toBe(true);
    expect(readiness.draft).toBe(true);
  });

  it("does not report an unset variable's marker a second time as stray prose", () => {
    const page = { path: "/example", texts: [`Contact: ${unsetMarker("LEGAL_CONTACT_EMAIL")}.`] };
    const readiness = legalReadiness([page], { ...filled, LEGAL_CONTACT_EMAIL: "" }, SIGNED);
    expect(readiness.missing).toEqual(["LEGAL_CONTACT_EMAIL"]);
    expect(readiness.strayPlaceholders).toEqual([]);
  });

  it("is a draft but not blocked when configured and not signed off", () => {
    const readiness = legalReadiness([cleanPage], filled, null);
    expect(readiness.blocked).toBe(false);
    expect(readiness.signedOff).toBe(false);
    expect(readiness.draft).toBe(true);
  });

  it("is neither once configured and signed off", () => {
    const readiness = legalReadiness([cleanPage], filled, SIGNED);
    expect(readiness).toMatchObject({ blocked: false, draft: false, signedOff: true });
  });
});

describe("checkLegalPagesPublishable", () => {
  it("names the unset variables, the pages, and env.example", () => {
    const warning = checkLegalPagesPublishable(
      [cleanPage, { ...cleanPage, path: "/other" }],
      { ...filled, LEGAL_CONTROLLER_NAME: "" },
    );
    expect(warning).toContain("LEGAL_CONTROLLER_NAME is not set");
    expect(warning).toContain("/example, /other");
    expect(warning).toContain("env.example");
    expect(warning).not.toContain("LEGAL_CONTACT_EMAIL");
  });

  it("names stray placeholder text per page", () => {
    const warning = checkLegalPagesPublishable(
      [cleanPage, { ...strayPage, path: "/stray" }],
      filled,
    );
    expect(warning).toContain("/stray still contains placeholder text ([fill in later])");
    expect(warning).not.toContain("/example still contains");
  });

  it("spells out the consequence for the environment it runs in", () => {
    expect(checkLegalPagesPublishable([cleanPage], unset)).toContain(
      "Production will not serve /example",
    );
    expect(checkLegalPagesPublishable([cleanPage], { ...DEV, ...UNSET_LEGAL_ENV })).toContain(
      "Outside production /example render",
    );
  });

  it("is null once configured, signed off or not", () => {
    // Sign-off is not an operator's problem; the boot log must not nag
    // about it. legalReadiness still reports it as draft.
    expect(checkLegalPagesPublishable([cleanPage], filled)).toBeNull();
    expect(checkLegalPagesPublishable([cleanPage], { ...DEV, ...FILLED_LEGAL_ENV })).toBeNull();
  });
});

describe("assertPublishable", () => {
  it("throws in production with the boot check's own message", () => {
    const env = { ...filled, LEGAL_CONTACT_EMAIL: "" };
    const expected = checkLegalPagesPublishable([cleanPage], env);
    expect(expected).not.toBeNull();
    expect(() => assertPublishable(cleanPage, env)).toThrow(expected as string);
  });

  it("throws in production on stray placeholder text alone", () => {
    expect(() => assertPublishable(strayPage, filled)).toThrow(/\[fill in later\]/);
  });

  it("is quiet in production once configured", () => {
    expect(() => assertPublishable(cleanPage, filled)).not.toThrow();
  });

  it("lets an unconfigured draft render outside production", () => {
    expect(() => assertPublishable(cleanPage, { ...DEV, ...UNSET_LEGAL_ENV })).not.toThrow();
    expect(() =>
      assertPublishable(strayPage, { NODE_ENV: "test", ...FILLED_LEGAL_ENV } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe("the real legal pages", () => {
  it("carry no stray placeholder text, configured or not", () => {
    // A "[TODO]" in the prose would otherwise be caught only in production,
    // by a visitor. With the variables unset, the only bracketed tokens
    // must be the unset markers, which legalReadiness already excludes.
    for (const env of [filled, unset]) {
      expect(legalReadiness(legalPages(env), env).strayPlaceholders).toEqual([]);
    }
  });

  it("are blocked exactly while unconfigured", () => {
    expect(legalReadiness(legalPages(unset), unset).blocked).toBe(true);
    expect(legalReadiness(legalPages(filled), filled).blocked).toBe(false);
  });

  it("each exist as a page file at the path src/lib/routes.ts names", () => {
    // The route constants are what the footer will link to; a constant with
    // no page behind it is a 404 nobody sees until the crawl.
    const appDir = path.join(REPO_ROOT, "src", "app");
    for (const route of [PRIVACY_PATH, LICENCE_PATH]) {
      expect(existsSync(path.join(appDir, route.slice(1), "page.tsx")), route).toBe(true);
    }
    expect(
      legalPages(filled)
        .map((page) => page.path)
        .sort(),
    ).toEqual([LICENCE_PATH, PRIVACY_PATH].sort());
  });
});
