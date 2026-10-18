import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ugcportal-qf9v K1/K2: the ten owner-facing mutating handlers apply the
 * same-origin second lock the admin routes already did.
 *
 * Prisma and the object store are replaced by objects that FAIL on any use, so
 * "403 and no write" is asserted by the 403 arriving at all: a handler that
 * reached its write would throw and answer 500 instead. The ownership gate
 * (`requireOwnedMedia`) is stubbed to say "yours" so the origin check, which
 * sits after it, is the only thing under test; the anonymous case uses the
 * real gate's 401 answer.
 */

const sessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => sessionMock() }));

const untouchable = () =>
  new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`write path reached: ${String(prop)}`);
      },
    },
  );
vi.mock("@/lib/prisma", () => ({ prisma: untouchable() }));
vi.mock("@/lib/s3", () => ({ getS3Client: untouchable }));

let owned = true;
vi.mock("@/lib/media-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media-access")>();
  return {
    ...actual,
    requireOwnedMedia: async () =>
      owned
        ? { ok: true, userId: "owner", role: "USER", media: {} }
        : { ok: false, status: 401, error: "Unauthorized" },
  };
});

const media = await import("@/app/api/media/route");
const item = await import("@/app/api/media/[id]/route");
const publish = await import("@/app/api/media/[id]/publish/route");
const tags = await import("@/app/api/media/[id]/tags/route");
const disclosure = await import("@/app/api/media/[id]/disclosure/route");
const links = await import("@/app/api/media/[id]/commercial-links/route");
const attestation = await import("@/app/api/media/[id]/attestation/route");

const ctx = { params: Promise.resolve({ id: "m1" }) };

type Handler = (request: Request, context: typeof ctx) => Promise<Response>;
const cases: [string, string, string, Handler][] = [
  ["POST /api/media", "POST", "/api/media", media.POST as Handler],
  ["PATCH /api/media/[id]", "PATCH", "/api/media/m1", item.PATCH],
  ["DELETE /api/media/[id]", "DELETE", "/api/media/m1", item.DELETE],
  ["POST publish", "POST", "/api/media/m1/publish", publish.POST],
  ["DELETE publish", "DELETE", "/api/media/m1/publish", publish.DELETE],
  ["PUT tags", "PUT", "/api/media/m1/tags", tags.PUT],
  ["PUT disclosure", "PUT", "/api/media/m1/disclosure", disclosure.PUT],
  ["POST commercial-links", "POST", "/api/media/m1/commercial-links", links.POST],
  ["DELETE commercial-links", "DELETE", "/api/media/m1/commercial-links?linkId=l1", links.DELETE],
  ["POST attestation", "POST", "/api/media/m1/attestation", attestation.POST],
];

function req(method: string, path: string, headers: Record<string, string>) {
  return new Request(`http://localhost:3000${path}`, { method, headers });
}

beforeEach(() => {
  owned = true;
  sessionMock.mockReset();
  sessionMock.mockResolvedValue({ user: { id: "owner", role: "USER" } });
  vi.stubEnv("AUTH_URL", "https://ugc.example");
});

describe("owner-facing mutating handlers, same-origin second lock", () => {
  it.each(cases)("%s refuses a foreign Origin with 403 and no write", async (_n, method, path, handler) => {
    const res = await handler(req(method, path, { origin: "https://evil.example" }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it.each(cases)("%s refuses Sec-Fetch-Site cross-site with 403", async (_n, method, path, handler) => {
    const res = await handler(req(method, path, { "sec-fetch-site": "cross-site" }), ctx);
    expect(res.status).toBe(403);
  });

  it.each(cases)("%s refuses Sec-Fetch-Site same-site with 403", async (_n, method, path, handler) => {
    const res = await handler(req(method, path, { "sec-fetch-site": "same-site" }), ctx);
    expect(res.status).toBe(403);
  });

  it.each(cases)("%s treats a request with no Origin like one with the matching Origin", async (_n, method, path, handler) => {
    // Some handlers have their own 403 (publish refuses a non-operator), so
    // "not 403" proves nothing. What K2 asks is that omitting Origin is not
    // itself a refusal: the outcome must equal the same request carrying the
    // configured origin. A throw is the handler past the lock, reaching the
    // untouchable store.
    const outcome = async (headers: Record<string, string>) => {
      try {
        const res = await handler(req(method, path, headers), ctx);
        return { status: res.status, body: await res.text() };
      } catch (error) {
        return { threw: String(error) };
      }
    };
    const without = await outcome({});
    const matching = await outcome({ origin: "https://ugc.example" });
    expect(without).toEqual(matching);
    // ...and neither is the lock's refusal: a foreign Origin differs.
    const foreign = await outcome({ origin: "https://evil.example" });
    expect(foreign).toEqual({ status: 403, body: JSON.stringify({ error: "Forbidden" }) });
  });

  it.each(cases)("%s answers 401 to an anonymous caller before any origin reasoning", async (_n, method, path, handler) => {
    owned = false;
    sessionMock.mockResolvedValue(null);
    const res = await handler(req(method, path, { origin: "https://evil.example" }), ctx);
    expect(res.status).toBe(401);
  });
});
