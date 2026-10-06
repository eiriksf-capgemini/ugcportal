import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LEGAL_CONTACT_VARS,
  SENTINEL_CONTACT,
  type LegalSignOff,
  readLegalContact,
  suspiciousLegalValueWarning,
  suspiciousLegalValues,
} from "@/lib/legal/contact";
import {
  BRACKETED_LEGAL_ENV,
  FILLED_LEGAL_ENV,
  PLAUSIBLE_LEGAL_ENV,
  REPO_ROOT,
  UNSET_LEGAL_ENV,
} from "@/lib/legal/legal-page.test-support";
import { LEGAL_PAGES } from "@/lib/legal/pages";
import {
  type LegalPage,
  assertPublishable,
  authoredDigest,
  checkLegalPagesPublishable,
  createLegalPageLoader,
  findPlaceholders,
  legalPage,
  legalReadiness,
  linkBlockedInProduction,
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
const bracketed = { ...PROD, ...BRACKETED_LEGAL_ENV };

/** Built the way the real pages are: authored prose, with the contact interpolated. */
function examplePage(prose = "Write to {email}.", route = "/example") {
  return legalPage(route, (contact) => [prose.replace("{email}", contact.contactEmail)]);
}
const cleanPage = examplePage();
const strayPage = examplePage("Retention: [fill in later]. Write to {email}.");

/** A sign-off that certifies exactly the given pages' current prose. */
function signOffFor(...pages: { path: string; authoredSha256: string }[]): LegalSignOff {
  return {
    by: "test",
    date: "2026-10-04",
    bead: "ugcportal-alg",
    authoredSha256: Object.fromEntries(pages.map((page) => [page.path, page.authoredSha256])),
  };
}
// For cleanPage's prose. strayPage shares its route, so a map keyed by
// route cannot certify both — and the stray tests only ever assert
// "blocked", which holds whatever the sign-off says.
const SIGNED = signOffFor(cleanPage);

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
    expect(
      readLegalContact({ ...filled, LEGAL_CONTACT_EMAIL: " a@b.no " }).contact.contactEmail,
    ).toBe("a@b.no");
  });

  it("names every variable in LEGAL_CONTACT_VARS when nothing is set", () => {
    expect(readLegalContact({} as NodeJS.ProcessEnv).missing).toEqual(
      Object.values(LEGAL_CONTACT_VARS),
    );
  });
});

describe("suspiciousLegalValues / suspiciousLegalValueWarning (ugcportal-qnq9.15 item 2)", () => {
  // Deliberately NOT FILLED_LEGAL_ENV: three of its four values already
  // contain the word "example" ("Example Hosting AS, Norway", "Example
  // Objects GmbH, Germany", "kari@example.com") — good for every OTHER test
  // in this file, which only cares that the variables are non-blank, but
  // exactly the thing this check exists to flag. PLAUSIBLE_LEGAL_ENV (same
  // test-support module) is the honest control for "does not flag a
  // legitimate value".
  const plausible = { ...PROD, ...PLAUSIBLE_LEGAL_ENV } as NodeJS.ProcessEnv;

  it("flags a SET value that still reads as env.example's own sample text", () => {
    // "Example Hosting AS, Norway" is env.example's own illustrative value
    // for LEGAL_HOSTING_PROVIDER — an operator who pasted it literally
    // would otherwise publish it with no warning at all.
    const found = suspiciousLegalValues({
      ...plausible,
      LEGAL_HOSTING_PROVIDER: "Example Hosting AS, Norway",
    });
    expect(found).toEqual([{ name: "LEGAL_HOSTING_PROVIDER", value: "Example Hosting AS, Norway" }]);
  });

  it("flags a bare TODO left in a SET value, case-insensitively", () => {
    expect(
      suspiciousLegalValues({ ...plausible, LEGAL_CONTROLLER_NAME: "todo: ask Eirik" }),
    ).toEqual([{ name: "LEGAL_CONTROLLER_NAME", value: "todo: ask Eirik" }]);
  });

  it("does not flag a legitimate operator value with neither signal", () => {
    // The control: a value containing neither "example" nor "todo" must not
    // warn, or this would nag on every real deployment.
    expect(suspiciousLegalValues(plausible)).toEqual([]);
  });

  it("does not flag an UNSET variable — that is readLegalContact's `missing`, not this", () => {
    // An unset variable renders as `[LEGAL_CONTROLLER_NAME]`, which itself
    // contains neither "example" nor "todo", but the exclusion is explicit
    // (by name, via `missing`) rather than incidental: this must stay true
    // even if a future variable name changed to contain either word.
    expect(suspiciousLegalValues(unset)).toEqual([]);
  });

  it("never blocks or marks a page a draft, whatever it finds (round 3's promise holds)", () => {
    // Verified by mutation: folding this into `legalReadiness`'s `blocked`
    // would make `blocked` true below; as written it is not, even though
    // FILLED_LEGAL_ENV (used here, not `plausible`, precisely because it
    // DOES trip this check on three of its four fields) is what every other
    // "the real legal pages" test treats as a fully configured deployment.
    expect(suspiciousLegalValues(filled).length).toBeGreaterThan(0);
    const readiness = legalReadiness(LEGAL_PAGES, filled);
    expect(readiness.blocked).toBe(false);
  });

  it("suspiciousLegalValueWarning is null when nothing is flagged, and names the variable and value when it is", () => {
    expect(suspiciousLegalValueWarning(plausible)).toBeNull();
    const warning = suspiciousLegalValueWarning({
      ...plausible,
      LEGAL_CONTACT_EMAIL: "kari@example.com",
    });
    expect(warning).toContain("LEGAL_CONTACT_EMAIL");
    expect(warning).toContain("kari@example.com");
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

  it("the sentinel contact can never read as a placeholder", () => {
    expect(findPlaceholders(Object.values(SENTINEL_CONTACT))).toEqual([]);
  });
});

describe("legalPage", () => {
  it("builds the authored prose from the sentinel, with its digest", () => {
    expect(cleanPage.authored).toEqual(["Write to contact-email-sentinel."]);
    expect(cleanPage.authoredSha256).toBe(authoredDigest(cleanPage.authored));
    expect(cleanPage.authoredSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives what a page requires from the fields its prose interpolates (round 5)", () => {
    expect(cleanPage.requires).toEqual(["contactEmail"]);
    const two = legalPage("/two", (c) => [`${c.controllerName} / ${c.storageProvider}`]);
    expect(two.requires).toEqual(["controllerName", "storageProvider"]);
    expect(legalPage("/none", () => ["static"]).requires).toEqual([]);
  });

  it("the sentinel values cannot be mistaken for one another", () => {
    // `requires` is detected by substring, so no sentinel may contain another.
    const values = Object.values(SENTINEL_CONTACT);
    for (const a of values) {
      for (const b of values) {
        if (a !== b) expect(a.includes(b)).toBe(false);
      }
    }
  });

  it("gives different prose a different digest", () => {
    expect(examplePage("Write to {email}!").authoredSha256).not.toBe(cleanPage.authoredSha256);
  });
});

describe("createLegalPageLoader (ugcportal-qnq9.15 item 4)", () => {
  // The one shape loadPrivacy/loadLicence (src/app/privacy/content.ts,
  // src/app/licence/content.ts) now both delegate to, instead of each
  // hand-rolling the same cache()-wrapped { content, page, readiness }
  // object. Exercised directly here, against a throwaway page, rather than
  // through either real loader: those stay covered by their own existing
  // page tests, unchanged (K4).
  type Built = { controllerName: string };
  const page = legalPage("/loader-example", (contact) => [
    `Run by ${contact.controllerName}.`,
  ]);
  const contentFor = (contact: { controllerName: string }): Built => ({
    controllerName: contact.controllerName,
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the given page record and content built from the configured contact", () => {
    const load = createLegalPageLoader(page, contentFor);
    const result = load(filled);
    expect(result.page).toBe(page);
    expect(result.content).toEqual({ controllerName: FILLED_LEGAL_ENV.LEGAL_CONTROLLER_NAME });
  });

  it("returns the SAME readiness legalReadiness([page], env) would compute, from the ARGUMENT, not process.env", () => {
    // process.env and the explicit argument deliberately disagree (same
    // technique as pages.test.ts's "follows the explicit env argument's
    // configuration, not process.env's"): process.env stubbed fully
    // configured (so dropping `env` internally would read it as NOT
    // blocked), the explicit argument unconfigured (blocked). Verified by
    // mutation: calling `legalReadiness([page])` without `env` inside
    // createLegalPageLoader makes this fail — readiness.blocked flips to
    // false because it would be computed from the stubbed process.env
    // instead of the unconfigured argument.
    for (const name of Object.values(LEGAL_CONTACT_VARS)) {
      vi.stubEnv(name, FILLED_LEGAL_ENV[name]);
    }
    const load = createLegalPageLoader(page, contentFor);
    const env = { ...unset, LEGAL_CONTROLLER_NAME: "" };
    const readiness = load(env).readiness;
    expect(readiness).toEqual(legalReadiness([page], env));
    expect(readiness.blocked).toBe(true);
  });

  it("defaults to process.env, same convention as every other reader in this module", () => {
    const load = createLegalPageLoader(page, contentFor);
    // No stubbing here — proves the parameter is optional and falls back,
    // rather than merely typed as optional and always required in practice.
    expect(() => load()).not.toThrow();
  });

  it("two pages built through this helper do not share a loader (each call makes its own cache())", () => {
    const other = legalPage("/other-loader-example", (contact) => [
      `Contact: ${contact.contactEmail}.`,
    ]);
    const loadA = createLegalPageLoader(page, contentFor);
    const loadB = createLegalPageLoader(other, (contact) => ({ email: contact.contactEmail }));
    expect(loadA(filled).page).toBe(page);
    expect(loadB(filled).page).toBe(other);
  });
});

describe("legalReadiness", () => {
  it("is blocked and draft while a variable the page renders is unset", () => {
    const readiness = legalReadiness([cleanPage], unset, SIGNED);
    // cleanPage renders only the contact address, so only that is missing.
    expect(readiness.missing).toEqual(["LEGAL_CONTACT_EMAIL"]);
    expect(readiness.strayPlaceholders).toEqual([]);
    expect(readiness.blocked).toBe(true);
    expect(readiness.draft).toBe(true);
  });

  it("ignores an unset variable the page never renders (round 5)", () => {
    const onlyEmail = { ...unset, LEGAL_CONTACT_EMAIL: "kari@example.com" };
    const readiness = legalReadiness([cleanPage], onlyEmail, SIGNED);
    expect(readiness).toMatchObject({ missing: [], blocked: false, draft: false });
    // The union over several pages: a page that renders the storage
    // provider brings its variable back in.
    const storage = legalPage("/storage", (c) => [`Stored by ${c.storageProvider}.`]);
    expect(legalReadiness([cleanPage, storage], onlyEmail, SIGNED).missing).toEqual([
      "LEGAL_STORAGE_PROVIDER",
    ]);
  });

  it("blockedPaths names only the page a missing variable actually belongs to (ugcportal-qnq9.15 item 1)", () => {
    // cleanPage renders only the contact address; storage renders only the
    // storage provider. Unsetting the storage provider alone must block
    // `storage` without blocking `cleanPage` — a page that never mentions
    // the storage provider has nothing wrong with it.
    const storage = legalPage("/storage", (c) => [`Stored by ${c.storageProvider}.`]);
    const onlyEmail = { ...unset, LEGAL_CONTACT_EMAIL: "kari@example.com" };
    const readiness = legalReadiness([cleanPage, storage], onlyEmail, SIGNED);
    expect(readiness.blocked).toBe(true);
    expect(readiness.paths).toEqual(["/example", "/storage"]);
    expect(readiness.blockedPaths).toEqual(["/storage"]);
  });

  it("blockedPaths also names a page with its own stray placeholder, and nothing else", () => {
    const stray = examplePage("[fill in later] {email}", "/stray");
    const readiness = legalReadiness([cleanPage, stray], filled, SIGNED);
    expect(readiness.blocked).toBe(true);
    expect(readiness.paths).toEqual(["/example", "/stray"]);
    expect(readiness.blockedPaths).toEqual(["/stray"]);
  });

  it("is blocked and draft while stray placeholder text remains", () => {
    const readiness = legalReadiness([strayPage], filled, SIGNED);
    expect(readiness.strayPlaceholders).toEqual([
      { path: "/example", tokens: ["[fill in later]"] },
    ]);
    expect(readiness.blocked).toBe(true);
    expect(readiness.draft).toBe(true);
  });

  it("scans the authored prose, not the operator's values (round 3)", () => {
    // An operator value with brackets or TBD is a SET variable. The page's
    // rendered text contains the brackets; the scan must not see them.
    const textsFor = (contact: { hostingProvider: string; controllerName: string }) => [
      `Hosted by ${contact.hostingProvider}; run by ${contact.controllerName}.`,
    ];
    const page = legalPage("/example", textsFor);
    const rendered = textsFor(readLegalContact(bracketed).contact);
    expect(rendered[0]).toContain("[Oslo]");
    expect(rendered[0]).toContain("TBD");
    const readiness = legalReadiness([page], bracketed, signOffFor(page));
    expect(readiness.strayPlaceholders).toEqual([]);
    expect(readiness).toMatchObject({ missing: [], blocked: false, draft: false });
    expect(() => assertPublishable(readiness, bracketed)).not.toThrow();
  });

  it("still catches a placeholder the repository wrote next to a bracketed value", () => {
    // The control for the case above: the authored text is what is scanned,
    // and an authored placeholder is still found with the same env.
    const page = legalPage("/example", (contact) => [
      `Hosted by ${contact.hostingProvider} [since TBD].`,
    ]);
    expect(legalReadiness([page], bracketed, signOffFor(page)).strayPlaceholders).toEqual([
      { path: "/example", tokens: ["[since TBD]"] },
    ]);
  });

  it("is a draft but not blocked when configured and not signed off", () => {
    const readiness = legalReadiness([cleanPage], filled, null);
    expect(readiness.blocked).toBe(false);
    expect(readiness.signedOff).toBe(false);
    expect(readiness.draft).toBe(true);
  });

  it("is neither once configured and signed off for this prose", () => {
    const readiness = legalReadiness([cleanPage], filled, SIGNED);
    expect(readiness).toMatchObject({ blocked: false, draft: false, signedOff: true });
  });

  it("treats a sign-off for different prose as no sign-off (round 4)", () => {
    // Edit one paragraph after the sign-off: the digest no longer matches,
    // so the page is unsigned and back in draft — not blocked, since the
    // configuration is fine. Verified by mutation: comparing `signOff !==
    // null` alone makes this pass as signed off.
    const edited = examplePage("Write to {email}, any time.");
    expect(edited.path).toBe(cleanPage.path);
    const readiness = legalReadiness([edited], filled, SIGNED);
    expect(readiness.signedOff).toBe(false);
    expect(readiness.draft).toBe(true);
    expect(readiness.blocked).toBe(false);
    // The control: re-sign the edited prose and it is signed off again.
    expect(legalReadiness([edited], filled, signOffFor(edited)).signedOff).toBe(true);
  });

  it("requires a matching digest for every page given, and exposes the current ones", () => {
    const other = examplePage("Other page: {email}.", "/other");
    const partial = signOffFor(cleanPage);
    expect(legalReadiness([cleanPage], filled, partial).signedOff).toBe(true);
    expect(legalReadiness([cleanPage, other], filled, partial).signedOff).toBe(false);
    expect(legalReadiness([cleanPage, other], filled, signOffFor(cleanPage, other)).signedOff).toBe(
      true,
    );
    expect(legalReadiness([cleanPage, other], filled).digests).toEqual({
      "/example": cleanPage.authoredSha256,
      "/other": other.authoredSha256,
    });
  });
});

describe("checkLegalPagesPublishable", () => {
  it("names the unset variable, env.example, and only the page it actually blocks", () => {
    // /other is the page that renders the controller; /example renders only
    // the contact and never the controller, so an unset controller name
    // must not block (or be named for) /example at all — ugcportal-qnq9.15
    // item 1, PR #90 round-6 cap finding: the message used to name EVERY
    // given page whenever any one of them was blocked. Verified by
    // mutation: reverting blockerWarning's `paths` back to
    // `readiness.paths` (every given page) makes the two `.not.toContain`
    // assertions below fail.
    const other = legalPage("/other", (contact) => [`Run by ${contact.controllerName}.`]);
    const warning = checkLegalPagesPublishable([cleanPage, other], {
      ...filled,
      LEGAL_CONTROLLER_NAME: "",
    });
    expect(warning).toContain("LEGAL_CONTROLLER_NAME is not set");
    expect(warning).toContain("/other");
    expect(warning).toContain("env.example");
    expect(warning).not.toContain("LEGAL_CONTACT_EMAIL");
    expect(warning).not.toContain("/example");
  });

  it("names stray placeholder text per page", () => {
    const warning = checkLegalPagesPublishable(
      [cleanPage, examplePage("[fill in later] {email}", "/stray")],
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
    expect(() => assertPublishable(legalReadiness([cleanPage], env), env)).toThrow(
      expected as string,
    );
  });

  it("throws in production on stray placeholder text alone", () => {
    expect(() => assertPublishable(legalReadiness([strayPage], filled), filled)).toThrow(
      /\[fill in later\]/,
    );
  });

  it("is quiet in production once configured, signed off or not", () => {
    expect(() => assertPublishable(legalReadiness([cleanPage], filled, null), filled)).not.toThrow();
  });

  it("lets an unconfigured draft render outside production", () => {
    const dev = { ...DEV, ...UNSET_LEGAL_ENV };
    expect(() => assertPublishable(legalReadiness([cleanPage], dev), dev)).not.toThrow();
    const test = { NODE_ENV: "test", ...FILLED_LEGAL_ENV } as NodeJS.ProcessEnv;
    expect(() => assertPublishable(legalReadiness([strayPage], test), test)).not.toThrow();
  });
});

describe("linkBlockedInProduction (ugcportal-akv6 K3; reused by ugcportal-nf9l for About)", () => {
  it("blocks a draft page once NODE_ENV is production", () => {
    const readiness = legalReadiness([cleanPage], filled, null);
    expect(readiness.draft).toBe(true);
    expect(linkBlockedInProduction(readiness, filled)).toBe(true);
  });

  it("MUTATION CHECK: does not block the same draft page outside production", () => {
    const readiness = legalReadiness([cleanPage], filled, null);
    expect(readiness.draft).toBe(true);
    expect(linkBlockedInProduction(readiness, DEV)).toBe(false);
  });

  it("does not block a page that is not a draft, even in production", () => {
    const readiness = legalReadiness([cleanPage], filled, SIGNED);
    expect(readiness.draft).toBe(false);
    expect(linkBlockedInProduction(readiness, filled)).toBe(false);
  });

  it("round-3 review: blocks a STALE sign-off too (fully configured, draft=true, but blocked=false)", () => {
    // The branch the e2e suite can observe but not control (a real
    // deployment's sign-off can go stale without ever becoming
    // unconfigured) — same fixture as "treats a sign-off for different
    // prose as no sign-off" above: the prose changed after SIGNED was
    // recorded, so signedOff=false and draft=true, but configuration is
    // fine so blocked stays false. `linkBlockedInProduction` must key off
    // `draft`, not `blocked`, or a stale-sign-off page would wrongly get
    // linked in production despite reading as a draft (DRAFT_META_NAME
    // still present — see src/components/legal/legal-page.tsx).
    const edited = examplePage("Write to {email}, any time.");
    const readiness = legalReadiness([edited], filled, SIGNED);
    expect(readiness).toMatchObject({ blocked: false, draft: true });
    expect(linkBlockedInProduction(readiness, filled)).toBe(true);
  });
});

describe("the real legal pages", () => {
  it("carry no stray placeholder text, whatever the operator typed", () => {
    // A "[TODO]" in the prose would otherwise be caught only in production,
    // by a visitor. The authored prose is the same under every env, so this
    // holds unset, filled and bracketed alike.
    for (const env of [filled, unset, bracketed]) {
      expect(legalReadiness(LEGAL_PAGES, env).strayPlaceholders).toEqual([]);
    }
  });

  it("each require exactly the variables their prose renders", () => {
    // /privacy names the controller, the contact, the host and the store;
    // /licence names the controller and the contact and nothing else.
    const byPath = Object.fromEntries(LEGAL_PAGES.map((page) => [page.path, page.requires]));
    expect(byPath[PRIVACY_PATH]).toEqual([
      "controllerName",
      "contactEmail",
      "hostingProvider",
      "storageProvider",
    ]);
    expect(byPath[LICENCE_PATH]).toEqual(["controllerName", "contactEmail"]);
  });

  it("/licence publishes with only its own two variables set; /privacy still needs all four", () => {
    // Verified by mutation: requiring every field on every page fails the
    // first expectation.
    const licenceOnly = {
      ...unset,
      LEGAL_CONTROLLER_NAME: FILLED_LEGAL_ENV.LEGAL_CONTROLLER_NAME,
      LEGAL_CONTACT_EMAIL: FILLED_LEGAL_ENV.LEGAL_CONTACT_EMAIL,
    };
    const licence = LEGAL_PAGES.find((page) => page.path === LICENCE_PATH) as LegalPage;
    const privacy = LEGAL_PAGES.find((page) => page.path === PRIVACY_PATH) as LegalPage;
    expect(legalReadiness([licence], licenceOnly).blocked).toBe(false);
    expect(() => assertPublishable(legalReadiness([licence], licenceOnly), licenceOnly)).not.toThrow();
    expect(legalReadiness([privacy], licenceOnly)).toMatchObject({
      blocked: true,
      missing: ["LEGAL_HOSTING_PROVIDER", "LEGAL_STORAGE_PROVIDER"],
    });
    // Boot walks both, so the boot warning still names what /privacy lacks.
    const warning = checkLegalPagesPublishable(LEGAL_PAGES, licenceOnly);
    expect(warning).toContain("LEGAL_HOSTING_PROVIDER, LEGAL_STORAGE_PROVIDER are not set");
    // ugcportal-qnq9.15 item 1 (PR #90 round-6 cap, reproduced with exactly
    // this env per this bead's notes): /licence is fully configured here
    // and must not be told production will refuse to serve it, even though
    // /privacy — which actually needs the two unset variables — is.
    // Verified by mutation: naming every given page (the pre-fix behaviour)
    // makes the second assertion fail.
    expect(warning).toContain(`Production will not serve ${PRIVACY_PATH}`);
    expect(warning).not.toContain(LICENCE_PATH);
  });

  it("are blocked exactly while unconfigured", () => {
    expect(legalReadiness(LEGAL_PAGES, unset).blocked).toBe(true);
    expect(legalReadiness(LEGAL_PAGES, filled).blocked).toBe(false);
    expect(legalReadiness(LEGAL_PAGES, bracketed).blocked).toBe(false);
    expect(() => assertPublishable(legalReadiness(LEGAL_PAGES, bracketed), bracketed)).not.toThrow();
  });

  it("each exist as a page file at the path src/lib/routes.ts names", () => {
    // The route constants are what the footer will link to; a constant with
    // no page behind it is a 404 nobody sees until the crawl.
    const appDir = path.join(REPO_ROOT, "src", "app");
    for (const route of [PRIVACY_PATH, LICENCE_PATH]) {
      expect(existsSync(path.join(appDir, route.slice(1), "page.tsx")), route).toBe(true);
    }
    expect(LEGAL_PAGES.map((page) => page.path).sort()).toEqual(
      [LICENCE_PATH, PRIVACY_PATH].sort(),
    );
  });
});
