import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin";
import { buildAuthorizeUrl, isCallbackSecure } from "@/lib/instagram";
import {
  STATE_COOKIE,
  createOAuthState,
  stateCookieOptions,
} from "@/lib/instagram-oauth-state";

/**
 * Starts the Instagram connect flow (ugcportal-5ce). Admin-only: a non-admin
 * gets 403 here rather than a redirect, so no OAuth round trip is ever begun
 * on their behalf.
 */
export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const state = createOAuthState();
  const response = NextResponse.redirect(buildAuthorizeUrl(state));
  response.cookies.set(STATE_COOKIE, state, stateCookieOptions(isCallbackSecure()));
  return response;
}
