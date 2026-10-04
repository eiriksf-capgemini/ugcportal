import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";

/**
 * What the two database writes in src/lib/live-session.ts do when the
 * database refuses them (ugcportal-mzr).
 *
 * Separate from src/lib/live-session.test.ts, which runs against a real
 * SQLite database: a `vi.spyOn` on a Prisma delegate method does not survive
 * `restoreAllMocks` there — the method is not an own property of the
 * delegate, so restoring deletes it and every later test in the file loses
 * the client. Here the module is mocked instead, which is the right tool for
 * "the write threw" and the wrong one for "the rows are gone".
 *
 * Both cases are fail-closed claims, which is why they are tested at all: a
 * failed delete must not become a permitted session, and a failed provider
 * write must not turn an already-permitted sign-in into Access Denied.
 */

const { deleteMany, updateMany } = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { session: { deleteMany }, user: { updateMany } },
}));

const { enforceLiveSessionPolicy, recordSignInProvider } = await import(
  "@/lib/live-session"
);

const LISTED = "owner@example.com";
const USER_ID = "user-1";

const originalAllowlist = process.env[PERMITTED_EMAILS_VAR];
const originalBootstrap = process.env.ADMIN_BOOTSTRAP_EMAILS;

function sessionFor(): Session {
  return {
    expires: "2026-12-01T00:00:00.000Z",
    user: { id: USER_ID, email: LISTED, role: "USER" },
  } as unknown as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Nobody is permitted, so every case below takes the refusal path.
  process.env[PERMITTED_EMAILS_VAR] = "someone-else@example.com";
  delete process.env.ADMIN_BOOTSTRAP_EMAILS;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of [
    [PERMITTED_EMAILS_VAR, originalAllowlist],
    ["ADMIN_BOOTSTRAP_EMAILS", originalBootstrap],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("a revocation whose delete fails", () => {
  it("still refuses the request", async () => {
    deleteMany.mockRejectedValue(new Error("database is locked"));

    const result = await enforceLiveSessionPolicy(sessionFor(), {
      id: USER_ID,
      email: LISTED,
    });

    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    // Fail closed: a database that cannot take the delete must not be able
    // to turn a refusal into a permission. The stale row simply survives to
    // be refused again on the next request.
    expect(result.user).toBeUndefined();
  });

  it("and does not reject, which would be a 500 on every page", async () => {
    deleteMany.mockRejectedValue(new Error("database is locked"));

    await expect(
      enforceLiveSessionPolicy(sessionFor(), { id: USER_ID, email: LISTED }),
    ).resolves.toBeDefined();
  });

  it("while a successful delete is still what normally happens", async () => {
    // The control. Without it, both assertions above would be satisfied by
    // an implementation that never called the delete at all.
    deleteMany.mockResolvedValue({ count: 2 });

    const result = await enforceLiveSessionPolicy(sessionFor(), {
      id: USER_ID,
      email: LISTED,
    });

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(result.user).toBeUndefined();
  });
});

describe("a provider record whose write fails", () => {
  it("does not throw, so a permitted sign-in still completes", async () => {
    // @auth/core awaits the signIn event inside the sign-in request, so a
    // throw here would turn a sign-in the gate had already permitted into
    // the Access Denied page.
    updateMany.mockRejectedValue(new Error("database is locked"));

    await expect(
      recordSignInProvider({ id: USER_ID }, { provider: "google" }),
    ).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
