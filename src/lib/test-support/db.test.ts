import { describe, expect, it } from "vitest";

import { migrationNames, splitStatements } from "@/lib/test-support/db";

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
