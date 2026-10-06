import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThrottledLog } from "./throttled-log";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createThrottledLog", () => {
  it("logs the first occurrence immediately, with nothing suppressed", () => {
    const throttle = createThrottledLog({ intervalMs: 10_000 });
    const emit = vi.fn();

    throttle.log(emit);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(0);
  });

  it("suppresses occurrences inside the window rather than logging each one", () => {
    const throttle = createThrottledLog({ intervalMs: 10_000 });
    const emit = vi.fn();

    throttle.log(emit); // logs immediately
    throttle.log(emit); // inside the window: suppressed
    throttle.log(emit); // inside the window: suppressed

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("reports the suppressed count on the next occurrence once the window elapses", () => {
    const throttle = createThrottledLog({ intervalMs: 10_000 });
    const emit = vi.fn();

    throttle.log(emit); // logs immediately, suppressed=0
    throttle.log(emit); // suppressed
    throttle.log(emit); // suppressed
    vi.advanceTimersByTime(10_000);
    throttle.log(emit); // outside the window: logs, reporting the 2 swallowed above

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, 0);
    expect(emit).toHaveBeenNthCalledWith(2, 2);
  });

  it("does not log the very first occurrence as though it were suppressed, even right after process start", () => {
    // Regression guard for the `everLogged` subtlety documented in the
    // module (ugcportal-qz1u item 1): `performance.now()` is relative to
    // process start, not the Unix epoch, so it genuinely reads as (or very
    // near) `0` early in a real process's life — unlike `Date.now()`, which
    // this module used before item 1 and which is never near `0` by the
    // accident of what year it is. `vi.useFakeTimers()` (the default for
    // this whole file) freezes `performance.now()` at exactly `0` until
    // timers are advanced, which is the fake-timer equivalent of that real
    // early-process-life case — no `vi.setSystemTime` needed to seed it, since
    // that only ever moved `Date.now()`, a clock this module no longer reads.
    const throttle = createThrottledLog({ intervalMs: 10_000 });
    const emit = vi.fn();

    throttle.log(emit);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(0);
  });

  /**
   * ugcportal-qz1u item 1/K2: a SECOND call, still at the frozen `0` the
   * first call also saw (no timer advance in between), must be suppressed —
   * not read as "never logged" again just because the clock has not moved.
   * This is the actual collision the old `lastAt !== 0` sentinel was
   * vulnerable to: with it, `lastAt` set to exactly `0` by the first call
   * is indistinguishable from "nothing has ever logged", so this second
   * call would wrongly take the not-suppressed branch and emit again.
   */
  it("still suppresses a second occurrence at the same frozen instant as the first", () => {
    const throttle = createThrottledLog({ intervalMs: 10_000 });
    const emit = vi.fn();

    throttle.log(emit); // logs immediately, at performance.now() === 0
    throttle.log(emit); // same instant: must be suppressed, not a fresh "first"

    expect(emit).toHaveBeenCalledTimes(1);
  });

  describe("flush: true", () => {
    it("schedules a flush that reports a suppressed count even if nothing else happens", () => {
      const onFlush = vi.fn();
      const throttle = createThrottledLog({
        intervalMs: 10_000,
        flush: true,
        onFlush,
      });
      const emit = vi.fn();

      throttle.log(emit); // logs immediately
      throttle.log(emit); // suppressed, schedules a flush
      throttle.log(emit); // suppressed

      expect(emit).toHaveBeenCalledTimes(1);
      expect(onFlush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10_000);

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith(2);
    });

    it("never fires a flush when nothing was suppressed", () => {
      const onFlush = vi.fn();
      const throttle = createThrottledLog({
        intervalMs: 10_000,
        flush: true,
        onFlush,
      });
      const emit = vi.fn();

      throttle.log(emit); // logs immediately, nothing queued behind it

      vi.advanceTimersByTime(60_000);

      expect(onFlush).not.toHaveBeenCalled();
    });

    it("flushNow respects the window even when called directly, rather than resetting the clock", () => {
      // Matches watermark.ts's flushShedLog guard: a caller polling this
      // faster than intervalMs must not be able to force an early line.
      const onFlush = vi.fn();
      const throttle = createThrottledLog({
        intervalMs: 10_000,
        flush: true,
        onFlush,
      });
      const emit = vi.fn();

      throttle.log(emit); // logs immediately
      throttle.log(emit); // suppressed

      vi.advanceTimersByTime(5_000); // still inside the window
      throttle.flushNow();
      expect(onFlush).not.toHaveBeenCalled(); // not yet — too soon

      vi.advanceTimersByTime(5_000); // window now elapsed
      throttle.flushNow();
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith(1);
    });

    /**
     * Round-4 review finding (MEDIUM): a flush used to be wired to whichever
     * `emit` closure the `log()` call that scheduled the pending timer had
     * passed in — so if different calls in the same window closed over
     * different per-occurrence data (a key name, a cause — exactly what
     * src/app/api/media/route.ts's cleanup-failure log used to do), only
     * the FIRST suppressed call's data survived into the flush; everything
     * about the second (and any later) suppressed call was never logged
     * anywhere, recoverable or not.
     *
     * This test proves the fix structurally rather than by re-running the
     * same scenario and hoping: `onFlush` is bound once, at creation, and
     * genuinely has no way to receive per-`log()`-call data — there is no
     * closure parameter on it at all, only a count. Passing THREE calls
     * with visibly different closures (each would push a different string
     * onto `seen` if it were ever invoked) and asserting none of them ever
     * ran is the closest a test can get to proving a whole class of bug is
     * unrepresentable, rather than merely absent from the cases tried.
     */
    it("never invokes a log() call's own emit closure from a flush, however many different ones were suppressed", () => {
      const onFlush = vi.fn();
      const throttle = createThrottledLog({
        intervalMs: 10_000,
        flush: true,
        onFlush,
      });
      const seen: string[] = [];

      throttle.log(() => seen.push("first")); // logs immediately
      throttle.log(() => seen.push("second")); // suppressed
      throttle.log(() => seen.push("third")); // suppressed

      vi.advanceTimersByTime(10_000);

      // Only the FIRST call's own emit ever actually ran (the one that
      // logged immediately) — "second" and "third" must never appear,
      // because nothing in this design ever calls a `log()` call's emit
      // from the flush path.
      expect(seen).toEqual(["first"]);
      expect(onFlush).toHaveBeenCalledWith(2);
    });

    /**
     * ugcportal-z3lo K3: a scheduled flush firing must not restart the
     * window as though it were a real logged line. Before the fix,
     * `flushNow`'s success path set `lastAt = Date.now()`, so an
     * occurrence arriving immediately after a flush fell right back
     * inside the "new" window the flush had just opened and was only
     * counted, not logged on its own.
     */
    it("logs its own detailed line for an occurrence arriving right after a scheduled flush fires, rather than folding it into the next count", () => {
      const onFlush = vi.fn();
      const throttle = createThrottledLog({
        intervalMs: 10_000,
        flush: true,
        onFlush,
      });
      const emit = vi.fn();

      throttle.log(emit); // logs immediately
      throttle.log(emit); // suppressed, schedules a flush

      vi.advanceTimersByTime(10_000); // the scheduled flush fires here
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith(1);

      throttle.log(emit); // arrives right after the flush — must log, not suppress

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenNthCalledWith(2, 0);
    });
  });

  describe("flush: false (the default)", () => {
    it("does NOT auto-flush a suppressed tail — it is lost if nothing else happens", () => {
      const throttle = createThrottledLog({ intervalMs: 10_000 });
      const emit = vi.fn();

      throttle.log(emit); // logs immediately
      throttle.log(emit); // suppressed

      vi.advanceTimersByTime(60_000);

      // No timer was ever scheduled, so the suppressed occurrence above is
      // never reported on its own — this is the documented, accepted cost
      // of the non-flush shape.
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it("flushNow is a no-op", () => {
      const onFlush = vi.fn();
      const throttle = createThrottledLog({ intervalMs: 10_000, onFlush });
      const emit = vi.fn();

      throttle.log(emit);
      throttle.log(emit);
      vi.advanceTimersByTime(10_000);
      throttle.flushNow();

      expect(onFlush).not.toHaveBeenCalled();
    });
  });

  it("reset() returns to a fresh state, so the next occurrence logs immediately regardless of elapsed time", () => {
    const throttle = createThrottledLog({ intervalMs: 10_000 });
    const emit = vi.fn();

    throttle.log(emit); // logs immediately
    throttle.log(emit); // suppressed

    throttle.reset();
    throttle.log(emit);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(2, 0);
  });

  /**
   * ugcportal-qz1u item 1/K2: "the throttle suppressing a genuinely new
   * occurrence for longer than the configured interval after a clock
   * adjustment" must never happen. `Date.now()` is wall-clock time: an NTP
   * correction, a container migrating hosts, or anything else that steps it
   * backward would, with the OLD `Date.now()`-based window check, make a
   * later occurrence's `now - lastAt` read as a large NEGATIVE number —
   * comfortably "inside the window" forever, since the window check never
   * closes until enough real time passes to overcome however far back the
   * clock jumped. `performance.now()` cannot step backward: it is monotonic
   * by specification, unaffected by wall-clock adjustments, so the window
   * closes after `intervalMs` of real elapsed time regardless of what
   * `Date.now()` claims.
   */
  it("still logs the next occurrence after intervalMs even though Date.now() stepped backward in between (ugcportal-qz1u K2)", () => {
    const throttle = createThrottledLog({ intervalMs: 10_000 });
    const emit = vi.fn();

    throttle.log(emit); // logs immediately

    // A backward wall-clock step — `vi.setSystemTime` only ever moves
    // `Date.now()`; it does not move `performance.now()`, which is exactly
    // the independence this fix relies on.
    vi.setSystemTime(Date.now() - 60_000);

    // Real (monotonic) elapsed time: exactly one full interval.
    vi.advanceTimersByTime(10_000);

    throttle.log(emit); // must log its own line, not be suppressed

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(2, 0);
  });
});
