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

  // RESTORED (ugcportal-xh4j, 2026-10-12): this asserted the POSITIVE path
  // -- fully configured AND signed off in production reads unblocked --
  // until ugcportal-yzo7 (PR #203) edited /licence's prose and put it back
  // in draft, at which point it was temporarily repointed at the (then
  // still true) BLOCKED outcome below. Eirik reviewed the new wording and
  // re-recorded LEGAL_SIGN_OFF for both pages on 2026-10-12, so /licence is
  // signed off again and the original positive-path assertion holds once
  // more. Not a synthetic sign-off: this reads the real
  // src/lib/legal/contact.ts constant, same as before.
  it("does not block /licence in production once fully configured and signed off", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    expect(legalLinkBlocked(LICENCE_PATH)).toBe(false);
  });

  it("does not block /privacy in production once fully configured and signed off", () => {
    // /privacy's authored prose picked up the uploader's own rights
    // attestation (src/lib/attestation.ts) in the "Rights-clearance
    // records" category's `what` paragraph (PR #204, ugcportal-fsdf) — a
    // real change to the published text — so its digest no longer matched
    // src/lib/legal/contact.ts's LEGAL_SIGN_OFF and the page went back to
    // draft (the same sequence ugcportal-mj50 and ugcportal-qnq9.2.2 each
    // went through). Eirik reviewed the new wording and re-recorded the
    // sign-off on 2026-10-12 (ugcportal-xh4j), so the page reads signed off
    // once more. The unsigned-and-unconfigured cases that discriminate a
    // version of legalLinkBlocked that stopped checking signedOff or
    // missing configuration live elsewhere: the "blocks the link ... while
    // unconfigured" case above, and the stale-sign-off coverage in
    // src/lib/legal/publishable.test.ts.
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
  // RESTORED (ugcportal-xh4j, 2026-10-12) -- same cause and same fix as the
  // positive-path case above. This isolates ENV PRECEDENCE: process.env
  // unconfigured, the explicit argument fully configured, so an UNBLOCKED
  // result proves the argument won (if `legalLinkBlocked` forgot to thread
  // `env` into `legalReadiness` -- the CONFIRMED medium this test was
  // written to guard -- it would read process.env instead, see the missing
  // variables, and report blocked). It needed a page that is unblocked FOR
  // SIGN-OFF REASONS once fully configured, which requires both (a) no
  // missing LEGAL_* variable and (b) a real, current LEGAL_SIGN_OFF entry;
  // while /licence was in draft for sign-off reasons neither env reading
  // could produce an unblocked result, so this could only read "blocked
  // either way" (true), which cannot distinguish the argument being read
  // from it being ignored. Eirik's 2026-10-12 re-sign (ugcportal-xh4j)
  // makes /licence genuinely unblocked when configured, so this now proves
  // what it was written to prove again.
  it("reads unblocked for /licence when the explicit env argument is fully configured, even though process.env is not", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(UNSET_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    const explicitFilled = {
      NODE_ENV: "production",
      ...FILLED_LEGAL_ENV,
    } as NodeJS.ProcessEnv;
    expect(legalLinkBlocked(LICENCE_PATH, explicitFilled)).toBe(false);
  });

  // RESTORED (ugcportal-xh4j, 2026-10-12) -- the third of three, and the
  // one that makes the hole complete. Found at PR #204 round 2 after the
  // first two were suspended and this sibling was missed.
  //
  // Reads: process.env fully configured AND signed off (so it would NOT
  // block on its own), explicit argument unconfigured, therefore blocked --
  // proving the argument won. Its premise "and signed off" stopped being
  // true when ugcportal-yzo7 drafted /licence, at which point this read
  // "blocked either way" and could no longer discriminate an env-argument
  // bug from the sign-off state -- the reason this comment block used to
  // carry a SUSPENDED marker and the one above it did too. Eirik's
  // 2026-10-12 re-sign (ugcportal-xh4j) makes process.env-alone genuinely
  // unblocked again, so the body below -- unchanged throughout, since its
  // assertion was always the correct one for a signed-off page -- is doing
  // real work again rather than passing on the coincidence that an
  // unconfigured explicit argument blocks regardless of sign-off state.
  it("reads blocked for /licence under a reversed env disagreement too, now that it is signed off", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(FILLED_LEGAL_ENV)) {
      vi.stubEnv(name, value);
    }
    const explicitUnset = {
      NODE_ENV: "production",
      ...UNSET_LEGAL_ENV,
    } as NodeJS.ProcessEnv;
    expect(legalLinkBlocked(LICENCE_PATH, explicitUnset)).toBe(true);
  });
});
