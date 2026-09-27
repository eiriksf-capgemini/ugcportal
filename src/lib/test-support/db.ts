import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Test-only helper (not imported by any application code): stand up a real
 * SQLite database with the real migrations applied, so a test can exercise
 * the actual Prisma client and the actual libsql driver rather than a mock
 * that agrees with whatever the test expects.
 *
 * The sellability gate is the kind of thing where that matters: a mocked
 * `findUnique` proves the code calls a function, not that the schema default
 * is UNREVIEWED, that a missing row really reads as null, or that a write is
 * really refused.
 */

/**
 * Point DATABASE_URL at a fresh empty database file. Must run *before*
 * importing `@/lib/prisma`, which builds its adapter from the variable at
 * import time.
 */
export function createTemporaryDatabase(): { url: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ugcportal-test-"));
  const url = `file:${join(dir, "test.db")}`;
  process.env.DATABASE_URL = url;
  return {
    url,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type RawExecutor = { $executeRawUnsafe: (sql: string) => Promise<unknown> };

const MIGRATIONS_DIR = resolve(process.cwd(), "prisma/migrations");

/**
 * Every committed migration directory, in apply order. Read off disk rather
 * than listed here, so a migration added later is picked up without anyone
 * remembering — the same reason the status tests iterate the generated enum.
 */
export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Split a migration file into the statements to execute.
 *
 * Deliberately a small scanner rather than `sql.split(/;\s*$/m)`, which is
 * what this used to be. That version split on any line-final semicolon —
 * including one inside a `--` comment, which is a thing prose does — and the
 * result was a "statement" of nothing but comments, which the libsql driver
 * answers with `SQLITE_UNKNOWN_0: not an error`. Worse, a semicolon in a
 * comment *inside* a CREATE TABLE would have cut a real statement in half.
 *
 * Neither failure is theoretical: a hand-written migration is exactly where
 * explanatory comments live, and this helper is what decides whether the
 * committed SQL is ever exercised by a test at all. So the scanner tracks
 * the two places a semicolon does not end a statement — inside a single
 * quoted string, and after `--` to end of line — and splits everywhere else.
 * `''` is the SQL escape for a quote inside a string and does not close it.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let inLineComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      current += char;
      continue;
    }
    if (inString) {
      current += char;
      if (char === "'") {
        if (next === "'") {
          current += next;
          index += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      inLineComment = true;
      current += char;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);

  return statements
    .map((statement) => statement.trim())
    // A trailing chunk of comments carries no SQL. Comments are stripped
    // only to decide that — the statement itself is executed as written, so
    // a `--` inside a string literal cannot change what runs.
    .filter(
      (statement) =>
        statement.replace(/--[^\n]*/g, "").trim().length > 0,
    );
}

/** Apply one committed migration by directory name. */
export async function applyMigration(
  client: RawExecutor,
  name: string,
): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
  for (const statement of splitStatements(sql)) {
    await client.$executeRawUnsafe(statement);
  }
}

/**
 * Apply every committed migration, in order. Deliberately the real
 * prisma/migrations/*.sql rather than `db push` from the schema: that way a
 * schema change with no migration behind it fails the tests, which is the
 * same thing `prisma migrate diff` checks in CI.
 *
 * `stopBefore` applies only the migrations that come before the named one,
 * which is how a test can stand up the schema as it was *before* a change
 * and then watch that change run against real rows (ugcportal-vsm K2).
 */
export async function applyMigrations(
  client: RawExecutor,
  options: { stopBefore?: string } = {},
): Promise<void> {
  const names = migrationNames();
  const stopAt = options.stopBefore
    ? names.indexOf(options.stopBefore)
    : names.length;
  if (options.stopBefore && stopAt < 0) {
    // A renamed migration must fail loudly rather than silently applying
    // all of them and making the test assert nothing.
    throw new Error(`No such migration: ${options.stopBefore}`);
  }
  for (const name of names.slice(0, stopAt)) {
    await applyMigration(client, name);
  }
}
