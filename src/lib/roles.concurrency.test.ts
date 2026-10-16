import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createTemporaryDatabase,
} from "@/lib/test-support/db";

/**
 * What the transaction in `setUserRole` does and does not buy against the
 * last-admin count (ugcportal-5bkn).
 *
 * The docstring above `setUserRole` used to say the shared transaction means
 * the count "can't be read stale". Nothing measured that: ugcportal-lu7's own
 * close notes flagged it as unmeasured, and ugcportal-yzo7's probe (c5bf99f,
 * see `recordPrice` in src/lib/curation-price-write.ts) tested a competing
 * write while a transaction was open, not two calls to this function. This
 * file is the measurement for THIS function's shape.
 *
 * Real file-backed SQLite through the real `@prisma/adapter-libsql` and the
 * real `prisma` singleton, which is the shape production has. Not mocked: a
 * mock would agree with whatever it was told about serialisation, and that is
 * the very thing in question.
 *
 * SCOPE OF WHAT IS MEASURED, deliberately narrow: two calls through ONE client.
 * A second client on the same file, and Postgres at READ COMMITTED, are NOT
 * measured here; lu7's note that they behave differently is a claim, not a
 * finding of this file.
 *
 * ONE TEST, NOT TWO. A second shape was tried and dropped: a call issued while
 * another transaction holds a count of 2 stays pending until that transaction
 * commits. It also stays pending with the transaction removed from
 * `setUserRole`, because the libsql client serialises queries while an
 * interactive transaction is open, so asserting it could not fail and proved
 * nothing about the transaction. The mutual-demotion test below is the one
 * that fails without it.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { setUserRole } = await import("@/lib/roles");

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

async function seedTwoAdmins(tag: string) {
  await prisma.roleChange.deleteMany();
  await prisma.user.deleteMany();
  await prisma.user.createMany({
    data: [
      { id: `a-${tag}`, email: `a-${tag}@example.test`, role: "ADMIN" },
      { id: `b-${tag}`, email: `b-${tag}@example.test`, role: "ADMIN" },
    ],
  });
}

const by = (userId: string) => ({ source: "ADMIN" as const, userId });
const adminCount = () => prisma.user.count({ where: { role: "ADMIN" } });

describe("setUserRole against concurrent calls on one client", () => {
  it("two admins demoting each other at once: one wins, one gets last_admin, one admin remains", async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 40; i++) {
      await seedTwoAdmins(`r${i}`);
      const settled = await Promise.all([
        setUserRole({ userId: `a-r${i}`, role: "USER", actor: by(`b-r${i}`) }),
        setUserRole({ userId: `b-r${i}`, role: "USER", actor: by(`a-r${i}`) }),
      ]);
      outcomes.push(settled.slice().sort().join("+"));
      expect(await adminCount()).toBe(1);
    }
    // Every one of the 40 rounds resolved to the same pair: no round in which
    // both calls read admins=2 and both wrote, and none that threw.
    expect(new Set(outcomes)).toEqual(new Set(["last_admin+updated"]));
  });
});
