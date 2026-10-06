import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `listPublicMedia`'s own K2 (ugcportal-0dh): the failure is logged, and
 * throttled.
 *
 * A malformed `?cursor=` is the one `ok: false` this function can produce
 * (src/lib/media-listing.ts), and `decodeMediaCursor` rejects it before
 * `listMedia` ever reaches Prisma — so this needs no seeded database, unlike
 * src/app/page.test.tsx's real-DB exercise of the SAME function's success
 * path. `vi.resetModules()` before each test gives a fresh module instance,
 * and with it fresh throttle counters: those counters are module-level
 * `let`s, shared across every call in a process, so a test that did not
 * isolate them would see whatever an earlier test in this file left behind.
 *
 * `@/lib/auth` is stubbed for the same reason src/app/page.test.tsx stubs it:
 * `@/lib/public-media` imports `@/lib/media-access`, which imports the real
 * `next-auth` config, which in turn imports `next/server` — a module that
 * only resolves inside Next's own bundler, not under plain Vitest module
 * resolution. The malformed-cursor path this file exercises never calls
 * `auth()` at all (it returns before `listMedia` reaches Prisma, let alone
 * a session), so the stub is here purely to let the import graph resolve.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("this path must not consult the session");
  },
}));

/**
 * The database is stubbed to THROW, explicitly (ugcportal-cl4e). An earlier
 * version of the "query itself throws" tests below relied on the real client
 * failing because the test "never seeds or migrates" a database — but it ran
 * against whatever DATABASE_URL pointed at, so on a laptop with a migrated
 * dev.db and an empty Media table the query quietly succeeded and both tests
 * failed, while CI (no migrated database) stayed green. The fixture is now
 * the stub, not the host. The malformed-cursor tests never reach it.
 */
const DB_FAILURE = "database unavailable (test fixture)";
vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      findMany: async () => {
        throw new Error(DB_FAILURE);
      },
    },
  },
}));

const BAD_CURSOR_URL =
  "http://listing.internal/api/public/media?cursor=not-a-real-cursor";

async function freshListPublicMedia() {
  vi.resetModules();
  return import("@/lib/public-media");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logs a failed listing", () => {
  it("logs the status and error a malformed cursor produces", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia } = await freshListPublicMedia();

    const result = await listPublicMedia(BAD_CURSOR_URL);

    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[gallery] public media listing failed",
      expect.objectContaining({ status: 400, error: "Invalid cursor" }),
    );
  });
});

describe("throttles repeated failures (ugcportal-0dh round 2: unauthenticated, unrate-limited input)", () => {
  it("logs once for a burst of failures inside the throttle window", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia } = await freshListPublicMedia();

    await listPublicMedia(BAD_CURSOR_URL);
    await listPublicMedia(BAD_CURSOR_URL);
    await listPublicMedia(BAD_CURSOR_URL);

    // The claim is specifically ONE line for the burst, not merely "fewer
    // than three" — a throttle that still let two through would pass a
    // looser assertion and fail the thing this test exists to check.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("reports the suppressed count once the window has genuinely elapsed", async () => {
    // Fake timers from the START of the test (ugcportal-qz1u item 1), not
    // installed partway through: `vi.useFakeTimers()` resets
    // `performance.now()` to `0` at the moment it installs, discarding
    // whatever real elapsed time came before it — so the three calls below
    // that seed `lastAt` have to run under the SAME fake clock the later
    // `vi.advanceTimersByTime` advances, or the throttle ends up comparing
    // a real-clock `lastAt` against a fake-clock `now` that both silently
    // restarted from `0`.
    vi.useFakeTimers();
    try {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { listPublicMedia, LISTING_FAILURE_LOG_INTERVAL_MS } =
        await freshListPublicMedia();

      await listPublicMedia(BAD_CURSOR_URL); // logs (first after a quiet start)
      await listPublicMedia(BAD_CURSOR_URL); // suppressed, 1
      await listPublicMedia(BAD_CURSOR_URL); // suppressed, 2

      // Moving the clock, not waiting out the real interval — a caller must
      // not be able to restart the window by asking again sooner, only by
      // time actually having passed. `performance.now()` is what the
      // throttle measures its window with (a monotonic clock, immune to a
      // stepped wall clock — the point of item 1); only advancing the
      // fake-timer clock moves it, unlike the `vi.spyOn(Date, "now")` this
      // test used before item 1, which no longer affects the throttle at
      // all.
      vi.advanceTimersByTime(LISTING_FAILURE_LOG_INTERVAL_MS + 1);
      await listPublicMedia(BAD_CURSOR_URL);

      expect(errorSpy).toHaveBeenCalledTimes(2);
      // The two lines must account for every failure between them: one
      // named by the first line, the other two by this one's `suppressed`
      // count.
      expect(errorSpy.mock.calls[1][1]).toMatchObject({ suppressed: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ugcportal-z3lo K2: unlike `watermark.ts`'s shed-upload throttle, this
   * call site must schedule NO flush timer — a malformed cursor is a
   * nuisance-input signal, not a capacity one (see this module's own
   * comment on `LISTING_FAILURE_LOG_INTERVAL_MS`), and losing a handful of
   * occurrences at the very tail of a quiet burst is the accepted,
   * smaller cost of that choice. Fake timers make a scheduled-but-absent
   * timer observable directly, rather than inferring it from log output.
   */
  it("schedules no flush timer for a suppressed occurrence", async () => {
    vi.useFakeTimers();
    try {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { listPublicMedia } = await freshListPublicMedia();

      await listPublicMedia(BAD_CURSOR_URL); // logs immediately
      await listPublicMedia(BAD_CURSOR_URL); // suppressed

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits `suppressed` entirely when nothing was swallowed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia } = await freshListPublicMedia();

    await listPublicMedia(BAD_CURSOR_URL);

    const logged = errorSpy.mock.calls[0][1] as Record<string, unknown>;
    // `ok: false` rides along because the real `listMedia` result is logged
    // directly rather than re-typed into a narrower shape (see
    // PublicMediaFailure's own comment) — it doubles as a discriminator
    // against the `threw: true` shape below, so the two failure modes read
    // apart in a log search rather than looking identical.
    expect(Object.keys(logged).sort()).toEqual(["error", "ok", "status"]);
  });
});

describe("logs the very first failure even when the clock reads near the epoch", () => {
  /**
   * Mirrors watermark.concurrency.test.ts's coverage of logShedUpload's own
   * `shedLogLastAt !== 0` guard. Without the matching guard here, the FIRST
   * call after a fresh module instance computes `now - 0`, and a `now` this
   * small reads as "still inside the window" — exactly backwards from what
   * "first failure after a quiet period always logs" promises. Production
   * never sees this (wall-clock time is nowhere near the epoch), but a test
   * using fake timers seeded at time zero, or a real clock mid-boot before
   * NTP sync, would.
   */
  it("still logs when Date.now() is smaller than the throttle interval", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia, LISTING_FAILURE_LOG_INTERVAL_MS } =
      await freshListPublicMedia();

    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Math.floor(LISTING_FAILURE_LOG_INTERVAL_MS / 2));
    try {
      await listPublicMedia(BAD_CURSOR_URL);
    } finally {
      nowSpy.mockRestore();
    }

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("logs (and rethrows) when the query itself throws, not just ok: false", () => {
  /**
   * No cursor on this URL, unlike `BAD_CURSOR_URL` above — so `listMedia`
   * passes `decodeMediaCursor`'s guard and reaches `prisma.media.findMany`,
   * which the stub at the top of this file makes throw. That is the
   * fixture: `listMedia` failing by throwing rather than by answering
   * `ok: false`, which is the one path src/app/page.tsx's own try/catch
   * exists to cover.
   */
  const NO_CURSOR_URL = "http://listing.internal/api/public/media";

  it("logs the thrown error and rethrows it to the caller", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia } = await freshListPublicMedia();

    // The stub's own message, so a different throw — a module that failed
    // to load, say — cannot satisfy this by accident.
    await expect(listPublicMedia(NO_CURSOR_URL)).rejects.toThrow(DB_FAILURE);

    expect(errorSpy).toHaveBeenCalledWith(
      "[gallery] public media listing failed",
      expect.objectContaining({
        threw: true,
        error: expect.stringContaining(DB_FAILURE),
      }),
    );
  });

  it("shares the SAME throttle as the ok: false case", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia } = await freshListPublicMedia();

    // One of each, back to back: an operator mid-incident does not care
    // which shape of failure is making the noise, and should not get twice
    // the budget by alternating between them.
    await expect(listPublicMedia(NO_CURSOR_URL)).rejects.toThrow(DB_FAILURE);
    const result = await listPublicMedia(BAD_CURSOR_URL);

    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
