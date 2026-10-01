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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia, LISTING_FAILURE_LOG_INTERVAL_MS } =
      await freshListPublicMedia();

    await listPublicMedia(BAD_CURSOR_URL); // logs (first after a quiet start)
    await listPublicMedia(BAD_CURSOR_URL); // suppressed, 1
    await listPublicMedia(BAD_CURSOR_URL); // suppressed, 2

    // Moving the clock, not waiting out the real interval — the same
    // technique watermark.concurrency.test.ts uses for logShedUpload, and for
    // the same reason: a caller must not be able to restart the window by
    // asking again sooner, only by time actually having passed.
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + LISTING_FAILURE_LOG_INTERVAL_MS + 1);
    await listPublicMedia(BAD_CURSOR_URL);
    nowSpy.mockRestore();

    expect(errorSpy).toHaveBeenCalledTimes(2);
    // The two lines must account for every failure between them: one named
    // by the first line, the other two by this one's `suppressed` count.
    expect(errorSpy.mock.calls[1][1]).toMatchObject({ suppressed: 2 });
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

describe("logs (and rethrows) when the query itself throws, not just ok: false", () => {
  /**
   * No cursor on this URL, unlike `BAD_CURSOR_URL` above — so `listMedia`
   * passes `decodeMediaCursor`'s guard and reaches a real
   * `prisma.media.findMany` call, against a database this test deliberately
   * never seeds or migrates (no `createTemporaryDatabase()`/
   * `applyMigrations()`, unlike src/app/page.test.tsx). That query throwing
   * on its own IS the fixture: it is `listMedia` failing by throwing rather
   * than by answering `ok: false`, which is the one path
   * src/app/page.tsx's own try/catch exists to cover.
   */
  const NO_CURSOR_URL = "http://listing.internal/api/public/media";

  it("logs the thrown error and rethrows it to the caller", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia } = await freshListPublicMedia();

    await expect(listPublicMedia(NO_CURSOR_URL)).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      "[gallery] public media listing failed",
      expect.objectContaining({ threw: true, error: expect.any(String) }),
    );
  });

  it("shares the SAME throttle as the ok: false case", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listPublicMedia } = await freshListPublicMedia();

    // One of each, back to back: an operator mid-incident does not care
    // which shape of failure is making the noise, and should not get twice
    // the budget by alternating between them.
    await expect(listPublicMedia(NO_CURSOR_URL)).rejects.toThrow();
    const result = await listPublicMedia(BAD_CURSOR_URL);

    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
