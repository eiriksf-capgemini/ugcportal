import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { decryptSecret, TOKEN_ENCRYPTION_KEY_ENV } from "@/lib/crypto";
import { STATE_COOKIE } from "@/lib/instagram-oauth-state";

const authMock = vi.fn();
const upsertMock = vi.fn();
const exchangeCodeMock = vi.fn();
const exchangeLongLivedMock = vi.fn();
const fetchProfileMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));
vi.mock("@/lib/prisma", () => ({
  prisma: { instagramAccount: { upsert: upsertMock } },
}));
vi.mock("@/lib/instagram", () => ({
  exchangeCodeForShortLivedToken: exchangeCodeMock,
  exchangeForLongLivedToken: exchangeLongLivedMock,
  fetchInstagramProfile: fetchProfileMock,
}));

const { GET } = await import("@/app/api/admin/instagram/callback/route");

const STATE = "state-value-abc";
const LONG_LIVED_TOKEN = "IGQV-long-lived-token";

beforeEach(() => {
  authMock.mockReset();
  upsertMock.mockReset().mockResolvedValue({});
  exchangeCodeMock.mockReset().mockResolvedValue({
    accessToken: "short-token",
    instagramUserId: "17841400000000000",
    permissions: "instagram_business_basic",
  });
  exchangeLongLivedMock.mockReset().mockResolvedValue({
    accessToken: LONG_LIVED_TOKEN,
    expiresAt: new Date("2026-11-23T00:00:00.000Z"),
  });
  fetchProfileMock.mockReset().mockResolvedValue({
    id: "17841400000000000",
    username: "acme.studio",
  });
  process.env[TOKEN_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64");
});

function callback({
  state = STATE,
  cookieState = STATE,
  code = "the-code",
  error,
}: {
  state?: string | null;
  cookieState?: string | null;
  code?: string | null;
  error?: string;
} = {}) {
  const url = new URL("http://localhost:3000/api/admin/instagram/callback");
  if (state !== null) url.searchParams.set("state", state);
  if (code !== null) url.searchParams.set("code", code);
  if (error) url.searchParams.set("error", error);

  return new Request(url, {
    headers: cookieState === null ? {} : { cookie: `${STATE_COOKIE}=${cookieState}` },
  });
}

function outcomeOf(response: Response) {
  const location = new URL(response.headers.get("location")!);
  return {
    pathname: location.pathname,
    connected: location.searchParams.get("connected"),
    error: location.searchParams.get("error"),
  };
}

describe("GET /api/admin/instagram/callback", () => {
  // ugcportal-5ce K2: the callback is admin-only too, not just the entry point.
  it("returns 403 for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET(callback());

    expect(response.status).toBe(403);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a signed-in non-admin user", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    const response = await GET(callback());

    expect(response.status).toBe(403);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  describe("as an admin", () => {
    beforeEach(() => {
      authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    });

    it("stores the long-lived token encrypted, never in plaintext", async () => {
      const response = await GET(callback());

      expect(outcomeOf(response)).toEqual({
        pathname: "/admin/settings/instagram",
        connected: "connected",
        error: null,
      });

      expect(upsertMock).toHaveBeenCalledTimes(1);
      const args = upsertMock.mock.calls[0][0];
      expect(args.where).toEqual({ instagramUserId: "17841400000000000" });
      expect(args.create).toMatchObject({
        instagramUserId: "17841400000000000",
        username: "acme.studio",
        scopes: "instagram_business_basic",
        connectedByUserId: "admin-1",
        tokenExpiresAt: new Date("2026-11-23T00:00:00.000Z"),
      });

      const stored = args.create.accessTokenEncrypted;
      expect(stored).not.toContain(LONG_LIVED_TOKEN);
      expect(JSON.stringify(args)).not.toContain(LONG_LIVED_TOKEN);
      expect(decryptSecret(stored)).toBe(LONG_LIVED_TOKEN);
    });

    it("upserts so reconnecting an existing account replaces its token", async () => {
      await GET(callback());

      const args = upsertMock.mock.calls[0][0];
      expect(decryptSecret(args.update.accessTokenEncrypted)).toBe(
        LONG_LIVED_TOKEN,
      );
      expect(args.update.connectedByUserId).toBe("admin-1");
    });

    it("clears the state cookie once the flow ends", async () => {
      const response = await GET(callback());

      const cookie = response.cookies.get(STATE_COOKIE);
      expect(cookie?.value).toBe("");
      expect(cookie?.maxAge).toBe(0);
    });

    it("rejects a callback whose state doesn't match the cookie", async () => {
      const response = await GET(callback({ state: "forged-state" }));

      expect(outcomeOf(response).error).toBe("invalid_state");
      expect(exchangeCodeMock).not.toHaveBeenCalled();
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it("rejects a callback with no state cookie at all", async () => {
      const response = await GET(callback({ cookieState: null }));

      expect(outcomeOf(response).error).toBe("invalid_state");
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it("rejects a callback with no state parameter", async () => {
      const response = await GET(callback({ state: null }));

      expect(outcomeOf(response).error).toBe("invalid_state");
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it("reports a denied authorisation without starting an exchange", async () => {
      const response = await GET(callback({ error: "access_denied" }));

      expect(outcomeOf(response).error).toBe("denied");
      expect(exchangeCodeMock).not.toHaveBeenCalled();
    });

    it("reports a missing code", async () => {
      const response = await GET(callback({ code: null }));

      expect(outcomeOf(response).error).toBe("missing_code");
      expect(exchangeCodeMock).not.toHaveBeenCalled();
    });

    // A concurrent callback for the same account makes Prisma's non-atomic
    // upsert throw P2002 (and SQLite adds SQLITE_BUSY). That must redirect
    // like any other failure, not 500 and leave the state cookie live.
    it("redirects and clears the cookie when the database write fails", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      upsertMock.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );

      const response = await GET(callback());

      expect(outcomeOf(response).error).toBe("exchange_failed");
      const cookie = response.cookies.get(STATE_COOKIE);
      expect(cookie?.value).toBe("");
      expect(cookie?.maxAge).toBe(0);
      consoleError.mockRestore();
    });

    it("surfaces a generic error and stores nothing when the exchange fails", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      exchangeLongLivedMock.mockRejectedValue(
        new Error("Instagram long-lived token exchange failed: 400 Bad Request"),
      );

      const response = await GET(callback());

      expect(outcomeOf(response).error).toBe("exchange_failed");
      expect(response.headers.get("location")).not.toContain("Bad Request");
      expect(upsertMock).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });

    // K1: Redirect origin matches AUTH_URL when set and request host differs
    describe("redirect origin with AUTH_URL configured", () => {
      beforeEach(() => {
        process.env.AUTH_URL = "https://example.test";
        authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
      });

      function internalCallback(
        overrides: {
          state?: string | null;
          cookieState?: string | null;
          code?: string | null;
          error?: string;
        } = {},
      ) {
        const url = new URL("http://internal:3000/api/admin/instagram/callback");
        const state = overrides.state ?? STATE;
        const cookieState = overrides.cookieState ?? STATE;
        const { code = "the-code", error } = overrides;

        if (state !== null) url.searchParams.set("state", state);
        if (code !== null) url.searchParams.set("code", code);
        if (error) url.searchParams.set("error", error);

        return new Request(url, {
          headers:
            cookieState === null ? {} : { cookie: `${STATE_COOKIE}=${cookieState}` },
        });
      }

      it("redirects to AUTH_URL on successful connection", async () => {
        const response = await GET(internalCallback());
        const location = response.headers.get("location")!;

        expect(location).toMatch(/^https:\/\/example\.test\/admin\/settings\/instagram/);
      });

      it("redirects to AUTH_URL when access is denied", async () => {
        const response = await GET(internalCallback({ error: "access_denied" }));
        const location = response.headers.get("location")!;

        expect(location).toMatch(/^https:\/\/example\.test\/admin\/settings\/instagram/);
      });

      it("redirects to AUTH_URL on invalid state", async () => {
        const response = await GET(internalCallback({ state: "forged" }));
        const location = response.headers.get("location")!;

        expect(location).toMatch(/^https:\/\/example\.test\/admin\/settings\/instagram/);
      });

      it("redirects to AUTH_URL when code is missing", async () => {
        const response = await GET(internalCallback({ code: null }));
        const location = response.headers.get("location")!;

        expect(location).toMatch(/^https:\/\/example\.test\/admin\/settings\/instagram/);
      });

      it("redirects to AUTH_URL when exchange fails", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        exchangeLongLivedMock.mockRejectedValue(new Error("Exchange failed"));

        const response = await GET(internalCallback());
        const location = response.headers.get("location")!;

        expect(location).toMatch(/^https:\/\/example\.test\/admin\/settings\/instagram/);
        consoleError.mockRestore();
      });
    });

    // K2: Redirect origin falls back to request.url when AUTH_URL unset
    describe("redirect origin without AUTH_URL (dev default)", () => {
      beforeEach(() => {
        delete process.env.AUTH_URL;
        authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
      });

      it("redirects to request's own origin when AUTH_URL is unset", async () => {
        const url = new URL("http://dev-host:8080/api/admin/instagram/callback");
        url.searchParams.set("state", STATE);
        url.searchParams.set("code", "the-code");

        const request_ = new Request(url, {
          headers: { cookie: `${STATE_COOKIE}=${STATE}` },
        });

        const response = await GET(request_);
        const location = response.headers.get("location")!;

        expect(location).toMatch(/^http:\/\/dev-host:8080\/admin\/settings\/instagram/);
      });
    });
  });
});
