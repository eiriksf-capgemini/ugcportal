"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { setResaleRightsStatus } from "@/lib/resale-rights-review";
import { INSTAGRAM_SETTINGS_PATH } from "@/lib/routes";

// Recording a resale-rights decision is NOT a server action: it carries an
// evidence file, and the only way to give a server action a body larger than
// 1 MB is `experimental.serverActions.bodySizeLimit`, which is global and
// enforced before any action's own auth check runs. See next.config.ts and
// src/app/api/admin/instagram/rights-decision/route.ts.

/**
 * Disconnect a connected Instagram account (ugcportal-5ce). Re-checks admin
 * here rather than trusting the page that rendered the form — a server
 * action is a public endpoint, reachable without ever loading that page.
 */
export async function disconnectInstagramAccount(formData: FormData) {
  const session = await requireAdmin();
  if (!session) {
    throw new Error("Forbidden");
  }

  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    throw new Error("Missing account id");
  }

  // Revoke *before* deleting, so the audit trail ends where the account's
  // rights actually ended (checklist Part E.3: admin disconnect → REVOKED).
  //
  // Without this the last event for a disconnected account still reads
  // `toStatus = CLEARED` — a trail that outlives the account, as it should,
  // but whose final entry is then a lie. The row itself cascades away with
  // the account; the event does not, which is the whole point of it having
  // no foreign keys.
  //
  // SYSTEM rather than ADMIN, with the admin named as the trigger: clicking
  // Disconnect revokes an account, it does not review one, and the ADMIN
  // path would stamp this admin in as `reviewedBy`.
  const revoked = await setResaleRightsStatus(id, {
    source: "SYSTEM",
    status: "REVOKED",
    reason: "Account disconnected by an admin.",
    triggeredByUserId: session.user.id,
    triggeredByEmail: session.user.email,
  });

  // "account_not_found" is a double submit or a stale tab — the account is
  // already gone, so there is nothing to revoke and nothing to delete. Any
  // other non-write outcome would mean the revoke failed, and deleting the
  // account anyway would destroy the evidence of why.
  if (revoked.outcome === "account_not_found") {
    revalidatePath(INSTAGRAM_SETTINGS_PATH);
    return;
  }

  // deleteMany, not delete: deleting an already-removed account (double
  // submit, stale tab) should be a no-op rather than a 500.
  await prisma.instagramAccount.deleteMany({ where: { id } });

  revalidatePath(INSTAGRAM_SETTINGS_PATH);
}
