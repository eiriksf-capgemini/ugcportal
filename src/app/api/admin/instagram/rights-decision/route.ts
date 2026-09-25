import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import type { ResaleRightsRoute } from "@/generated/prisma/enums";
import { requireAdmin } from "@/lib/admin";
import { expectedOrigin, isSameOriginRequest } from "@/lib/origin";
import { readCappedFormData } from "@/lib/request-body";
import { isResaleRightsRoute, isResaleRightsStatus } from "@/lib/resale-rights";
import { setResaleRightsStatus } from "@/lib/resale-rights-review";
import {
  deleteRightsEvidence,
  putRightsEvidence,
} from "@/lib/rights-evidence";
import { INSTAGRAM_SETTINGS_PATH } from "@/lib/routes";

/**
 * Record a resale-rights decision for one connected account (ugcportal-0ss,
 * checklist Part E). This is the *only* path that can write
 * status = CLEARED.
 *
 * A route handler rather than a server action, which is the unusual choice
 * here and the deliberate one. The decision can carry an evidence file, and
 * the only lever for a server-action body over 1 MB is
 * `experimental.serverActions.bodySizeLimit` — which is global, and which
 * the framework applies *before* any action code runs. Raising it to fit a
 * 20 MB contract would have let an anonymous caller make the server buffer
 * 21 MB against any action id in the app, including the sign-in ones: a
 * denial-of-service surface opened by an admin-only feature. A route handler
 * owns its own limit and imposes it on nobody else.
 *
 * Progressive enhancement is preserved: the form posts here directly, with
 * no JavaScript, and this redirects back to the settings page the way the
 * server action did.
 */

// A scanned contract or a filled-in checklist. Generous enough for a PDF
// with signature pages, small enough to hold in memory — and, unlike the
// server-action limit it replaces, scoped to this endpoint alone.
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;

/** The form's own fields are tiny; the file is the only bulk. */
const MAX_BODY_BYTES = MAX_EVIDENCE_BYTES + 64 * 1024;

function settingsRedirect(request: Request, query = ""): NextResponse {
  // Resolved against the configured public origin, not `request.url` — which
  // behind a TLS-terminating proxy is the internal host, exactly the trap
  // src/lib/origin.ts exists to point out. Sending that back as an absolute
  // Location would bounce the admin to an address the browser cannot reach.
  // `request.url` is the fallback for a dev server with no AUTH_URL set,
  // where the two are the same thing anyway.
  //
  // 303: the browser must follow a POST redirect with GET, or the settings
  // page is re-requested as a POST.
  return NextResponse.redirect(
    new URL(`${INSTAGRAM_SETTINGS_PATH}${query}`, expectedOrigin() ?? request.url),
    303,
  );
}

/**
 * Reads one optional form field with the same three-way meaning the writer
 * uses: **absent** leaves the stored value alone, **blank** clears it, a
 * value sets it.
 *
 * `formData.get()` alone collapses the first two into `null`, which is how
 * `validUntil` became a fail-open twice: a POST that simply omits the field
 * — a partial request, a future form that drops it — silently cleared a
 * clearance's expiry. The form's `defaultValue` is what stopped that in a
 * browser, but the handler should not depend on its own UI being the only
 * caller. One helper for every optional field, so the next one added gets
 * the same semantics without anyone remembering to ask for them.
 */
function optionalField(
  formData: FormData,
  name: string,
): string | null | undefined {
  if (!formData.has(name)) {
    return undefined;
  }
  const raw = formData.get(name);
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === "" ? null : value;
}

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) {
    // JSON, not a redirect: a non-admin should learn nothing about the
    // screen this belongs to. Matches the connect route.
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await readCappedFormData(request, MAX_BODY_BYTES);
  if (!body.ok) {
    if (body.status === 413) {
      return settingsRedirect(request, "?error=rights_evidence_too_large");
    }
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const formData = body.value;

  const instagramAccountId = formData.get("instagramAccountId");
  if (typeof instagramAccountId !== "string" || !instagramAccountId) {
    return NextResponse.json({ error: "Missing account id" }, { status: 400 });
  }

  const status = formData.get("status");
  if (!isResaleRightsStatus(status)) {
    // Not a user-facing state: every value the form can submit is a member
    // of the enum, so anything else is a tampered request.
    return NextResponse.json(
      { error: "Unknown resale-rights status" },
      { status: 400 },
    );
  }

  const routeValue = optionalField(formData, "route");
  if (routeValue != null && !isResaleRightsRoute(routeValue)) {
    return NextResponse.json(
      { error: "Unknown resale-rights route" },
      { status: 400 },
    );
  }
  const route = routeValue as ResaleRightsRoute | null | undefined;

  const reasonValue = formData.get("reason");
  const reason = typeof reasonValue === "string" ? reasonValue.trim() : "";
  if (!reason) {
    return settingsRedirect(request, "?error=rights_reason_required");
  }

  // An unticked checkbox submits nothing at all, so absence is "no" — which
  // is the safe reading: the stored checklist version stays as it is, and a
  // clearance granted under a retired version is not quietly revalidated by
  // an edit to some other field.
  const restampChecklist = formData.get("restampChecklist") === "yes";

  const validUntilValue = optionalField(formData, "validUntil");
  let validUntil: Date | null | undefined;
  if (validUntilValue != null) {
    // A date input submits YYYY-MM-DD, which Date parses as midnight UTC —
    // so the clearance stops counting at the *start* of the chosen day, not
    // the end of it. Left that way deliberately: of the two readings, it is
    // the one that stops selling sooner.
    const parsed = new Date(validUntilValue);
    if (Number.isNaN(parsed.getTime())) {
      return settingsRedirect(request, "?error=rights_invalid_valid_until");
    }
    validUntil = parsed;
  } else {
    // null (blank, clear it) or undefined (absent, leave it) — both pass
    // straight through to the writer, which understands the difference.
    validUntil = validUntilValue;
  }

  const conditions = optionalField(formData, "conditions");

  // Whose uploads this clearance covers. Not validated against the user
  // table here: setResaleRightsStatus writes it as a foreign key, so a made
  // up id is refused by the database (and reported as `missing_reference`)
  // rather than by a check that could drift from it. A blank value clears
  // it, and a CLEARED review without one authorises nothing (see
  // accountClearanceBlocker).
  const clearedOwnerUserId = optionalField(formData, "clearedOwnerUserId");

  // Uploaded before the status write, so a failed upload leaves no clearance
  // claiming evidence that isn't there. The cost of this ordering is the
  // other kind of orphan: if the write below is then refused, the object
  // stays in the bucket unreferenced. That is the cheaper failure — an
  // unreferenced private file, rather than a clearance pointing at nothing.
  let evidence: { key: string; sha256: string } | undefined;
  const file = formData.get("evidence");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_EVIDENCE_BYTES) {
      return settingsRedirect(request, "?error=rights_evidence_too_large");
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
      return settingsRedirect(request, "?error=rights_evidence_failed");
    }
  }

  let result;
  try {
    result = await setResaleRightsStatus(instagramAccountId, {
      source: "ADMIN",
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      status,
      reason,
      route,
      validUntil,
      conditions,
      clearedOwnerUserId,
      evidence,
      restampChecklist,
    });
  } catch (error) {
    // An error the writer deliberately re-throws — a real fault rather than
    // a lost race. It still leaves an uploaded contract with nothing
    // pointing at it, which is the case the cleanup below exists for, so do
    // it here too and then let the fault surface unchanged.
    if (evidence) {
      await deleteRightsEvidence(evidence.key);
    }
    throw error;
  }

  revalidatePath(INSTAGRAM_SETTINGS_PATH);

  // Closed set, mapped exhaustively rather than with a default, so a new
  // outcome fails to compile here instead of silently reporting success.
  const FAILURE_CODES = {
    account_not_found: "rights_account_not_found",
    // The session said ADMIN but the database disagrees — the role was
    // revoked between sign-in and now.
    actor_not_admin: "rights_actor_not_admin",
    conflict: "rights_conflict",
    // The rights holder named on the form was deleted before the write.
    missing_reference: "rights_holder_missing",
    forbidden_system_transition: "rights_conflict",
  } as const;

  if (result.outcome in FAILURE_CODES) {
    const code = FAILURE_CODES[result.outcome as keyof typeof FAILURE_CODES];
    // Nothing was recorded, so an evidence file uploaded moments ago has
    // nothing pointing at it. Remove it rather than leaving a contract or a
    // model release sitting in the bucket unreferenced.
    if (evidence) {
      await deleteRightsEvidence(evidence.key);
    }
    return settingsRedirect(request, `?error=${code}`);
  }
  // Redirect on success too, so a stale `?error=` from a previous attempt
  // doesn't stay pinned to the URL after a decision that worked.
  return settingsRedirect(request, "?rights=recorded");
}
