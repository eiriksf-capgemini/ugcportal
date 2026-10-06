import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { Adapter } from "next-auth/adapters";

import { type ThrottledLog, createThrottledLog } from "@/lib/throttled-log";

/**
 * Say out loud when a database query failed because the database is behind
 * prisma/migrations (ugcportal-w7wc).
 *
 * WHY: the generated client selects every scalar column the schema
 * declares, so one unapplied `ALTER TABLE ... ADD COLUMN` fails every query
 * on that table. On the auth path that is `getSessionAndUser`, which runs
 * on every request, and @auth/core turns it into `SessionTokenError` — a
 * generic name and a documentation link that say nothing about a column or
 * a migration. The degrade-to-signed-out of ugcportal-8df3 then keeps the
 * page at 200, so what the visitor sees is a site that is signed out
 * everywhere and a sign-in that always fails.
 *
 * scripts/check-migrations.mjs is what stops this happening on `npm run
 * dev`. This module is for when it happens anyway — a server already
 * running when the migration landed, a deploy that skipped it, a database
 * reached over the network that the dev check will not write to.
 */

/** Shortest interval between two of these lines, as elsewhere in this app. */
export const SCHEMA_MISMATCH_LOG_INTERVAL_MS = 10_000;

export type SchemaMismatch = {
  kind: "column" | "table";
  /** `Session.signInProvider` for a column, `Session` for a table. */
  qualified: string;
  /** The identifier on its own, as it appears in a migration's SQL. */
  name: string;
};

/**
 * SQLite's own wording, as it reaches us through the libsql driver adapter
 * inside Prisma's P2039: ``Database error. Code: `1`. Message: `SQLITE_ERROR:
 * no such column: main.Session.signInProvider` ``.
 *
 * Matched on the message text rather than on a Prisma error code: P2039 is
 * "the underlying database said no", which covers far more than this, and
 * the column name is in the text. src/lib/schema-mismatch.test.ts drives
 * the real client against a real database to check this still matches.
 */
const NO_SUCH_OBJECT =
  /no such (column|table):\s*([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)/i;

/**
 * The missing column or table an error reports, or null for an error that
 * reports neither.
 *
 * Reads `message` off anything object-shaped rather than narrowing to a
 * Prisma error class: the driver adapter re-wraps errors, and an
 * `instanceof` across module instances is a coin flip (the same reasoning
 * as `prismaErrorCode` in src/lib/prisma-errors.ts).
 */
export function schemaMismatchFrom(error: unknown): SchemaMismatch | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") {
    return null;
  }
  const match = NO_SUCH_OBJECT.exec(message);
  if (!match) {
    return null;
  }
  const kind = match[1].toLowerCase() as "column" | "table";
  // SQLite qualifies the identifier with the schema it searched
  // (`main.Session.signInProvider`). Keeping the last two parts for a
  // column and the last one for a table reads that form and a bare one
  // alike, without assuming the schema is called `main`.
  const parts = match[2].split(".");
  return {
    kind,
    qualified: (kind === "column" ? parts.slice(-2) : parts.slice(-1)).join("."),
    name: parts[parts.length - 1],
  };
}

/** Memoised per identifier: the directory does not change while we run. */
const introducedBy = new Map<string, string | null>();

/**
 * The earliest migration whose SQL quotes this identifier anywhere.
 *
 * A BEST-EFFORT NAME MATCH, and the docstring has to say so because the
 * caller prints the answer as the migration that adds the column. Nothing
 * here checks that the match is the `ADD COLUMN` or `CREATE TABLE` that
 * introduces the identifier rather than a later statement that merely
 * mentions it, and when two migrations quote the same one this names the
 * earlier — which is the introducing migration only as long as identifiers
 * are introduced once. src/lib/schema-mismatch.test.ts checks that holds
 * for every identifier prisma/migrations currently introduces, and pins the
 * earliest-wins behaviour on a two-migration fixture.
 *
 * Quoted, because that is how Prisma writes identifiers in generated SQL
 * (`ADD COLUMN "signInProvider" TEXT`) while the prose in these files'
 * comments writes them bare. Memoised for the lifetime of the process, so a
 * migration added while the dev server is running is not picked up. Null
 * whenever the migrations directory is not on disk — the production image
 * copies `prisma/schema.prisma` and not the history — or when nothing
 * matches.
 */
export function migrationIntroducing(
  name: string,
  migrationsDir = path.join(process.cwd(), "prisma", "migrations"),
): string | null {
  const cacheKey = JSON.stringify([migrationsDir, name]);
  const cached = introducedBy.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let found: string | null = null;
  try {
    const needle = `"${name}"`;
    const directories = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const directory of directories) {
      let sql: string;
      try {
        sql = readFileSync(path.join(migrationsDir, directory, "migration.sql"), "utf8");
      } catch {
        continue;
      }
      if (sql.includes(needle)) {
        found = directory;
        break;
      }
    }
  } catch {
    found = null;
  }
  introducedBy.set(cacheKey, found);
  return found;
}

/** Test-only: forget what {@link migrationIntroducing} has looked up. */
export function resetMigrationLookupCache(): void {
  introducedBy.clear();
}

/**
 * The line a developer can act on, naming the missing column and —
 * best-effort, see `migrationIntroducing` — the migration that adds it.
 */
export function describeSchemaMismatch(
  mismatch: SchemaMismatch,
  { method, migrationsDir }: { method: string; migrationsDir?: string },
): string {
  const migration = migrationIntroducing(mismatch.name, migrationsDir);
  const adds = migration ? `, which prisma/migrations/${migration} adds` : "";
  return (
    `[auth] The auth adapter's ${method} failed: the database has no ` +
    `${mismatch.kind} ${mismatch.qualified}${adds}. The client selects every ` +
    "column the schema declares, so one missing column fails every query on " +
    "that table. Apply the migrations with `npx prisma migrate deploy` — " +
    "`npm run dev` does it for a local database (scripts/check-migrations.mjs)."
  );
}

/**
 * One throttle per missing identifier, not one for the whole module.
 *
 * A single throttle would count a SECOND missing column as a repeat of the
 * first and never name it — which is this bead's own incident, where
 * `Session.signInProvider` and `User.configuredHandle` were both missing,
 * and is the payload-in-a-throttled-closure trap src/lib/throttled-log.ts's
 * own header documents. Keyed this way each distinct mismatch gets its own
 * first line, and only its own repeats are counted (src/lib/
 * schema-mismatch.test.ts drives both columns off the real client).
 *
 * The key space is bounded by the schema: the sole production caller is the
 * adapter chain in src/lib/auth.ts, whose SQL is generated from
 * prisma/schema.prisma, so the identifiers SQLite can report missing are
 * that file's. Nothing visitor-supplied reaches here.
 */
const mismatchLogs = new Map<string, ThrottledLog>();

function throttleFor(identifier: string): ThrottledLog {
  const existing = mismatchLogs.get(identifier);
  if (existing) {
    return existing;
  }
  const created = createThrottledLog({ intervalMs: SCHEMA_MISMATCH_LOG_INTERVAL_MS });
  mismatchLogs.set(identifier, created);
  return created;
}

/** Test-only: back to a never-logged state. */
export function resetSchemaMismatchLog(): void {
  mismatchLogs.clear();
}

/**
 * Report a schema mismatch behind `error`, if that is what it is, and say
 * nothing otherwise.
 *
 * @returns whether the error was a schema mismatch.
 */
export function reportSchemaMismatch(
  error: unknown,
  method: string,
  migrationsDir?: string,
): boolean {
  const mismatch = schemaMismatchFrom(error);
  if (!mismatch) {
    return false;
  }
  throttleFor(mismatch.qualified).log((suppressed) => {
    const note =
      suppressed > 0 ? ` (${suppressed} further failure(s) on this ${mismatch.kind})` : "";
    console.error(describeSchemaMismatch(mismatch, { method, migrationsDir }) + note);
  });
  return true;
}

/**
 * The adapter, with every method reporting a schema mismatch before letting
 * the error through.
 *
 * Rethrows unchanged: @auth/core's handling of a failed adapter call — the
 * `SessionTokenError`, the refused sign-in — is what it was. This only adds
 * the line that says which column.
 */
export function withSchemaMismatchLogging(adapter: Adapter): Adapter {
  const wrapped: Record<string, unknown> = { ...adapter };
  for (const [method, value] of Object.entries(adapter)) {
    if (typeof value !== "function") {
      continue;
    }
    const original = value as (...args: unknown[]) => unknown;
    wrapped[method] = async (...args: unknown[]) => {
      try {
        return await original.apply(adapter, args);
      } catch (error) {
        reportSchemaMismatch(error, method);
        throw error;
      }
    };
  }
  return wrapped as Adapter;
}
