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
 * committed SQL is ever exercised by a test at all. A splitter that mangles
 * a migration silently is worse than one that fails, because the suite keeps
 * running — against a database that was never migrated the way production
 * will be.
 *
 * So the scanner models EVERY construct in which SQLite does not treat `;`
 * as a statement terminator, rather than the two that happened to bite
 * first. Being selectively complete here is how the original bug came back
 * one syntax over, so the list is the full one from the SQLite grammar:
 *
 *   - single-quoted string literal; `''` is an escaped quote, not the end
 *   - double-quoted identifier; `""` likewise
 *   - backtick identifier (MySQL-compat, accepted by SQLite)
 *   - square-bracket identifier (MSSQL-compat; no escape form, `]` closes)
 *   - `--` line comment, to end of line
 *   - slash-star block comment, which may span lines and does not nest
 *
 * Prisma emits `"…"` identifiers and `'…'` literals, so those two are the
 * ones in use today; the rest cost a branch each and remove the question.
 */
/** Closing delimiter for each quoting form, keyed by its opener. */
const QUOTE_CLOSERS: Record<string, string> = {
  "'": "'",
  '"': '"',
  "`": "`",
  "[": "]",
};

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  /** The delimiter that would close the quote we are inside, or null. */
  let closer: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

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
    if (inBlockComment) {
      current += char;
      // Block comments do not nest in SQLite: the first `*/` ends it.
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (closer !== null) {
      current += char;
      if (char === closer) {
        // A doubled delimiter is an escaped one and does not close the
        // quote — true for '' and "" and ``. `[…]` has no escape form, so
        // `]` always closes it, which is SQLite's own rule.
        if (next === closer && closer !== "]") {
          current += next;
          index += 1;
        } else {
          closer = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      inLineComment = true;
      current += char;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      current += char + next;
      index += 1;
      continue;
    }
    if (QUOTE_CLOSERS[char] !== undefined) {
      closer = QUOTE_CLOSERS[char];
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
    .filter((statement) => withoutComments(statement).trim().length > 0);
}

/** Comment-free view of a chunk, for deciding whether it carries any SQL. */
function withoutComments(statement: string): string {
  return statement.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
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
