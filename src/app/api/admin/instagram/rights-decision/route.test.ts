import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const revalidatePathMock = vi.fn();
const setResaleRightsStatusMock = vi.fn();
const putRightsEvidenceMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/resale-rights-review", () => ({
  setResaleRightsStatus: setResaleRightsStatusMock,
}));
vi.mock("@/lib/rights-evidence", () => ({
  putRightsEvidence: putRightsEvidenceMock,
}));

const { POST } = await import(
  "@/app/api/admin/instagram/rights-decision/route"
);

const URL_ = "http://localhost/api/admin/instagram/rights-decision";

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
};

function decisionForm(overrides: Record<string, string | File> = {}) {
  const data = new FormData();
  data.set("instagramAccountId", "acc-1");
  data.set("status", "CLEARED");
  data.set("reason", "Signed assignment on file.");
  for (const [key, value] of Object.entries(overrides)) {
    data.set(key, value);
  }
  return data;
}

function request(form: FormData, init: RequestInit = {}) {
  return new Request(URL_, {
    method: "POST",
    body: form,
    headers: { origin: "http://localhost" },
    ...init,
  });
}

async function post(form: FormData, init?: RequestInit) {
  return POST(request(form, init));
}

/** The `?error=` / `?rights=` a 303 carries back to the settings page. */
function outcomeOf(response: Response): string {
  expect(response.status).toBe(303);
  return new URL(response.headers.get("location")!).search;
}

beforeEach(() => {
  // The origin check compares against AUTH_URL, so the tests have to say
  // what the public origin is — the same variable production sets.
  process.env.AUTH_URL = "http://localhost";
  authMock.mockReset().mockResolvedValue(ADMIN_SESSION);
  revalidatePathMock.mockReset();
  setResaleRightsStatusMock
    .mockReset()
    .mockResolvedValue({ outcome: "recorded", reviewId: "rev-1", selfReview: false });
  putRightsEvidenceMock
    .mockReset()
    .mockResolvedValue({ key: "rights-evidence/acc-1/x.pdf", sha256: "hash" });
});

/**
 * This endpoint exists as a route handler rather than a server action
 * specifically so its 20 MB body limit belongs to it alone — see
 * next.config.ts. That makes its own authorization the only thing standing
 * in front of a 20 MB buffer, so these tests matter more than the usual
 * admin-gate boilerplate.
 */
describe("authorization", () => {
  it("refuses an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);

    const response = await post(decisionForm());

    expect(response.status).toBe(403);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
    expect(putRightsEvidenceMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin caller", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    expect((await post(decisionForm())).status).toBe(403);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("refuses a session with no role at all", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });

    expect((await post(decisionForm())).status).toBe(403);
  });

  // A server action would have done this for us. The session cookie is
  // SameSite=Lax so a cross-site POST carries no credentials anyway — this
  // is the second lock, for the day that changes.
  it("refuses a cross-origin form post", async () => {
    const response = await POST(
      new Request(URL_, {
        method: "POST",
        body: decisionForm(),
        headers: { origin: "https://evil.example" },
      }),
    );

    expect(response.status).toBe(403);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("refuses a cross-site post even with a matching Origin spoofed away", async () => {
    // Sec-Fetch-Site is set by the browser and cannot be forged from page
    // script, so it is worth consulting on its own.
    const response = await POST(
      new Request(URL_, {
        method: "POST",
        body: decisionForm(),
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );

    expect(response.status).toBe(403);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  /**
   * The expected origin comes from AUTH_URL, not from `request.url`.
   *
   * Behind a TLS-terminating proxy — what the standalone image assumes —
   * the handler sees `http://<internal>:3000` while the browser sends the
   * public `https://<host>`. Comparing against the request would 403 every
   * legitimate decision in production while passing a test that used one
   * host for both, so this test deliberately makes them differ.
   */
  it("accepts the public origin when the server sees an internal one", async () => {
    process.env.AUTH_URL = "https://ugc.example";

    const response = await POST(
      new Request("http://10.0.0.7:3000/api/admin/instagram/rights-decision", {
        method: "POST",
        body: decisionForm(),
        headers: { origin: "https://ugc.example" },
      }),
    );

    expect(response.status).toBe(303);
    expect(setResaleRightsStatusMock).toHaveBeenCalled();
  });

  it("refuses an origin that is not the configured one", async () => {
    process.env.AUTH_URL = "https://ugc.example";

    const response = await POST(
      new Request(URL_, {
        method: "POST",
        body: decisionForm(),
        headers: { origin: "http://localhost" },
      }),
    );

    expect(response.status).toBe(403);
  });

  // Allowed on purpose: no browser omits Origin on a *cross-origin* POST,
  // so its absence cannot be an attacker's cross-site form — while some
  // clients do omit it same-origin, and refusing those would be an outage
  // dressed up as a defence. requireAdmin and SameSite=Lax still apply.
  it("allows a post with no Origin header", async () => {
    const response = await POST(
      new Request(URL_, { method: "POST", body: decisionForm() }),
    );

    expect(response.status).toBe(303);
  });

  it("checks admin before reading the body at all", async () => {
    // The point of the whole route-handler move: an unauthenticated caller
    // must not get the server to buffer 20 MB. requireAdmin runs first, so
    // nothing downstream of it is reached.
    authMock.mockResolvedValue(null);
    const huge = new FormData();
    huge.set("evidence", new File([new Uint8Array(1024)], "x.pdf"));

    expect((await post(huge)).status).toBe(403);
    expect(putRightsEvidenceMock).not.toHaveBeenCalled();
  });
});

describe("recording the decision", () => {
  it("records it against the signed-in admin and redirects back", async () => {
    const response = await post(
      decisionForm({
        route: "CONTRACT",
        validUntil: "2027-06-01",
        conditions: "  Editorial use only.  ",
        reason: "  Signed assignment on file.  ",
      }),
    );

    expect(outcomeOf(response)).toBe("?rights=recorded");
    expect(setResaleRightsStatusMock).toHaveBeenCalledWith("acc-1", {
      source: "ADMIN",
      // Taken from the session, never from the form: the form cannot name
      // someone else as the reviewer of record.
      actorUserId: "admin-1",
      actorEmail: "admin@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file.",
      route: "CONTRACT",
      validUntil: new Date("2027-06-01"),
      conditions: "Editorial use only.",
      clearedOwnerUserId: null,
      evidence: undefined,
      restampChecklist: false,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/instagram");
  });

  it("passes the re-stamp through only when the box was ticked", async () => {
    await post(decisionForm({ restampChecklist: "yes" }));

    expect(setResaleRightsStatusMock).toHaveBeenCalledWith(
      "acc-1",
      expect.objectContaining({ restampChecklist: true }),
    );
  });

  it("treats any other value for the re-stamp as not ticked", async () => {
    for (const value of ["on", "true", "1", ""]) {
      setResaleRightsStatusMock.mockClear();
      await post(decisionForm({ restampChecklist: value }));

      expect(setResaleRightsStatusMock).toHaveBeenCalledWith(
        "acc-1",
        expect.objectContaining({ restampChecklist: false }),
      );
    }
  });

  it("rejects a tampered status without writing anything", async () => {
    const response = await post(decisionForm({ status: "SUPERCLEARED" }));

    expect(response.status).toBe(400);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("rejects a tampered route without writing anything", async () => {
    const response = await post(decisionForm({ route: "HANDSHAKE" }));

    expect(response.status).toBe(400);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("rejects a missing account id", async () => {
    const data = decisionForm();
    data.delete("instagramAccountId");

    expect((await post(data)).status).toBe(400);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("insists on a reason", async () => {
    const response = await post(decisionForm({ reason: "   " }));

    expect(outcomeOf(response)).toBe("?error=rights_reason_required");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("rejects an unparseable validUntil", async () => {
    const response = await post(decisionForm({ validUntil: "whenever" }));

    expect(outcomeOf(response)).toBe("?error=rights_invalid_valid_until");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("surfaces an account that disappeared", async () => {
    setResaleRightsStatusMock.mockResolvedValue({
      outcome: "account_not_found",
    });

    expect(outcomeOf(await post(decisionForm()))).toBe(
      "?error=rights_account_not_found",
    );
  });

  it("surfaces an admin whose role was revoked mid-session", async () => {
    setResaleRightsStatusMock.mockResolvedValue({ outcome: "actor_not_admin" });

    expect(outcomeOf(await post(decisionForm()))).toBe(
      "?error=rights_actor_not_admin",
    );
  });

  it("surfaces a concurrent first decision as a retryable message", async () => {
    // Not an unhandled error page: two admins deciding at once is a thing
    // that happens, and the loser needs to be told to re-read and redo.
    setResaleRightsStatusMock.mockResolvedValue({ outcome: "conflict" });

    expect(outcomeOf(await post(decisionForm()))).toBe(
      "?error=rights_conflict",
    );
  });
});

describe("evidence upload", () => {
  it("stores an attached file and records its hash", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "assignment.pdf", {
      type: "application/pdf",
    });

    expect(outcomeOf(await post(decisionForm({ evidence: file })))).toBe(
      "?rights=recorded",
    );
    expect(putRightsEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instagramAccountId: "acc-1",
        filename: "assignment.pdf",
        contentType: "application/pdf",
      }),
    );
    expect(setResaleRightsStatusMock).toHaveBeenCalledWith(
      "acc-1",
      expect.objectContaining({
        evidence: { key: "rights-evidence/acc-1/x.pdf", sha256: "hash" },
      }),
    );
  });

  it("ignores an empty file input", async () => {
    await post(decisionForm({ evidence: new File([], "") }));

    expect(putRightsEvidenceMock).not.toHaveBeenCalled();
  });

  // Ordering matters: a clearance that names evidence which was never
  // stored is worse than no clearance at all.
  it("records nothing when the upload fails", async () => {
    putRightsEvidenceMock.mockRejectedValue(new Error("bucket on fire"));
    const file = new File([new Uint8Array([1])], "a.pdf");

    expect(outcomeOf(await post(decisionForm({ evidence: file })))).toBe(
      "?error=rights_evidence_failed",
    );
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized file rather than uploading it", async () => {
    const tooBig = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "huge.pdf");

    expect(outcomeOf(await post(decisionForm({ evidence: tooBig })))).toBe(
      "?error=rights_evidence_too_large",
    );
    expect(putRightsEvidenceMock).not.toHaveBeenCalled();
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  // The cap this endpoint owns, as opposed to the global one it replaced.
  // Declared Content-Length is a cheap early-out; a lying client is stopped
  // by the stream itself.
  it("stops a body that declares itself oversized", async () => {
    const response = await POST(
      new Request(URL_, {
        method: "POST",
        body: decisionForm(),
        headers: {
          origin: "http://localhost",
          "content-length": String(64 * 1024 * 1024),
        },
      }),
    );

    expect(outcomeOf(response)).toBe("?error=rights_evidence_too_large");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  /**
   * The reason this endpoint exists, asserted so it cannot quietly revert.
   *
   * An earlier revision raised `experimental.serverActions.bodySizeLimit` to
   * 21mb so a large evidence file could reach a server action. That setting
   * is global and the framework applies it before any action's own auth
   * check, so it let an anonymous caller make the server buffer 21 MB
   * against any action id in the app — a DoS surface opened by an
   * admin-only feature. Anyone re-adding it should have to delete this test
   * and say why.
   */
  it("does not rely on a raised global server-action body limit", () => {
    const config = readFileSync(
      resolve(process.cwd(), "next.config.ts"),
      "utf8",
    );

    // Named only in the comment explaining why it is absent.
    expect(config).not.toMatch(/^\s*bodySizeLimit\s*:/m);
  });

  it("rejects a body that is not multipart at all", async () => {
    const response = await POST(
      new Request(URL_, {
        method: "POST",
        body: "not a form",
        headers: {
          origin: "http://localhost",
          "content-type": "text/plain",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });
});
