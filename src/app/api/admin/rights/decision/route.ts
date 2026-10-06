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
import { RIGHTS_SETTINGS_PATH } from "@/lib/routes";
import {
  ObjectStorageUnreachableError,
  objectStorageUnreachableLogFields,
} from "@/lib/s3";

/**
 * Record a resale-rights decision for one uploader (ugcportal-0ss, checklist
 * Part E; re-anchored from connected accounts to uploaders by
 * ugcportal-vsm). This is the *only* path that can write status = CLEARED.
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

/**
 * Send the admin back to the settings screen.
 *
 * `reopenFor` is the uploader whose form should be open when they land, and
 * it is only omitted on success. The settings page renders the decision form
 * for whoever `?edit=` names, so a redirect without it drops the admin on a
 * long list with the form closed and nothing saying which uploader the error
 * was about — after they had typed a reason and picked an expiry. That was a
 * regression against ugcportal-0ss, where the form was rendered inline per
 * account and an error put you back in front of it.
 *
 * On success the form is deliberately left closed: the decision is recorded,
 * and re-opening the form for a record that has just been written invites
 * submitting it twice.
 *
 * The typed reason is deliberately NOT carried back. It is free text that
 * may quote contract terms or name people, and a query parameter lands in
 * server logs, proxy logs, browser history and `Referer` headers. Losing a
 * sentence the admin retypes is the cheaper failure; see ugcportal-40s.
 */
function settingsRedirect(
  request: Request,
  params: { error?: string; rights?: string; reopenFor?: string } = {},
): NextResponse {
  // Resolved against the configured public origin, not `request.url` — which
  // behind a TLS-terminating proxy is the internal host, exactly the trap
  // src/lib/origin.ts exists to point out. Sending that back as an absolute
  // Location would bounce the admin to an address the browser cannot reach.
  // `request.url` is the fallback for a dev server with no AUTH_URL set,
  // where the two are the same thing anyway.
  const url = new URL(RIGHTS_SETTINGS_PATH, expectedOrigin() ?? request.url);
  // URLSearchParams rather than string concatenation: a uploader id is a
  // cuid today, but a value spliced into a query string raw is one schema
  // change away from being an injection into the admin's own URL.
  if (params.error) {
    url.searchParams.set("error", params.error);
  }
  if (params.rights) {
    url.searchParams.set("rights", params.rights);
  }
  if (params.reopenFor) {
    url.searchParams.set("edit", params.reopenFor);
  }

  // 303: the browser must follow a POST redirect with GET, or the settings
  // page is re-requested as a POST.
  //
  // `no-store` (ugcportal-98rb): a 303 is not cacheable by default, so this
  // changes nothing for a conforming cache — it is here for the ones that
  // are not, and because the Location this carries encodes a one-shot
  // outcome (`?error=`, `?rights=recorded`, `?edit=<uploader>`). A stored
  // copy of any of those replayed onto a later POST would send the admin to
  // a screen reporting a decision that is not the one they just made.
  return NextResponse.redirect(url, {
    status: 303,
    headers: { "cache-control": "no-store" },
  });
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
      // No uploader to reopen for: the body was refused before any field of
      // it was read, which is the entire point of the cap.
      return settingsRedirect(request, { error: "rights_evidence_too_large" });
    }
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const formData = body.value;

  // Whose uploads this decision is about. Not validated against the user
  // table here: setResaleRightsStatus reads the row inside its transaction
  // and writes this as a foreign key, so a made-up id is refused there (and
  // reported as `uploader_not_found`) rather than by a check that could
  // drift from it.
  const uploaderUserId = formData.get("uploaderUserId");
  if (typeof uploaderUserId !== "string" || !uploaderUserId) {
    return NextResponse.json({ error: "Missing uploader id" }, { status: 400 });
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
    return settingsRedirect(request, {
      error: "rights_reason_required",
      reopenFor: uploaderUserId,
    });
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
      return settingsRedirect(request, {
        error: "rights_invalid_valid_until",
        reopenFor: uploaderUserId,
      });
    }
    validUntil = parsed;
  } else {
    // null (blank, clear it) or undefined (absent, leave it) — both pass
    // straight through to the writer, which understands the difference.
    validUntil = validUntilValue;
  }

  const conditions = optionalField(formData, "conditions");

  // Uploaded before the status write, so a failed upload leaves no clearance
  // claiming evidence that isn't there. The cost of this ordering is the
  // other kind of orphan: if the write below is then refused, the object
  // stays in the bucket unreferenced. That is the cheaper failure — an
  // unreferenced private file, rather than a clearance pointing at nothing.
  let evidence: { key: string; sha256: string } | undefined;
  const file = formData.get("evidence");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_EVIDENCE_BYTES) {
      return settingsRedirect(request, {
        error: "rights_evidence_too_large",
        reopenFor: uploaderUserId,
      });
    }
    try {
      evidence = await putRightsEvidence({
        uploaderUserId,
        filename: file.name,
        body: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type,
      });
    } catch (cause) {
      if (cause instanceof ObjectStorageUnreachableError) {
        // ugcportal-98rb K2. A redirect, not a 503, and that is the bead's
        // own acceptance criterion rather than a softening of it: this
        // endpoint is posted to by a plain HTML form with no JavaScript (see
        // this file's top doc comment), so a 503 JSON body would be rendered
        // to the admin as a raw error document with their typed reason lost
        // and no way back. What K2 asks for is that the outage be
        // DISTINGUISHABLE, and the distinct `?error=` code is what carries
        // that here — `rights_storage_unavailable` means "come back in a
        // moment", `rights_evidence_failed` means "this will keep failing
        // until someone looks at the logs". Each has its own sentence in
        // src/app/admin/settings/rights/outcomes.ts.
        //
        // Nothing is written either way: `setResaleRightsStatus` is below
        // this block and is never reached, so no ResaleRightsReview row
        // changes and no clearance ends up naming evidence that was never
        // stored.
        //
        // Not throttled, unlike the preview route's line: this is an
        // admin-only form submission, so the volume ceiling is however fast
        // one human can resubmit a form, and each line names the uploader
        // the attempt was about.
        console.error("[resale-rights] object storage unreachable", {
          uploaderUserId,
          ...objectStorageUnreachableLogFields(cause),
        });
        return settingsRedirect(request, {
          error: "rights_storage_unavailable",
          reopenFor: uploaderUserId,
        });
      }
      console.error("[resale-rights] evidence upload failed", {
        uploaderUserId,
        cause,
      });
      return settingsRedirect(request, {
        error: "rights_evidence_failed",
        reopenFor: uploaderUserId,
      });
    }
  }

  let result;
  try {
    result = await setResaleRightsStatus(uploaderUserId, {
      source: "ADMIN",
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      status,
      reason,
      route,
      validUntil,
      conditions,
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

  revalidatePath(RIGHTS_SETTINGS_PATH);

  // Closed set, mapped exhaustively rather than with a default, so a new
  // outcome fails to compile here instead of silently reporting success.
  const FAILURE_CODES = {
    uploader_not_found: "rights_uploader_not_found",
    // The session said ADMIN but the database disagrees — the role was
    // revoked between sign-in and now.
    actor_not_admin: "rights_actor_not_admin",
    conflict: "rights_conflict",
    // A user this decision names — the uploader, or the reviewer — was
    // deleted before the write landed.
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
    return settingsRedirect(request, {
      error: code,
      // Including rights_uploader_not_found: the page explains a ?edit=
      // naming nobody, which is more use than a list with no form.
      reopenFor: uploaderUserId,
    });
  }
  // Redirect on success too, so a stale `?error=` from a previous attempt
  // doesn't stay pinned to the URL after a decision that worked.
  return settingsRedirect(request, { rights: "recorded" });
}
