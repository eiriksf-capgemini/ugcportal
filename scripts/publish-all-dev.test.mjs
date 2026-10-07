/**
 * Tests for scripts/publish-all-dev.mjs (ugcportal-x8sx).
 *
 * K2 (non-`file:` DATABASE_URL refused before any request), K3 (`--dry-run`
 * makes no request) and K4 (a row whose owner has no live session is
 * skipped, with a reason, and the exit code is non-zero) are each asserted
 * here. K1 (the live run) is a manual check against dev.db. The one real
 * I/O path, `readPublishInputs`, is exercised against a temporary SQLite
 * file built with the same `@libsql/client` the script uses, so the column
 * names in its SQL are checked against a schema rather than trusted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";


import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  isLoopbackHost,
  main,
  parseArgs,
  planPublishes,
  preflight,
  publishAll,
  readPublishInputs,
  sessionCookieName,
  sqlitePathFromDatabaseUrl,
  summarize,
} from "./publish-all-dev.mjs";

const NOW = new Date("2026-10-07T12:00:00Z");
const LIVE = "2026-11-06T11:22:10.580+00:00";
const EXPIRED = "2026-10-01T00:00:00.000+00:00";

/** A fetch stub that records calls and answers with a fixed status/body. */
function stubFetch(status = 200, body = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { fetch, calls };
}

describe("parseArgs", () => {
  it("defaults to a live run with no base URL override", () => {
    expect(parseArgs([])).toEqual({ ok: true, dryRun: false, baseUrl: undefined });
  });
  it("accepts --dry-run and both --base-url spellings", () => {
    expect(parseArgs(["--dry-run"])).toMatchObject({ ok: true, dryRun: true });
    expect(parseArgs(["--base-url", "http://127.0.0.1:4000"])).toMatchObject({
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(parseArgs(["--base-url=http://localhost:5000"])).toMatchObject({
      baseUrl: "http://localhost:5000",
    });
  });
  it("refuses an unknown flag instead of ignoring it", () => {
    expect(parseArgs(["--dry"])).toEqual({ ok: false, error: "unknown argument: --dry" });
  });
  it("refuses --base-url with no value", () => {
    expect(parseArgs(["--base-url"])).toMatchObject({ ok: false });
    expect(parseArgs(["--base-url", "--dry-run"])).toMatchObject({ ok: false });
  });
});

describe("sqlitePathFromDatabaseUrl", () => {
  it("resolves the default and relative file: URLs against cwd", () => {
    expect(sqlitePathFromDatabaseUrl(undefined, "/repo")).toBe(path.resolve("/repo", "dev.db"));
    expect(sqlitePathFromDatabaseUrl("file:./dev.db", "/repo")).toBe(path.resolve("/repo", "dev.db"));
    expect(sqlitePathFromDatabaseUrl("file:data/x.db", "/repo")).toBe(path.resolve("/repo", "data/x.db"));
  });
  it("keeps an absolute path absolute and drops a query string", () => {
    expect(sqlitePathFromDatabaseUrl("file:/tmp/a.db?mode=ro", "/repo")).toBe("/tmp/a.db");
    expect(sqlitePathFromDatabaseUrl("file:///tmp/b.db", "/repo")).toBe("/tmp/b.db");
  });
});

describe("preflight (K2 and the loopback rule)", () => {
  it("refuses a non-file: DATABASE_URL", () => {
    const result = preflight({
      databaseUrl: "postgresql://user:pw@db.example.com/ugc",
      baseUrl: DEFAULT_BASE_URL,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a local `file:` database");
  });
  it("refuses a non-loopback base URL even with a local database", () => {
    const result = preflight({ databaseUrl: "file:./dev.db", baseUrl: "https://ugc.example.com" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ugc.example.com");
  });
  it("refuses an unparseable base URL", () => {
    expect(preflight({ databaseUrl: undefined, baseUrl: "not a url" })).toMatchObject({ ok: false });
  });
  it("passes the default database and a loopback base URL", () => {
    const result = preflight({ databaseUrl: undefined, baseUrl: "http://localhost:3000" });
    expect(result.ok).toBe(true);
    expect(result.baseUrl.origin).toBe("http://localhost:3000");
  });
  it("isLoopbackHost spells [::1] the way URL#hostname does", () => {
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("sessionCookieName", () => {
  it("adds the __Secure- prefix for https only", () => {
    expect(sessionCookieName(new URL("http://localhost:3000"))).toBe("authjs.session-token");
    expect(sessionCookieName(new URL("https://localhost:3000"))).toBe("__Secure-authjs.session-token");
  });
});

describe("planPublishes (K4)", () => {
  const unpublished = [
    { id: "m1", userId: "alice" },
    { id: "m2", userId: "bob" },
    { id: "m3", userId: "alice" },
  ];
  it("pairs each row with its OWNER's live session and skips owners without one", () => {
    const { publish, skipped } = planPublishes({
      unpublished,
      sessions: [
        { userId: "alice", sessionToken: "tok-alice", expires: LIVE },
        { userId: "bob", sessionToken: "tok-bob-old", expires: EXPIRED },
      ],
      now: NOW,
    });
    expect(publish).toEqual([
      { id: "m1", userId: "alice", sessionToken: "tok-alice" },
      { id: "m3", userId: "alice", sessionToken: "tok-alice" },
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe("m2");
    expect(skipped[0].reason).toContain("bob");
    expect(skipped[0].reason).toContain("no unexpired session");
  });
  it("never hands a row another user's session", () => {
    const { publish, skipped } = planPublishes({
      unpublished: [{ id: "m2", userId: "bob" }],
      sessions: [{ userId: "alice", sessionToken: "tok-alice", expires: LIVE }],
      now: NOW,
    });
    expect(publish).toEqual([]);
    expect(skipped.map((s) => s.id)).toEqual(["m2"]);
  });
  it("prefers the latest-expiring live session when a user has several", () => {
    const { publish } = planPublishes({
      unpublished: [{ id: "m1", userId: "alice" }],
      sessions: [
        { userId: "alice", sessionToken: "tok-sooner", expires: "2026-10-08T00:00:00Z" },
        { userId: "alice", sessionToken: "tok-later", expires: "2026-10-09T00:00:00Z" },
      ],
      now: NOW,
    });
    expect(publish[0].sessionToken).toBe("tok-later");
  });
  it("treats an unparseable expires as expired", () => {
    const { publish, skipped } = planPublishes({
      unpublished: [{ id: "m1", userId: "alice" }],
      sessions: [{ userId: "alice", sessionToken: "tok", expires: "not-a-date" }],
      now: NOW,
    });
    expect(publish).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});

describe("publishAll", () => {
  const baseUrl = new URL("http://localhost:3000");
  const publish = [{ id: "m1", userId: "alice", sessionToken: "tok-alice" }];

  it("K3: --dry-run makes no request and reports what it would do", async () => {
    const { fetch, calls } = stubFetch();
    const results = await publishAll({ publish, baseUrl, cookieName: "authjs.session-token", fetch, dryRun: true });
    expect(calls).toHaveLength(0);
    expect(results).toEqual([{ id: "m1", ok: true, status: null, detail: "would publish" }]);
  });
  it("POSTs to the publish route with the owner's session cookie", async () => {
    const { fetch, calls } = stubFetch(200);
    const results = await publishAll({ publish, baseUrl, cookieName: "authjs.session-token", fetch, dryRun: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:3000/api/media/m1/publish");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.cookie).toBe("authjs.session-token=tok-alice");
    expect(results[0]).toMatchObject({ ok: true, status: 200, detail: "published" });
  });
  it("surfaces the route's own refusal text on a non-2xx answer", async () => {
    const { fetch } = stubFetch(400, { error: "Add alt text before publishing this item.", field: "altText" });
    const results = await publishAll({ publish, baseUrl, cookieName: "authjs.session-token", fetch, dryRun: false });
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toBe("HTTP 400: Add alt text before publishing this item.");
  });
  it("reports a connection failure as a failed row pointing at the dev server", async () => {
    const fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const results = await publishAll({ publish, baseUrl, cookieName: "authjs.session-token", fetch, dryRun: false });
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toContain("ECONNREFUSED");
    expect(results[0].detail).toContain("http://localhost:3000");
  });
});

describe("summarize", () => {
  it("exits 0 only when nothing failed and nothing was skipped", () => {
    expect(summarize({ results: [{ id: "a", ok: true, detail: "published" }], skipped: [], dryRun: false }).exitCode).toBe(0);
    expect(summarize({ results: [{ id: "a", ok: false, detail: "HTTP 400" }], skipped: [], dryRun: false }).exitCode).toBe(1);
    expect(summarize({ results: [], skipped: [{ id: "b", reason: "no session" }], dryRun: false }).exitCode).toBe(1);
  });
  it("says so when there is nothing to publish", () => {
    const { lines, exitCode } = summarize({ results: [], skipped: [], dryRun: false });
    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toContain("nothing is unpublished");
  });
  it("uses dry-run wording in dry-run mode", () => {
    const { lines } = summarize({ results: [{ id: "a", ok: true, detail: "would publish" }], skipped: [], dryRun: true });
    expect(lines.at(-1)).toMatch(/^would publish 1,/);
  });
});

describe("readPublishInputs against a real SQLite file", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function makeDb() {
    dir = mkdtempSync(path.join(tmpdir(), "publish-all-dev-"));
    const file = path.join(dir, "dev.db");
    const db = createClient({ url: `file:${file}` });
    await db.executeMultiple(`
      CREATE TABLE "Media" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "publishedAt" TEXT);
      CREATE TABLE "Session" ("id" TEXT PRIMARY KEY, "sessionToken" TEXT NOT NULL, "userId" TEXT NOT NULL, "expires" TEXT NOT NULL);
      INSERT INTO "Media" VALUES ('older', 'alice', '2026-10-07T10:00:00Z', NULL);
      INSERT INTO "Media" VALUES ('done',  'alice', '2026-10-07T10:30:00Z', '2026-10-07T11:00:00Z');
      INSERT INTO "Media" VALUES ('newer', 'bob',   '2026-10-07T11:00:00Z', NULL);
      INSERT INTO "Session" VALUES ('s1', 'tok-alice', 'alice', '${LIVE}');
    `);
    db.close();
    return file;
  }

  it("returns only unpublished rows, oldest first, plus every session", async () => {
    const { unpublished, sessions } = await readPublishInputs(await makeDb());
    expect(unpublished).toEqual([
      { id: "older", userId: "alice" },
      { id: "newer", userId: "bob" },
    ]);
    expect(sessions).toEqual([{ userId: "alice", sessionToken: "tok-alice", expires: LIVE }]);
  });

  it("main(): end to end with a stub fetch -- publishes alice's row, skips bob's, exits 1", async () => {
    const file = await makeDb();
    const { fetch, calls } = stubFetch(200);
    const logged = [];
    const code = await main({
      argv: [],
      cwd: dir,
      env: { DATABASE_URL: `file:${file}` },
      fetch,
      log: (line) => logged.push(line),
      error: (line) => logged.push(line),
      now: NOW,
    });
    expect(calls.map((c) => c.url)).toEqual(["http://localhost:3000/api/media/older/publish"]);
    expect(code).toBe(1);
    expect(logged.join("\n")).toContain("skip newer");
    expect(logged.join("\n")).toContain("published 1, failed 0, skipped 1");
  });

  it("main(): K2 refuses before touching the database or the network", async () => {
    const { fetch, calls } = stubFetch(200);
    const errors = [];
    const code = await main({
      argv: [],
      cwd: "/nonexistent",
      env: { DATABASE_URL: "postgresql://x@db.example.com/ugc" },
      fetch,
      log: () => {},
      error: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("not a local `file:` database");
  });
});
