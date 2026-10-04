import { cookies } from "next/headers";

import { CONSENT_COOKIE_NAME, parseConsentChoice, type ConsentChoice } from "./consent";

/**
 * The server-only half of consent.ts: reads the stored choice during a
 * server render (src/app/layout.tsx) so the first paint already matches
 * what the browser has, rather than always rendering the banner for one
 * frame and then correcting on the client.
 *
 * Split out from consent.ts rather than added to it because `next/headers`
 * cannot be imported from a "use client" module — this file must only ever
 * be imported by server components.
 */
export async function readConsentCookieOnServer(): Promise<ConsentChoice | null> {
  const store = await cookies();
  return parseConsentChoice(store.get(CONSENT_COOKIE_NAME)?.value);
}
