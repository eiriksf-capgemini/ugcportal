import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin";
import { isSameOriginRequest } from "@/lib/origin";
import { readJsonBody } from "@/lib/request-body";
import { recordPrice } from "@/lib/curation-price-write";
import {
  MAX_PRICE_CENTS,
  isStorablePriceCents,
  isSupportedCurrency,
} from "@/lib/pricing";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

// Two numbers and a currency code. Anything larger is not this request.
const MAX_BODY_BYTES = 1024;

// The ceiling and the currency allowlist both live in
// src/lib/pricing.ts now (ugcportal-yzo7), shared by this route, the admin
// form and the single write they all bound. This route used to own both, which was fine while it was
// the only entry point; the admin curation screen is a second one, and a
// bound enforced at one of two entry points is not a bound. What stays here
// is the HTTP-shaped half: what a malformed BODY is, and which sentence a
// caller gets for it.

type PriceInput = { priceCents: number | null; currency?: string };
type ParseResult =
  | { ok: true; value: PriceInput }
  | { ok: false; error: string };

/**
 * Pulls the two writable fields off the body. Unknown fields are ignored and
 * nothing from the body is ever spread into Prisma — in particular the
 * triage columns, which decide sellability, are not settable here.
 */
function parsePriceInput(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Expected a JSON object body" };
  }

  const { priceCents, currency } = body as {
    priceCents?: unknown;
    currency?: unknown;
  };

  // `null` is how a price is removed (un-pricing an item). `undefined` is a
  // caller who forgot the field, which is a malformed request rather than a
  // request to clear the price.
  if (priceCents !== null) {
    if (typeof priceCents !== "number" || !Number.isSafeInteger(priceCents)) {
      // Rejects NaN, Infinity, 19.99 and "1000" alike: money is integer
      // minor units, and a float here becomes a rounding argument later.
      return { ok: false, error: "priceCents must be an integer or null" };
    }
    // The range half is `isStorablePriceCents` (src/lib/curation-price-write.ts),
    // so this route and the admin screen cannot disagree about the ceiling.
    // The write re-checks it anyway and answers `price_amount_invalid`; this
    // is here to produce the specific sentence a JSON caller gets, which a
    // closed-set refusal code cannot.
    if (!isStorablePriceCents(priceCents)) {
      return {
        ok: false,
        error: `priceCents must be between 0 and ${MAX_PRICE_CENTS}`,
      };
    }
  }

  if (currency !== undefined && !isSupportedCurrency(currency)) {
    return { ok: false, error: "Unsupported currency" };
  }

  return {
    ok: true,
    value: {
      priceCents: priceCents as number | null,
      currency: currency as string | undefined,
    },
  };
}

/**
 * Set (or clear) the price on one listed upload — the price-setting endpoint
 * ugcportal-0ss K1 gates and ugcportal-74w will drive from its UI. `[id]` is
 * a MediaListing id (ugcportal-vsm renamed the model from CuratedPost; the
 * endpoint's contract is unchanged).
 *
 * Four refusals, deliberately distinct:
 *   403 — not an admin. Same answer for signed-out and signed-in non-admin.
 *   400 — the body is not a well-formed price.
 *   404 — no such listing.
 *   422 — the listing exists and the caller is allowed, but its uploader has
 *         no current resale-rights clearance, the upload itself is not
 *         triaged, or it has no watermarked preview (ugcportal-yzo7 K3). The
 *         request is well-formed; the state forbids it.
 *
 * `{"priceCents": null}` — un-pricing — is **not** gated. The gate exists to
 * stop things being offered for sale; refusing to *withdraw* an offer would
 * point it backwards, and would strand a price on exactly the uploaders that
 * just lost their clearance. An admin can always take something off sale.
 *
 * NOT THE PLACE THE RULES LIVE ANY MORE (ugcportal-yzo7). The gate read, the
 * preview check and the update are `recordPrice`
 * (src/lib/curation-price-write.ts), because the admin curation screen is now
 * a second entry point for the same write and three conditions spelled at two
 * entry points is how one of them comes to be missing the third. What stays
 * here is HTTP: who may call it, what a malformed body is, and which status
 * each outcome maps to.
 *
 * WHAT A STORED PRICE DOES NOT MEAN. An earlier version of this comment
 * justified an unserialised transaction here by saying "the catalogue and
 * checkout evaluate this same gate again at render and at payment". Neither
 * existed when that was written (PR #196, review round 1). Half of it exists
 * now: `src/lib/sellable-media.ts` re-evaluates the gate at RENDER, so a
 * clearance that lapses after this endpoint ran removes the offer with no
 * write at all. Checkout (ugcportal-p3v) still does not exist, and nothing
 * here should be read as saying it does.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Same second lock as the decision handler: SameSite=Lax means a
  // cross-site POST arrives uncredentialed and requireAdmin refuses it
  // first, but a route handler gets no framework-level check and this one
  // moves money-adjacent state.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const parsed = parsePriceInput(body.value);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // The gate, the preview check and the write all live in `recordPrice`
  // (src/lib/curation-price-write.ts, ugcportal-yzo7), which the admin
  // curation screen's `setPrice` action also calls. This route used to spell
  // the gate read and the update inline; two entry points spelling the same
  // three conditions is how one of them comes to be missing the third.
  const outcome = await recordPrice({
    target: { listingId: id },
    priceCents: parsed.value.priceCents,
    currency: parsed.value.currency,
  });

  if (outcome.kind === "price_media_not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (outcome.kind === "price_no_preview") {
    // 422 rather than 404 or 409: the listing exists and the caller is
    // allowed, and the state forbids the request. `blocker` carries a code
    // from the same closed set the UI reads, so an admin is told which step
    // is missing rather than being handed a generic refusal.
    return NextResponse.json(
      {
        error:
          "Not sellable: this upload has no watermarked preview, so pricing it would offer the unprotected original.",
        blocker: "no_preview",
      },
      { status: 422 },
    );
  }
  if (outcome.kind === "price_amount_invalid") {
    // Unreachable through `parsePriceInput` above, which refuses the same
    // values with a more specific sentence first. Here because the write's
    // outcome is a closed set and silently falling through a member of it
    // would be a fail-open on the one endpoint that writes money.
    return NextResponse.json(
      { error: "priceCents must be an integer or null" },
      { status: 400 },
    );
  }
  if (outcome.kind === "price_not_sellable") {
    // The blocker code is one of a closed set (SellabilityBlocker), safe to
    // hand back: it tells an admin which step of the checklist is missing,
    // and this endpoint is admin-only anyway.
    return NextResponse.json(
      { error: "Not sellable", blocker: outcome.blocker },
      { status: 422 },
    );
  }

  // The same three fields this endpoint has always echoed, rebuilt from the
  // write's own outcome rather than from a second read.
  return NextResponse.json({
    id: outcome.listingId,
    priceCents: outcome.kind === "priced" ? outcome.priceCents : null,
    currency: outcome.currency,
  });
}
