/**
 * The one place this repo reads, writes or deletes a first-party browser
 * cookie (ugcportal-3wgp review round 1, finding 6 — reuse). Before this,
 * `src/lib/consent.ts` and `src/components/consent/analytics-loader.tsx`
 * each hand-rolled their own `document.cookie` parsing/building; the next
 * consent-adjacent cookie (a second vendor, a `__Host-` prefix, a SameSite
 * tightening) would have been a fourth variant instead of a one-line change
 * here.
 *
 * Deliberately generic and vendor-agnostic: this module must never mention
 * a specific analytics vendor by name, so it is exempt from the K6
 * repo-grep test's allowlist rather than needing to be added to it.
 */

function isBrowser(): boolean {
  return typeof document !== "undefined";
}

/** Reads a single cookie by exact name, or `null` if absent or server-side. */
export function getCookie(name: string): string | null {
  if (!isBrowser()) return null;
  const prefix = `${name}=`;
  const row = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix));
  if (row === undefined) return null;
  return decodeURIComponent(row.slice(prefix.length));
}

export type SetCookieOptions = {
  /** Omit for a session cookie. */
  maxAgeSeconds?: number;
  sameSite?: "Lax" | "Strict" | "None";
  /**
   * Defaults to `true` on an HTTPS origin and `false` otherwise (plain HTTP
   * dev servers can't set a `Secure` cookie at all — the browser silently
   * drops it). Override only if a caller has a reason to force one way.
   */
  secure?: boolean;
};

/** Writes a cookie with `Path=/`. No-op server-side. */
export function setCookie(
  name: string,
  value: string,
  options: SetCookieOptions = {},
): void {
  if (!isBrowser()) return;
  const { maxAgeSeconds, sameSite = "Lax" } = options;
  const secure = options.secure ?? window.location.protocol === "https:";
  const parts = [`${name}=${value}`, "Path=/", `SameSite=${sameSite}`];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push("Secure");
  document.cookie = parts.join("; ");
}

/**
 * Expires a cookie immediately. No-op (including server-side) if the cookie
 * was never set — deleting something absent is not an error.
 *
 * Deliberately does not set `SameSite`/`Secure`: a browser honours a
 * `Max-Age=0` expiry for a name+Path match regardless of what those
 * attributes were on the cookie being deleted, so there is nothing to match.
 */
export function deleteCookie(name: string): void {
  if (!isBrowser()) return;
  document.cookie = `${name}=; Max-Age=0; Path=/`;
}
