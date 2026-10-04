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
 */

export type ThrottledLogOptions = {
  /** Shortest interval between two "real" (non-suppressed) log lines. */
  intervalMs: number;
  /**
   * Also guarantee the tail of a quiet burst is reported even if nothing
   * else happens to trigger it — a scheduled timer flushes any suppressed
   * count once the window elapses. See `watermark.ts`'s own `flushShedLog`
   * doc comment for why this matters for a signal worth paging on: without
   * it, a burst that sheds once more right at the edge of the window and
   * then goes quiet has its count sit uncounted forever, because the only
   * thing that would have flushed it is a *next* occurrence that never
   * comes.
   *
   * Leave this off (the default, matching `public-media.ts`'s copy) for a
   * failure that is a nuisance-input signal rather than a capacity one, where
   * losing a handful of occurrences at the very tail of a quiet burst is an
   * accepted, smaller version of the same cost.
   */
  flush?: boolean;
};

export type ThrottledLog = {
  /**
   * Call on every occurrence.
   *
   * If this call is outside the throttle window (the first call ever, or
   * the first since the window last elapsed), `emit` runs now, with the
   * count of occurrences the window swallowed since the last real line (0
   * the common case). Otherwise this occurrence is only counted — `emit`
   * does not run now, though a flush-enabled instance may still run it
   * later from a scheduled timer.
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
  flushNow(emit: (suppressed: number) => void): void;
  /** Test-only: back to a fresh, never-logged state. */
  reset(): void;
};

export function createThrottledLog({
  intervalMs,
  flush: flushEnabled = false,
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

  function scheduleFlush(emit: (suppressed: number) => void): void {
    if (flushTimer) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastAt));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushNow(emit);
    }, delay);
    // Never hold the event loop open just to report a count.
    flushTimer.unref?.();
  }

  function flushNow(emit: (suppressed: number) => void): void {
    if (!flushEnabled) return;
    if (suppressed === 0) {
      clearFlushTimer();
      return;
    }
    if (Date.now() - lastAt < intervalMs) {
      scheduleFlush(emit);
      return;
    }
    clearFlushTimer();
    const count = suppressed;
    suppressed = 0;
    lastAt = Date.now();
    emit(count);
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
        if (flushEnabled) scheduleFlush(emit);
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
