#!/usr/bin/env node
/**
 * Publish every unpublished upload in the LOCAL database (ugcportal-x8sx).
 *
 * WHY THIS EXISTS: an upload lands with `publishedAt` NULL on purpose, the
 * gallery lists published items only, and the only way to publish is
 * `POST /api/media/<id>/publish` -- the owner library / curation screen that
 * would carry a publish button is deferred (ugcportal-1wz, ugcportal-74w).
 * So a developer who uploads a test photograph sees nothing happen, and the
 * alternative to this script is one hand-written curl per id, cookie and all.
 *
 * HOW IT PUBLISHES -- through the real endpoint, never the database. Each
 * unpublished row is POSTed to the running dev server with a session cookie
 * belonging to that row's owner, read from the local Session table. That is
 * what keeps every gate the route applies (alt text, advertising label,
 * alcohol facts, watermarked preview, ownership) applied here too, without a
 * second copy of any of them in this file; the database is opened read-only
 * and only ever READ (media ids and owners, session tokens).
 *
 * LOCAL ONLY, by two independent refusals in `preflight` below: DATABASE_URL
 * must be a local `file:` URL (the same rule scripts/check-migrations.mjs
 * applies before it will run `migrate deploy`), and the dev server's base URL
 * must have a loopback hostname. A session token read from one database is
 * worthless against a server using another, so the second check is mostly
 * about not sending that token anywhere surprising.
 *
 * Usage:
 *   npm run dev:publish-all                  # publish everything unpublished
 *   npm run dev:publish-all -- --dry-run     # list what would be published
 *   npm run dev:publish-all -- --base-url http://localhost:3000
 *
 * The base URL defaults to AUTH_URL from the `.env*` chain `next dev` reads
 * (via scripts/lib/env-files.mjs), then to http://localhost:3000. The dev
 * server has to be running: this script is a client of it, not a replacement.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { isLocalFileDatabase } from "./check-migrations.mjs";
import { loadDevEnvFiles } from "./lib/env-files.mjs";
import { isMainModule } from "./lib/is-main.mjs";

const PREFIX = "[publish-all-dev]";
export const DEFAULT_BASE_URL = "http://localhost:3000";
export const DEFAULT_DATABASE_URL = "file:./dev.db";

/**
 * Parses argv. Unknown flags are an error rather than ignored, so a typo like
 * `--dry` does not silently publish.
 * @param {string[]} argv
 * @returns {{ ok: true, dryRun: boolean, baseUrl: string | undefined } | { ok: false, error: string }}
 */
export function parseArgs(argv) {
  let dryRun = false;
  let baseUrl;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--base-url") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: "--base-url needs a value" };
      }
      baseUrl = value;
      i += 1;
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
    } else {
      return { ok: false, error: `unknown argument: ${arg}` };
    }
  }
  return { ok: true, dryRun, baseUrl };
}

/**
 * The on-disk path behind a `file:` DATABASE_URL. Relative paths resolve
 * against `cwd`: the app's own default is `file:./dev.db` (src/lib/prisma.ts)
 * and dev.db sits at the repo root, where `next dev` runs, so resolving the
 * same string against the same directory opens the same file.
 * @param {string | undefined} databaseUrl
 * @param {string} cwd
 * @returns {string}
 */
export function sqlitePathFromDatabaseUrl(databaseUrl, cwd) {
  const url = databaseUrl === undefined ? DEFAULT_DATABASE_URL : databaseUrl;
  const rest = url.trimStart().replace(/^file:/i, "");
  const withoutQuery = rest.split("?")[0];
  const stripped = withoutQuery.startsWith("//") ? withoutQuery.slice(2) : withoutQuery;
  return path.resolve(cwd, stripped);
}

/**
 * Loopback hostnames as the WHATWG URL parser spells them -- `[::1]` keeps its
 * brackets in `URL#hostname`.
 * @param {string} hostname
 */
export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Auth.js's database-session cookie name for the given origin: it prefixes
 * `__Secure-` whenever it sets secure cookies, which it does for https
 * (see @auth/core/lib/utils/cookie.js `defaultCookies`).
 * @param {URL} baseUrl
 */
export function sessionCookieName(baseUrl) {
  return baseUrl.protocol === "https:"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

/**
 * The two refusals that make this local-only. Both are checked before the
 * database is opened or any request is made.
 * @param {{ databaseUrl: string | undefined, baseUrl: string }} input
 * @returns {{ ok: true, baseUrl: URL } | { ok: false, error: string }}
 */
export function preflight({ databaseUrl, baseUrl }) {
  if (!isLocalFileDatabase(databaseUrl)) {
    return {
      ok: false,
      error:
        "DATABASE_URL is not a local `file:` database; this script only ever runs against one.",
    };
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: `base URL is not a valid URL: ${baseUrl}` };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      error: `base URL host must be loopback (localhost, 127.0.0.1 or [::1]), got ${parsed.hostname}`,
    };
  }
  return { ok: true, baseUrl: parsed };
}

/**
 * Reads what the plan needs and nothing else. Read-only open: this file never
 * writes to the database, and the flag makes that a property of the
 * connection rather than of the SQL below.
 * @param {string} dbPath
 * @returns {{ unpublished: Array<{ id: string, userId: string }>, sessions: Array<{ userId: string, sessionToken: string, expires: string }> }}
 */
export function readPublishInputs(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const unpublished = db
      .prepare(
        'SELECT "id", "userId" FROM "Media" WHERE "publishedAt" IS NULL ORDER BY "createdAt"',
      )
      .all();
    const sessions = db
      .prepare('SELECT "userId", "sessionToken", "expires" FROM "Session"')
      .all();
    return { unpublished, sessions };
  } finally {
    db.close();
  }
}

/**
 * Pairs each unpublished row with an unexpired session of ITS OWNER -- the
 * route checks ownership (requireOwnedMedia answers 403 otherwise), so a
 * session for some other signed-in user would only turn into a refusal one
 * round trip later. Rows whose owner has no live session are reported as
 * skipped, with the reason, rather than dropped.
 * @param {{ unpublished: Array<{ id: string, userId: string }>, sessions: Array<{ userId: string, sessionToken: string, expires: string }>, now: Date }} input
 */
export function planPublishes({ unpublished, sessions, now }) {
  const liveByUser = new Map();
  for (const session of sessions) {
    const expires = new Date(session.expires);
    if (Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime()) {
      continue;
    }
    const current = liveByUser.get(session.userId);
    if (!current || new Date(current.expires).getTime() < expires.getTime()) {
      liveByUser.set(session.userId, session);
    }
  }
  const publish = [];
  const skipped = [];
  for (const row of unpublished) {
    const session = liveByUser.get(row.userId);
    if (!session) {
      skipped.push({
        id: row.id,
        reason: `owner ${row.userId} has no unexpired session; sign in to the dev server as that user first`,
      });
      continue;
    }
    publish.push({ id: row.id, userId: row.userId, sessionToken: session.sessionToken });
  }
  return { publish, skipped };
}

/**
 * One POST per planned row, sequentially, so the per-row report reads in the
 * same order the rows were queued. In dry-run mode `fetch` is never called.
 * @param {{ publish: Array<{ id: string, sessionToken: string }>, baseUrl: URL, cookieName: string, fetch: typeof globalThis.fetch, dryRun: boolean }} input
 * @returns {Promise<Array<{ id: string, ok: boolean, status: number | null, detail: string }>>}
 */
export async function publishAll({ publish, baseUrl, cookieName, fetch, dryRun }) {
  const results = [];
  for (const item of publish) {
    if (dryRun) {
      results.push({ id: item.id, ok: true, status: null, detail: "would publish" });
      continue;
    }
    const target = new URL(`/api/media/${encodeURIComponent(item.id)}/publish`, baseUrl);
    let response;
    try {
      response = await fetch(target, {
        method: "POST",
        headers: { cookie: `${cookieName}=${item.sessionToken}` },
      });
    } catch (error) {
      results.push({
        id: item.id,
        ok: false,
        status: null,
        detail: `request failed (${error instanceof Error ? error.message : String(error)}) -- is the dev server running at ${baseUrl.origin}?`,
      });
      continue;
    }
    let detail = response.ok ? "published" : `HTTP ${response.status}`;
    if (!response.ok) {
      try {
        const body = await response.json();
        if (body && typeof body.error === "string") detail = `HTTP ${response.status}: ${body.error}`;
      } catch {
        // No JSON body; the status alone is the detail.
      }
    }
    results.push({ id: item.id, ok: response.ok, status: response.status, detail });
  }
  return results;
}

/**
 * Exit code and report lines. Anything not published -- a refused POST, a
 * row with no session -- makes the exit code non-zero, so a shell `&&` after
 * this command cannot proceed on a partial result.
 * @param {{ results: Array<{ id: string, ok: boolean, detail: string }>, skipped: Array<{ id: string, reason: string }>, dryRun: boolean }} input
 */
export function summarize({ results, skipped, dryRun }) {
  const lines = [];
  for (const result of results) {
    lines.push(`${result.ok ? "ok  " : "FAIL"} ${result.id}: ${result.detail}`);
  }
  for (const skip of skipped) {
    lines.push(`skip ${skip.id}: ${skip.reason}`);
  }
  const published = results.filter((result) => result.ok).length;
  const failed = results.length - published;
  const verb = dryRun ? "would publish" : "published";
  lines.push(
    `${verb} ${published}, failed ${failed}, skipped ${skipped.length}` +
      (results.length + skipped.length === 0 ? " (nothing is unpublished)" : ""),
  );
  return { lines, exitCode: failed + skipped.length > 0 ? 1 : 0 };
}

export async function main({ argv = process.argv.slice(2), cwd = process.cwd(), env = process.env, fetch = globalThis.fetch, log = console.log, error = console.error, now = new Date() } = {}) {
  const args = parseArgs(argv);
  if (!args.ok) {
    error(`${PREFIX} ${args.error}`);
    return 2;
  }
  const flight = preflight({
    databaseUrl: env.DATABASE_URL,
    baseUrl: args.baseUrl ?? env.AUTH_URL ?? DEFAULT_BASE_URL,
  });
  if (!flight.ok) {
    error(`${PREFIX} ${flight.error}`);
    return 2;
  }
  const dbPath = sqlitePathFromDatabaseUrl(env.DATABASE_URL, cwd);
  let inputs;
  try {
    inputs = readPublishInputs(dbPath);
  } catch (cause) {
    error(`${PREFIX} could not read ${dbPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 2;
  }
  const { publish, skipped } = planPublishes({ ...inputs, now });
  const results = await publishAll({
    publish,
    baseUrl: flight.baseUrl,
    cookieName: sessionCookieName(flight.baseUrl),
    fetch,
    dryRun: args.dryRun,
  });
  const { lines, exitCode } = summarize({ results, skipped, dryRun: args.dryRun });
  for (const line of lines) log(`${PREFIX} ${line}`);
  return exitCode;
}

if (isMainModule(import.meta.url)) {
  loadDevEnvFiles({ cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))) });
  main().then((code) => {
    process.exitCode = code;
  });
}
