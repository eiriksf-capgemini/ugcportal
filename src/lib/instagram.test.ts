import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizeUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchInstagramProfile,
  getRedirectUri,
  isCallbackSecure,
} from "@/lib/instagram";

const ENV_KEYS = [
  "AUTH_URL",
  "INSTAGRAM_CLIENT_ID",
  "INSTAGRAM_CLIENT_SECRET",
  "INSTAGRAM_REDIRECT_URI",
  "INSTAGRAM_SCOPES",
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUTH_URL = "http://localhost:3000";
  process.env.INSTAGRAM_CLIENT_ID = "client-id";
  process.env.INSTAGRAM_CLIENT_SECRET = "client-secret";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(response: Partial<Response> & { json?: () => unknown }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    ...response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getRedirectUri", () => {
  it("derives the callback from AUTH_URL", () => {
    expect(getRedirectUri()).toBe(
      "http://localhost:3000/api/admin/instagram/callback",
    );
  });

  it("prefers an explicit override", () => {
    process.env.INSTAGRAM_REDIRECT_URI = "https://ugc.example/cb";
    expect(getRedirectUri()).toBe("https://ugc.example/cb");
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds an authorize URL carrying the state and least-privilege scope", () => {
    const url = new URL(buildAuthorizeUrl("state-123"));

    expect(url.origin + url.pathname).toBe(
      "https://www.instagram.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/admin/instagram/callback",
    );
  });

  it("never puts the client secret in the authorize URL", () => {
    expect(buildAuthorizeUrl("state-123")).not.toContain("client-secret");
  });

  it("throws rather than building a URL with a missing client id", () => {
    delete process.env.INSTAGRAM_CLIENT_ID;
    expect(() => buildAuthorizeUrl("state-123")).toThrow(
      /INSTAGRAM_CLIENT_ID/,
    );
  });
});

describe("isCallbackSecure", () => {
  it("follows the registered callback URL, not the inbound request", () => {
    expect(isCallbackSecure()).toBe(false);

    process.env.INSTAGRAM_REDIRECT_URI = "https://ugc.example/cb";
    expect(isCallbackSecure()).toBe(true);
  });
});

describe("exchangeCodeForShortLivedToken", () => {
  // The shape Business Login for Instagram actually returns. Reading only
  // the flat Basic-Display shape would burn the one-time code every time.
  it("unwraps the `data` array Business Login returns", async () => {
    stubFetch({
      json: async () => ({
        data: [
          {
            access_token: "short-token",
            user_id: "17841400000000000",
            permissions: "instagram_business_basic",
          },
        ],
      }),
    });

    await expect(exchangeCodeForShortLivedToken("the-code")).resolves.toEqual({
      accessToken: "short-token",
      instagramUserId: "17841400000000000",
      permissions: "instagram_business_basic",
    });
  });

  it("throws when the `data` array is present but empty", async () => {
    stubFetch({ json: async () => ({ data: [] }) });

    await expect(exchangeCodeForShortLivedToken("code")).rejects.toThrow(
      /returned no access token/,
    );
  });

  it("still accepts the flat response shape", async () => {
    const fetchMock = stubFetch({
      json: async () => ({
        access_token: "short-token",
        user_id: 17841400000000000,
        permissions: ["instagram_business_basic"],
      }),
    });

    const result = await exchangeCodeForShortLivedToken("the-code");

    expect(result).toEqual({
      accessToken: "short-token",
      instagramUserId: "17841400000000000",
      permissions: "instagram_business_basic",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.instagram.com/oauth/access_token");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body.toString());
    expect(body.get("code")).toBe("the-code");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("client-secret");
  });

  it("throws on a non-OK response", async () => {
    stubFetch({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => '{"error_message":"nope"}',
    });

    await expect(exchangeCodeForShortLivedToken("bad")).rejects.toThrow(
      /Instagram code exchange failed: 400 Bad Request/,
    );
  });

  it("throws when the response carries no access token", async () => {
    stubFetch({ json: async () => ({ user_id: 1 }) });

    await expect(exchangeCodeForShortLivedToken("code")).rejects.toThrow(
      /returned no access token/,
    );
  });
});

describe("exchangeForLongLivedToken", () => {
  it("converts expires_in into an absolute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fetchMock = stubFetch({
      json: async () => ({ access_token: "long-token", expires_in: 5184000 }),
    });

    const result = await exchangeForLongLivedToken("short-token");

    expect(result.accessToken).toBe("long-token");
    expect(result.expiresAt.toISOString()).toBe("2026-03-02T00:00:00.000Z");

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(url.searchParams.get("access_token")).toBe("short-token");
  });

  it("throws when expires_in is missing", async () => {
    stubFetch({ json: async () => ({ access_token: "long-token" }) });

    await expect(exchangeForLongLivedToken("short")).rejects.toThrow(
      /returned no token/,
    );
  });
});

describe("fetchInstagramProfile", () => {
  it("returns the id and username", async () => {
    const fetchMock = stubFetch({
      json: async () => ({ id: "17841400000000000", username: "acme.studio" }),
    });

    await expect(fetchInstagramProfile("long-token")).resolves.toEqual({
      id: "17841400000000000",
      username: "acme.studio",
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/me");
    expect(url.searchParams.get("fields")).toBe("id,username");
  });

  it("throws when the profile is incomplete", async () => {
    stubFetch({ json: async () => ({ id: "1" }) });

    await expect(fetchInstagramProfile("long-token")).rejects.toThrow(
      /returned no id\/username/,
    );
  });
});
