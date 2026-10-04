/**
 * A small shared implementation of the "first occurrence after a quiet
 * period logs immediately; the rest within the window are counted and
 * folded into the next line" pattern this codebase uses more than once to
 * keep a noisy, repeating failure from becoming a log storm.
 *
 * Extracted here as the THIRD independent copy of this exact algorithm.
 * `src/lib/watermark.ts`'s `logShedUpload`/`flushShedLog` (ugcportal-e86)
 * and `src/lib/public-media.ts`'s `logFailedPublicListing` (ugcportal-0dh)
 * each hand-wrote it — a duplication already tracked as ugcportal-z3lo,
 * whose own text names a shared `createThrottledLog(intervalMs, { flush })`
 * utility as the fix once a third caller needed it (round-3 review finding
 * 5 on ugcportal-1b2c, src/app/api/media/route.ts's storage-unreachable log
 * lines, is that third caller).
 *
 * Deliberately NOT a retrofit of the two existing copies — this module adds
 * the shared implementation and a new caller uses it; `watermark.ts` and
 * `public-media.ts` are left exactly as they are. `watermark.ts`'s copy in
 * particular carries its own hardened history (several review rounds' worth
 * of fixed subtle bugs — a `shedLogLastAt !== 0` guard, a flush-timer race
 * that let a health check restart the window), and ugcportal-z3lo's own
 * investigation found migrating it a real regression risk for no benefit to
 * whichever bead happens to add the third caller. That migration, if ever
 * done, is its own piece of work with `watermark.concurrency.test.ts` as its
 * regression baseline — not a drive-by part of this one.
 *
 * THE FLUSH PATH IS PAYLOAD-FREE, AND THAT IS NOT A STYLE CHOICE (round-4
 * review finding, MEDIUM). An earlier version of this module let `log()`'s
 * caller-supplied `emit` closure double as the flush callback too: whichever
 * call happened to be the one that scheduled the pending timer had ITS
 * closure invoked later, by the timer, with the final suppressed count.
 * That is silently wrong the moment two different calls in the same window
 * close over different per-occurrence data (a key name, a cause) rather than
 * reading from shared outer state the way `watermark.ts`'s `gate?.stats()` or
 * `public-media.ts`'s per-process counters do — `src/app/api/media/route.ts`'s
 * cleanup-failure line did exactly that, closing over `storedKey` and
 * `cleanupError` per call, and lost the second of two distinct orphaned
 * keys' name and cause when both landed in the same throttle window: the
 * flush faithfully reported the FIRST suppressed call's closure, and the
 * second one's payload was never logged anywhere, recoverable or not.
 *
 * The fix is structural, not a caller discipline: `onFlush` is bound once,
 * at `createThrottledLog` call time, and only ever receives a count — there
 * is no per-call closure for a flush to accidentally pick up, so this
 * mistake is not representable here again. A caller that genuinely needs
 * every suppressed occurrence's own payload preserved needs a different
 * design (a bounded buffer of pending payloads, flushed as a batch) — this
 * module deliberately does not attempt that; it only ever reports a count.
 */

export type ThrottledLogOptions = {
  /** Shortest interval between two "real" (non-suppressed) log lines. */
  intervalMs: number;
  /**
   * Also guarantee the tail of a quiet burst is reported even if nothing
   * else happens to trigger it — a scheduled timer calls `onFlush` with any
   * suppressed count once the window elapses. See `watermark.ts`'s own
   * `flushShedLog` doc comment for why this matters for a signal worth
   * paging on: without it, a burst that sheds once more right at the edge
   * of the window and then goes quiet has its count sit uncounted forever,
   * because the only thing that would have flushed it is a *next*
   * occurrence that never comes.
   *
   * Leave this off (the default, matching `public-media.ts`'s copy) for a
   * failure that is a nuisance-input signal rather than a capacity one, where
   * losing a handful of occurrences at the very tail of a quiet burst is an
   * accepted, smaller version of the same cost.
   */
  flush?: boolean;
  /**
   * Called with a suppressed count once a scheduled flush actually fires.
   * Required when `flush` is true (a flush-enabled instance with no
   * `onFlush` simply has nothing to report the tail with); unused
   * otherwise.
   *
   * Deliberately `(suppressed: number) => void` and nothing richer — see
   * this module's own top-of-file doc comment for why a flush must never
   * carry per-occurrence data. Bound once, here, rather than accepted again
   * per `log()` call.
   */
  onFlush?: (suppressed: number) => void;
};

export type ThrottledLog = {
  /**
   * Call on every occurrence.
   *
   * If this call is outside the throttle window (the first call ever, or
   * the first since the window last elapsed), `emit` runs now, with the
   * count of occurrences the window swallowed since the last real line (0
   * the common case). Otherwise this occurrence is only counted — neither
   * `emit` nor `onFlush` runs now; `onFlush` may still run later, from a
   * scheduled timer, on a flush-enabled instance, but never with this
   * particular call's closure — see `onFlush` above.
   */
  log(emit: (suppressedSinceLastLine: number) => void): void;
  /**
   * Forces out the tail of a quiet burst if the window has already elapsed
   * and something is waiting to be reported. A no-op when `flush` is not
   * enabled, or when there is nothing suppressed. Exists for the same
   * reason `watermark.ts`'s own `flushShedLog` is called from
   * `watermarkConcurrencyStats`: a stats read, or a process about to exit,
   * is a chance to report a tail that would otherwise wait for the timer.
   *
   * Respects the window even when called directly — the same guard
   * `watermark.ts`'s `flushShedLog` has, and for the same reason: without
   * it, a caller polling this on a schedule shorter than `intervalMs` (a
   * health check, say) becomes the clock the throttle resets on, rather
   * than a caller asking it a question.
   */
  flushNow(): void;
  /** Test-only: back to a fresh, never-logged state. */
  reset(): void;
};

export function createThrottledLog({
  intervalMs,
  flush: flushEnabled = false,
  onFlush,
}: ThrottledLogOptions): ThrottledLog {
  let lastAt = 0;
  let suppressed = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastAt));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushNow();
    }, delay);
    // Never hold the event loop open just to report a count.
    flushTimer.unref?.();
  }

  function flushNow(): void {
    if (!flushEnabled) return;
    if (suppressed === 0) {
      clearFlushTimer();
      return;
    }
    if (Date.now() - lastAt < intervalMs) {
      scheduleFlush();
      return;
    }
    clearFlushTimer();
    const count = suppressed;
    suppressed = 0;
    lastAt = Date.now();
    onFlush?.(count);
  }

  return {
    log(emit) {
      const now = Date.now();
      // `lastAt !== 0`, not just "the window has elapsed" — matching
      // watermark.ts's identical guard on its own `shedLogLastAt`. Without
      // it, the FIRST occurrence after process start computes `now - 0`,
      // which only reads as "outside the window" because wall-clock time is
      // nowhere near the epoch — true by the accident of what year it is,
      // not by anything this function asserts.
      if (lastAt !== 0 && now - lastAt < intervalMs) {
        suppressed += 1;
        if (flushEnabled) scheduleFlush();
        return;
      }
      const count = suppressed;
      suppressed = 0;
      lastAt = now;
      emit(count);
    },
    flushNow,
    reset() {
      lastAt = 0;
      suppressed = 0;
      clearFlushTimer();
    },
  };
}
