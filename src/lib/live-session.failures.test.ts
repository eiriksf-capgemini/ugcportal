import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";
import { pinEnvironment } from "@/lib/test-support/env";

/**
 * What the two database writes in src/lib/live-session.ts do when the
 * database refuses them (ugcportal-mzr).
 *
 * Separate from src/lib/live-session.test.ts, which runs against a real
 * SQLite database: a `vi.spyOn` on a Prisma delegate method does not survive
 * `restoreAllMocks` there — the method is not an own property of the
 * delegate, so restoring deletes it and every later test in the file loses
 * the client. Here the module is mocked instead, which is the right tool for
 * "the write threw" and the wrong one for "the row is gone".
 *
 * Both cases are fail-closed claims, which is why they are tested at all: a
 * failed delete must not become a permitted session, and a failed identity
 * write must not turn an already-permitted sign-in into Access Denied.
 */

const { deleteMany, findMany, updateMany } = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { session: { deleteMany, findMany, updateMany } },
}));

const { enforceLiveSessionPolicy, recordSignInIdentity } = await import(
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
  return {
    id: SESSION_ID,
    sessionToken: "token-1",
    userId: USER_ID,
    expires: "2026-12-01T00:00:00.000Z",
    signInProvider: "google",
    signInEmail: LISTED,
    user: { id: USER_ID, email: LISTED, role: "USER" },
  } as unknown as Session;
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

describe("an identity record whose write fails", () => {
  it("does not throw, so a permitted sign-in still completes", async () => {
    // @auth/core awaits the signIn event inside the sign-in request, so a
    // throw here would turn a sign-in the gate had already permitted into
    // the Access Denied page.
    findMany.mockResolvedValue([{ id: SESSION_ID }]);
    updateMany.mockRejectedValue(new Error("database is locked"));

    await expect(
      recordSignInIdentity({
        user: { id: USER_ID, email: LISTED },
        account: { provider: "google" },
      }),
    ).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the lookup itself fails either", async () => {
    findMany.mockRejectedValue(new Error("database is locked"));

    await expect(
      recordSignInIdentity({
        user: { id: USER_ID, email: LISTED },
        account: { provider: "google" },
      }),
    ).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("asks for the newest session that has no identity recorded yet", async () => {
    // The row this sign-in just created. Narrowing on `signInProvider: null`
    // is what makes "newest" the right answer in the ordinary case: every
    // other session of theirs was stamped at its own sign-in.
    findMany.mockResolvedValue([{ id: SESSION_ID }]);
    updateMany.mockResolvedValue({ count: 1 });

    await recordSignInIdentity({
      user: { id: USER_ID, email: LISTED },
      account: { provider: "google" },
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, signInProvider: null },
      orderBy: { expires: "desc" },
      take: 1,
      select: { id: true },
    });
  });
});
