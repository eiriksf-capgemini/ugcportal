"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/admin";
import { parseTriageAnswers } from "@/lib/curation-triage";
import { recordTriageFacts } from "@/lib/curation-triage-write";
import { CURATION_PATH } from "@/lib/routes";

import type { TriageOutcomeCode } from "./outcomes";

/**
 * Record the per-upload triage facts for one upload (ugcportal-vq3z K1).
 *
 * Re-checks admin here rather than trusting the page that rendered the form
 * (K2). A server action is a public endpoint: it is reachable by POSTing its
 * action id without ever loading the screen, so the page's own `requireAdmin`
 * is a second lock on the door rather than the lock. These columns are what
 * the sellability gate trusts — `depictsPeople: false` is an assertion that
 * there is no identifiable person in a photograph, and it is the assertion
 * that SELLS it — so the role check and the recorded actor are the same
 * mechanism, not two.
 *
 * `throw` rather than a redirect for a refused caller, matching
 * `changeUserRole` on the users screen: a non-admin has no screen to be sent
 * back to, and an error is the honest answer to a request that should not
 * have been made.
 *
 * Everything the admin CAN legitimately get wrong is a redirect carrying one
 * of a closed set of codes (see ./outcomes.ts) — never text from the request.
 */
export async function recordTriage(formData: FormData) {
  const session = await requireAdmin();
  if (!session) {
    throw new Error("Forbidden");
  }

  const mediaId = formData.get("mediaId");
  if (typeof mediaId !== "string" || !mediaId) {
    // Not a user-facing state: the form carries this in a hidden field on
    // every row, so its absence is a tampered request rather than a mistake
    // to render a banner for.
    throw new Error("Missing media id");
  }

  const parsed = parseTriageAnswers(formData);
  if (!parsed.ok) {
    // `return redirect(...)` rather than a bare call. In production
    // `redirect` throws and nothing after it runs; under test it is a mock
    // that returns, and without the `return` the action would carry straight
    // on into the write it just refused — a test-only fail-open, which is the
    // worst kind, because the suite would be the thing that stopped noticing.
    return redirect(triageErrorPath("unanswered", mediaId));
  }

  const outcome = await recordTriageFacts({
    mediaId,
    answers: parsed.answers,
    // From the session, never from the form. The whole point of
    // `triagedByUserId` is that the gate can re-read the signer's current
    // role; a form-supplied actor would let a caller sign an admin's name to
    // their own answers.
    actorUserId: session.user.id,
  });

  revalidatePath(CURATION_PATH);
  // Redirect either way, so a stale `?error=` from a previous attempt doesn't
  // stay pinned to the URL after a triage that worked.
  return redirect(
    outcome.kind === "recorded"
      ? `${CURATION_PATH}?triage=recorded`
      : triageErrorPath(outcome.kind, mediaId),
  );
}

/**
 * Where a refused attempt goes: the screen, the closed-set code, and the row
 * whose form should reopen.
 *
 * The media id is echoed back into `?edit=`, which is the same thing the
 * resale-rights screen already does with `?edit=<user id>`: the admin came
 * here to act on one row and has to land back on it with their answers
 * visible, and a code with no row would make them hunt for it again. It is
 * `encodeURIComponent`-escaped on the way out, and on the way back the page
 * only ever COMPARES it against ids it loaded itself — `?edit=` is never
 * rendered, not even as the "that upload no longer exists" message, which
 * deliberately names no id.
 *
 * A module-level helper rather than inline, because a "use server" file may
 * only EXPORT async functions — a non-exported synchronous one is fine.
 */
function triageErrorPath(
  error: TriageOutcomeCode,
  mediaId: string,
): string {
  return `${CURATION_PATH}?error=${error}&edit=${encodeURIComponent(mediaId)}`;
}
