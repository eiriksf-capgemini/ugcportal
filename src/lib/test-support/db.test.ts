import { describe, expect, it } from "vitest";

import {
  applyMigration,
  applyMigrations,
  migrationNames,
  splitStatements,
} from "@/lib/test-support/db";

/**
 * The statement splitter decides whether the committed migration SQL is
 * exercised by the integration tests at all, so it gets its own tests.
 *
 * It replaced `sql.split(/;\s*$/m)`, which broke on a semicolon at the end
 * of a `--` comment line — prose does that — producing a chunk of nothing
 * but comments and a `SQLITE_UNKNOWN_0: not an error` from the libsql
 * driver. A splitter that quietly mangles a migration is worse than one that
 * fails, because the tests still run and assert against a database that was
 * never migrated the way production will be.
 */
describe("splitStatements", () => {
  it("splits ordinary statements on their terminators", () => {
    expect(splitStatements('CREATE TABLE "a" ("id" TEXT);\nDROP TABLE "b";\n'))
      .toEqual(['CREATE TABLE "a" ("id" TEXT)', 'DROP TABLE "b"']);
  });

  it("ignores a semicolon inside a line comment", () => {
    const sql = [
      "-- one clause; then another",
      'DROP INDEX "x";',
      "-- a trailing note; nothing after it",
    ].join("\n");

    const statements = splitStatements(sql);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DROP INDEX "x"');
  });

  it("ignores a semicolon inside a comment in the middle of a statement", () => {
    // The dangerous version of the bug: the old splitter cut the CREATE
    // TABLE in half and produced two fragments that are each invalid SQL.
    const sql = [
      'CREATE TABLE "a" (',
      '  -- an id; nothing more',
      '  "id" TEXT',
      ");",
    ].join("\n");

    expect(splitStatements(sql)).toHaveLength(1);
  });

  it("ignores a semicolon inside a string literal", () => {
    const statements = splitStatements(
      "INSERT INTO \"a\" (\"reason\") VALUES ('first; second');\n",
    );

    expect(statements).toEqual([
      "INSERT INTO \"a\" (\"reason\") VALUES ('first; second')",
    ]);
  });

  it("treats '' as an escaped quote rather than the end of a string", () => {
    const statements = splitStatements(
      "INSERT INTO \"a\" VALUES ('it''s here; really');\nDROP TABLE \"b\";",
    );

    expect(statements).toHaveLength(2);
    expect(statements[1]).toBe('DROP TABLE "b"');
  });

  it("ignores a semicolon inside a block comment", () => {
    // The residue of the first fix, one syntax over: the scanner modelled
    // `--` and `'…'` but not slash-star, so a `;` in a block comment still
    // halved a statement. Same silent-mangling class the rewrite existed to
    // eliminate.
    const sql = [
      'CREATE TABLE "a" (',
      "  /* an id; nothing more",
      "     and it spans lines; still not a terminator */",
      '  "id" TEXT',
      ");",
    ].join("\n");

    expect(splitStatements(sql)).toHaveLength(1);
  });

  it("ignores a semicolon inside a quoted identifier", () => {
    // Prisma emits double-quoted identifiers everywhere, so this is the one
    // of the three identifier forms actually in use.
    const statements = splitStatements(
      'CREATE TABLE "od;d" ("i;d" TEXT);\nDROP TABLE "b";',
    );

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('"od;d"');
    expect(statements[1]).toBe('DROP TABLE "b"');
  });

  it("treats \"\" as an escaped quote inside an identifier", () => {
    const statements = splitStatements(
      'CREATE TABLE "a""b;c" ("id" TEXT);\nDROP TABLE "b";',
    );

    expect(statements).toHaveLength(2);
  });

  it.each([
    ["backtick", "CREATE TABLE `od;d` (`id` TEXT);\nDROP TABLE `b`;"],
    ["square bracket", "CREATE TABLE [od;d] ([id] TEXT);\nDROP TABLE [b];"],
  ])("ignores a semicolon inside a %s identifier", (_name, sql) => {
    // Neither form is emitted by Prisma today. They are modelled because
    // being selectively complete is how the original defect came back one
    // syntax over.
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it("drops a block-comment-only tail rather than executing it", () => {
    expect(splitStatements('DROP TABLE "b";\n/* done; finished */\n')).toEqual([
      'DROP TABLE "b"',
    ]);
  });

  it("drops a comment-only tail rather than executing it", () => {
    expect(splitStatements('DROP TABLE "b";\n-- done\n')).toEqual([
      'DROP TABLE "b"',
    ]);
  });

  it("keeps the comments attached to the statement they document", () => {
    // Executed as written: stripping comments is only how emptiness is
    // decided, so a `--` inside a string literal cannot change what runs.
    const statements = splitStatements("-- why\nDROP TABLE \"b\";");
    expect(statements[0]).toBe('-- why\nDROP TABLE "b"');
  });
});

describe("migrationNames", () => {
  it("reads the committed migrations off disk, in apply order", () => {
    const names = migrationNames();

    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toMatch(/^\d{14}_/);
  });
});

/**
 * `applyMigrations`' window, asserted against a recording stub rather than
 * a real database: what is under test is WHICH migrations each set of
 * options applies, and standing up SQLite to find out would mean the
 * assertion could also fail for reasons that are not that (ugcportal-qn3).
 */
describe("applyMigrations", () => {
  /** A client that records the SQL it is handed, in order. */
  function recordingClient(): { sql: string[]; $executeRawUnsafe: (s: string) => Promise<number> } {
    const sql: string[] = [];
    return {
      sql,
      $executeRawUnsafe: async (statement: string) => {
        sql.push(statement);
        return 0;
      },
    };
  }

  it("stopBefore and startAfter partition the migrations exactly", async () => {
    // Every statement applied once, with no gap and no overlap. That is
    // the property the two-phase migration tests rest on: stop before a
    // migration, run it on its own, then catch the schema up with
    // startAfter so the generated client can read the database.
    const names = migrationNames();
    const pivot = names[Math.floor(names.length / 2)];

    const whole = recordingClient();
    await applyMigrations(whole);

    const before = recordingClient();
    await applyMigrations(before, { stopBefore: pivot });

    const pivotOnly = recordingClient();
    await applyMigration(pivotOnly, pivot);

    const after = recordingClient();
    await applyMigrations(after, { startAfter: pivot });

    expect([...before.sql, ...pivotOnly.sql, ...after.sql]).toEqual(whole.sql);
    // Non-empty on both sides, so a pivot at either end could not make
    // this pass by one half simply being the whole thing.
    expect(before.sql.length).toBeGreaterThan(0);
    expect(after.sql.length).toBeGreaterThan(0);
  });

  it("refuses a name that is not a committed migration", async () => {
    // Loudly, on both options: a renamed migration that silently became
    // "apply everything" (or "apply nothing") would leave the test that
    // asked for a window asserting against the wrong schema.
    const client = recordingClient();
    await expect(
      applyMigrations(client, { stopBefore: "nope" }),
    ).rejects.toThrow("No such migration: nope");
    await expect(
      applyMigrations(client, { startAfter: "nope" }),
    ).rejects.toThrow("No such migration: nope");
    expect(client.sql).toEqual([]);
  });
});
