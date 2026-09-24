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

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: CONNECTING_ADMIN, email: "connector@example.com", role: "ADMIN" },
      { id: OTHER_ADMIN, email: "reviewer@example.com", role: "ADMIN" },
      { id: "user-1", email: "user@example.com", role: "USER" },
    ],
  });
  await prisma.instagramAccount.create({
    data: {
      id: "acc-1",
      instagramUserId: "ig-1",
      username: "owner",
      accessTokenEncrypted: "sealed",
      tokenExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      scopes: "instagram_business_basic",
      connectedByUserId: CONNECTING_ADMIN,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  // Cascades the events with it.
  await prisma.resaleRightsReview.deleteMany({});
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
