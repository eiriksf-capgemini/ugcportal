import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin";
import { isSameOriginRequest } from "@/lib/origin";
import {
  PRISMA_RECORD_NOT_FOUND,
  prismaErrorCode,
} from "@/lib/prisma-errors";
import { readJsonBody } from "@/lib/request-body";
import { prisma } from "@/lib/prisma";
import { MEDIA_GATE_SELECT, evaluateSellability } from "@/lib/resale-rights";

// App Router hands dynamic segments in as a Promise (Next 16).
type RouteContext = { params: Promise<{ id: string }> };

// Two numbers and a currency code. Anything larger is not this request.
const MAX_BODY_BYTES = 1024;

// 10 000 000 minor units — NOK 100 000. A ceiling exists so a fat finger or a
// tampered client can't record a price that later becomes a charge; the
// number itself is a placeholder for whatever ugcportal-p3v settles on.
const MAX_PRICE_CENTS = 10_000_000;

// Kept to currencies the checkout work (ugcportal-p3v) will actually
// support, so a price can't be recorded in a currency nothing can charge.
const SUPPORTED_CURRENCIES = new Set(["NOK", "EUR", "USD"]);

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
    if (priceCents < 0 || priceCents > MAX_PRICE_CENTS) {
      return {
        ok: false,
        error: `priceCents must be between 0 and ${MAX_PRICE_CENTS}`,
      };
    }
  }

  if (currency !== undefined) {
    if (typeof currency !== "string" || !SUPPORTED_CURRENCIES.has(currency)) {
      return { ok: false, error: "Unsupported currency" };
    }
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
 * Three refusals, deliberately distinct:
 *   403 — not an admin. Same answer for signed-out and signed-in non-admin.
 *   404 — no such listing.
 *   422 — the listing exists and the caller is allowed, but its uploader has
 *         no current resale-rights clearance, or the upload itself is not
 *         triaged. The request is well-formed; the state forbids it.
 *
 * `{"priceCents": null}` — un-pricing — is **not** gated. The gate exists to
 * stop things being offered for sale; refusing to *withdraw* an offer would
 * point it backwards, and would strand a price on exactly the uploaders that
 * just lost their clearance. An admin can always take something off sale.
 *
 * The gate read and the write share a transaction. Note honestly what that
 * does and does not buy: `@prisma/adapter-libsql` opens SQLite transactions
 * as `deferred` (the known issue recorded on ugcportal-lu7 about
 * src/lib/roles.ts), so this does not serialise against a concurrent
 * revocation — a revoke committing between the read and the write can leave
 * a price set on a no-longer-cleared upload. Two things make that survivable,
 * and both are load-bearing: a price is not a sale, because the catalogue and
 * checkout evaluate this same gate again at render and at payment (Part E.3,
 * and an acceptance criterion on ugcportal-74w and ugcportal-p3v); and the
 * stale price really can be cleared afterwards, because un-pricing is
 * ungated.
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

  const unpricing = parsed.value.priceCents === null;

  const result = await prisma.$transaction(async (tx) => {
    // Read from the Media side, not the listing side, and with the shared
    // select rather than a local one. That is what makes the clearance this
    // endpoint checks the clearance of the file's own uploader: the path
    // from the file to its review lives in MEDIA_GATE_SELECT, so there is
    // nothing here that could point somewhere else. One query, no reshaping.
    const upload = await tx.media.findFirst({
      where: { listing: { id } },
      select: MEDIA_GATE_SELECT,
    });
    // No listing with that id — or, impossible behind the foreign key but
    // answered the same way, no file behind it.
    if (!upload) {
      return { kind: "not_found" } as const;
    }

    if (!unpricing) {
      const gate = evaluateSellability(upload);
      if (!gate.sellable) {
        return { kind: "blocked", blocker: gate.blocker } as const;
      }
    }

    try {
      const updated = await tx.mediaListing.update({
        where: { id },
        data: {
          priceCents: parsed.value.priceCents,
          // Currency is only meaningful alongside a price, and applying it
          // on an un-pricing call would be a write the gate never checked.
          ...(!unpricing && parsed.value.currency
            ? { currency: parsed.value.currency }
            : {}),
        },
        select: { id: true, priceCents: true, currency: true },
      });
      return { kind: "ok", post: updated } as const;
    } catch (error) {
      // The gate read above and this write are not serialised (deferred
      // transactions again), so the listing can be deleted in between. That is
      // the same 404 the caller would have got a moment earlier, not a
      // server fault — and answering it as one on an endpoint that maps
      // 403/404/422 deliberately would be the odd one out.
      if (prismaErrorCode(error) === PRISMA_RECORD_NOT_FOUND) {
        return { kind: "not_found" } as const;
      }
      throw error;
    }
  });

  if (result.kind === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (result.kind === "blocked") {
    // The blocker code is one of a closed set (SellabilityBlocker), safe to
    // hand back: it tells an admin which step of the checklist is missing,
    // and this endpoint is admin-only anyway.
    return NextResponse.json(
      { error: "Not sellable", blocker: result.blocker },
      { status: 422 },
    );
  }

  return NextResponse.json(result.post);
}
