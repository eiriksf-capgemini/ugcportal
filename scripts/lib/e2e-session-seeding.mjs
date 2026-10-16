/**
 * Seed a signed-in session for the Playwright suite (ugcportal-0wh6).
 *
 * HOW IT WORKS. src/lib/auth.ts runs Auth.js with the Prisma adapter and the
 * `"database"` session strategy, so a session is nothing more than a `Session`
 * row plus a cookie carrying that row's `sessionToken`. This module writes a
 * throwaway `User` and `Session` straight into the local SQLite file the dev
 * server reads, and hands back the cookie. The root suite calls it once per
 * run from its globalSetup (e2e/signed-in-setup.ts), and
 * e2e/signed-in-fixture.ts puts that cookie into the browser context of each
 * test that asks to be signed in. The server then resolves it through its ordinary `auth()` path —
 * the same adapter lookup and the same per-request policy check
 * (`enforceLiveSessionPolicy`, src/lib/live-session.ts) every real session
 * goes through. Nothing is skipped on the server side, and nothing is added
 * to it.
 *
 * WHY NOT A SEEDING ROUTE. A route under src/app/api would be application
 * code: compiled into every build, guarded only by whatever condition someone
 * remembered to put in front of it. This mechanism has no HTTP surface at
 * all. It lives outside src/, which is the tree `next build` compiles, and
 * minting a session with it needs write access to the database file — which
 * already confers everything a session would. The vitest guard beside this
 * file (e2e-session-seeding.test.mjs) asserts both halves of that: that no
 * module under src/ imports this file or anything under e2e/, and that the
 * seeding call itself refuses, before it writes anything, whenever it is
 * pointed somewhere that is not a local development setup.
 *
 * THE IDENTITY. The live-session check re-judges every request against
 * ALLOWED_SIGNIN_EMAILS, using the address recorded on the session row
 * (`signInEmail`). The seeded row records E2E_SIGNED_IN_EMAIL, and the root
 * playwright.config.ts sets the ALLOWED_SIGNIN_EMAILS of the dev server it
 * starts to exactly that address. A server it did not start (UGCPORTAL_E2E_REUSE_SERVER=1)
 * will not have it, and refuses the seeded session: the signed-in specs then
 * fail on a signed-out page rather than passing on one.
 *
 * A plain .mjs file, not TypeScript under e2e/, for the reason
 * e2e/seeded/alcohol-commerce.spec.ts gives for its own raw SQL: Playwright
 * loads specs through a CJS transform that cannot import the generated
 * Prisma client, and vitest excludes e2e/** — so the one module both runners
 * can import is here, next to scripts/lib/env-files.mjs, which the seeded
 * specs already share the same way.
 */
import { randomBytes, randomUUID } from "node:crypto";

/** The address the seeded session records as its sign-in identity. A
 * reserved `.test` domain (RFC 2606), so it is not a real mailbox. */
export const E2E_SIGNED_IN_EMAIL = "e2e-signed-in@example.test";

/** Every row this module writes carries this id prefix, and cleanup only
 * ever deletes by the ids it generated itself. */
export const E2E_SESSION_ID_PREFIX = "e2e-0wh6-";

/** Auth.js's session cookie name over plain http. Over https it is
 * `__Secure-authjs.session-token`; the guard below only permits an http
 * loopback base URL, so this is the one name that can apply. */
export const E2E_SESSION_COOKIE = "authjs.session-token";

/** Auth.js's default session `maxAge`, 30 days. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** src/lib/prisma.ts's own fallback when DATABASE_URL is unset. */
const DEFAULT_DATABASE_URL = "file:./dev.db";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Throw unless this is a local development setup. Each condition is one way
 * of being pointed at something real:
 *
 *   - NODE_ENV=production in the process doing the seeding;
 *   - a DATABASE_URL that is not a local `file:` database (a `libsql://` or
 *     `https://` URL is a remote one, and a session written there is a
 *     session on that deployment);
 *   - a base URL that is not plain http on a loopback host, which is where
 *     the cookie would be sent.
 *
 * @param {{ env: Record<string, string | undefined>, baseURL: string | undefined }} where
 */
export function assertSessionSeedingPermitted({ env, baseURL }) {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "e2e session seeding refused: NODE_ENV is production. " +
        "This is a test-only helper and never runs against a production environment.",
    );
  }
  const databaseUrl = env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(
      `e2e session seeding refused: DATABASE_URL is not a local file: database (${databaseUrl}).`,
    );
  }
  let url;
  try {
    url = new URL(String(baseURL));
  } catch {
    throw new Error(`e2e session seeding refused: base URL is not a URL (${baseURL}).`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `e2e session seeding refused: base URL is not plain http on a loopback host (${baseURL}).`,
    );
  }
}

/**
 * Write a User and a Session for one test and return the cookie that carries
 * it. Refuses (throws, having written nothing) unless
 * `assertSessionSeedingPermitted` allows it.
 *
 * @param {{
 *   db: { execute: (stmt: { sql: string, args: Array<string | number | null> }) => Promise<unknown> },
 *   env: Record<string, string | undefined>,
 *   baseURL: string | undefined,
 *   name?: string,
 *   now?: Date,
 * }} options
 */
export async function seedSession({ db, env, baseURL, name = "E2E Signed In", now = new Date() }) {
  assertSessionSeedingPermitted({ env, baseURL });

  const userId = `${E2E_SESSION_ID_PREFIX}user-${randomUUID()}`;
  const sessionId = `${E2E_SESSION_ID_PREFIX}session-${randomUUID()}`;
  const sessionToken = randomBytes(32).toString("hex");
  const stamp = now.toISOString();
  // A full Auth.js session lifetime (its default `maxAge`, which
  // src/lib/auth.ts does not override), and not shorter on purpose. @auth/core
  // rewrites a database session's expiry on any request where
  // `expires - maxAge + updateAge` (updateAge: 24 hours) has already passed
  // (lib/actions/session.js). Any expiry shorter than maxAge - updateAge
  // makes that true on EVERY signed-in request, so each page load becomes a
  // write to the one SQLite file every parallel worker's pages are reading
  // — the SQLITE_BUSY shape e2e/signed-in-setup.ts exists to avoid. Nor
  // would a short expiry stay short: the first request extends it to maxAge.
  // A row a crashed run leaves behind is therefore live that long, and only
  // on a server whose allowlist names E2E_SIGNED_IN_EMAIL (see the vitest
  // guard's "refused by a server that has not allowlisted it" cases).
  const expires = new Date(now.getTime() + SESSION_MAX_AGE_MS).toISOString();

  // `email` left NULL on the User: User.email is unique, and specs run in
  // parallel, each with its own user. The identity the live-session check
  // judges is the session row's `signInEmail`, which it prefers over
  // User.email (src/lib/live-session.ts, `recorded.email ?? user.email`).
  await db.execute({
    sql: `INSERT INTO "User" ("id","name","email","role","createdAt","updatedAt")
          VALUES (?, ?, NULL, 'USER', ?, ?)`,
    args: [userId, name, stamp, stamp],
  });
  await db.execute({
    sql: `INSERT INTO "Session" ("id","sessionToken","userId","expires","signInProvider","signInEmail")
          VALUES (?, ?, ?, ?, NULL, ?)`,
    args: [sessionId, sessionToken, userId, expires, E2E_SIGNED_IN_EMAIL],
  });

  return {
    userId,
    cookie: {
      name: E2E_SESSION_COOKIE,
      value: sessionToken,
      url: new URL(String(baseURL)).origin,
      httpOnly: true,
      sameSite: /** @type {const} */ ("Lax"),
    },
    async cleanup() {
      // Session first; it would cascade from User anyway, but naming both
      // keeps this from depending on the foreign-key pragma being on.
      await db.execute({ sql: `DELETE FROM "Session" WHERE "userId" = ?`, args: [userId] });
      await db.execute({ sql: `DELETE FROM "User" WHERE "id" = ?`, args: [userId] });
    },
  };
}
