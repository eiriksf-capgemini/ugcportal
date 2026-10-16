import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { decideLiveSession } from "../../src/lib/sign-in-policy";
import {
  E2E_SESSION_COOKIE,
  E2E_SESSION_ID_PREFIX,
  E2E_SIGNED_IN_EMAIL,
  SESSION_MAX_AGE_MS,
  assertSessionSeedingPermitted,
  seedSession,
} from "./e2e-session-seeding.mjs";

/**
 * ugcportal-0wh6 K3: "the session-seeding mechanism is reachable in a
 * production build" must never happen.
 *
 * A vitest test, not a Playwright one, on purpose: the e2e suite runs under
 * `next dev`, which hard-codes NODE_ENV=development, so nothing inside it can
 * exercise a production branch. What this file can do is pin down each way
 * the mechanism could reach something real:
 *
 *   1. Through the build. scripts/lib/e2e-session-seeding.mjs has no HTTP
 *      surface, so it can only run in production if application code
 *      imports it (or anything under e2e/). The scan below walks every
 *      module under src/ — the tree `next build` compiles — and fails on
 *      such an import. Its SOURCE does land in the build directory:
 *      next.config.ts's `output: "standalone"` file tracing copies it, the
 *      setup, the fixture and the Playwright configs into .next/standalone
 *      and lists them in *.nft.json manifests. What keeps those copies out
 *      of the deployed image is the Dockerfile runner stage's named COPY
 *      list (server.js, .next, node_modules, package.json, public, prisma;
 *      ugcportal-6jcq), not this scan.
 *   2. Through the seeding call itself, run from a process whose own
 *      NODE_ENV is production, or pointed at a remote database or a
 *      non-loopback site. (NODE_ENV is the seeding process's, not the
 *      server's: seeding against the e2e/production `next start` server on
 *      http://localhost:3100 is permitted, since that is a local build on a
 *      local file database.) `seedSession` must refuse
 *      BEFORE its first write; the fake database below records every
 *      statement, so "refused" means "executed nothing", not "threw at some
 *      point".
 *   3. Through a stray seeded row. If one ever reached a deployment's
 *      database, that server re-judges it on every request against its own
 *      ALLOWED_SIGNIN_EMAILS, which will not name a `.test` address.
 *
 * Every refusal case is paired with a permitted control that runs the same
 * call with only the one condition changed, so a guard that refused
 * everything (or a fake that recorded nothing) fails here too.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const LOCAL = { env: { NODE_ENV: "development", DATABASE_URL: "file:./dev.db" }, baseURL: "http://localhost:3000" };

function fakeDb() {
  const statements = [];
  return {
    statements,
    async execute(stmt) {
      statements.push(stmt);
      return { rows: [] };
    },
  };
}

describe("seedSession: refuses before writing anything (K3)", () => {
  it("permitted control: a local development setup writes a User and a Session", async () => {
    const db = fakeDb();
    const seeded = await seedSession({ db, ...LOCAL });
    expect(db.statements.map((s) => s.sql.match(/INSERT INTO "(\w+)"/)?.[1])).toEqual(["User", "Session"]);
    expect(seeded.userId.startsWith(E2E_SESSION_ID_PREFIX)).toBe(true);
    // The cookie carries exactly the token the Session row was written with,
    // under Auth.js's http cookie name, for the base URL's origin only.
    const sessionArgs = db.statements[1].args;
    expect(seeded.cookie).toMatchObject({
      name: E2E_SESSION_COOKIE,
      value: sessionArgs[1],
      url: "http://localhost:3000",
      httpOnly: true,
    });
    expect(sessionArgs[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionArgs[2]).toBe(seeded.userId);
    expect(sessionArgs[4]).toBe(E2E_SIGNED_IN_EMAIL);
  });

  it("expires a full 30-day maxAge out, so serving the session never makes the server write", async () => {
    // @auth/core updates the row on a request once `expires - maxAge +
    // updateAge` is in the past; anything shorter than maxAge - updateAge
    // (29 days) turns every signed-in page load into a write.
    const db = fakeDb();
    const now = new Date("2026-10-16T00:00:00.000Z");
    await seedSession({ db, ...LOCAL, now });
    expect(SESSION_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(db.statements[1].args[3]).toBe("2026-11-15T00:00:00.000Z");
  });

  it("cleanup deletes only the rows it created", async () => {
    const db = fakeDb();
    const seeded = await seedSession({ db, ...LOCAL });
    await seeded.cleanup();
    const deletes = db.statements.slice(2);
    expect(deletes.map((s) => s.sql.match(/DELETE FROM "(\w+)"/)?.[1])).toEqual(["Session", "User"]);
    for (const statement of deletes) {
      expect(statement.args).toEqual([seeded.userId]);
    }
  });

  const refusals = [
    ["NODE_ENV is production", { ...LOCAL, env: { ...LOCAL.env, NODE_ENV: "production" } }, /NODE_ENV is production/],
    ["DATABASE_URL is a remote libsql:// database", { ...LOCAL, env: { ...LOCAL.env, DATABASE_URL: "libsql://ugcportal.turso.io" } }, /not a local file/],
    ["DATABASE_URL is an https:// database", { ...LOCAL, env: { ...LOCAL.env, DATABASE_URL: "https://db.example.com" } }, /not a local file/],
    ["the base URL is a public https site", { ...LOCAL, baseURL: "https://ugcportal.example" }, /not plain http on a loopback/],
    ["the base URL is http on a public host", { ...LOCAL, baseURL: "http://ugcportal.example" }, /not plain http on a loopback/],
    ["the base URL only starts with 'localhost'", { ...LOCAL, baseURL: "http://localhost.attacker.example:3000" }, /not plain http on a loopback/],
    ["the base URL is https on localhost", { ...LOCAL, baseURL: "https://localhost:3000" }, /not plain http on a loopback/],
    ["there is no base URL", { ...LOCAL, baseURL: undefined }, /not a URL/],
  ];

  for (const [label, where, message] of refusals) {
    it(`refuses, executing no statement, when ${label}`, async () => {
      const db = fakeDb();
      await expect(seedSession({ db, ...where })).rejects.toThrow(message);
      expect(db.statements).toEqual([]);
      // e2e/signed-in-setup.ts's own up-front check gives the same answer.
      expect(() => assertSessionSeedingPermitted(where)).toThrow(message);
    });
  }

  const permitted = [
    ["NODE_ENV is unset", { ...LOCAL, env: { DATABASE_URL: "file:./dev.db" } }],
    ["NODE_ENV is test", { ...LOCAL, env: { ...LOCAL.env, NODE_ENV: "test" } }],
    ["DATABASE_URL is unset (src/lib/prisma.ts's file:./dev.db default)", { ...LOCAL, env: { NODE_ENV: "development" } }],
    ["the base URL is 127.0.0.1 on another port", { ...LOCAL, baseURL: "http://127.0.0.1:3300" }],
    ["the base URL is [::1]", { ...LOCAL, baseURL: "http://[::1]:3000" }],
  ];

  for (const [label, where] of permitted) {
    it(`permits (control) when ${label}`, async () => {
      const db = fakeDb();
      await seedSession({ db, ...where });
      expect(db.statements).toHaveLength(2);
    });
  }
});

describe("a seeded session is refused by a server that has not allowlisted it (K3)", () => {
  it("refuses the seeded identity under an allowlist that does not name it", () => {
    const decision = decideLiveSession(
      { email: E2E_SIGNED_IN_EMAIL, provider: null },
      { ALLOWED_SIGNIN_EMAILS: "someone@example.com", ADMIN_BOOTSTRAP_EMAILS: "" },
      [],
    );
    expect(decision.permitted).toBe(false);
  });

  it("refuses it under an empty allowlist (the default)", () => {
    const decision = decideLiveSession({ email: E2E_SIGNED_IN_EMAIL, provider: null }, {}, []);
    expect(decision.permitted).toBe(false);
  });

  it("permits it (control) only where it is allowlisted, as the e2e dev server is", () => {
    const decision = decideLiveSession(
      { email: E2E_SIGNED_IN_EMAIL, provider: null },
      { ALLOWED_SIGNIN_EMAILS: E2E_SIGNED_IN_EMAIL },
      [],
    );
    expect(decision.permitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The build half: nothing under src/ may import the seeding code.

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];
const TEST_ONLY_NAMES = ["e2e-session-seeding", "signed-in-fixture", "signed-in-setup"];

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (SOURCE_EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every import specifier in `srcDir`, and those that reach test-only code:
 * a relative path resolving under `<root>/e2e`, or any specifier naming the
 * seeding module, the setup or the fixture. */
function scanForTestOnlyImports(root, srcDir) {
  const files = listSourceFiles(srcDir);
  const specifiers = [];
  const offending = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1];
        specifiers.push({ file, specifier });
        const resolved = specifier.startsWith(".")
          ? path.relative(root, path.resolve(path.dirname(file), specifier))
          : "";
        const intoE2e = resolved === "e2e" || resolved.startsWith(`e2e${path.sep}`);
        if (intoE2e || TEST_ONLY_NAMES.some((name) => specifier.includes(name))) {
          offending.push(`${path.relative(root, file)} -> ${specifier}`);
        }
      }
    }
  }
  return { files, specifiers, offending };
}

describe("no module under src/ imports the seeding code (K3, the build half)", () => {
  let tmp;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
    vi.restoreAllMocks();
  });

  it("detects each shape of such an import in a fixture tree (positive control)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-seeding-scan-"));
    const src = path.join(tmp, "src");
    fs.mkdirSync(path.join(src, "app", "api", "x"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.ts"), 'import { signedInTest } from "../e2e/signed-in-fixture";\n');
    fs.writeFileSync(path.join(src, "app", "api", "x", "route.ts"), 'const m = await import("../../../../scripts/lib/e2e-session-seeding.mjs");\n');
    fs.writeFileSync(path.join(src, "c.tsx"), 'export { x } from "../e2e/has-horizontal-scroll";\n');
    fs.writeFileSync(path.join(src, "d.js"), 'require("@/scripts/e2e-session-seeding");\n');
    fs.writeFileSync(path.join(src, "e.ts"), 'import setup from "@/../e2e/signed-in-setup";\n');
    fs.writeFileSync(path.join(src, "clean.ts"), 'import { prisma } from "@/lib/prisma";\nimport "./side-effect";\n');

    const { files, offending } = scanForTestOnlyImports(tmp, src);
    expect(files).toHaveLength(6);
    expect(offending.sort()).toEqual([
      "src/a.ts -> ../e2e/signed-in-fixture",
      "src/app/api/x/route.ts -> ../../../../scripts/lib/e2e-session-seeding.mjs",
      "src/c.tsx -> ../e2e/has-horizontal-scroll",
      "src/d.js -> @/scripts/e2e-session-seeding",
      "src/e.ts -> @/../e2e/signed-in-setup",
    ]);
  });

  it("finds none in the real src/ tree, having read its imports", () => {
    const { files, specifiers, offending } = scanForTestOnlyImports(REPO_ROOT, path.join(REPO_ROOT, "src"));
    // Not a scan of nothing: the tree is the real one and the extractor read
    // real imports out of it, including a known one from src/lib/auth.ts.
    expect(files.length).toBeGreaterThan(300);
    expect(specifiers).toContainEqual({ file: path.join(REPO_ROOT, "src", "lib", "auth.ts"), specifier: "@/lib/prisma" });
    expect(offending).toEqual([]);
  });
});
