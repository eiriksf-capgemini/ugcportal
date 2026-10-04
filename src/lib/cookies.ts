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
 *
 * Round 4, LOW (Family 4 — this module's own `withUmamiDisableFlag` sibling
 * in analytics-loader.tsx already has this guard; `document.cookie` lacked
 * it): merely ACCESSING `document.cookie` — not just decoding what comes
 * back — can throw (a `SecurityError` in a sandboxed cross-origin iframe
 * without `allow-same-origin`, the same precedent `localStorage` access
 * already has here). Without a try/catch around the access itself, that
 * throw would propagate out of whatever click handler called this, which
 * for the banner's own buttons means the handler exits having done nothing
 * — stuck, unresponsive to further clicks, with no visible error. The whole
 * read is now inside the try, not just the decode.
 */
export function getCookie(name: string): string | null {
  if (!isBrowser()) return null;
  try {
    const prefix = `${name}=`;
    const row = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith(prefix));
    if (row === undefined) return null;
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
 *
 * Round 3, finding 10: this discriminated union serves exactly one call
 * site today (nothing in this repo passes `sameSite: "None"` yet) — a
 * runtime guard (throw inside `setCookie` if `sameSite === "None"` and
 * `!secure`) would cover that one site with less type-level machinery.
 * Kept as a type anyway: this is exactly what round 2's own review asked
 * for ("make the type forbid it"), and a compile-time error is strictly
 * stronger than a runtime throw for a mistake this specific — it is caught
 * in the editor and in review, before the code ever runs, rather than only
 * when a test happens to exercise that exact call with that exact caller.
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
 *
 * Round 4, LOW: the WRITE can throw too, same precedent as `getCookie`'s
 * own fix above — a sandboxed context that throws on read can throw on
 * write just as readily, and an uncaught throw here (e.g. from a banner
 * button's `onClick`) leaves that click having silently done nothing.
 */
export function setCookie(
  name: string,
  value: string,
  options: SetCookieOptions = {},
): void {
  if (!isBrowser()) return;
  try {
    document.cookie = buildCookieAssignment(name, value, options.maxAgeSeconds, options);
  } catch {
    // See getCookie's own comment — fails safe rather than throwing out of
    // a caller (most often a click handler) that has no way to recover.
  }
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
  try {
    document.cookie = buildCookieAssignment(name, "", 0, options);
  } catch {
    // See getCookie's own comment.
  }
}
