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
 *
 * The subject is the uploader (ugcportal-vsm). Separation of duties moved
 * with it: the conflict of interest is now an admin clearing their *own*
 * uploads for sale, which is why ADMIN_UPLOADER exists below.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { setResaleRightsStatus } = await import("@/lib/resale-rights-review");

const UPLOADER = "uploader-1";
/** An admin who is also an uploader, so they can review their own work. */
const ADMIN_UPLOADER = "admin-uploader";
const REVIEWER = "admin-reviewer";

async function events(reviewId: string) {
  return prisma.resaleRightsEvent.findMany({
    where: { reviewId },
    // `id` as a tiebreak: Prisma writes createdAt at millisecond
    // resolution, so two events in the same millisecond would otherwise
    // come back in an undefined order.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function review(uploaderUserId = UPLOADER) {
  return prisma.resaleRightsReview.findUnique({ where: { uploaderUserId } });
}

const USERS = [
  { id: REVIEWER, email: "reviewer@example.com", role: "ADMIN" },
  { id: ADMIN_UPLOADER, email: "admin-uploader@example.com", role: "ADMIN" },
  { id: UPLOADER, email: "uploader@example.com", role: "USER" },
  { id: "user-1", email: "user@example.com", role: "USER" },
] as const;

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  // Rebuilt rather than merely truncated, because two tests here delete the
  // uploader and the reviewer on purpose — that is the behaviour under test.
  //
  // Note that events are cleared explicitly: they no longer cascade from
  // anything, which is the entire point of the table (see the schema, and
  // "survives the uploader's account being deleted" below). Before that
  // change this line was invisible, because deleting the review took the
  // events with it.
  await prisma.resaleRightsEvent.deleteMany({});
  await prisma.user.deleteMany({});
  for (const user of USERS) {
    await prisma.user.create({ data: user });
  }
});

describe("ugcportal-0ss K3: an admin clearance is recorded", () => {
  it("creates the review, the audit row, and the decision reference", async () => {
    const result = await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      actorEmail: "reviewer@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file, Part D complete.",
      route: "CONTRACT",
      validUntil: new Date("2027-06-01T00:00:00.000Z"),
      conditions: "Editorial use only.",
      evidence: {
        key: "rights-evidence/uploader-1/contract.pdf",
        sha256: "abc123",
      },
    });

    expect(result).toMatchObject({ outcome: "recorded", selfReview: false });

    const saved = await review();
    expect(saved).toMatchObject({
      uploaderUserId: UPLOADER,
      status: "CLEARED",
      route: "CONTRACT",
      reviewedByUserId: REVIEWER,
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      conditions: "Editorial use only.",
      evidenceKey: "rights-evidence/uploader-1/contract.pdf",
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
      actorUserId: REVIEWER,
      actorEmail: "reviewer@example.com",
      reason: "Signed assignment on file, Part D complete.",
      selfReview: false,
      // Snapshots, so the row still answers "cleared against what, on what
      // evidence, about whom" when the review and the user are gone.
      subjectKind: "UPLOADER",
      subjectId: UPLOADER,
      subjectLabel: "uploader@example.com",
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      evidenceKey: "rights-evidence/uploader-1/contract.pdf",
      evidenceSha256: "abc123",
    });
  });

  it("flags an admin who clears their own uploads for sale", async () => {
    const result = await setResaleRightsStatus(ADMIN_UPLOADER, {
      source: "ADMIN",
      actorUserId: ADMIN_UPLOADER,
      status: "CLEARED",
      reason: "Only admin on this instance.",
    });

    expect(result).toMatchObject({ outcome: "recorded", selfReview: true });
    const saved = await review(ADMIN_UPLOADER);
    expect((await events(saved!.id))[0]?.selfReview).toBe(true);
  });

  it("does not flag an admin clearing somebody else", async () => {
    // Without this the assertion above would also pass with selfReview
    // hard-wired to true.
    const result = await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: ADMIN_UPLOADER,
      status: "CLEARED",
      reason: "Reviewed a different uploader's work.",
    });
    expect(result).toMatchObject({ selfReview: false });
  });

  it("keeps the trail append-only across several decisions", async () => {
    for (const [status, reason] of [
      ["IN_REVIEW", "Checklist started."],
      ["CLEARED", "Contract signed."],
      ["REVOKED", "Uploader withdrew."],
    ] as const) {
      await setResaleRightsStatus(UPLOADER, {
        source: "ADMIN",
        actorUserId: REVIEWER,
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

  it("does not wipe the evidence pointer when the uploader is later rejected", async () => {
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      status: "CLEARED",
      reason: "Contract signed.",
      evidence: {
        key: "rights-evidence/uploader-1/contract.pdf",
        sha256: "abc123",
      },
    });
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      status: "REJECTED",
      reason: "Contract turned out to cover only editorial use.",
    });

    expect(await review()).toMatchObject({
      status: "REJECTED",
      evidenceKey: "rights-evidence/uploader-1/contract.pdf",
      evidenceSha256: "abc123",
    });
  });

  // An audit trail that disappears when the subject does is not an audit
  // trail. RoleChange (ugcportal-lu7) solved this by carrying no foreign
  // keys; this table does the same, and snapshots the facts a reader needs
  // so the row still stands alone. Under ugcportal-0ss the cascade ran on
  // one click of Disconnect; here it would run on deleting a user, which is
  // the same failure with a different trigger.
  it("survives the uploader's account being deleted", async () => {
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      actorEmail: "reviewer@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file.",
      evidence: {
        key: "rights-evidence/uploader-1/contract.pdf",
        sha256: "abc123",
      },
    });

    await prisma.user.delete({ where: { id: UPLOADER } });

    // The current-state row goes with the user, by design.
    expect(await review()).toBeNull();

    // The history does not.
    const survivors = await prisma.resaleRightsEvent.findMany({
      where: { subjectKind: "UPLOADER", subjectId: UPLOADER },
    });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({
      subjectId: UPLOADER,
      // Who, when, what, about whom, against which checklist, on which
      // evidence — all readable with no other table present.
      subjectLabel: "uploader@example.com",
      actorUserId: REVIEWER,
      actorEmail: "reviewer@example.com",
      toStatus: "CLEARED",
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      evidenceKey: "rights-evidence/uploader-1/contract.pdf",
      evidenceSha256: "abc123",
    });
  });

  it("survives the reviewing admin's account being deleted", async () => {
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      actorEmail: "reviewer@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file.",
    });

    await prisma.user.delete({ where: { id: REVIEWER } });

    const [event] = await prisma.resaleRightsEvent.findMany({
      where: { subjectId: UPLOADER },
    });
    // The id dangles, but the snapshotted email still names the human.
    expect(event).toMatchObject({
      actorUserId: REVIEWER,
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
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      status: "CLEARED",
      reason: "Contract signed.",
      restampChecklist: true,
    });
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: UPLOADER },
      data: {
        checklistVersion: "2019-01-01.0",
        productDecisionRef: "ugcportal-old",
      },
    });

    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
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
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      status: "CLEARED",
      reason: "Contract signed.",
    });
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: UPLOADER },
      data: { checklistVersion: "2019-01-01.0", productDecisionRef: "old" },
    });

    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
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
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      status: "IN_REVIEW",
      reason: "Starting the checklist.",
    });

    expect(await review()).toMatchObject({
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      productDecisionRef: PRODUCT_DECISION_REF,
    });
  });

  it("records the effective version on the audit row either way", async () => {
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
      status: "CLEARED",
      reason: "Contract signed.",
    });
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: UPLOADER },
      data: { checklistVersion: "2019-01-01.0" },
    });
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: REVIEWER,
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
      setResaleRightsStatus(UPLOADER, {
        source: "ADMIN",
        actorUserId: REVIEWER,
        status: "CLEARED",
        reason: "   ",
      }),
    ).rejects.toThrow("reason is required");
    expect(await review()).toBeNull();
  });
});

describe("ugcportal-0ss K4: no system path to CLEARED", () => {
  it("refuses a system transition to CLEARED and writes nothing", async () => {
    const result = await setResaleRightsStatus(UPLOADER, {
      source: "SYSTEM",
      // The type forbids this; the cast is the test — a plain-JS caller, or
      // a value widened somewhere upstream, must still be refused.
      status: "CLEARED" as unknown as "REVOKED",
      reason: "sweep",
    });

    expect(result).toEqual({ outcome: "forbidden_system_transition" });
    expect(await review()).toBeNull();
    expect(await prisma.resaleRightsEvent.count()).toBe(0);
  });

  it.each(["UNREVIEWED", "IN_REVIEW", "REJECTED"] as const)(
    "refuses a system transition to %s as well",
    async (status) => {
      const result = await setResaleRightsStatus(UPLOADER, {
        source: "SYSTEM",
        status: status as unknown as "REVOKED",
        reason: "sweep",
      });
      expect(result).toEqual({ outcome: "forbidden_system_transition" });
      expect(await review()).toBeNull();
    },
  );

  it.each(["REVOKED", "EXPIRED"] as const)(
    "lets the system move an uploader to %s",
    async (status: ResaleRightsStatus) => {
      await setResaleRightsStatus(UPLOADER, {
        source: "ADMIN",
        actorUserId: REVIEWER,
        status: "CLEARED",
        reason: "Contract signed.",
      });

      const result = await setResaleRightsStatus(UPLOADER, {
        source: "SYSTEM",
        status: status as "REVOKED" | "EXPIRED",
        reason: "Validity sweep.",
      });

      expect(result).toMatchObject({ outcome: "recorded", selfReview: false });
      const saved = await review();
      expect(saved?.status).toBe(status);
      // The reviewer of record is untouched: the human who cleared it is
      // still who cleared it, whatever happened afterwards.
      expect(saved?.reviewedByUserId).toBe(REVIEWER);
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
    await setResaleRightsStatus(UPLOADER, {
      source: "SYSTEM",
      status: "REVOKED",
      reason: "Validity sweep.",
    });
    const second = await setResaleRightsStatus(UPLOADER, {
      source: "SYSTEM",
      status: "REVOKED",
      reason: "Validity sweep, retried.",
    });

    expect(second.outcome).toBe("unchanged");
    const saved = await review();
    expect(await events(saved!.id)).toHaveLength(1);
  });

  it("refuses an admin whose role was revoked since they signed in", async () => {
    const result = await setResaleRightsStatus(UPLOADER, {
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
    const result = await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: "ghost",
      status: "CLEARED",
      reason: "Deleted user.",
    });
    expect(result).toEqual({ outcome: "actor_not_admin" });
  });

  it("reports an unknown uploader without writing anything", async () => {
    const result = await setResaleRightsStatus("no-such-user", {
      source: "ADMIN",
      actorUserId: REVIEWER,
      status: "CLEARED",
      reason: "Typo in the id.",
    });

    expect(result).toEqual({ outcome: "uploader_not_found" });
    expect(await prisma.resaleRightsReview.count()).toBe(0);
  });
});
