import { beforeEach, describe, expect, it, vi } from "vitest";

import { STATE_COOKIE } from "@/lib/instagram-oauth-state";

const authMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const { GET } = await import("@/app/api/admin/instagram/connect/route");

beforeEach(() => {
  authMock.mockReset();
  process.env.AUTH_URL = "http://localhost:3000";
  process.env.INSTAGRAM_CLIENT_ID = "client-id";
  process.env.INSTAGRAM_CLIENT_SECRET = "client-secret";
});

describe("GET /api/admin/instagram/connect", () => {
  // ugcportal-5ce K2: a non-admin must never reach the connect flow.
  it("returns 403 for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns 403 for a signed-in non-admin user", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns 403 when the session carries no role at all", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });

    expect((await GET()).status).toBe(403);
  });

  it("redirects an admin to Instagram and pins the state in a cookie", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    const response = await GET();

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://www.instagram.com/oauth/authorize",
    );

    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();

    const cookie = response.cookies.get(STATE_COOKIE);
    expect(cookie?.value).toBe(state);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/api/admin/instagram");
  });

  // Derived from the registered callback, not the inbound request: behind a
  // proxy that drops x-forwarded-proto the request reads as http, and the
  // cookie would silently lose Secure on a production HTTPS site.
  it("marks the state cookie secure when the registered callback is https", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    process.env.AUTH_URL = "https://ugc.example";

    expect((await GET()).cookies.get(STATE_COOKIE)?.secure).toBe(true);
  });

  it("does not mark it secure for a plain http dev callback", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    expect((await GET()).cookies.get(STATE_COOKIE)?.secure).toBe(false);
  });

  it("uses a fresh state per request", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    const first = await GET();
    const second = await GET();

    expect(first.cookies.get(STATE_COOKIE)?.value).not.toBe(
      second.cookies.get(STATE_COOKIE)?.value,
    );
  });
});
