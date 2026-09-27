"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { INSTAGRAM_SETTINGS_PATH } from "@/lib/routes";

/**
 * Disconnect a connected Instagram account (ugcportal-5ce). Re-checks admin
 * here rather than trusting the page that rendered the form — a server
 * action is a public endpoint, reachable without ever loading that page.
 *
 * Under ugcportal-0ss this first drove the account's resale-rights review to
 * REVOKED, because the review hung off the account and one click of
 * Disconnect would otherwise have left the audit trail's last word reading
 * "cleared" for an account that no longer existed. ugcportal-vsm moved the
 * review to the uploader, so disconnecting an account now decides nothing
 * about resale rights and must not pretend to: revoking an uploader's
 * standing clearance because an unrelated Instagram connection was removed
 * would be a decision no human made. The events recorded under the old
 * anchor are still there — ResaleRightsEvent has never had a foreign key to
 * anything here.
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

  // deleteMany, not delete: deleting an already-removed account (double
  // submit, stale tab) should be a no-op rather than a 500.
  await prisma.instagramAccount.deleteMany({ where: { id } });

  revalidatePath(INSTAGRAM_SETTINGS_PATH);
}
