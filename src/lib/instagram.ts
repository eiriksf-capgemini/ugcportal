// Thin client for "Instagram API with Instagram Login" — the flow where an
// Instagram Business/Creator account authorises this app directly, rather
// than being reached through a linked Facebook Page. That matters here
// because ugcportal connects *several* content accounts under one admin
// (ugcportal-5ce), which the Page-linked flow does not model cleanly.
//
// Deliberately separate from Auth.js: the Facebook provider in
// src/lib/auth.ts answers "who is signed in", while these tokens answer
// "whose content may we pull" (ugcportal-ct0). Conflating them would make
// signing in with a different account silently repoint the content source.

import { INSTAGRAM_CALLBACK_PATH } from "@/lib/routes";

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_URL = "https://graph.instagram.com";

// Read access to the account's profile and media, which is all the sync job
// (ugcportal-ct0) needs. Overridable so a deployment can widen scopes
// without a code change, but the default stays least-privilege.
const DEFAULT_SCOPES = "instagram_business_basic";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getRedirectUri(): string {
  const explicit = process.env.INSTAGRAM_REDIRECT_URI;
  if (explicit) {
    return explicit;
  }
  // Meta matches redirect URIs exactly, so derive from the same base URL the
  // Auth.js callbacks already use rather than from the inbound request host
  // (which a Host header can forge).
  return new URL(INSTAGRAM_CALLBACK_PATH, requireEnv("AUTH_URL")).toString();
}

/**
 * Whether cookies in this flow must carry `Secure`. Derived from the
 * registered callback URL rather than the inbound request: behind a
 * TLS-terminating proxy that doesn't set `x-forwarded-proto`, `request.url`
 * reads as http and would silently drop `Secure` on a production HTTPS site.
 */
export function isCallbackSecure(): boolean {
  return new URL(getRedirectUri()).protocol === "https:";
}

export function getScopes(): string {
  return process.env.INSTAGRAM_SCOPES || DEFAULT_SCOPES;
}

export function buildAuthorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", requireEnv("INSTAGRAM_CLIENT_ID"));
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", getScopes());
  url.searchParams.set("state", state);
  return url.toString();
}

export type ShortLivedToken = {
  accessToken: string;
  instagramUserId: string;
  permissions: string;
};

export type LongLivedToken = {
  accessToken: string;
  /** Absolute expiry, derived from the API's relative `expires_in`. */
  expiresAt: Date;
};

export type InstagramProfile = {
  id: string;
  username: string;
};

async function readError(response: Response): Promise<string> {
  // Meta returns JSON errors, but an edge/proxy failure can return HTML.
  // Cap the length so a stray error page doesn't end up in the logs whole.
  const body = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`;
}

/** Step 1: trade the one-time `code` for a ~1 hour token. */
export async function exchangeCodeForShortLivedToken(
  code: string,
): Promise<ShortLivedToken> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("INSTAGRAM_CLIENT_ID"),
      client_secret: requireEnv("INSTAGRAM_CLIENT_SECRET"),
      grant_type: "authorization_code",
      redirect_uri: getRedirectUri(),
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`Instagram code exchange failed: ${await readError(response)}`);
  }

  const body = await response.json();

  // Business Login for Instagram wraps the payload in a `data` array:
  //   { "data": [ { access_token, user_id, permissions } ] }
  // The older Basic Display API returned those fields flat. Accept either,
  // because reading only the flat shape silently burns the one-time code on
  // every real connect attempt — and a mocked test can't tell you that.
  const payload = Array.isArray(body?.data) ? body.data[0] : body;

  if (!payload?.access_token || payload?.user_id === undefined) {
    throw new Error("Instagram code exchange returned no access token");
  }

  return {
    accessToken: String(payload.access_token),
    // `user_id` can arrive as a JSON number, which can't hold every Instagram
    // id exactly — the value has already been through JSON.parse by now, so
    // stringify it to at least stop anything downstream doing arithmetic.
    instagramUserId: String(payload.user_id),
    permissions: Array.isArray(payload.permissions)
      ? payload.permissions.join(",")
      : String(payload.permissions ?? getScopes()),
  };
}

/** Step 2: upgrade to the ~60 day token the sync job actually runs on. */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
): Promise<LongLivedToken> {
  const url = new URL("/access_token", GRAPH_URL);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", requireEnv("INSTAGRAM_CLIENT_SECRET"));
  url.searchParams.set("access_token", shortLivedToken);

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(
      `Instagram long-lived token exchange failed: ${await readError(response)}`,
    );
  }

  const data = await response.json();
  if (!data?.access_token || typeof data?.expires_in !== "number") {
    throw new Error("Instagram long-lived token exchange returned no token");
  }

  return {
    accessToken: String(data.access_token),
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

/** Step 3: resolve the handle, so the settings list shows something humans recognise. */
export async function fetchInstagramProfile(
  accessToken: string,
): Promise<InstagramProfile> {
  const url = new URL("/me", GRAPH_URL);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Instagram profile lookup failed: ${await readError(response)}`);
  }

  const data = await response.json();
  if (!data?.id || !data?.username) {
    throw new Error("Instagram profile lookup returned no id/username");
  }

  return { id: String(data.id), username: String(data.username) };
}
