/**
 * The one shared "run this, and if it throws for any reason, do nothing and
 * move on" wrapper (ugcportal-3wgp review round 5, LOW finding 5 — reuse,
 * Family 4). Before this, `src/lib/cookies.ts` (getCookie/setCookie/
 * deleteCookie, around `document.cookie` access) and
 * `src/components/consent/analytics-loader.tsx` (`withUmamiDisableFlag`,
 * around `window.localStorage` access) each hand-rolled the identical
 * try/catch-and-swallow shape — both exist for the SAME real-world reason
 * (a sandboxed cross-origin iframe without `allow-same-origin` throws a
 * `SecurityError` merely ACCESSING either storage API, not just calling a
 * method on it), so a third storage-adjacent call site would have been a
 * third hand-rolled copy instead of a one-line reuse.
 *
 * Deliberately synchronous-only (no `Promise`/`async` handling): neither
 * current caller's wrapped action is ever asynchronous, and silently
 * swallowing a REJECTED promise would be a materially different, far more
 * dangerous kind of "fail safe" (an unawaited, unobserved async failure)
 * than swallowing a synchronous throw — not something to add speculatively
 * before a caller actually needs it.
 */
export function trySilently<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
