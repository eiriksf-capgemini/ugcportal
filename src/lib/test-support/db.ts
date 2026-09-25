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

/**
 * Apply every committed migration, in order. Deliberately the real
 * prisma/migrations/*.sql rather than `db push` from the schema: that way a
 * schema change with no migration behind it fails the tests, which is the
 * same thing `prisma migrate diff` checks in CI.
 */
export async function applyMigrations(client: RawExecutor): Promise<void> {
  const migrationsDir = resolve(process.cwd(), "prisma/migrations");
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
    // The generated SQLite migrations are plain statements terminated by
    // `;` at end of line; none of them contain a semicolon inside a string
    // literal. Split on that rather than pulling in a SQL parser.
    const statements = sql
      .split(/;\s*$/m)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await client.$executeRawUnsafe(statement);
    }
  }
}
