import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ResaleRightsStatus } from "@/generated/prisma/enums";
import {
  CURRENT_CHECKLIST_VERSION,
  PRODUCT_DECISION_REF,
} from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-0ss K3 and K4 against a real database: the audit row and the
 * self-review warning have to actually exist, and the system path has to
 * actually be unable to produce CLEARED.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { setResaleRightsStatus } = await import("@/lib/resale-rights-review");

const CONNECTING_ADMIN = "admin-connector";
const OTHER_ADMIN = "admin-reviewer";

async function events(reviewId: string) {
  return prisma.resaleRightsEvent.findMany({
    where: { reviewId },
    // `id` as a tiebreak: Prisma writes createdAt at millisecond
    // resolution, so two events in the same millisecond would otherwise
    // come back in an undefined order.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function review() {
  return prisma.resaleRightsReview.findUnique({
    where: { instagramAccountId: "acc-1" },
  });
}

const USERS = [
  { id: CONNECTING_ADMIN, email: "connector@example.com", role: "ADMIN" },
  { id: OTHER_ADMIN, email: "reviewer@example.com", role: "ADMIN" },
  { id: "user-1", email: "user@example.com", role: "USER" },
] as const;

const ACCOUNT = {
  id: "acc-1",
  instagramUserId: "ig-1",
  username: "owner",
  accessTokenEncrypted: "sealed",
  tokenExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
  scopes: "instagram_business_basic",
  connectedByUserId: CONNECTING_ADMIN,
};

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  // Rebuilt rather than merely truncated, because two tests here delete the
  // account and the reviewer on purpose — that is the behaviour under test.
  //
  // Note that events are cleared explicitly: they no longer cascade from
  // anything, which is the entire point of the table (see the schema, and
  // "survives the account being disconnected" below). Before that change
  // this line was invisible, because deleting the review took the events
  // with it.
  await prisma.resaleRightsEvent.deleteMany({});
  await prisma.instagramAccount.deleteMany({});
  await prisma.user.deleteMany({});
  for (const user of USERS) {
    await prisma.user.create({ data: user });
  }
  await prisma.instagramAccount.create({ data: ACCOUNT });
});

describe("ugcportal-0ss K3: an admin clearance is recorded", () => {
  it("creates the review, the audit row, and the decision reference", async () => {
    const result = await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      actorEmail: "reviewer@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file, Part D complete.",
      route: "CONTRACT",
      validUntil: new Date("2027-06-01T00:00:00.000Z"),
      conditions: "Editorial use only.",
      evidence: { key: "rights-evidence/acc-1/contract.pdf", sha256: "abc123" },
    });

    expect(result).toMatchObject({ outcome: "recorded", selfReview: false });

    const saved = await review();
    expect(saved).toMatchObject({
      status: "CLEARED",
      route: "CONTRACT",
      reviewedByUserId: OTHER_ADMIN,
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      conditions: "Editorial use only.",
      evidenceKey: "rights-evidence/acc-1/contract.pdf",
      evidenceSha256: "abc123",
      // ugcportal-2eh Option A: recorded on every admin decision.
      productDecisionRef: PRODUCT_DECISION_REF,
    });
    expect(saved?.reviewedAt).toBeInstanceOf(Date);

    const [event, ...rest] = await events(saved!.id);
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      fromStatus: "UNREVIEWED",
      toStatus: "CLEARED",
      actorUserId: OTHER_ADMIN,
      actorEmail: "reviewer@example.com",
      reason: "Signed assignment on file, Part D complete.",
      selfReview: false,
      // Snapshots, so the row still answers "cleared against what, on what
      // evidence" when the review and the account are gone.
      instagramAccountId: "acc-1",
      instagramUsername: "owner",
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      evidenceKey: "rights-evidence/acc-1/contract.pdf",
      evidenceSha256: "abc123",
    });
  });

  it("flags a clearance signed by the admin who connected the account", async () => {
    const result = await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: CONNECTING_ADMIN,
      status: "CLEARED",
      reason: "Only admin on this instance.",
    });

    expect(result).toMatchObject({ outcome: "recorded", selfReview: true });
    const saved = await review();
    expect((await events(saved!.id))[0]?.selfReview).toBe(true);
  });

  it("keeps the trail append-only across several decisions", async () => {
    for (const [status, reason] of [
      ["IN_REVIEW", "Checklist started."],
      ["CLEARED", "Contract signed."],
      ["REVOKED", "Owner withdrew."],
    ] as const) {
      await setResaleRightsStatus("acc-1", {
        source: "ADMIN",
        actorUserId: OTHER_ADMIN,
        status,
        reason,
      });
    }

    const saved = await review();
    expect(saved?.status).toBe("REVOKED");
    expect(
      (await events(saved!.id)).map((event) => [
        event.fromStatus,
        event.toStatus,
      ]),
    ).toEqual([
      ["UNREVIEWED", "IN_REVIEW"],
      ["IN_REVIEW", "CLEARED"],
      ["CLEARED", "REVOKED"],
    ]);
  });

  it("does not wipe the evidence pointer when the account is later rejected", async () => {
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "CLEARED",
      reason: "Contract signed.",
      evidence: { key: "rights-evidence/acc-1/contract.pdf", sha256: "abc123" },
    });
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "REJECTED",
      reason: "Contract turned out to cover only editorial use.",
    });

    expect(await review()).toMatchObject({
      status: "REJECTED",
      evidenceKey: "rights-evidence/acc-1/contract.pdf",
      evidenceSha256: "abc123",
    });
  });

  // An audit trail that disappears when someone clicks Disconnect is not an
  // audit trail. RoleChange (ugcportal-lu7) solved this by carrying no
  // foreign keys; this table does the same, and snapshots the facts a reader
  // needs so the row still stands alone.
  it("survives the account being disconnected", async () => {
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      actorEmail: "reviewer@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file.",
      evidence: { key: "rights-evidence/acc-1/contract.pdf", sha256: "abc123" },
    });

    // Exactly what disconnectInstagramAccount does.
    await prisma.instagramAccount.delete({ where: { id: "acc-1" } });

    // The current-state row goes with the account, by design.
    expect(await review()).toBeNull();

    // The history does not.
    const survivors = await prisma.resaleRightsEvent.findMany({
      where: { instagramAccountId: "acc-1" },
    });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({
      instagramAccountId: "acc-1",
      // Who, when, what, against which checklist, on which evidence — all
      // readable with no other table present.
      instagramUsername: "owner",
      actorUserId: OTHER_ADMIN,
      actorEmail: "reviewer@example.com",
      toStatus: "CLEARED",
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      evidenceKey: "rights-evidence/acc-1/contract.pdf",
      evidenceSha256: "abc123",
    });
  });

  it("survives the reviewing admin's account being deleted", async () => {
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      actorEmail: "reviewer@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file.",
    });

    await prisma.user.delete({ where: { id: OTHER_ADMIN } });

    const [event] = await prisma.resaleRightsEvent.findMany({
      where: { instagramAccountId: "acc-1" },
    });
    // The id dangles, but the snapshotted email still names the human.
    expect(event).toMatchObject({
      actorUserId: OTHER_ADMIN,
      actorEmail: "reviewer@example.com",
    });
    // And the clearance stops counting, because the gate re-reads the role
    // and there is no longer a user to read (ON DELETE SET NULL).
    expect((await review())?.reviewedByUserId).toBeNull();
  });

  // checklistVersion and productDecisionRef both answer "under what was this
  // granted". Neither may move on an ordinary edit: retiring a checklist
  // version is how a revised legal process forces re-review, and
  // re-attributing a clearance to a product decision taken after it is a
  // false audit record.
  it("leaves the recorded checklist version and decision ref alone by default", async () => {
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "CLEARED",
      reason: "Contract signed.",
      restampChecklist: true,
    });
    await prisma.resaleRightsReview.update({
      where: { instagramAccountId: "acc-1" },
      data: {
        checklistVersion: "2019-01-01.0",
        productDecisionRef: "ugcportal-old",
      },
    });

    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "CLEARED",
      reason: "Fixed a typo in the conditions.",
      conditions: "Editorial use only.",
    });

    expect(await review()).toMatchObject({
      checklistVersion: "2019-01-01.0",
      productDecisionRef: "ugcportal-old",
    });
  });

  it("re-stamps both only when the reviewer asks", async () => {
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "CLEARED",
      reason: "Contract signed.",
    });
    await prisma.resaleRightsReview.update({
      where: { instagramAccountId: "acc-1" },
      data: { checklistVersion: "2019-01-01.0", productDecisionRef: "old" },
    });

    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "CLEARED",
      reason: "Re-reviewed against the current checklist.",
      restampChecklist: true,
    });

    expect(await review()).toMatchObject({
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      productDecisionRef: PRODUCT_DECISION_REF,
    });
  });

  it("stamps the current version on a first decision, with nothing to preserve", async () => {
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "IN_REVIEW",
      reason: "Starting the checklist.",
    });

    expect(await review()).toMatchObject({
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      productDecisionRef: PRODUCT_DECISION_REF,
    });
  });

  it("records the effective version on the audit row either way", async () => {
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "CLEARED",
      reason: "Contract signed.",
    });
    await prisma.resaleRightsReview.update({
      where: { instagramAccountId: "acc-1" },
      data: { checklistVersion: "2019-01-01.0" },
    });
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "REJECTED",
      reason: "Scope turned out to be narrower.",
    });

    const saved = await review();
    // The snapshot is read back from the written row, so it reports what the
    // review actually says rather than what this call passed in.
    expect((await events(saved!.id)).at(-1)).toMatchObject({
      toStatus: "REJECTED",
      checklistVersion: "2019-01-01.0",
    });
  });

  it("refuses to record a decision with no reason", async () => {
    await expect(
      setResaleRightsStatus("acc-1", {
        source: "ADMIN",
        actorUserId: OTHER_ADMIN,
        status: "CLEARED",
        reason: "   ",
      }),
    ).rejects.toThrow("reason is required");
    expect(await review()).toBeNull();
  });
});

describe("ugcportal-0ss K4: no system path to CLEARED", () => {
  it("refuses a system transition to CLEARED and writes nothing", async () => {
    const result = await setResaleRightsStatus("acc-1", {
      source: "SYSTEM",
      // The type forbids this; the cast is the test — a plain-JS caller, or
      // a value widened somewhere upstream, must still be refused.
      status: "CLEARED" as unknown as "REVOKED",
      reason: "sync job",
    });

    expect(result).toEqual({ outcome: "forbidden_system_transition" });
    expect(await review()).toBeNull();
    expect(await prisma.resaleRightsEvent.count()).toBe(0);
  });

  it.each(["UNREVIEWED", "IN_REVIEW", "REJECTED"] as const)(
    "refuses a system transition to %s as well",
    async (status) => {
      const result = await setResaleRightsStatus("acc-1", {
        source: "SYSTEM",
        status: status as unknown as "REVOKED",
        reason: "sync job",
      });
      expect(result).toEqual({ outcome: "forbidden_system_transition" });
      expect(await review()).toBeNull();
    },
  );

  it.each(["REVOKED", "EXPIRED"] as const)(
    "lets the system move an account to %s",
    async (status: ResaleRightsStatus) => {
      await setResaleRightsStatus("acc-1", {
        source: "ADMIN",
        actorUserId: OTHER_ADMIN,
        status: "CLEARED",
        reason: "Contract signed.",
      });

      const result = await setResaleRightsStatus("acc-1", {
        source: "SYSTEM",
        status: status as "REVOKED" | "EXPIRED",
        reason: "Instagram deauthorize callback.",
      });

      expect(result).toMatchObject({ outcome: "recorded", selfReview: false });
      const saved = await review();
      expect(saved?.status).toBe(status);
      // The reviewer of record is untouched: the human who cleared it is
      // still who cleared it, whatever happened afterwards.
      expect(saved?.reviewedByUserId).toBe(OTHER_ADMIN);
      const all = await events(saved!.id);
      expect(all).toHaveLength(2);
      expect(all.find((event) => event.toStatus === status)).toMatchObject({
        fromStatus: "CLEARED",
        actorUserId: null,
        actorEmail: null,
      });
    },
  );

  it("is idempotent for a repeated system revoke", async () => {
    await setResaleRightsStatus("acc-1", {
      source: "SYSTEM",
      status: "REVOKED",
      reason: "Deauthorize callback.",
    });
    const second = await setResaleRightsStatus("acc-1", {
      source: "SYSTEM",
      status: "REVOKED",
      reason: "Deauthorize callback, retried.",
    });

    expect(second.outcome).toBe("unchanged");
    const saved = await review();
    expect(await events(saved!.id)).toHaveLength(1);
  });

  it("refuses an admin whose role was revoked since they signed in", async () => {
    const result = await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: "user-1",
      status: "CLEARED",
      reason: "Stale session.",
    });

    expect(result).toEqual({ outcome: "actor_not_admin" });
    expect(await review()).toBeNull();
    expect(await prisma.resaleRightsEvent.count()).toBe(0);
  });

  it("refuses an actor who no longer exists", async () => {
    const result = await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: "ghost",
      status: "CLEARED",
      reason: "Deleted user.",
    });
    expect(result).toEqual({ outcome: "actor_not_admin" });
  });

  it("reports an unknown account without writing anything", async () => {
    const result = await setResaleRightsStatus("no-such-account", {
      source: "ADMIN",
      actorUserId: OTHER_ADMIN,
      status: "CLEARED",
      reason: "Typo in the id.",
    });

    expect(result).toEqual({ outcome: "account_not_found" });
    expect(await prisma.resaleRightsReview.count()).toBe(0);
  });
});
