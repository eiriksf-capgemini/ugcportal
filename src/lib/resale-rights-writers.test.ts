import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ugcportal-0ss K4, the "grep" half: no code path other than the admin
 * action may write status = CLEARED.
 *
 * The runtime half lives in resale-rights-review.test.ts, which proves the
 * system path is refused. This file is the structural half — it fails when a
 * *new* file starts talking about CLEARED, so that a sync job, an OAuth
 * callback or a seed script quietly setting it has to be noticed in review
 * rather than discovered in production.
 */

const SRC = resolve(process.cwd(), "src");

/** Generated Prisma output names every enum member; it writes nothing. */
const IGNORED_DIRS = new Set(["generated"]);

/**
 * Files allowed to mention CLEARED at all, with why. Adding to this list is
 * the deliberate act the test exists to force.
 */
const ALLOWED = new Map<string, string>([
  ["lib/resale-rights.ts", "the gate: compares against it, never writes"],
  [
    "lib/resale-rights-review.ts",
    "the only writer — an ADMIN transition, guarded by type and at runtime",
  ],
  [
    "app/admin/settings/instagram/actions.ts",
    "documentation only: the admin action that calls the writer",
  ],
]);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        sourceFiles(join(dir, entry.name), found);
      }
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    found.push(join(dir, entry.name));
  }
  return found;
}

const files = sourceFiles(SRC).map((path) => ({
  name: relative(SRC, path).split(sep).join("/"),
  source: readFileSync(path, "utf8"),
}));

describe("ugcportal-0ss K4: the only writer of CLEARED", () => {
  it("found application sources to scan", () => {
    // Guards the scan itself: a broken path would make every assertion
    // below vacuously true.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((file) => file.name)).toContain("lib/resale-rights.ts");
  });

  it("is the admin transition, and no other file even names the status", () => {
    const mentions = files
      .filter((file) => /\bCLEARED\b/.test(file.source))
      .map((file) => file.name)
      .sort();

    expect(mentions).toEqual([...ALLOWED.keys()].sort());
  });

  it("has no literal status write to CLEARED outside the writer", () => {
    // Catches the shape an accidental writer would take:
    //   prisma.resaleRightsReview.update({ data: { status: "CLEARED" } })
    const offenders = files.filter(
      (file) =>
        file.name !== "lib/resale-rights-review.ts" &&
        /status\s*:\s*(["']CLEARED["']|ResaleRightsStatus\.CLEARED)/.test(
          file.source,
        ),
    );

    expect(offenders.map((file) => file.name)).toEqual([]);
  });

  it("has exactly one module that writes ResaleRightsReview at all", () => {
    const writers = files
      .filter((file) =>
        /resaleRightsReview\.(create|update|upsert|updateMany|createMany)\b/.test(
          file.source,
        ),
      )
      .map((file) => file.name);

    expect(writers).toEqual(["lib/resale-rights-review.ts"]);
  });
});

describe("the database's own default", () => {
  it("is UNREVIEWED in the schema", () => {
    const schema = readFileSync(
      resolve(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );
    expect(schema).toMatch(
      /status\s+ResaleRightsStatus\s+@default\(UNREVIEWED\)/,
    );
    expect(schema).not.toMatch(/@default\(CLEARED\)/);
  });

  it("is UNREVIEWED in the committed migrations, and no migration sets CLEARED", () => {
    const migrationsDir = resolve(process.cwd(), "prisma/migrations");
    const sql = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readFileSync(join(migrationsDir, entry.name, "migration.sql"), "utf8"),
      )
      .join("\n");

    expect(sql).toContain(`"status" TEXT NOT NULL DEFAULT 'UNREVIEWED'`);
    expect(sql).not.toContain("CLEARED");
  });
});
