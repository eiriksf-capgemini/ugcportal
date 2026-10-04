import type { Session } from "next-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";
import { pinEnvironment } from "@/lib/test-support/env";

/**
 * The live-session refusal log is throttled (PR #91 review, round 1,
 * finding 5).
 *
 * It has to be. The refusals that do NOT delete the session row —
 * `no-configuration` above all — recur on every authenticated request for as
 * long as the condition lasts, so an instance that lost
 * `ALLOWED_SIGNIN_EMAILS` would write one line per request per signed-in
 * visitor, for as long as nobody noticed. That is exactly the moment the log
 * has to stay readable.
 *
 * `vi.resetModules()` before each test gives a fresh module instance, and
 * with it fresh throttle counters: those counters are module-level `let`s
 * shared across every call in a process, so a test that did not isolate them
 * would see whatever an earlier test in this file left behind. Same
 * technique, and same reason, as src/lib/public-media.logging.test.ts.
 */

vi.mock("@/lib/prisma", () => ({
  prisma: {
    session: {
      deleteMany: async () => ({ count: 0 }),
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
  },
}));

const LISTED = "owner@example.com";
const USER_ID = "user-1";

pinEnvironment({
  // Configured, and naming somebody else: `not-permitted`, which refuses
  // every time.
  [PERMITTED_EMAILS_VAR]: "someone-else@example.com",
  ADMIN_BOOTSTRAP_EMAILS: undefined,
});

function sessionRow(): Session {
  return {
    id: "session-1",
    expires: "2026-12-01T00:00:00.000Z",
    signInProvider: "google",
    signInEmail: LISTED,
    user: { id: USER_ID, email: LISTED, role: "USER" },
  } as unknown as Session;
}

async function freshModule() {
  vi.resetModules();
  return import("@/lib/live-session");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("throttles repeated live-session refusals", () => {
  it("logs once for a burst inside the window", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enforceLiveSessionPolicy } = await freshModule();
    const user = { id: USER_ID, email: LISTED };

    for (let request = 0; request < 3; request += 1) {
      expect(
        (await enforceLiveSessionPolicy(sessionRow(), user)).user,
      ).toBeUndefined();
    }

    // Specifically ONE line for the burst, not merely "fewer than three" —
    // a throttle that still let two through would pass a looser assertion
    // and fail the thing this test exists to check.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports the suppressed count once the window has genuinely elapsed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enforceLiveSessionPolicy, LIVE_SESSION_LOG_INTERVAL_MS } =
      await freshModule();
    const user = { id: USER_ID, email: LISTED };

    await enforceLiveSessionPolicy(sessionRow(), user); // logs
    await enforceLiveSessionPolicy(sessionRow(), user); // suppressed, 1
    await enforceLiveSessionPolicy(sessionRow(), user); // suppressed, 2

    // Moving the clock rather than waiting out the real interval, the way
    // public-media.logging.test.ts does: a caller must not be able to
    // restart the window by asking again sooner, only by time having passed.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + LIVE_SESSION_LOG_INTERVAL_MS + 1);
    await enforceLiveSessionPolicy(sessionRow(), user);
    now.mockRestore();

    expect(warn).toHaveBeenCalledTimes(2);
    // The two lines account for every refusal between them: one named by the
    // first, the other two by this one's count — and by REASON, so a bulk
    // revocation does not report one line and an anonymous total (PR #91
    // review, round 3, finding 5).
    expect(String(warn.mock.calls[1][0])).toContain(
      "(2 similar line(s) suppressed: not-permitted x2)",
    );
  });

  it("breaks the suppressed count down by reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enforceLiveSessionPolicy, LIVE_SESSION_LOG_INTERVAL_MS } =
      await freshModule();
    const user = { id: USER_ID, email: LISTED };

    await enforceLiveSessionPolicy(sessionRow(), user); // logs: not-permitted
    await enforceLiveSessionPolicy(sessionRow(), user); // suppressed
    // A different reason inside the same window. Both are refusals; only
    // one of them is a decision about the list, which is exactly the
    // distinction an operator reading this line is trying to make.
    delete process.env[PERMITTED_EMAILS_VAR];
    await enforceLiveSessionPolicy(sessionRow(), user); // suppressed
    process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";

    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + LIVE_SESSION_LOG_INTERVAL_MS + 1);
    await enforceLiveSessionPolicy(sessionRow(), user);
    now.mockRestore();

    const flushed = String(warn.mock.calls[1][0]);
    expect(flushed).toContain("2 similar line(s) suppressed");
    expect(flushed).toContain("not-permitted x1");
    expect(flushed).toContain("no-configuration x1");
  });

  it("clears the counts it has reported, so the next line is not cumulative", async () => {
    // A map that is read but never cleared reports the same suppressions
    // again on every later flush, which turns the count from a measurement
    // into a running total nobody can interpret.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enforceLiveSessionPolicy, LIVE_SESSION_LOG_INTERVAL_MS } =
      await freshModule();
    const user = { id: USER_ID, email: LISTED };
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);

    await enforceLiveSessionPolicy(sessionRow(), user); // logs
    await enforceLiveSessionPolicy(sessionRow(), user); // suppressed, 1
    clock += LIVE_SESSION_LOG_INTERVAL_MS + 1;
    await enforceLiveSessionPolicy(sessionRow(), user); // flushes that 1
    await enforceLiveSessionPolicy(sessionRow(), user); // suppressed, 1 again
    clock += LIVE_SESSION_LOG_INTERVAL_MS + 1;
    await enforceLiveSessionPolicy(sessionRow(), user); // flushes that 1
    now.mockRestore();

    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[1][0])).toContain("not-permitted x1");
    // x1, not x2: the first flush took the first one with it.
    expect(String(warn.mock.calls[2][0])).toContain("not-permitted x1");
  });

  it("says nothing about suppression when nothing was swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enforceLiveSessionPolicy } = await freshModule();

    await enforceLiveSessionPolicy(sessionRow(), {
      id: USER_ID,
      email: LISTED,
    });

    expect(String(warn.mock.calls[0][0])).not.toContain("suppressed");
  });

  it("logs the very first refusal even when the clock reads near the epoch", async () => {
    // The `lastAt !== 0` guard. Without it the first call computes
    // `now - 0`, which clears the window only by the accident of what year
    // it is; a clock near the epoch (fake timers, a container before NTP)
    // would read as "still inside the window" and swallow the one line this
    // throttle most needs to let through.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enforceLiveSessionPolicy, LIVE_SESSION_LOG_INTERVAL_MS } =
      await freshModule();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Math.floor(LIVE_SESSION_LOG_INTERVAL_MS / 2));

    await enforceLiveSessionPolicy(sessionRow(), {
      id: USER_ID,
      email: LISTED,
    });
    now.mockRestore();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not throttle a PERMITTED session into silence about anything", async () => {
    // The control that keeps the assertions above about throttling rather
    // than about refusing: a permitted session logs nothing at all, so a
    // "logs once" result could not come from the wrong direction.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enforceLiveSessionPolicy } = await freshModule();
    process.env[PERMITTED_EMAILS_VAR] = LISTED;

    const result = await enforceLiveSessionPolicy(sessionRow(), {
      id: USER_ID,
      email: LISTED,
    });

    expect(result.user?.id).toBe(USER_ID);
    expect(warn).not.toHaveBeenCalled();
  });
});
