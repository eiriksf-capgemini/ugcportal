"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ResaleRightsRoute } from "@/generated/prisma/enums";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import {
  isResaleRightsRoute,
  isResaleRightsStatus,
} from "@/lib/resale-rights";
import { setResaleRightsStatus } from "@/lib/resale-rights-review";
import { putRightsEvidence } from "@/lib/rights-evidence";
import { INSTAGRAM_SETTINGS_PATH } from "@/lib/routes";

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

  // deleteMany, not delete: deleting an already-removed account (double
  // submit, stale tab) should be a no-op rather than a 500.
  await prisma.instagramAccount.deleteMany({ where: { id } });

  revalidatePath(INSTAGRAM_SETTINGS_PATH);
}

// A scanned contract or a filled-in checklist. Generous enough for a PDF
// with signature pages, small enough that the action can hold it in memory.
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;

/**
 * Record a resale-rights decision for one connected account (ugcportal-0ss,
 * checklist Part E). This is the *only* way status = CLEARED can be written,
 * and it re-checks admin here rather than trusting the page that rendered
 * the form — a server action is a public endpoint, reachable without ever
 * loading that page (the same reason disconnect above does it).
 *
 * The decision itself is the human's: nothing in this code path inspects the
 * evidence or the checklist. What it guarantees is that a named admin, and
 * only a named admin, can put an account into the state that makes its
 * uploads sellable, and that the transition is recorded.
 */
export async function recordResaleRightsDecision(formData: FormData) {
  const session = await requireAdmin();
  if (!session) {
    throw new Error("Forbidden");
  }

  const instagramAccountId = formData.get("instagramAccountId");
  if (typeof instagramAccountId !== "string" || !instagramAccountId) {
    throw new Error("Missing account id");
  }

  const status = formData.get("status");
  if (!isResaleRightsStatus(status)) {
    // Not a user-facing state: every value the form can submit is a member
    // of the enum, so anything else is a tampered request.
    throw new Error("Unknown resale-rights status");
  }

  const routeValue = formData.get("route");
  let route: ResaleRightsRoute | null = null;
  if (routeValue !== null && routeValue !== "") {
    if (!isResaleRightsRoute(routeValue)) {
      throw new Error("Unknown resale-rights route");
    }
    route = routeValue;
  }

  const reasonValue = formData.get("reason");
  const reason = typeof reasonValue === "string" ? reasonValue.trim() : "";
  if (!reason) {
    redirect(`${INSTAGRAM_SETTINGS_PATH}?error=rights_reason_required`);
  }

  const validUntilValue = formData.get("validUntil");
  let validUntil: Date | null = null;
  if (typeof validUntilValue === "string" && validUntilValue !== "") {
    // A date input submits YYYY-MM-DD, which Date parses as midnight UTC —
    // so the clearance stops counting at the *start* of the chosen day, not
    // the end of it. Left that way deliberately: of the two readings, it is
    // the one that stops selling sooner.
    const parsed = new Date(validUntilValue);
    if (Number.isNaN(parsed.getTime())) {
      redirect(`${INSTAGRAM_SETTINGS_PATH}?error=rights_invalid_valid_until`);
    }
    validUntil = parsed;
  }

  const conditionsValue = formData.get("conditions");
  const conditions =
    typeof conditionsValue === "string" && conditionsValue.trim()
      ? conditionsValue.trim()
      : null;

  // Uploaded before the status write, so a failed upload leaves no clearance
  // claiming evidence that isn't there. The reverse order could record
  // CLEARED with a dangling evidenceKey. The cost of this ordering is the
  // other kind of orphan: if the write below is then refused, the object
  // stays in the bucket unreferenced. That is the cheaper failure — an
  // unreferenced private file, rather than a clearance pointing at nothing.
  let evidence: { key: string; sha256: string } | undefined;
  const file = formData.get("evidence");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_EVIDENCE_BYTES) {
      redirect(`${INSTAGRAM_SETTINGS_PATH}?error=rights_evidence_too_large`);
    }
    try {
      evidence = await putRightsEvidence({
        instagramAccountId,
        filename: file.name,
        body: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type,
      });
    } catch (cause) {
      console.error("[resale-rights] evidence upload failed", {
        instagramAccountId,
        cause,
      });
      redirect(`${INSTAGRAM_SETTINGS_PATH}?error=rights_evidence_failed`);
    }
  }

  const result = await setResaleRightsStatus(instagramAccountId, {
    source: "ADMIN",
    actorUserId: session.user.id,
    actorEmail: session.user.email,
    status,
    reason,
    route,
    validUntil,
    conditions,
    evidence,
  });

  revalidatePath(INSTAGRAM_SETTINGS_PATH);

  if (result.outcome === "account_not_found") {
    redirect(`${INSTAGRAM_SETTINGS_PATH}?error=rights_account_not_found`);
  }
  if (result.outcome === "actor_not_admin") {
    // The session said ADMIN but the database disagrees — the role was
    // revoked between sign-in and now.
    redirect(`${INSTAGRAM_SETTINGS_PATH}?error=rights_actor_not_admin`);
  }
  // Redirect on success too, so a stale `?error=` from a previous attempt
  // doesn't stay pinned to the URL after a decision that worked.
  redirect(`${INSTAGRAM_SETTINGS_PATH}?rights=recorded`);
}
