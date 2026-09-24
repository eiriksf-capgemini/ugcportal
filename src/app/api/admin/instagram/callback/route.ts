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

  let username: string;
  let instagramUserId: string;
  let encryptedToken: string;
  let tokenExpiresAt: Date;
  let scopes: string;

  try {
    const shortLived = await exchangeCodeForShortLivedToken(code);
    const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
    const profile = await fetchInstagramProfile(longLived.accessToken);

    instagramUserId = profile.id;
    username = profile.username;
    scopes = shortLived.permissions;
    tokenExpiresAt = longLived.expiresAt;
    encryptedToken = encryptSecret(longLived.accessToken);
  } catch (error) {
    // Log for the operator, but don't surface provider text to the browser.
    console.error("Instagram connect failed", error);
    return settingsRedirect(request, "exchange_failed");
  }

  // Upsert rather than create: reconnecting an already-connected account is
  // the normal way to replace a revoked or expired token, and should not
  // collide on the unique instagramUserId.
  await prisma.instagramAccount.upsert({
    where: { instagramUserId },
    create: {
      instagramUserId,
      username,
      accessTokenEncrypted: encryptedToken,
      tokenExpiresAt,
      scopes,
      connectedByUserId: session.user.id,
    },
    update: {
      username,
      accessTokenEncrypted: encryptedToken,
      tokenExpiresAt,
      scopes,
      connectedByUserId: session.user.id,
    },
  });

  return settingsRedirect(request, "connected");
}
