import { afterEach, describe, expect, it, vi } from "vitest";

import { FILLED_LEGAL_ENV, UNSET_LEGAL_ENV } from "@/lib/legal/legal-page.test-support";
import { LEGAL_PAGES, legalLinkBlocked, legalPageFor } from "@/lib/legal/pages";
import { LICENCE_PATH, PRIVACY_PATH } from "@/lib/routes";

/**
 * `legalPageFor` and `legalLinkBlocked` (ugcportal-nf9l) — the lookup and
 * the link-blocking decision the footer (src/components/site-footer.tsx)
 * and the About page's contact notice (src/components/site/
 * contact-section.tsx) both now read from here, rather than each keeping
 * its own copy. The cross-component agreement itself (K2) is tested where
 * both components are rendered — src/components/
 * legal-link-consistency.test.tsx — not here; this file only covers the
 * two functions in isolation.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legalPageFor", () => {
  it("finds a registered page by its route", () => {
    expect(legalPageFor(PRIVACY_PATH)).toBe(
      LEGAL_PAGES.find((page) => page.path === PRIVACY_PATH),
    );
    expect(legalPageFor(LICENCE_PATH)).toBe(
      LEGAL_PAGES.find((page) => page.path === LICENCE_PATH),
    );
  });

  it("throws for a route that is not in LEGAL_PAGES", () => {
    expect(() => legalPageFor("/not-a-real-legal-page")).toThrow(
      /not registered in LEGAL_PAGES/,
    );
  });
});

describe("legalLinkBlocked", () => {
  it("blocks the link in production while unconfigured", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(UNSET_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    expect(legalLinkBlocked(PRIVACY_PATH)).toBe(true);
  });

  it("MUTATION CHECK: does not block the same configuration outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const [name, value] of Object.entries(UNSET_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    expect(legalLinkBlocked(PRIVACY_PATH)).toBe(false);
  });

  it("does not block in production once configured and signed off (today's real sign-off)", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    expect(legalLinkBlocked(PRIVACY_PATH)).toBe(false);
  });

  it("throws for an unregistered route, same as legalPageFor", () => {
    expect(() => legalLinkBlocked("/not-a-real-legal-page")).toThrow(
      /not registered in LEGAL_PAGES/,
    );
  });

  // Round-1 review, CONFIRMED medium: legalLinkBlocked accepted an `env`
  // parameter but passed only `pages` to `legalReadiness`, so `missing`/
  // `strayPlaceholders`/`signedOff`/`draft`/`blocked` were always computed
  // off the real `process.env` — only the final NODE_ENV check in
  // `linkBlockedInProduction` ever read the argument. NODE_ENV is held at
  // "production" in BOTH process.env and the explicit argument below (so a
  // buggy version cannot pass by accident on the final NODE_ENV check
  // alone); only the LEGAL_* configuration disagrees between the two, which
  // is exactly the part a version that forgets to thread `env` into
  // `legalReadiness` would get from the wrong source.
  it("follows the explicit env argument's configuration, not process.env's, when the two disagree", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(UNSET_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    // process.env is unconfigured (would block on its own); the explicit
    // argument is fully configured and production — not blocked.
    const explicitFilled = {
      NODE_ENV: "production",
      ...FILLED_LEGAL_ENV,
    } as NodeJS.ProcessEnv;
    expect(legalLinkBlocked(PRIVACY_PATH, explicitFilled)).toBe(false);
  });

  it("MUTATION CHECK: the reverse disagreement also follows the argument", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    // process.env is fully configured and signed off (would NOT block on
    // its own); the explicit argument is unconfigured — blocked.
    const explicitUnset = {
      NODE_ENV: "production",
      ...UNSET_LEGAL_ENV,
    } as NodeJS.ProcessEnv;
    expect(legalLinkBlocked(PRIVACY_PATH, explicitUnset)).toBe(true);
  });
});
