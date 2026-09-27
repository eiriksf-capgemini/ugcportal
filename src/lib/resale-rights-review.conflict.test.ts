import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lost race on a *first* decision (ugcportal-0ss).
 *
 * `setResaleRightsStatus` reads whether a review row exists and then creates
 * one, and `@prisma/adapter-libsql` opens SQLite transactions as `deferred`,
 * so that read is not serialised against a concurrent writer. Two admins
 * deciding on the same never-reviewed uploader at the same moment can both
 * see no row and both try to create one. The unique index on
 * `uploaderUserId` is what actually prevents two reviews existing; the
 * loser gets P2002.
 *
 * Mocked rather than raced, deliberately: forcing the interleaving against a
 * real database means either a sleep or a retry loop, and the resulting test
 * would be slow and occasionally lie. What matters is the contract — the
 * error is turned into an outcome rather than thrown at a function whose
 * signature promises outcomes — and that is exact under a mock.
 */

const createMock = vi.fn();
const updateMock = vi.fn();
const eventCreateMock = vi.fn();

const tx = {
  // The subject lookup and the actor role check share this mock: both read
  // `user`, and every test here wants a real uploader and an admin actor.
  user: {
    findUnique: vi
      .fn()
      .mockResolvedValue({ id: "uploader-1", email: "u@example.com", role: "ADMIN" }),
  },
  resaleRightsReview: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: createMock,
    update: updateMock,
  },
  resaleRightsEvent: { create: eventCreateMock },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
  },
}));

const { setResaleRightsStatus } = await import("@/lib/resale-rights-review");

/** What Prisma raises for a unique-constraint violation. */
function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target: ["uploaderUserId"] },
  });
}

/** What Prisma raises when a foreign key has nothing to point at. */
function foreignKeyViolation(fieldName = "reviewedByUserId") {
  return Object.assign(new Error("Foreign key constraint violated"), {
    code: "P2003",
    meta: { field_name: fieldName },
  });
}

const DECISION = {
  source: "ADMIN",
  actorUserId: "admin-1",
  status: "CLEARED",
  reason: "Contract signed.",
} as const;

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  tx.resaleRightsReview.findUnique.mockReset().mockResolvedValue(null);
  eventCreateMock.mockReset().mockResolvedValue({});
});

describe("a concurrent first decision", () => {
  it("is reported as an outcome, not thrown", async () => {
    createMock.mockRejectedValue(uniqueViolation());

    await expect(
      setResaleRightsStatus("uploader-1", DECISION),
    ).resolves.toEqual({ outcome: "conflict" });
  });

  it("writes no audit row for the decision that lost", async () => {
    // The winner's event is the one that describes what happened; a second
    // row for a write that never landed would be a false trail.
    createMock.mockRejectedValue(uniqueViolation());

    await setResaleRightsStatus("uploader-1", DECISION);

    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it("still lets any other database error surface", async () => {
    // Only the unique violation is an expected, explainable outcome.
    // Swallowing everything here would turn a broken database into a
    // friendly message and hide it.
    createMock.mockRejectedValue(
      Object.assign(new Error("disk I/O error"), { code: "P1017" }),
    );

    await expect(setResaleRightsStatus("uploader-1", DECISION)).rejects.toThrow(
      "disk I/O error",
    );
  });

  it("does not mistake a plain error carrying no code for a conflict", async () => {
    createMock.mockRejectedValue(new Error("boom"));

    await expect(setResaleRightsStatus("uploader-1", DECISION)).rejects.toThrow(
      "boom",
    );
  });
});

/**
 * `uploaderUserId` and `reviewedByUserId` are real foreign keys and libsql
 * enforces foreign keys, so a user deleted between page render and form
 * submit is a write the database refuses. Before this was mapped it came out
 * of `$transaction` as an unhandled 500 — no message, and the evidence file
 * uploaded moments earlier left orphaned in the bucket.
 */
describe("a named user deleted mid-form", () => {
  it("is reported as missing_reference on the create path", async () => {
    createMock.mockRejectedValue(foreignKeyViolation());

    await expect(setResaleRightsStatus("uploader-1", DECISION)).resolves.toEqual({
      outcome: "missing_reference",
    });
  });

  it("is reported on the update path too", async () => {
    // The original catch wrapped only the create, so an existing review
    // being re-decided against a since-deleted user still threw.
    tx.resaleRightsReview.findUnique.mockResolvedValueOnce({
      id: "rev-1",
      status: "IN_REVIEW",
    });
    updateMock.mockRejectedValue(foreignKeyViolation());

    await expect(setResaleRightsStatus("uploader-1", DECISION)).resolves.toEqual({
      outcome: "missing_reference",
    });
    expect(eventCreateMock).not.toHaveBeenCalled();
  });

  it("treats a vanished review row as a conflict on the update path", async () => {
    tx.resaleRightsReview.findUnique.mockResolvedValueOnce({
      id: "rev-1",
      status: "IN_REVIEW",
    });
    updateMock.mockRejectedValue(
      Object.assign(new Error("Record to update not found"), { code: "P2025" }),
    );

    await expect(setResaleRightsStatus("uploader-1", DECISION)).resolves.toEqual({
      outcome: "conflict",
    });
  });

  /**
   * Two foreign keys on this row can raise P2003 — the uploader and the
   * reviewer — and they need different answers. Reporting both as "the
   * reviewer no longer exists" is advice that cannot work when the
   * *uploader* is what vanished, and points at the wrong record.
   */
  it("reports a vanished uploader as uploader_not_found, not as a bad reviewer", async () => {
    // SQLite names the constraint rather than the bare column.
    createMock.mockRejectedValue(
      foreignKeyViolation("ResaleRightsReview_uploaderUserId_fkey (index)"),
    );

    await expect(
      setResaleRightsStatus("uploader-1", DECISION),
    ).resolves.toEqual({ outcome: "uploader_not_found" });
  });

  it("falls back to the user-facing message when the driver says nothing", async () => {
    // No field name to go on: the message this maps to names both
    // possibilities rather than guessing one.
    createMock.mockRejectedValue(
      Object.assign(new Error("FOREIGN KEY constraint failed"), {
        code: "P2003",
      }),
    );

    await expect(setResaleRightsStatus("uploader-1", DECISION)).resolves.toEqual({
      outcome: "missing_reference",
    });
  });

  // The allow-list is deliberate. After two codes turned out to be
  // reachable the temptation is to catch everything — but a disk error
  // answered with a tidy "try again" is a fault nobody ever looks at.
  it("still lets an unmapped database error surface", async () => {
    createMock.mockRejectedValue(
      Object.assign(new Error("database is locked"), { code: "P2034" }),
    );

    await expect(setResaleRightsStatus("uploader-1", DECISION)).rejects.toThrow(
      "database is locked",
    );
  });
});
