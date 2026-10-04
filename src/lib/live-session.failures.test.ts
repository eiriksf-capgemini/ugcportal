import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";
import { pinEnvironment } from "@/lib/test-support/env";
import { callbackSession } from "@/lib/test-support/session";

/**
 * What the revocation in src/lib/live-session.ts does when the database
 * refuses it — and what the request does while it is in flight
 * (ugcportal-mzr).
 *
 * Separate from src/lib/live-session.test.ts, which runs against a real
 * SQLite database: a `vi.spyOn` on a Prisma delegate method does not survive
 * `restoreAllMocks` there — the method is not an own property of the
 * delegate, so restoring deletes it and every later test in the file loses
 * the client. Here the module is mocked instead, which is the right tool for
 * "the write threw" and the wrong one for "the row is gone".
 *
 * Fail-closed claims, which is why they are tested at all: a failed delete
 * must not become a permitted session, and a delete that never finishes must
 * not hold the refusal up behind it (PR #91 review, round 2, finding 6).
 */

const { deleteMany } = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { session: { deleteMany } } }));

const { enforceLiveSessionPolicy, settleRevocations } = await import(
  "@/lib/live-session"
);

const LISTED = "owner@example.com";
const USER_ID = "user-1";
const SESSION_ID = "session-1";

pinEnvironment({
  // Nobody is permitted, so every case below takes the refusal path.
  [PERMITTED_EMAILS_VAR]: "someone-else@example.com",
  ADMIN_BOOTSTRAP_EMAILS: undefined,
});

function sessionRow(): Session {
  return callbackSession({ id: SESSION_ID, userId: USER_ID, signInEmail: LISTED });
}

function enforce() {
  return enforceLiveSessionPolicy(sessionRow(), {
    id: USER_ID,
    email: LISTED,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a revocation whose delete fails", () => {
  it("still refuses the request", async () => {
    deleteMany.mockRejectedValue(new Error("database is locked"));

    const result = await enforce();

    expect(deleteMany).toHaveBeenCalledWith({ where: { id: SESSION_ID } });
    // Fail closed: a database that cannot take the delete must not be able
    // to turn a refusal into a permission. The stale row simply survives to
    // be refused again on the next request.
    expect(result.user).toBeUndefined();
  });

  it("and does not reject, which would be a 500 on every page", async () => {
    deleteMany.mockRejectedValue(new Error("database is locked"));

    await expect(enforce()).resolves.toBeDefined();
  });

  it("while a successful delete is still what normally happens", async () => {
    // The control. Without it, both assertions above would be satisfied by
    // an implementation that never called the delete at all.
    deleteMany.mockResolvedValue({ count: 1 });

    const result = await enforce();

    expect(deleteMany).toHaveBeenCalledTimes(1);
    // And by the id of the session in front of it, never by its owner —
    // `{ userId }` here would take every device the person is signed in on.
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: SESSION_ID } });
    expect(result.user).toBeUndefined();
  });
});

describe("a revocation that has not finished", () => {
  it("does not hold up the refusal", async () => {
    // The delete is started and never settles. If the refusal awaited it,
    // this test would not finish — vitest's timeout is the assertion, and
    // it is the only way to state "does not wait" that a passing-by-luck
    // implementation cannot satisfy.
    let finish = (): void => {};
    deleteMany.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({ count: 1 });
      }),
    );

    const result = await enforce();

    expect(result.user).toBeUndefined();
    expect(deleteMany).toHaveBeenCalledTimes(1);
    // Let it go, so the pending promise does not leak into the next test.
    finish();
    await settleRevocations();
  });
});
