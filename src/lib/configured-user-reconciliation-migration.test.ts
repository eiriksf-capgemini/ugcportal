import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONFIGURED_USERS } from "@/config/users";
import { configuredUserHandle } from "@/lib/sign-in-policy";
import { parsePermittedEntry } from "@/lib/sign-in-policy";
import {
  applyMigration,
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";

/**
 * The one-off reconciliation for people who already had more than one user
 * (ugcportal-t33p K4).
 *
 * Against the REAL committed .sql, applied to a temporary database seeded
 * with the split state it exists to repair — the same shape
 * src/lib/seed-portfolio-tag-migration.test.ts uses, and for the same
 * reason: asserting on the text of a migration proves it was written, not
 * that it does anything. The before-state is CAPTURED in `beforeAll` and
 * asserted on afterwards, because the migration has to have run before the
 * after-assertions and a test cannot be in two places at once.
 */

const MIGRATION_NAME = "20261005120500_reconcile_configured_users";

const EIRIK_GOOGLE = "eiriksanderfjeld@gmail.com";
const EIRIK_FACEBOOK = "eirik@sander-fjeld.com";
const GRY_FACEBOOK = "gry@sander-fjeld.no";
const AUGUST_GOOGLE = "augustsanderfjeld@gmail.com";

/** The user who has been here longest, and so the one that survives. */
const EIRIK_GOOGLE_USER = "user-eirik-google";
/** The second user the same person got by arriving through Facebook. */
const EIRIK_FACEBOOK_USER = "user-eirik-facebook";
const GRY_USER = "user-gry";
/** Listed as `google:...`, but holding only a Facebook account. Not August. */
const WRONG_PROVIDER_USER = "user-wrong-provider";
/** Shares a domain with Eirik's Google address and nothing else. */
const SAME_DOMAIN_USER = "user-same-domain";
const STRANGER_USER = "user-stranger";

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

type Snapshot = {
  users: unknown[];
  accounts: unknown[];
  media: unknown[];
  roleChanges: unknown[];
  sessions: unknown[];
};

async function snapshot(): Promise<Snapshot> {
  return {
    users: await prisma.user.findMany({ orderBy: { id: "asc" } }),
    accounts: await prisma.account.findMany({ orderBy: { id: "asc" } }),
    media: await prisma.media.findMany({ orderBy: { id: "asc" } }),
    roleChanges: await prisma.roleChange.findMany({ orderBy: { id: "asc" } }),
    sessions: await prisma.session.findMany({ orderBy: { id: "asc" } }),
  };
}

async function createUser(options: {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}): Promise<void> {
  await prisma.user.create({
    data: {
      id: options.id,
      email: options.email,
      name: options.name,
      createdAt: new Date(options.createdAt),
    },
  });
}

async function linkAccount(
  userId: string,
  provider: string,
  subject: string,
): Promise<void> {
  await prisma.account.create({
    data: { userId, provider, providerAccountId: subject, type: "oauth" },
  });
}

async function upload(userId: string, key: string): Promise<void> {
  await prisma.media.create({
    data: {
      userId,
      kind: "IMAGE",
      key,
      mimeType: "image/jpeg",
      sizeBytes: 1,
      originalName: key,
    },
  });
}

let before: Snapshot;

beforeAll(async () => {
  // Everything up to, but not including, the migration under test — so the
  // `configuredHandle` column exists (its own migration ran) and nothing has
  // been reconciled.
  await applyMigrations(prisma, { stopBefore: MIGRATION_NAME });

  // THE SPLIT STATE. Eirik arrived through Google first and got a user; he
  // later arrived through Facebook with his other address and Auth.js, which
  // links by the provider's subject and falls back to e-mail, gave him a
  // second one. Each has its own uploads and its own role history.
  await createUser({
    id: EIRIK_GOOGLE_USER,
    email: EIRIK_GOOGLE,
    name: "Eirik From Google",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await linkAccount(EIRIK_GOOGLE_USER, "google", "google-subject-eirik");
  await upload(EIRIK_GOOGLE_USER, "uploads/from-google.jpg");
  await prisma.roleChange.create({
    data: {
      targetUserId: EIRIK_GOOGLE_USER,
      targetEmail: EIRIK_GOOGLE,
      previousRole: "USER",
      newRole: "ADMIN",
      source: "BOOTSTRAP",
    },
  });
  await prisma.session.create({
    data: {
      sessionToken: "session-eirik-google",
      userId: EIRIK_GOOGLE_USER,
      expires: new Date("2099-01-01T00:00:00.000Z"),
      signInProvider: "google",
      signInEmail: EIRIK_GOOGLE,
    },
  });

  await createUser({
    id: EIRIK_FACEBOOK_USER,
    email: EIRIK_FACEBOOK,
    name: "Eirik From Facebook",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  await linkAccount(EIRIK_FACEBOOK_USER, "facebook", "facebook-subject-eirik");
  await upload(EIRIK_FACEBOOK_USER, "uploads/from-facebook.jpg");
  // An audit row from BOTH directions, so moving only `targetUserId` would
  // leave the actor column pointing at a row this migration deletes.
  await prisma.roleChange.create({
    data: {
      targetUserId: STRANGER_USER,
      targetEmail: "stranger@example.com",
      previousRole: "USER",
      newRole: "ADMIN",
      source: "ADMIN",
      actorUserId: EIRIK_FACEBOOK_USER,
      actorEmail: EIRIK_FACEBOOK,
    },
  });
  await prisma.session.create({
    data: {
      sessionToken: "session-eirik-facebook",
      userId: EIRIK_FACEBOOK_USER,
      expires: new Date("2099-01-01T00:00:00.000Z"),
      signInProvider: "facebook",
      signInEmail: EIRIK_FACEBOOK,
    },
  });

  // Gry has exactly one user. There is nothing to merge, but she must still
  // be adopted — stamped with her handle — or her next sign-in through a
  // second provider would start the split all over again.
  await createUser({
    id: GRY_USER,
    email: GRY_FACEBOOK,
    name: "Gry From Facebook",
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  await linkAccount(GRY_USER, "facebook", "facebook-subject-gry");

  // THE TWO DECOYS. Neither may be touched, and each is a different half of
  // K5's "never by domain or by provider alone".
  await createUser({
    id: WRONG_PROVIDER_USER,
    email: AUGUST_GOOGLE,
    name: "Not August",
    createdAt: "2026-03-01T00:00:00.000Z",
  });
  await linkAccount(WRONG_PROVIDER_USER, "facebook", "facebook-subject-impostor");

  await createUser({
    id: SAME_DOMAIN_USER,
    email: "someone-else@gmail.com",
    name: "Same Domain",
    createdAt: "2026-04-01T00:00:00.000Z",
  });
  await linkAccount(SAME_DOMAIN_USER, "google", "google-subject-same-domain");

  await createUser({
    id: STRANGER_USER,
    email: "stranger@example.com",
    name: "Stranger",
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  await linkAccount(STRANGER_USER, "google", "google-subject-stranger");
  await upload(STRANGER_USER, "uploads/stranger.jpg");

  before = await snapshot();

  await applyMigration(prisma, MIGRATION_NAME);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("before the reconciliation, the same person owns two users", () => {
  it("has two user rows for Eirik, each with its own uploads", () => {
    const eirik = (before.users as { id: string }[]).filter((user) =>
      [EIRIK_GOOGLE_USER, EIRIK_FACEBOOK_USER].includes(user.id),
    );
    expect(eirik).toHaveLength(2);

    const owners = new Set(
      (before.media as { userId: string; key: string }[])
        .filter((item) => item.key.startsWith("uploads/from-"))
        .map((item) => item.userId),
    );
    expect(owners).toEqual(new Set([EIRIK_GOOGLE_USER, EIRIK_FACEBOOK_USER]));
  });

  it("has nobody carrying a configured handle yet", () => {
    expect(
      (before.users as { configuredHandle: string | null }[]).map(
        (user) => user.configuredHandle,
      ),
    ).toEqual([null, null, null, null, null, null]);
  });
});

describe("after the reconciliation, the person owns one user (K4)", () => {
  it("keeps the OLDEST of Eirik's users and removes the stray", async () => {
    expect(await prisma.user.findUnique({ where: { id: EIRIK_FACEBOOK_USER } }))
      .toBeNull();

    const survivor = await prisma.user.findUniqueOrThrow({
      where: { id: EIRIK_GOOGLE_USER },
    });
    expect(survivor.configuredHandle).toBe("eirik");
    // The display name comes from the array, not from either provider.
    expect(survivor.name).toBe("Eirik");
  });

  it("moves both Account rows onto the survivor", async () => {
    const accounts = await prisma.account.findMany({
      where: { userId: EIRIK_GOOGLE_USER },
      orderBy: { provider: "asc" },
    });

    expect(accounts.map((account) => account.providerAccountId)).toEqual([
      "facebook-subject-eirik",
      "google-subject-eirik",
    ]);
  });

  it("moves the stray's uploads onto the survivor", async () => {
    const keys = await prisma.media.findMany({
      where: { userId: EIRIK_GOOGLE_USER },
      orderBy: { key: "asc" },
      select: { key: true },
    });

    expect(keys.map((item) => item.key)).toEqual([
      "uploads/from-facebook.jpg",
      "uploads/from-google.jpg",
    ]);
  });

  it("moves the role history, from both directions", async () => {
    // `targetUserId` is the obvious one. `actorUserId` is the sibling that
    // a merge moving only "the person's own rows" would leave pointing at a
    // deleted user.
    expect(
      await prisma.roleChange.count({
        where: { targetUserId: EIRIK_GOOGLE_USER },
      }),
    ).toBe(1);
    expect(
      await prisma.roleChange.count({ where: { actorUserId: EIRIK_GOOGLE_USER } }),
    ).toBe(1);
    expect(
      await prisma.roleChange.count({
        where: {
          OR: [
            { targetUserId: EIRIK_FACEBOOK_USER },
            { actorUserId: EIRIK_FACEBOOK_USER },
          ],
        },
      }),
    ).toBe(0);
  });

  it("moves the stray's sessions rather than letting them cascade away", async () => {
    // Nobody is signed out by the merge. Each row keeps the identity it was
    // minted under (ugcportal-mzr), so it is still judged on that.
    const sessions = await prisma.session.findMany({
      where: { userId: EIRIK_GOOGLE_USER },
      orderBy: { sessionToken: "asc" },
    });

    expect(sessions.map((session) => session.sessionToken)).toEqual([
      "session-eirik-facebook",
      "session-eirik-google",
    ]);
    expect(sessions.map((session) => session.signInProvider)).toEqual([
      "facebook",
      "google",
    ]);
  });

  it("adopts a person who only ever had one user", async () => {
    const gry = await prisma.user.findUniqueOrThrow({ where: { id: GRY_USER } });

    expect(gry.configuredHandle).toBe("gry");
    expect(gry.name).toBe("Gry");
  });

  it("leaves a user matched only by provider alone, or by domain, untouched (K5)", async () => {
    // `WRONG_PROVIDER_USER` holds August's listed ADDRESS but arrived
    // through Facebook, and the array lists him as `google:`. Adopting it
    // would be merging two different people.
    const wrongProvider = await prisma.user.findUniqueOrThrow({
      where: { id: WRONG_PROVIDER_USER },
    });
    expect(wrongProvider.configuredHandle).toBeNull();
    expect(wrongProvider.name).toBe("Not August");

    // `SAME_DOMAIN_USER` shares `@gmail.com` with Eirik's Google address.
    const sameDomain = await prisma.user.findUniqueOrThrow({
      where: { id: SAME_DOMAIN_USER },
    });
    expect(sameDomain.configuredHandle).toBeNull();
  });

  it("leaves everybody else exactly as they were", async () => {
    const stranger = await prisma.user.findUniqueOrThrow({
      where: { id: STRANGER_USER },
    });

    expect(stranger.configuredHandle).toBeNull();
    expect(stranger.name).toBe("Stranger");
    expect(
      await prisma.media.count({ where: { userId: STRANGER_USER } }),
    ).toBe(1);
    expect(
      await prisma.account.count({ where: { userId: STRANGER_USER } }),
    ).toBe(1);
  });

  it("drops its working tables rather than leaving them in the schema", async () => {
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE name LIKE '_Configured%'",
    );

    expect(rows).toEqual([]);
  });
});

describe("running the reconciliation a second time changes nothing (K4)", () => {
  it("leaves every row in every affected table exactly as it was", async () => {
    const afterFirstRun = await snapshot();

    await applyMigration(prisma, MIGRATION_NAME);

    expect(await snapshot()).toEqual(afterFirstRun);
  });
});

describe("a stray that still owns something is kept rather than quietly destroyed", () => {
  const BLOCKED_STRAY = "user-eirik-facebook-again";

  it("moves what it can and leaves the stray in place", async () => {
    // Eirik signs in through Facebook again on an instance where his
    // Facebook account was unlinked at some point, so he picks up a third
    // user carrying his Facebook address once more. This one has a STANDING
    // RIGHTS REVIEW, which cascades on delete — and the survivor already has
    // one of its own, so it cannot move either. Deleting the stray would
    // silently destroy a rights position; the NOT EXISTS guard in step 6 of
    // the migration is what stops it.
    //
    // Re-uses the same database on purpose: the migration is re-runnable,
    // which is the property the test above just established, so a second
    // scenario costs one more application rather than a second file.
    await createUser({
      id: BLOCKED_STRAY,
      email: EIRIK_FACEBOOK,
      name: "Eirik Again",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await linkAccount(BLOCKED_STRAY, "facebook", "facebook-subject-eirik-again");
    await upload(BLOCKED_STRAY, "uploads/again.jpg");
    await prisma.resaleRightsReview.create({
      data: { uploaderUserId: BLOCKED_STRAY, checklistVersion: "test" },
    });
    await prisma.resaleRightsReview.create({
      data: { uploaderUserId: EIRIK_GOOGLE_USER, checklistVersion: "test" },
    });

    await applyMigration(prisma, MIGRATION_NAME);

    // The upload and the account moved to the survivor...
    expect(
      await prisma.media.count({
        where: { userId: EIRIK_GOOGLE_USER, key: "uploads/again.jpg" },
      }),
    ).toBe(1);
    expect(
      await prisma.account.count({
        where: {
          userId: EIRIK_GOOGLE_USER,
          providerAccountId: "facebook-subject-eirik-again",
        },
      }),
    ).toBe(1);
    // ...but the stray survives, with its rights review intact, because
    // deleting it would have destroyed that review through the cascade.
    expect(await prisma.user.findUnique({ where: { id: BLOCKED_STRAY } }))
      .not.toBeNull();
    expect(
      await prisma.resaleRightsReview.count({
        where: { uploaderUserId: BLOCKED_STRAY },
      }),
    ).toBe(1);
  });
});

describe("the migration's copy of the array has not drifted from the derivation", () => {
  const sql = readFileSync(
    path.resolve(
      __dirname,
      `../../prisma/migrations/${MIGRATION_NAME}/migration.sql`,
    ),
    "utf8",
  );

  /** The seed rows, as (handle, name, provider, email) tuples. */
  const seeded = [
    ...sql.matchAll(
      /\(\s*'([a-z0-9-]+)',\s*'([^']+)',\s*'([a-z]+)',\s*'([^']+)'\s*\)/g,
    ),
  ].map(([, handle, name, provider, email]) => ({
    handle,
    name,
    provider,
    email,
  }));

  it("found the seed rows at all", () => {
    // Guards the two checks below against passing on an empty list because
    // the migration was reformatted.
    expect(seeded.length).toBeGreaterThan(0);
  });

  it("uses the handle `configuredUserHandle` derives for each name", () => {
    // A migration is history and its MEMBERSHIP is allowed to age — adding
    // a person later does not mean editing it. What must not drift is the
    // derivation: a hand-typed handle that the code would not produce would
    // adopt nobody, silently.
    for (const row of seeded) {
      expect(configuredUserHandle({ name: row.name, identities: [] })).toBe(
        row.handle,
      );
    }
  });

  it("uses the (provider, address) pair the policy parser produces", () => {
    for (const row of seeded) {
      expect(parsePermittedEntry(`${row.provider}:${row.email}`)).toEqual({
        provider: row.provider,
        email: row.email,
      });
    }
  });

  it("names only people who are in the array today", () => {
    // Not an equality: the array may grow past this migration. But a name
    // here that nobody recognises means the migration adopted a handle the
    // running code will never ask for.
    const names = new Set(CONFIGURED_USERS.map((user) => user.name));
    for (const row of seeded) {
      expect(names).toContain(row.name);
    }
  });
});
