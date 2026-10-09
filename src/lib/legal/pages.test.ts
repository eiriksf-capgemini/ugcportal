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

  // SUSPENDED, not deleted. This asserted the POSITIVE path: fully
  // configured AND signed off in production reads unblocked. It cannot be
  // asserted against the real constants today, because BOTH legal pages are
  // in draft -- ugcportal-yzo7 (PR #203) edited /licence's prose and
  // ugcportal-fsdf (PR #204) edited /privacy's, so each page's authored
  // digest no longer matches LEGAL_SIGN_OFF. There is no signed-off page
  // left to point this at.
  //
  // Restore it -- pointed at whichever page is signed off -- when Eirik
  // re-records the digests. Do NOT substitute a synthetic sign-off to keep
  // a green positive case: this block deliberately reads the real fact, and
  // faking it would make the test pass while telling the reader nothing.
  // Tracked by ugcportal-44qs.
  it("blocks /licence in production while its edited prose awaits sign-off (ugcportal-yzo7)", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    expect(legalLinkBlocked(LICENCE_PATH)).toBe(true);
  });

  it("blocks /privacy in production even fully configured, because its prose changed since the last sign-off (ugcportal-fsdf)", () => {
    // /privacy's authored prose picked up the uploader's own rights
    // attestation (src/lib/attestation.ts) in the "Rights-clearance
    // records" category's `what` — a real change to the published text —
    // so its digest no longer matches src/lib/legal/contact.ts's
    // LEGAL_SIGN_OFF, and the page is correctly back in draft until a human
    // re-approves it (the same sequence ugcportal-mj50 and
    // ugcportal-qnq9.2.2 each went through). Paired with the /licence case
    // above: a version of legalLinkBlocked that stopped checking signedOff
    // (configuration alone) would report BOTH as not-blocked, passing the
    // /licence test above but failing this one.
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    expect(legalLinkBlocked(PRIVACY_PATH)).toBe(true);
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
  // SUSPENDED, not deleted -- same cause as the positive-path case above.
  // This isolated ENV PRECEDENCE: process.env unconfigured, the explicit
  // argument fully configured, so an unblocked result proved the argument
  // won. It needs a page that is unblocked FOR SIGN-OFF REASONS, and since
  // both pages went to draft (ugcportal-yzo7, ugcportal-fsdf) every page
  // reads blocked regardless of which env is threaded through -- so the
  // assertion can no longer tell an env-argument bug from the sign-off
  // state, which is exactly the confusion its own earlier comment warned
  // about when it was repointed from /privacy to /licence.
  //
  // The reverse direction below still covers the argument being honoured,
  // so precedence is not entirely untested in the meantime. Restore this
  // half when a sign-off lands. Tracked by ugcportal-44qs.
  it("reads blocked for /licence under either env while its prose awaits sign-off (ugcportal-yzo7)", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(UNSET_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    const explicitFilled = {
      NODE_ENV: "production",
      ...FILLED_LEGAL_ENV,
    } as NodeJS.ProcessEnv;
    expect(legalLinkBlocked(LICENCE_PATH, explicitFilled)).toBe(true);
  });

  it("MUTATION CHECK: the reverse disagreement also follows the argument", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    // process.env is fully configured and signed off (would NOT block on
    // its own); the explicit argument is unconfigured — blocked. /licence
    // again, for the same reason as the test above.
    const explicitUnset = {
      NODE_ENV: "production",
      ...UNSET_LEGAL_ENV,
    } as NodeJS.ProcessEnv;
    expect(legalLinkBlocked(LICENCE_PATH, explicitUnset)).toBe(true);
  });
});
