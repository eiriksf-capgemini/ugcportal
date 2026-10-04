import { describe, expect, it, vi } from "vitest";

import { CONSENT_COOKIE_NAME } from "./consent";

/**
 * Covers the server-only half of the consent store: the initial SSR read
 * src/app/layout.tsx uses to seed ConsentProvider, so the first paint
 * already matches whatever the browser's cookie carries (K2/K3 — "no banner
 * shows on the next navigation" / "does not reappear on later visits",
 * which both depend on the SERVER already knowing the stored choice, not
 * just the client).
 */
const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

const { readConsentCookieOnServer } = await import("./consent.server");

describe("readConsentCookieOnServer", () => {
  it("reads null when no cookie is present", async () => {
    cookieStore.clear();
    expect(await readConsentCookieOnServer()).toBeNull();
  });

  it("reads 'granted' from the real cookie name", async () => {
    cookieStore.clear();
    cookieStore.set(CONSENT_COOKIE_NAME, "granted");
    expect(await readConsentCookieOnServer()).toBe("granted");
  });

  it("reads 'denied' from the real cookie name", async () => {
    cookieStore.clear();
    cookieStore.set(CONSENT_COOKIE_NAME, "denied");
    expect(await readConsentCookieOnServer()).toBe("denied");
  });

  it("does not trust an unrecognised stored value as either real choice", async () => {
    cookieStore.clear();
    cookieStore.set(CONSENT_COOKIE_NAME, "yes-please");
    expect(await readConsentCookieOnServer()).toBeNull();
  });
});
