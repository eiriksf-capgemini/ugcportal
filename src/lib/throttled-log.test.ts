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
    // Regression guard for the `lastAt !== 0` subtlety documented in the
    // module: without it, `Date.now() - 0` at real wall-clock time is far
    // larger than any realistic intervalMs, so this case passes trivially
    // UNLESS lastAt is compared to 0 explicitly. Pin it anyway so a future
    // change to the guard (e.g. swapping in a elapsed-only check) is caught
    // if it ever regresses under fake timers seeded at the epoch.
    vi.setSystemTime(0);
    const throttle = createThrottledLog({ intervalMs: 10_000 });
    const emit = vi.fn();

    throttle.log(emit);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(0);
  });

  describe("flush: true", () => {
    it("schedules a flush that reports a suppressed tail even if nothing else happens", () => {
      const throttle = createThrottledLog({ intervalMs: 10_000, flush: true });
      const emit = vi.fn();

      throttle.log(emit); // logs immediately
      throttle.log(emit); // suppressed, schedules a flush
      throttle.log(emit); // suppressed

      expect(emit).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10_000);

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenNthCalledWith(2, 2);
    });

    it("never fires a flush when nothing was suppressed", () => {
      const throttle = createThrottledLog({ intervalMs: 10_000, flush: true });
      const emit = vi.fn();

      throttle.log(emit); // logs immediately, nothing queued behind it

      vi.advanceTimersByTime(60_000);

      expect(emit).toHaveBeenCalledTimes(1);
    });

    it("flushNow respects the window even when called directly, rather than resetting the clock", () => {
      // Matches watermark.ts's flushShedLog guard: a caller polling this
      // faster than intervalMs must not be able to force an early line.
      const throttle = createThrottledLog({ intervalMs: 10_000, flush: true });
      const emit = vi.fn();

      throttle.log(emit); // logs immediately
      throttle.log(emit); // suppressed

      vi.advanceTimersByTime(5_000); // still inside the window
      throttle.flushNow(emit);
      expect(emit).toHaveBeenCalledTimes(1); // not yet — too soon

      vi.advanceTimersByTime(5_000); // window now elapsed
      throttle.flushNow(emit);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenNthCalledWith(2, 1);
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
      const throttle = createThrottledLog({ intervalMs: 10_000 });
      const emit = vi.fn();

      throttle.log(emit);
      throttle.log(emit);
      vi.advanceTimersByTime(10_000);
      throttle.flushNow(emit);

      expect(emit).toHaveBeenCalledTimes(1);
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
});
