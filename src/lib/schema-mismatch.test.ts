import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Adapter } from "next-auth/adapters";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCHEMA_MISMATCH_LOG_INTERVAL_MS,
  describeSchemaMismatch,
  migrationIntroducing,
  reportSchemaMismatch,
  resetMigrationLookupCache,
  resetSchemaMismatchLog,
  schemaMismatchFrom,
  withSchemaMismatchLogging,
} from "@/lib/schema-mismatch";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * Tests for the schema-mismatch log line (ugcportal-w7wc).
 *
 * The parser is driven against errors the REAL Prisma client raises against
 * a REAL database stopped one migration short, not against a string someone
 * typed: what it has to match is SQLite's wording as the libsql driver and
 * Prisma re-wrap it, and a hand-written fixture agrees with whatever the
 * regex already does.
 */

const SIGN_IN_IDENTITY_MIGRATION = "20261004180000_add_session_sign_in_identity";
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma", "migrations");

// Before importing @/lib/prisma, which builds its adapter from
// DATABASE_URL at import time (see src/lib/test-support/db.ts).
const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

beforeAll(async () => {
  await applyMigrations(prisma, { stopBefore: SIGN_IN_IDENTITY_MIGRATION });
});

afterAll(() => {
  database.cleanup();
});

beforeEach(() => {
  resetSchemaMismatchLog();
  resetMigrationLookupCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The error a call raises, or null if it did not raise one. */
async function raised(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return null;
  } catch (error) {
    return error;
  }
}

describe("schemaMismatchFrom, against the real client", () => {
  it("names the column the generated client selected and the database lacks", async () => {
    const error = await raised(() => prisma.session.findFirst());
    expect(error).not.toBeNull();
    expect((error as Error).message).toContain("no such column");
    expect(schemaMismatchFrom(error)).toEqual({
      kind: "column",
      qualified: "Session.signInProvider",
      name: "signInProvider",
    });
  });

  it("names a missing table", async () => {
    const error = await raised(() =>
      prisma.$queryRawUnsafe('SELECT 1 FROM "NoSuchTableHere"'),
    );
    expect(error).not.toBeNull();
    expect(schemaMismatchFrom(error)).toEqual({
      kind: "table",
      qualified: "NoSuchTableHere",
      name: "NoSuchTableHere",
    });
  });

  it("says nothing about a database error that is not a schema mismatch", async () => {
    const error = await raised(() => prisma.$queryRawUnsafe("SELEC 1"));
    expect(error).not.toBeNull();
    expect((error as Error).message).toContain("syntax error");
    expect(schemaMismatchFrom(error)).toBeNull();
  });
});

describe("schemaMismatchFrom, shapes the real client cannot produce here", () => {
  it("reads an identifier that carries no schema qualifier", () => {
    expect(schemaMismatchFrom({ message: "no such column: signInProvider" })).toEqual({
      kind: "column",
      qualified: "signInProvider",
      name: "signInProvider",
    });
  });

  it("reads a table qualified by a schema that is not called main", () => {
    expect(schemaMismatchFrom({ message: "no such table: attached.Media" })).toEqual({
      kind: "table",
      qualified: "Media",
      name: "Media",
    });
  });

  it("returns null for anything with no usable message", () => {
    expect(schemaMismatchFrom(null)).toBeNull();
    expect(schemaMismatchFrom(undefined)).toBeNull();
    expect(schemaMismatchFrom("no such column: main.Session.signInProvider")).toBeNull();
    expect(schemaMismatchFrom({})).toBeNull();
    expect(schemaMismatchFrom({ message: 42 })).toBeNull();
    expect(schemaMismatchFrom(new Error("connection refused"))).toBeNull();
  });
});

describe("migrationIntroducing", () => {
  it("finds the committed migration that adds each column the outage named", () => {
    expect(migrationIntroducing("signInProvider")).toBe(SIGN_IN_IDENTITY_MIGRATION);
    expect(migrationIntroducing("configuredHandle")).toBe(
      "20261005120000_add_user_configured_handle",
    );
  });

  it("prefers the migration that creates an identifier over one that only mentions it", () => {
    // `Session` is created by the first migration and referred to by later
    // ones; the earliest is the answer.
    expect(migrationIntroducing("Session")).toBe("20260916184059_init");
  });

  it("answers null for an identifier no migration mentions", () => {
    expect(migrationIntroducing("notAColumnAnywhere")).toBeNull();
  });

  it("names the earlier migration when two quote the same identifier", () => {
    // The best-effort half of the docstring, pinned: the match is on the
    // name, not on the statement that introduces it, so two migrations
    // quoting one identifier resolve to the earlier regardless of which
    // actually adds it.
    const dir = mkdtempSync(path.join(tmpdir(), "ugcportal-dup-migrations-"));
    try {
      for (const [name, sql] of [
        ["20260101000000_mentions_it", 'UPDATE "Thing" SET "later" = "duplicated";'],
        ["20260102000000_adds_it", 'ALTER TABLE "Thing" ADD COLUMN "duplicated" TEXT;'],
      ]) {
        mkdirSync(path.join(dir, name));
        writeFileSync(path.join(dir, name, "migration.sql"), sql);
      }
      expect(migrationIntroducing("duplicated", dir)).toBe("20260101000000_mentions_it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves every identifier prisma/migrations introduces to the migration that does", () => {
    // What makes the best-effort match good enough on today's schema, and
    // the thing that stops being true the day an identifier is introduced
    // twice. `CREATE TABLE "x"` and `ADD COLUMN "x"` are the two statements
    // Prisma generates to introduce one.
    const introduces = new Map<string, Set<string>>();
    for (const migration of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, migration, "migration.sql"), "utf8")
        // These files carry long `--` explanations that quote SQL back
        // (20260928103000_add_media_tags quotes its own `CREATE TABLE
        // "Tag"`). Collecting migrations into a Set already absorbs a
        // quote inside the migration that introduces the identifier; this
        // is for a quote in some OTHER migration, which none does yet.
        .replace(/--[^\n]*/g, "");
      for (const [, identifier] of sql.matchAll(
        /(?:CREATE TABLE(?: IF NOT EXISTS)?|ADD COLUMN)\s+"([^"]+)"/g,
      )) {
        introduces.set(identifier, (introduces.get(identifier) ?? new Set()).add(migration));
      }
    }
    expect(introduces.size).toBeGreaterThan(20);
    const introducedTwice = [...introduces]
      .filter(([, where]) => where.size > 1)
      .map(([identifier, where]) => [identifier, [...where]]);
    expect(introducedTwice).toEqual([]);
    for (const [identifier, where] of introduces) {
      expect(migrationIntroducing(identifier), identifier).toBe([...where][0]);
    }
  });

  it("answers null when the migrations directory is not on disk", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "ugcportal-no-migrations-"));
    try {
      expect(migrationIntroducing("signInProvider", path.join(empty, "missing"))).toBeNull();
      // An existing but empty directory is the other half of the same case.
      expect(migrationIntroducing("signInProvider", empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("describeSchemaMismatch", () => {
  const mismatch = {
    kind: "column",
    qualified: "Session.signInProvider",
    name: "signInProvider",
  } as const;

  it("names the column, the migration that adds it, and the command", () => {
    const line = describeSchemaMismatch(mismatch, { method: "getSessionAndUser" });
    expect(line).toContain("Session.signInProvider");
    expect(line).toContain(`prisma/migrations/${SIGN_IN_IDENTITY_MIGRATION}`);
    expect(line).toContain("npx prisma migrate deploy");
    expect(line).toContain("getSessionAndUser");
  });

  it("still names the column when the migration history is not on disk", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "ugcportal-no-migrations-"));
    try {
      const line = describeSchemaMismatch(mismatch, {
        method: "getSessionAndUser",
        migrationsDir: path.join(empty, "missing"),
      });
      expect(line).toContain("Session.signInProvider");
      expect(line).toContain("npx prisma migrate deploy");
      expect(line).not.toContain("prisma/migrations/2026");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("withSchemaMismatchLogging", () => {
  function adapterWith(getSessionAndUser: () => unknown): Adapter {
    return {
      getSessionAndUser,
      // A non-function property, to prove the wrapper copies it rather than
      // dropping everything it does not wrap.
      notAMethod: "kept",
    } as unknown as Adapter;
  }

  it("reports the missing column and rethrows the original error unchanged", async () => {
    const error = Object.assign(new Error("no such column: main.Session.signInProvider"), {
      code: "P2039",
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = withSchemaMismatchLogging(
      adapterWith(() => {
        throw error;
      }),
    );
    await expect(adapter.getSessionAndUser!("token")).rejects.toBe(error);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toContain("Session.signInProvider");
    expect(errors.mock.calls[0][0]).toContain("getSessionAndUser");
  });

  it("reports a rejected promise, not only a synchronous throw", async () => {
    const error = new Error("no such column: main.User.configuredHandle");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = withSchemaMismatchLogging(adapterWith(() => Promise.reject(error)));
    await expect(adapter.getSessionAndUser!("token")).rejects.toBe(error);
    expect(errors.mock.calls[0][0]).toContain("User.configuredHandle");
  });

  it("says nothing about an error that is not a schema mismatch", async () => {
    const error = new Error("SQLITE_BUSY: database is locked");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = withSchemaMismatchLogging(
      adapterWith(() => {
        throw error;
      }),
    );
    await expect(adapter.getSessionAndUser!("token")).rejects.toBe(error);
    expect(errors).not.toHaveBeenCalled();
  });

  it("passes arguments through and returns what the adapter returned", async () => {
    const calls: unknown[][] = [];
    const adapter = withSchemaMismatchLogging(
      adapterWith((...args: unknown[]) => {
        calls.push(args);
        return { session: "s", user: "u" };
      }),
    );
    await expect(adapter.getSessionAndUser!("some-token")).resolves.toEqual({
      session: "s",
      user: "u",
    });
    expect(calls).toEqual([["some-token"]]);
    expect((adapter as unknown as { notAMethod: string }).notAMethod).toBe("kept");
  });

  it("throttles a repeat rather than writing one line per request", async () => {
    const error = new Error("no such column: main.Session.signInProvider");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = withSchemaMismatchLogging(
      adapterWith(() => {
        throw error;
      }),
    );
    for (let i = 0; i < 5; i += 1) {
      await expect(adapter.getSessionAndUser!("token")).rejects.toBe(error);
    }
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("counts what the throttle swallowed into the next line", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = { message: "no such column: main.Session.signInProvider" };
    // Fake timers for the whole test (ugcportal-qz1u item 1 ripple): the
    // underlying throttle (src/lib/throttled-log.ts) now measures its window
    // with `performance.now()`, not `Date.now()`, so advancing the window
    // with `vi.setSystemTime` alone (which moves `Date`, not
    // `performance.now()`) no longer does anything — see
    // watermark.concurrency.test.ts's own comment on the same fix.
    // `vi.advanceTimersByTime` moves both together.
    vi.useFakeTimers();
    try {
      expect(reportSchemaMismatch(error, "getSessionAndUser")).toBe(true);
      expect(reportSchemaMismatch(error, "getSessionAndUser")).toBe(true);
      expect(reportSchemaMismatch(error, "getSessionAndUser")).toBe(true);
      expect(errors).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(SCHEMA_MISMATCH_LOG_INTERVAL_MS + 1);
      expect(reportSchemaMismatch(error, "getSessionAndUser")).toBe(true);
      expect(errors).toHaveBeenCalledTimes(2);
      expect(errors.mock.calls[1][0]).toContain("2 further failure(s) on this column");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the second missing column too, instead of folding it into the first", async () => {
    // The incident this module is for: on 2026-10-05 BOTH
    // Session.signInProvider and User.configuredHandle were missing. The
    // database here is stopped before the first of the two migrations that
    // add them, so both errors are the real client's.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sessionError = await raised(() => prisma.session.findFirst());
    const userError = await raised(() => prisma.user.findFirst());
    expect(schemaMismatchFrom(sessionError)?.qualified).toBe("Session.signInProvider");
    expect(schemaMismatchFrom(userError)?.qualified).toBe("User.configuredHandle");

    expect(reportSchemaMismatch(sessionError, "getSessionAndUser")).toBe(true);
    expect(reportSchemaMismatch(userError, "getUserByAccount")).toBe(true);
    // Twice, in the same throttle window: a single shared throttle reported
    // the first and folded the second into its "further failure(s)" count,
    // describing a different column.
    expect(errors).toHaveBeenCalledTimes(2);
    const logged = errors.mock.calls.map((call) => String(call[0]));
    expect(logged[0]).toContain("Session.signInProvider");
    expect(logged[1]).toContain("User.configuredHandle");
    expect(logged[1]).toContain("20261005120000_add_user_configured_handle");
    for (const line of logged) {
      expect(line).not.toContain("further failure(s)");
    }
  });

  it("keeps each identifier's repeats on its own counter", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const session = { message: "no such column: main.Session.signInProvider" };
    const user = { message: "no such column: main.User.configuredHandle" };
    // See the previous test's comment: the window advances with
    // `vi.advanceTimersByTime`, not `vi.setSystemTime`, now that the
    // underlying throttle reads `performance.now()`.
    vi.useFakeTimers();
    try {
      reportSchemaMismatch(session, "getSessionAndUser");
      reportSchemaMismatch(session, "getSessionAndUser");
      reportSchemaMismatch(session, "getSessionAndUser");
      reportSchemaMismatch(user, "getUserByAccount");
      expect(errors).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(SCHEMA_MISMATCH_LOG_INTERVAL_MS + 1);
      reportSchemaMismatch(user, "getUserByAccount");
      expect(errors).toHaveBeenCalledTimes(3);
      // The user column was suppressed no times; the two swallowed calls
      // belong to the session column's counter and must not appear here.
      expect(errors.mock.calls[2][0]).toContain("User.configuredHandle");
      expect(errors.mock.calls[2][0]).not.toContain("further failure(s)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers false, and logs nothing, for an error it does not recognise", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportSchemaMismatch(new Error("connection refused"), "createUser")).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });
});
