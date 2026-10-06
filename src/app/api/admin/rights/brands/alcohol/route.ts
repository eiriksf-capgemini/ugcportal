import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { requireAdminAccess } from "@/lib/admin";
import { recordBrandAlcoholLinked } from "@/lib/benefit-source";
import { expectedOrigin, isSameOriginRequest } from "@/lib/origin";
import { readCappedFormData } from "@/lib/request-body";
import { RIGHTS_BRANDS_PATH } from "@/lib/routes";

/**
 * Record a brand as alcohol-linked (ugcportal-mqh8). The one and only route
 * that may write `BenefitSource.alcoholLinked = true` — see
 * `recordBrandAlcoholLinked` (src/lib/benefit-source.ts) for why PUT
 * /api/media/[id]/disclosure cannot be that route.
 *
 * A SINGLE MONOTONE ACTION, and the form this posts for has no field for
 * the opposite one. There is no "value" in the request body this route
 * reads other than which brand — `recordBrandAlcoholLinked` never writes
 * anything but `true`, so there is no way to ask this endpoint for a `false`
 * even by hand-crafting the POST.
 *
 * 401/403, NOT the 403-for-both collapse `requireAdmin` gives every other
 * admin route in this product. `requireAdminAccess`'s own docstring is the
 * reason: this is the one surface this bead's acceptance criteria name the
 * split for by status code, not a general change of policy — see that
 * function before reusing this shape elsewhere.
 *
 * Progressive enhancement, same as RIGHTS_DECISION_PATH: the brand list's
 * form posts here with no JavaScript, and this redirects back to it exactly
 * the way that route does.
 */

// The body is one field: a cuid. Nowhere near large enough to need a file
// upload's generosity.
const MAX_BODY_BYTES = 2048;

/**
 * Send the admin back to the brand list.
 *
 * `no-store` for the same reason `settingsRedirect` in
 * src/app/api/admin/rights/decision/route.ts states at length (ugcportal-98rb):
 * the Location this builds encodes a one-shot outcome, and a cached 303
 * replayed onto a later POST would report a decision that is not the one
 * just made.
 */
function brandsRedirect(
  request: Request,
  params: { error?: string; recorded?: string } = {},
): NextResponse {
  const url = new URL(RIGHTS_BRANDS_PATH, expectedOrigin() ?? request.url);
  if (params.error) {
    url.searchParams.set("error", params.error);
  }
  if (params.recorded) {
    url.searchParams.set("recorded", params.recorded);
  }
  return NextResponse.redirect(url, {
    status: 303,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const access = await requireAdminAccess();
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  // Same second lock the decision and price routes take: SameSite=Lax means
  // a cross-site POST arrives uncredentialed and the gate above already
  // refuses it, but a route handler gets no framework-level CSRF check of
  // its own.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await readCappedFormData(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const formData = body.value;

  // Named `brandId` on the wire rather than `benefitSourceId`: this request
  // names a brand to answer a question about, which is all this screen is
  // for, not a benefit being attached to anything — the distinction
  // src/lib/alcohol-commerce.write-paths.test.ts draws between an
  // item-attachment write and everything else.
  const brandId = formData.get("brandId");
  if (typeof brandId !== "string" || !brandId) {
    return brandsRedirect(request, { error: "brand_id_missing" });
  }

  const outcome = await recordBrandAlcoholLinked(brandId, access.session.user.id);

  if (outcome === "not-found") {
    return brandsRedirect(request, { error: "brand_not_found" });
  }

  // "recorded" and "already-recorded" both land here with no `?error=`: the
  // second is not a failure, it is the monotone guard doing its job on a
  // brand an admin (possibly a different one, in another tab) already
  // answered — see recordBrandAlcoholLinked's own docstring.
  revalidatePath(RIGHTS_BRANDS_PATH);
  return brandsRedirect(request, { recorded: "1" });
}
