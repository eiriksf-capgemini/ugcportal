/**
 * Tests for the dev-start migration check (ugcportal-w7wc).
 *
 * The decision function is driven directly; the runner is driven through an
 * injected command runner that records what it was asked to run, so "which
 * prisma commands may this script issue" is an assertion rather than a
 * reading of the source. One describe block below runs the REAL
 * `prisma migrate status` against temporary databases, because every other
 * test here depends on how Prisma words its output and a captured string
 * cannot notice that changing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEPLOY_ARGS,
  DEPLOY_COMMAND,
  STATUS_ARGS,
  isLocalFileDatabase,
  parsePendingMigrations,
  planMigrationCheck,
  runMigrationCheck,
} from "./check-migrations.mjs";

const SCRIPT = fileURLToPath(new URL("./check-migrations.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRISMA_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "prisma");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "prisma", "migrations");

/**
 * A runner that answers from a queue and records every call, standing in
 * for `spawnSync(prisma, ...)`.
 *
 * @param {Array<{status: number | null, output?: string, error?: Error}>} answers
 */
function recordingRunner(answers) {
  // Copied, not consumed in place: the BRANCHES table below is shared by two
  // describes, and shifting its arrays would empty them for the second.
  const queue = [...answers];
  /** @type {Array<{args: string[], inherit: boolean}>} */
  const calls = [];
  const run = (args, options = {}) => {
    calls.push({ args: [...args], inherit: options.inherit === true });
    const answer = queue.shift();
    if (!answer) {
      throw new Error(`unexpected extra prisma call: ${args.join(" ")}`);
    }
    return answer;
  };
  return { run, calls };
}

function collectingOut() {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const error = [];
  return { log: (m) => log.push(m), error: (m) => error.push(m), logged: log, errored: error };
}

// Verbatim from `prisma migrate status` on Prisma 7.10.0. The integration
// block at the bottom of this file re-derives the same two shapes from the
// installed Prisma rather than trusting these, so a reworded release shows
// up as a failure here instead of as a dev server that starts anyway.
const UP_TO_DATE_OUTPUT = `Loaded Prisma config from prisma7.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": SQLite database "dev.db" at "file:./dev.db"

17 migrations found in prisma/migrations

Database schema is up to date!
`;

const PENDING_OUTPUT = `Loaded Prisma config from prisma7.config.ts.

Prisma schema loaded from prisma/schema.prisma.
Datasource "db": SQLite database "dev.db" at "file:./dev.db"

17 migrations found in prisma/migrations
Following migrations have not yet been applied:
20261004180000_add_session_sign_in_identity
20261005120000_add_user_configured_handle
20261005120500_reconcile_configured_users

To apply migrations in development run prisma migrate dev.
To apply migrations in production run prisma migrate deploy.
`;

const PENDING_NAMES = [
  "20261004180000_add_session_sign_in_identity",
  "20261005120000_add_user_configured_handle",
  "20261005120500_reconcile_configured_users",
];

const pendingStatus = { code: 1, output: PENDING_OUTPUT };

describe("parsePendingMigrations", () => {
  it("reads the names under the heading and stops at the sentence after them", () => {
    expect(parsePendingMigrations(PENDING_OUTPUT)).toEqual(PENDING_NAMES);
  });

  it("finds nothing in an up-to-date report", () => {
    expect(parsePendingMigrations(UP_TO_DATE_OUTPUT)).toEqual([]);
  });

  it("finds nothing when the heading is worded differently", () => {
    // The fail-closed direction: an unrecognised report yields no names,
    // and no names is what `planMigrationCheck` refuses to start on.
    expect(
      parsePendingMigrations("Some migrations are outstanding:\n20261004180000_x\n"),
    ).toEqual([]);
  });

  it("finds nothing in empty, missing or non-string output", () => {
    expect(parsePendingMigrations("")).toEqual([]);
    expect(parsePendingMigrations(undefined)).toEqual([]);
    expect(parsePendingMigrations(null)).toEqual([]);
  });

  it("reads a report whose lines end in CRLF", () => {
    expect(parsePendingMigrations(PENDING_OUTPUT.replace(/\n/g, "\r\n"))).toEqual(
      PENDING_NAMES,
    );
  });
});

describe("isLocalFileDatabase", () => {
  it("treats an unset DATABASE_URL as the local file prisma7.config.ts falls back to", () => {
    expect(isLocalFileDatabase(undefined)).toBe(true);
  });

  it("accepts a file: URL whatever its case or leading whitespace", () => {
    expect(isLocalFileDatabase("file:./dev.db")).toBe(true);
    expect(isLocalFileDatabase("FILE:./dev.db")).toBe(true);
    expect(isLocalFileDatabase("  file:/var/lib/ugcportal.db")).toBe(true);
  });

  it("refuses anything reached over the network, and anything unparseable", () => {
    expect(isLocalFileDatabase("libsql://db.turso.io?authToken=secret")).toBe(false);
    expect(isLocalFileDatabase("postgresql://user:pw@host/db")).toBe(false);
    // Set-but-empty is NOT the fallback: prisma7.config.ts uses `??`, so
    // Prisma is handed "" and fails on it.
    expect(isLocalFileDatabase("")).toBe(false);
    expect(isLocalFileDatabase("   ")).toBe(false);
    expect(isLocalFileDatabase(42)).toBe(false);
    expect(isLocalFileDatabase(null)).toBe(false);
  });
});

describe("planMigrationCheck", () => {
  it("starts, silently and with no further command, when the database is up to date", () => {
    const plan = planMigrationCheck({
      databaseUrl: "file:./dev.db",
      status: { code: 0, output: UP_TO_DATE_OUTPUT },
    });
    expect(plan).toEqual({ action: "start", pending: [], commands: [], message: null });
  });

  it("applies pending migrations to a local file database", () => {
    const plan = planMigrationCheck({ databaseUrl: "file:./dev.db", status: pendingStatus });
    expect(plan.action).toBe("apply");
    expect(plan.pending).toEqual(PENDING_NAMES);
    expect(plan.commands).toEqual([DEPLOY_ARGS]);
    for (const name of PENDING_NAMES) {
      expect(plan.message).toContain(name);
    }
  });

  it("creates a local database that does not exist yet", () => {
    const plan = planMigrationCheck({
      databaseUrl: undefined,
      status: { code: 1, output: "Error: P1003: Database `dev.db` does not exist\n" },
    });
    expect(plan.action).toBe("apply");
    expect(plan.commands).toEqual([DEPLOY_ARGS]);
  });

  it("refuses, and writes nothing, when DATABASE_URL is not a local file", () => {
    const plan = planMigrationCheck({
      databaseUrl: "libsql://db.turso.io?authToken=hunter2",
      status: pendingStatus,
    });
    expect(plan.action).toBe("refuse");
    expect(plan.commands).toEqual([]);
    expect(plan.pending).toEqual(PENDING_NAMES);
    for (const name of PENDING_NAMES) {
      expect(plan.message).toContain(name);
    }
    expect(plan.message).toContain(DEPLOY_COMMAND);
    // The message is printed to a terminal and often pasted into an issue;
    // the URL it describes carries a credential.
    expect(plan.message).not.toContain("hunter2");
    expect(plan.message).not.toContain("db.turso.io");
  });

  it("refuses a remote database that does not exist, with no names to list", () => {
    const plan = planMigrationCheck({
      databaseUrl: "libsql://db.turso.io",
      status: { code: 1, output: "Error: P1003: Database `app.db` does not exist\n" },
    });
    expect(plan.action).toBe("refuse");
    expect(plan.commands).toEqual([]);
    expect(plan.message).toContain(DEPLOY_COMMAND);
  });

  it("refuses an unreadable database rather than guessing at a repair", () => {
    const output =
      "Error: SQLite database error\nfile is not a database in database.sqlite\n";
    const plan = planMigrationCheck({ databaseUrl: "file:./dev.db", status: { code: 1, output } });
    expect(plan.action).toBe("refuse");
    expect(plan.commands).toEqual([]);
    // Prisma's own diagnosis is the only thing anyone can act on here.
    expect(plan.message).toContain("file is not a database");
  });

  it("keeps the datasource URL out of the prisma output it echoes", () => {
    const databaseUrl = "libsql://db.turso.io?authToken=hunter2";
    const plan = planMigrationCheck({
      databaseUrl,
      status: {
        code: 1,
        output: `Datasource "db": database at "${databaseUrl}"\nError: P1013: invalid\n`,
      },
    });
    expect(plan.action).toBe("refuse");
    expect(plan.message).not.toContain("hunter2");
    expect(plan.message).toContain("P1013");
  });

  it("refuses, rather than throwing, for a DATABASE_URL that is not a string", () => {
    // `main()` cannot produce these — `process.env` is string-valued — but
    // `isLocalFileDatabase` and `redactDatasource` both guard the same
    // argument, and an unguarded third reader is the sibling-omission shape.
    for (const databaseUrl of [null, 42, {}, [], true]) {
      for (const output of [PENDING_OUTPUT, "Error: P1003: Database `x` does not exist"]) {
        const plan = planMigrationCheck({ databaseUrl, status: { code: 1, output } });
        expect(plan.action).toBe("refuse");
        expect(plan.commands).toEqual([]);
        expect(plan.message).toContain(DEPLOY_COMMAND);
      }
    }
  });

  it("refuses a failed status with no output at all", () => {
    const plan = planMigrationCheck({
      databaseUrl: "file:./dev.db",
      status: { code: null, output: "" },
    });
    expect(plan.action).toBe("refuse");
    expect(plan.commands).toEqual([]);
  });
});

describe("runMigrationCheck", () => {
  it("asks prisma exactly once, and says nothing, when nothing is pending", () => {
    const { run, calls } = recordingRunner([{ status: 0, output: UP_TO_DATE_OUTPUT }]);
    const out = collectingOut();
    expect(runMigrationCheck({ run, databaseUrl: "file:./dev.db", out })).toBe(0);
    expect(calls).toEqual([{ args: [...STATUS_ARGS], inherit: false }]);
    expect(out.logged).toEqual([]);
    expect(out.errored).toEqual([]);
  });

  it("deploys after status when migrations are pending locally", () => {
    const { run, calls } = recordingRunner([
      { status: 1, output: PENDING_OUTPUT },
      { status: 0 },
    ]);
    const out = collectingOut();
    expect(runMigrationCheck({ run, databaseUrl: "file:./dev.db", out })).toBe(0);
    expect(calls.map((c) => c.args)).toEqual([[...STATUS_ARGS], [...DEPLOY_ARGS]]);
    expect(out.errored).toEqual([]);
    expect(out.logged.join("\n")).toContain(PENDING_NAMES[0]);
  });

  it("propagates a failed deploy as a non-zero exit instead of starting anyway", () => {
    const { run, calls } = recordingRunner([
      { status: 1, output: PENDING_OUTPUT },
      { status: 3 },
    ]);
    const out = collectingOut();
    expect(runMigrationCheck({ run, databaseUrl: "file:./dev.db", out })).toBe(3);
    expect(calls).toHaveLength(2);
    expect(out.errored.join("\n")).toContain("still behind prisma/migrations");
  });

  it("exits non-zero when a deploy is killed by a signal and reports no code", () => {
    const { run } = recordingRunner([
      { status: 1, output: PENDING_OUTPUT },
      { status: null },
    ]);
    expect(runMigrationCheck({ run, databaseUrl: "file:./dev.db", out: collectingOut() })).toBe(1);
  });

  it("exits non-zero, with one command issued, when prisma cannot be started", () => {
    const { run, calls } = recordingRunner([{ status: null, error: new Error("ENOENT") }]);
    const out = collectingOut();
    expect(runMigrationCheck({ run, databaseUrl: "file:./dev.db", out })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(out.errored.join("\n")).toContain("ENOENT");
  });

  it("exits non-zero when the deploy itself cannot be started", () => {
    const { run } = recordingRunner([
      { status: 1, output: PENDING_OUTPUT },
      { status: null, error: new Error("EACCES") },
    ]);
    const out = collectingOut();
    expect(runMigrationCheck({ run, databaseUrl: "file:./dev.db", out })).toBe(1);
    expect(out.errored.join("\n")).toContain("EACCES");
  });

  it("refuses a remote database with instructions, having run only status", () => {
    const { run, calls } = recordingRunner([{ status: 1, output: PENDING_OUTPUT }]);
    const out = collectingOut();
    expect(
      runMigrationCheck({ run, databaseUrl: "libsql://db.turso.io", out }),
    ).toBe(1);
    expect(calls).toEqual([{ args: [...STATUS_ARGS], inherit: false }]);
    expect(out.errored.join("\n")).toContain(DEPLOY_COMMAND);
  });
});

/**
 * EVERY branch of the runner: the answers that reach it, and what it does.
 *
 * Shared by the two describes below so there is one list rather than two
 * that drift. A branch added later without a row here leaves both of them
 * describing less than they claim to.
 *
 * `exit` is the code `npm run dev` takes, `silent` whether the branch
 * writes nothing at all, and `namesCommand` whether its message tells the
 * reader to run `npx prisma migrate deploy` — which the branches that
 * `migrate deploy` cannot fix deliberately do not.
 */
const BRANCHES = [
  {
    name: "up to date, local",
    databaseUrl: "file:./dev.db",
    answers: [{ status: 0, output: UP_TO_DATE_OUTPUT }],
    exit: 0,
    silent: true,
    namesCommand: false,
  },
  {
    name: "up to date, remote",
    databaseUrl: "libsql://db.turso.io",
    answers: [{ status: 0, output: UP_TO_DATE_OUTPUT }],
    exit: 0,
    silent: true,
    namesCommand: false,
  },
  {
    name: "pending, local",
    databaseUrl: "file:./dev.db",
    answers: [{ status: 1, output: PENDING_OUTPUT }, { status: 0 }],
    exit: 0,
    silent: false,
    namesCommand: false,
  },
  {
    name: "pending, local, deploy fails",
    databaseUrl: "file:./dev.db",
    answers: [{ status: 1, output: PENDING_OUTPUT }, { status: 3 }],
    exit: 3,
    silent: false,
    namesCommand: true,
  },
  {
    name: "pending, local, deploy killed by a signal",
    databaseUrl: "file:./dev.db",
    answers: [{ status: 1, output: PENDING_OUTPUT }, { status: null }],
    exit: 1,
    silent: false,
    namesCommand: true,
  },
  {
    name: "pending, local, deploy cannot be started",
    databaseUrl: "file:./dev.db",
    answers: [
      { status: 1, output: PENDING_OUTPUT },
      { status: null, error: new Error("EACCES") },
    ],
    exit: 1,
    silent: false,
    namesCommand: true,
  },
  {
    name: "database missing, local",
    databaseUrl: undefined,
    answers: [
      { status: 1, output: "Error: P1003: Database `dev.db` does not exist" },
      { status: 0 },
    ],
    exit: 0,
    silent: false,
    namesCommand: false,
  },
  {
    name: "pending, remote",
    databaseUrl: "libsql://db.turso.io",
    answers: [{ status: 1, output: PENDING_OUTPUT }],
    exit: 1,
    silent: false,
    namesCommand: true,
  },
  {
    name: "database missing, remote",
    databaseUrl: "libsql://db.turso.io",
    answers: [{ status: 1, output: "Error: P1003: Database `app.db` does not exist" }],
    exit: 1,
    silent: false,
    namesCommand: true,
  },
  {
    name: "unreadable database",
    databaseUrl: "file:./dev.db",
    answers: [{ status: 1, output: "Error: SQLite database error\nfile is not a database" }],
    exit: 1,
    silent: false,
    // `migrate deploy` is not the answer to drift or a corrupt file, so the
    // message hands over Prisma's own output instead of a command.
    namesCommand: false,
  },
  {
    name: "status cannot be run",
    databaseUrl: "file:./dev.db",
    answers: [{ status: null, error: new Error("ENOENT") }],
    exit: 1,
    silent: false,
    namesCommand: false,
  },
];

describe("every branch, by exit code and message", () => {
  it.each(BRANCHES)(
    "$name exits $exit (silent: $silent, names the command: $namesCommand)",
    ({ answers, databaseUrl, exit, silent, namesCommand }) => {
      const { run } = recordingRunner(answers);
      const out = collectingOut();
      expect(runMigrationCheck({ run, databaseUrl, out })).toBe(exit);
      const printed = [...out.logged, ...out.errored];
      expect(printed.length === 0).toBe(silent);
      expect(printed.join("\n").includes(DEPLOY_COMMAND)).toBe(namesCommand);
    },
  );
});

describe("K3: nothing this script runs can drop data", () => {
  it.each(BRANCHES)("$name issues only migrate status / migrate deploy", ({ answers, databaseUrl }) => {
    const { run, calls } = recordingRunner(answers);
    runMigrationCheck({ run, databaseUrl, out: collectingOut() });
    expect(calls.length).toBeGreaterThan(0);
    for (const { args } of calls) {
      expect([[...STATUS_ARGS], [...DEPLOY_ARGS]]).toContainEqual(args);
    }
  });

  it("never auto-applies to a database that is not a local file", () => {
    for (const databaseUrl of [
      "libsql://db.turso.io?authToken=x",
      "postgresql://user:pw@host/db",
      "",
      "   ",
    ]) {
      const { run, calls } = recordingRunner([{ status: 1, output: PENDING_OUTPUT }]);
      expect(runMigrationCheck({ run, databaseUrl, out: collectingOut() })).toBe(1);
      expect(calls.map((c) => c.args)).toEqual([[...STATUS_ARGS]]);
    }
  });

  it("names no destructive prisma subcommand anywhere in the script's code", () => {
    // Comments are stripped first: the file's header names `migrate reset`
    // and `db push` in order to say they are never run, so a search over
    // the whole file would match its own documentation. Stripping too much
    // would weaken this, so the result is checked for the code that has to
    // survive it.
    const code = fs
      .readFileSync(SCRIPT, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("export function runMigrationCheck");
    expect(code).toContain("spawnSync");
    // Then string and template literals only, because that is the only
    // shape an argument handed to prisma can have. `Array#push` is a
    // method call, not a command, and would otherwise match.
    const literals = code.match(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g) ?? [];
    expect(literals).toContain('"migrate"');
    expect(
      literals.filter((l) => /reset|db push|drop|execute|truncate/i.test(l)),
    ).toEqual([]);
  });
});

/**
 * The fixtures above are strings somebody typed. These are the installed
 * Prisma's own answers, so a release that rewords `migrate status` fails
 * here rather than silently turning every report into the refuse branch.
 */
describe("against the installed Prisma", () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let dbPath;

  const prisma = (args, extraEnv = {}) => {
    const result = spawnSync(PRISMA_BIN, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: `file:${dbPath}`, ...extraEnv },
    });
    return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugcportal-migrations-"));
    dbPath = path.join(dir, "probe.db");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a database that does not exist as work to do", () => {
    expect(fs.existsSync(dbPath)).toBe(false);
    const status = prisma(["migrate", "status"]);
    expect(status.code).not.toBe(0);
    const plan = planMigrationCheck({ databaseUrl: `file:${dbPath}`, status });
    expect(plan.action).toBe("apply");
  }, 60_000);

  it("reports a freshly deployed database as up to date", () => {
    const deploy = prisma(["migrate", "deploy"]);
    expect(deploy.code).toBe(0);
    const status = prisma(["migrate", "status"]);
    expect(status.code).toBe(0);
    expect(planMigrationCheck({ databaseUrl: `file:${dbPath}`, status }).action).toBe("start");
  }, 120_000);

  it("reports migrations removed from the history as pending, by name", () => {
    const applied = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const removed = applied.slice(-3);
    // Prisma's own client, so this needs no sqlite3 on the machine running
    // the suite. It is a write, which `db execute` is documented to be for.
    execFileSync(
      PRISMA_BIN,
      ["db", "execute", "--stdin"],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
        stdio: ["pipe", "pipe", "pipe"],
        input: `DELETE FROM _prisma_migrations WHERE migration_name IN (${removed
          .map((name) => `'${name}'`)
          .join(", ")});`,
      },
    );

    const status = prisma(["migrate", "status"]);
    expect(status.code).not.toBe(0);
    expect(parsePendingMigrations(status.output)).toEqual(removed);
    const plan = planMigrationCheck({ databaseUrl: `file:${dbPath}`, status });
    expect(plan.action).toBe("apply");
    expect(plan.pending).toEqual(removed);
  }, 120_000);
});
