#!/usr/bin/env node
/**
 * Bring the local database up to date, or refuse to start the dev server
 * (ugcportal-w7wc).
 *
 * WHY THIS EXISTS: the generated Prisma client selects every scalar column
 * the schema declares, so a single column a migration has not added yet
 * fails every query on that table. Pulling `main` on 2026-10-05 produced
 * exactly that: `getSessionAndUser` failing on `Session.signInProvider` for
 * every request and the Google callback failing on `User.configuredHandle`,
 * i.e. a site that renders signed out on every page and answers every
 * sign-in with "Sign in misconfigured". It still answered 200 throughout,
 * because the degrade-to-signed-out of ugcportal-8df3 keeps the page up
 * while the session read underneath it fails — so nothing about the symptom
 * points at the database.
 *
 * Wired as the first half of package.json's `dev` script, ahead of the `&&`,
 * so a non-zero exit here means `next dev` never starts. Not npm's `predev`
 * hook, which reaches the same place through one more npm process.
 *
 * WHAT IT IS ALLOWED TO RUN: `prisma migrate status`, and for a local
 * `file:` datasource `prisma migrate deploy`. Those two and nothing else —
 * this runs unattended against whatever working database a developer has in
 * front of them, so a command that can drop a table or a row has no place
 * in it. A datasource that is not a local `file:` URL is never written to:
 * the deploy branch sits behind `isLocalFileDatabase` below.
 * scripts/check-migrations.test.mjs asserts the command list for every
 * branch, that no branch deploys to a non-`file:` URL, and — in "every
 * branch, by exit code and message" — what each branch exits with and
 * whether it names a command. Not every branch does both: the up-to-date
 * branch is silent and exits 0, and the two branches that cannot be fixed
 * by `migrate deploy` (prisma unspawnable, and a status failure that is not
 * pending work) exit non-zero without naming it.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

/** Prefix on every line this script prints, matching scripts/with-local-ca.mjs. */
const PREFIX = "[migrations]";

/** The only two prisma invocations any branch of this script may make. */
export const STATUS_ARGS = Object.freeze(["migrate", "status"]);
export const DEPLOY_ARGS = Object.freeze(["migrate", "deploy"]);

/** What a human is told to run when this script declines to run it for them. */
export const DEPLOY_COMMAND = "npx prisma migrate deploy";

/**
 * Prisma's error code for "the datasource names a database that is not
 * there". `migrate deploy` creates a SQLite file and applies everything
 * from scratch in that case, so for a local file this is a has-pending-work
 * branch rather than a failure.
 */
const DATABASE_DOES_NOT_EXIST = "P1003";

/**
 * A migration directory name as `prisma migrate status` lists it. Used to
 * decide where the list of pending names ends, so a trailing sentence
 * ("To apply migrations in development run prisma migrate dev.") is not
 * collected as if it were one.
 */
const MIGRATION_NAME = /^\d{14}_\w+$/;

/**
 * The migration names `prisma migrate status` reported as unapplied.
 *
 * Empty for any output that does not contain the heading — including an
 * up-to-date database, a failure that never got as far as comparing, and a
 * missing/undefined output. Every caller treats "no names" as "do not
 * touch the database", so the lossy direction here is the safe one.
 *
 * @param {string | undefined | null} output combined stdout+stderr
 * @returns {string[]}
 */
export function parsePendingMigrations(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  const heading = lines.findIndex((line) =>
    /have not yet been applied/i.test(line),
  );
  if (heading === -1) {
    return [];
  }
  const pending = [];
  for (const line of lines.slice(heading + 1)) {
    const name = line.trim();
    if (!MIGRATION_NAME.test(name)) {
      break;
    }
    pending.push(name);
  }
  return pending;
}

/**
 * Whether `DATABASE_URL` names a SQLite file on this machine, which is the
 * only shape this script will write to on its own.
 *
 * `undefined` is the local case because that is the one value
 * prisma7.config.ts replaces with its own `file:./dev.db` default — it uses
 * `??`, so a set-but-empty DATABASE_URL is a configured value Prisma will
 * fail on rather than a fallback to the local file, and it answers false
 * here for the same reason.
 *
 * @param {string | undefined} databaseUrl
 * @returns {boolean}
 */
export function isLocalFileDatabase(databaseUrl) {
  if (databaseUrl === undefined) {
    return true;
  }
  if (typeof databaseUrl !== "string") {
    return false;
  }
  return databaseUrl.trimStart().toLowerCase().startsWith("file:");
}

/**
 * The scheme of a datasource URL, for a message that must not echo the URL
 * itself — a libsql or Postgres URL carries credentials.
 *
 * @param {string | undefined} databaseUrl
 * @returns {string}
 */
function describeDatasource(databaseUrl) {
  if (databaseUrl === undefined) {
    return "the default local database";
  }
  // The same `typeof` guard `isLocalFileDatabase` and `redactDatasource`
  // carry, because the three read the same argument and only two of them
  // had it. `main()` cannot reach this (`process.env` is string-valued), so
  // this is symmetry rather than a live fix.
  if (typeof databaseUrl !== "string") {
    return "DATABASE_URL";
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(databaseUrl.trimStart());
  return scheme ? `the \`${scheme[1].toLowerCase()}:\` database` : "DATABASE_URL";
}

/** @param {string[]} pending */
function listPending(pending) {
  return pending.map((name) => `  ${name}`).join("\n");
}

/**
 * Prisma's own output with the datasource URL taken out of it, because the
 * refuse branch prints that output verbatim and Prisma names the datasource
 * it opened ("SQLite database \"dev.db\" at \"file:./dev.db\"") — which for
 * a libsql or Postgres URL is a string with a credential in it.
 *
 * Removes the URL as DATABASE_URL gave it. A form Prisma re-encoded on the
 * way out would not match, so this is a reason not to paste the output
 * around rather than a promise that there is nothing in it.
 *
 * @param {string} output
 * @param {string | undefined} databaseUrl
 */
function redactDatasource(output, databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    return output;
  }
  return output.split(databaseUrl).join("[DATABASE_URL]");
}

/**
 * What to do about the result of `prisma migrate status`.
 *
 * @param {object} options
 * @param {string | undefined} options.databaseUrl
 * @param {{code: number | null, output: string}} options.status
 * @returns {{
 *   action: "start" | "apply" | "refuse",
 *   pending: string[],
 *   commands: readonly (readonly string[])[],
 *   message: string | null,
 * }} `commands` is every further prisma invocation this branch makes.
 */
export function planMigrationCheck({ databaseUrl, status }) {
  if (status.code === 0) {
    return { action: "start", pending: [], commands: [], message: null };
  }

  const output = String(status.output ?? "");
  const pending = parsePendingMigrations(output);
  const databaseMissing = output.includes(DATABASE_DOES_NOT_EXIST);

  if (pending.length === 0 && !databaseMissing) {
    // Drift, a migration that failed half way, an unreadable file, a
    // datasource that cannot be reached: `migrate deploy` is not the answer
    // to any of them, and guessing which one this is would be guessing with
    // somebody's database. Hand the output over and stop.
    return {
      action: "refuse",
      pending,
      commands: [],
      message:
        `${PREFIX} \`prisma migrate status\` failed and reported no pending ` +
        "migrations, so nothing was applied and the dev server was not " +
        "started. Its output was:\n" +
        redactDatasource(output.trimEnd(), databaseUrl),
    };
  }

  if (!isLocalFileDatabase(databaseUrl)) {
    const what = databaseMissing
      ? "does not exist"
      : `is behind prisma/migrations by ${pending.length} migration(s)`;
    return {
      action: "refuse",
      pending,
      commands: [],
      message:
        `${PREFIX} ${describeDatasource(databaseUrl)} ${what}.` +
        (pending.length > 0 ? `\n${listPending(pending)}` : "") +
        `\nNothing was applied: DATABASE_URL is not a local \`file:\` ` +
        `database, and this check only ever writes to one. Run ` +
        `\`${DEPLOY_COMMAND}\` yourself, then start the dev server again.`,
    };
  }

  return {
    action: "apply",
    pending,
    commands: [DEPLOY_ARGS],
    message: databaseMissing
      ? `${PREFIX} the local database does not exist yet; creating it before starting the dev server.`
      : `${PREFIX} applying ${pending.length} pending migration(s) before starting the dev server:\n${listPending(pending)}`,
  };
}

/**
 * Run the check and report the exit code `npm run dev` should take.
 *
 * Takes its command runner rather than reaching for `spawnSync` itself, so
 * the branches — including the one where `migrate deploy` fails — are
 * driven in scripts/check-migrations.test.mjs against a runner that records
 * what it was asked to run.
 *
 * @param {object} options
 * @param {(args: readonly string[], options?: {inherit?: boolean}) => {
 *   status: number | null, output?: string, error?: Error,
 * }} options.run
 * @param {string | undefined} options.databaseUrl
 * @param {{log: (message: string) => void, error: (message: string) => void}} options.out
 * @returns {number}
 */
export function runMigrationCheck({ run, databaseUrl, out }) {
  const status = run(STATUS_ARGS);
  if (status.error) {
    out.error(
      `${PREFIX} could not run \`prisma migrate status\`: ${status.error.message}`,
    );
    return 1;
  }

  const plan = planMigrationCheck({
    databaseUrl,
    status: { code: status.status, output: status.output ?? "" },
  });

  if (plan.action === "start") {
    // Silent, like scripts/with-local-ca.mjs's no-proxy path: the ordinary
    // case prints nothing and the dev server's own first line stays first.
    return 0;
  }
  if (plan.action === "refuse") {
    out.error(/** @type {string} */ (plan.message));
    return 1;
  }

  out.log(/** @type {string} */ (plan.message));
  const deploy = run(DEPLOY_ARGS, { inherit: true });
  if (deploy.error) {
    out.error(
      `${PREFIX} could not run \`${DEPLOY_COMMAND}\`: ${deploy.error.message}`,
    );
    return 1;
  }
  if (deploy.status !== 0) {
    // A failed deploy leaves the database in exactly the state this check
    // exists to refuse to start against, so it has to end the run. `?? 1`
    // covers a deploy killed by a signal, where `status` is null.
    out.error(
      `${PREFIX} \`${DEPLOY_COMMAND}\` failed, so the dev server was not ` +
        "started. The database is still behind prisma/migrations.",
    );
    return deploy.status ?? 1;
  }
  return 0;
}

/* c8 ignore start -- process wiring, exercised by `npm run dev` itself */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PRISMA_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "prisma");

function main() {
  const exitCode = runMigrationCheck({
    databaseUrl: process.env.DATABASE_URL,
    out: {
      log: (message) => console.log(message),
      error: (message) => console.error(message),
    },
    run: (args, { inherit = false } = {}) => {
      const result = spawnSync(PRISMA_BIN, [...args], {
        cwd: REPO_ROOT,
        env: process.env,
        encoding: "utf8",
        stdio: inherit ? "inherit" : "pipe",
        // Windows needs a shell to resolve the .cmd shim in node_modules/.bin;
        // POSIX must not use one. Same reasoning as scripts/with-local-ca.mjs,
        // and there is no caller-supplied argument here to pass through it.
        shell: process.platform === "win32",
      });
      return {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
        error: result.error,
      };
    },
  });
  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) main();
/* c8 ignore stop */
