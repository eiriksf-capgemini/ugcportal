import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin";
import { encryptSecret, safeEquals } from "@/lib/crypto";
import {
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchInstagramProfile,
} from "@/lib/instagram";
import { STATE_COOKIE, STATE_COOKIE_PATH } from "@/lib/instagram-oauth-state";
import { prisma } from "@/lib/prisma";
import { INSTAGRAM_SETTINGS_PATH } from "@/lib/routes";

// Fixed codes rather than the provider's own message: whatever Meta puts in
// `error_description` is attacker-influencable and would end up reflected
// into the settings page.
type Outcome =
  | "connected"
  | "denied"
  | "invalid_state"
  | "missing_code"
  | "exchange_failed";

function settingsRedirect(request: Request, outcome: Outcome) {
  const url = new URL(INSTAGRAM_SETTINGS_PATH, request.url);
  url.searchParams.set(outcome === "connected" ? "connected" : "error", outcome);
  const response = NextResponse.redirect(url);
  // One-shot value: clear it whichever way the flow ended, so a stale state
  // can't be reused by a later callback.
  response.cookies.set(STATE_COOKIE, "", {
    path: STATE_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}

/**
 * Completes the Instagram connect flow (ugcportal-5ce): verifies the CSRF
 * state, exchanges the code for a long-lived token, and stores that token
 * encrypted at rest.
 */
export async function GET(request: Request) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;

  if (params.get("error")) {
    // The admin pressed "Cancel" on Instagram's consent screen.
    return settingsRedirect(request, "denied");
  }

  const expectedState = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);
  const receivedState = params.get("state");

  if (!expectedState || !receivedState || !safeEquals(expectedState, receivedState)) {
    return settingsRedirect(request, "invalid_state");
  }

  const code = params.get("code");
  if (!code) {
    return settingsRedirect(request, "missing_code");
  }

  try {
    const shortLived = await exchangeCodeForShortLivedToken(code);
    const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
    const profile = await fetchInstagramProfile(longLived.accessToken);

    // Upsert rather than create: reconnecting an already-connected account is
    // the normal way to replace a revoked or expired token, and should not
    // collide on the unique instagramUserId. Inside the try because Prisma's
    // upsert isn't atomic — two concurrent callbacks for the same account
    // race to P2002, and SQLite adds SQLITE_BUSY on top. That must end as a
    // redirect like any other failure, not a raw 500 that leaves the
    // one-shot state cookie live for the rest of its 10 minutes.
    const fields = {
      username: profile.username,
      accessTokenEncrypted: encryptSecret(longLived.accessToken),
      tokenExpiresAt: longLived.expiresAt,
      scopes: shortLived.permissions,
      connectedByUserId: session.user.id,
    };

    await prisma.instagramAccount.upsert({
      where: { instagramUserId: profile.id },
      create: { instagramUserId: profile.id, ...fields },
      update: fields,
    });
  } catch (error) {
    // Log for the operator, but don't surface provider text to the browser.
    console.error("Instagram connect failed", error);
    return settingsRedirect(request, "exchange_failed");
  }

  return settingsRedirect(request, "connected");
}
