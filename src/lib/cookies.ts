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

/**
 * Reads a single cookie by exact name, or `null` if absent, server-side, or
 * unreadable.
 *
 * Fails safe rather than throwing (review round 2, finding 2): a cookie
 * this module didn't write itself — tampered with by hand, or truncated by
 * a browser/proxy cookie-jar size limit — can contain a `%` that is not a
 * valid percent-escape, and `decodeURIComponent` throws `URIError` on that.
 * The one caller that matters most, `readStoredConsent`, needs exactly this
 * behaviour: a malformed cookie must read as "no choice yet" (`null`), the
 * same safe default an absent cookie gets, not crash the render.
 */
export function getCookie(name: string): string | null {
  if (!isBrowser()) return null;
  const prefix = `${name}=`;
  const row = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix));
  if (row === undefined) return null;
  try {
    return decodeURIComponent(row.slice(prefix.length));
  } catch {
    return null;
  }
}

/**
 * `sameSite: "None"` without `secure: true` is forbidden at the TYPE level
 * (review round 2, finding 6), not just by a runtime default: per the
 * Set-Cookie spec, and every modern browser's enforcement of it, a cookie
 * with `SameSite=None` that does not also carry `Secure` is rejected
 * outright — silently written to the `document.cookie` string in the JS
 * sense, never actually persisted by the browser. The discriminated union
 * below makes `{ sameSite: "None" }` with no `secure` (or `secure: false`)
 * a compile error instead of a runtime footgun a caller could hit blind.
 */
type SameSiteOptions =
  | { sameSite?: "Lax" | "Strict"; secure?: boolean }
  | { sameSite: "None"; secure: true };

export type SetCookieOptions = SameSiteOptions & {
  /** Omit for a session cookie. */
  maxAgeSeconds?: number;
};

/**
 * Builds the `document.cookie` assignment string shared by `setCookie` and
 * `deleteCookie` (review round 2, finding 5) — a delete is just a write of
 * an empty value with `Max-Age=0`, and sharing one builder means the two
 * can never again drift on `SameSite`/`Secure`, which is exactly how
 * `deleteCookie` ended up silently missing both in round 1.
 */
function buildCookieAssignment(
  name: string,
  value: string,
  maxAgeSeconds: number | undefined,
  attrs: SameSiteOptions,
): string {
  const { sameSite = "Lax" } = attrs;
  const secure = attrs.secure ?? window.location.protocol === "https:";
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `SameSite=${sameSite}`];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Writes a cookie with `Path=/`. No-op server-side. Encodes `value` with
 * `encodeURIComponent` (review round 2, finding 2 — `getCookie` always
 * decoded on read, but nothing encoded on write; asymmetric, and a value
 * containing `;`, `,`, or a literal `%` would either corrupt the
 * `document.cookie` string or throw on the next read).
 */
export function setCookie(
  name: string,
  value: string,
  options: SetCookieOptions = {},
): void {
  if (!isBrowser()) return;
  document.cookie = buildCookieAssignment(name, value, options.maxAgeSeconds, options);
}

/**
 * Expires a cookie immediately. No-op (including server-side) if the cookie
 * was never set — deleting something absent is not an error.
 *
 * Writes the SAME `SameSite`/`Secure` attributes `setCookie` would have used
 * for these options (review round 2, finding 5): a cookie written with
 * `Secure` can only be overwritten — including by an expiring delete — from
 * a secure context, per "Leave Secure Cookies Alone" (RFC 6265bis,
 * implemented in Chromium/Firefox). A delete that omits `Secure` is
 * silently ignored by the browser against such a cookie, which the
 * previous version of this function's own comment claimed could not
 * happen ("regardless of what those attributes were on the cookie being
 * deleted") — it was wrong. Pass the same `options` used to set a cookie
 * when deleting it, so this actually clears it.
 */
export function deleteCookie(name: string, options: SameSiteOptions = {}): void {
  if (!isBrowser()) return;
  document.cookie = buildCookieAssignment(name, "", 0, options);
}
