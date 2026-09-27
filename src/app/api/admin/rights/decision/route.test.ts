import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const revalidatePathMock = vi.fn();
const setResaleRightsStatusMock = vi.fn();
const putRightsEvidenceMock = vi.fn();
const deleteRightsEvidenceMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/resale-rights-review", () => ({
  setResaleRightsStatus: setResaleRightsStatusMock,
}));
vi.mock("@/lib/rights-evidence", () => ({
  putRightsEvidence: putRightsEvidenceMock,
  deleteRightsEvidence: deleteRightsEvidenceMock,
}));

const { POST } = await import("@/app/api/admin/rights/decision/route");

const URL_ = "http://localhost/api/admin/rights/decision";

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
};

function decisionForm(overrides: Record<string, string | File> = {}) {
  const data = new FormData();
  data.set("uploaderUserId", "uploader-1");
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

/**
 * What a 303 carries back to the settings page, as fields rather than as a
 * raw query string.
 *
 * `edit` matters as much as `error` does: the settings page only renders the
 * decision form for whoever `?edit=` names, so a redirect that drops it puts
 * the admin on a long list with the form closed and no indication which
 * uploader the error concerned.
 */
function outcomeOf(response: Response): {
  error: string | null;
  rights: string | null;
  edit: string | null;
} {
  expect(response.status).toBe(303);
  const params = new URL(response.headers.get("location")!).searchParams;
  return {
    error: params.get("error"),
    rights: params.get("rights"),
    edit: params.get("edit"),
  };
}

/** A recoverable failure must name the code AND reopen the uploader's form. */
function expectReopened(
  outcome: ReturnType<typeof outcomeOf>,
  error: string,
): void {
  expect(outcome).toEqual({ error, rights: null, edit: "uploader-1" });
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
    .mockResolvedValue({ key: "rights-evidence/uploader-1/x.pdf", sha256: "hash" });
  deleteRightsEvidenceMock.mockReset().mockResolvedValue(undefined);
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
      new Request("http://10.0.0.7:3000/api/admin/rights/decision", {
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

    // Success closes the form: the decision is written, and re-opening it
    // for a record that was just saved invites submitting it twice.
    expect(outcomeOf(response)).toEqual({
      error: null,
      rights: "recorded",
      edit: null,
    });
    expect(setResaleRightsStatusMock).toHaveBeenCalledWith("uploader-1", {
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
      evidence: undefined,
      restampChecklist: false,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/rights");
  });

  it("passes the re-stamp through only when the box was ticked", async () => {
    await post(decisionForm({ restampChecklist: "yes" }));

    expect(setResaleRightsStatusMock).toHaveBeenCalledWith(
      "uploader-1",
      expect.objectContaining({ restampChecklist: true }),
    );
  });

  it("treats any other value for the re-stamp as not ticked", async () => {
    for (const value of ["on", "true", "1", ""]) {
      setResaleRightsStatusMock.mockClear();
      await post(decisionForm({ restampChecklist: value }));

      expect(setResaleRightsStatusMock).toHaveBeenCalledWith(
        "uploader-1",
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

  it("rejects a missing uploader id", async () => {
    const data = decisionForm();
    data.delete("uploaderUserId");

    expect((await post(data)).status).toBe(400);
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("insists on a reason", async () => {
    const response = await post(decisionForm({ reason: "   " }));

    expectReopened(outcomeOf(response), "rights_reason_required");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("rejects an unparseable validUntil", async () => {
    const response = await post(decisionForm({ validUntil: "whenever" }));

    expectReopened(outcomeOf(response), "rights_invalid_valid_until");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("surfaces an uploader that disappeared", async () => {
    setResaleRightsStatusMock.mockResolvedValue({
      outcome: "uploader_not_found",
    });

    expectReopened(
      outcomeOf(await post(decisionForm())),
      "rights_uploader_not_found",
    );
  });

  it("surfaces an admin whose role was revoked mid-session", async () => {
    setResaleRightsStatusMock.mockResolvedValue({ outcome: "actor_not_admin" });

    expectReopened(
      outcomeOf(await post(decisionForm())),
      "rights_actor_not_admin",
    );
  });

  it("surfaces a named user deleted between render and submit", async () => {
    setResaleRightsStatusMock.mockResolvedValue({
      outcome: "missing_reference",
    });

    expectReopened(
      outcomeOf(await post(decisionForm())),
      "rights_holder_missing",
    );
  });

  /**
   * Absent field vs blank field. The handler used to collapse both into
   * `null`, so a partial POST — one that simply omits `validUntil` —
   * silently cleared a clearance's expiry, defended only by the form's
   * `defaultValue`. That is the same fail-open as rounds 2 and 3, reached
   * by not being the form.
   */
  it("leaves omitted optional fields alone rather than clearing them", async () => {
    const partial = new FormData();
    partial.set("uploaderUserId", "uploader-1");
    partial.set("status", "CLEARED");
    partial.set("reason", "Partial post.");

    await post(partial);

    const [, transition] = setResaleRightsStatusMock.mock.calls[0];
    // `undefined` is the writer's "leave it as it was".
    expect(transition.validUntil).toBeUndefined();
    expect(transition.conditions).toBeUndefined();
    expect(transition.route).toBeUndefined();
  });

  it("still clears a field that is present but blank", async () => {
    // The other half of the contract: the form submits empty strings when
    // an admin deliberately empties a field, and that must still clear it.
    await post(decisionForm({ validUntil: "", conditions: "", route: "" }));

    const [, transition] = setResaleRightsStatusMock.mock.calls[0];
    expect(transition.validUntil).toBeNull();
    expect(transition.conditions).toBeNull();
    expect(transition.route).toBeNull();
  });

  it("surfaces a concurrent first decision as a retryable message", async () => {
    // Not an unhandled error page: two admins deciding at once is a thing
    // that happens, and the loser needs to be told to re-read and redo.
    setResaleRightsStatusMock.mockResolvedValue({ outcome: "conflict" });

    expectReopened(outcomeOf(await post(decisionForm())), "rights_conflict");
  });
});

/**
 * ugcportal-0ss rendered the decision form inline for every account, so an
 * error simply re-rendered the page with the form still in front of you.
 * This screen opens one form at a time via `?edit=`, which made losing that
 * parameter a regression: the admin landed on a hundred-row list with the
 * form closed, their typed reason gone, and nothing saying which uploader
 * the message was about.
 */
describe("a recoverable failure puts the admin back in front of the form", () => {
  it("reopens the form for the uploader the decision was about", async () => {
    const response = await post(decisionForm({ reason: "   " }));

    expect(outcomeOf(response).edit).toBe("uploader-1");
  });

  it("carries the uploader id safely rather than splicing it into a string", async () => {
    // A cuid today, but a value concatenated into a query string raw is one
    // schema change away from being an injection into the admin's own URL.
    const data = decisionForm();
    data.set("uploaderUserId", "a&error=denied#x");
    data.set("reason", "   ");

    const location = new URL(
      (await post(data)).headers.get("location")!,
    );

    expect(location.searchParams.get("edit")).toBe("a&error=denied#x");
    expect(location.searchParams.get("error")).toBe("rights_reason_required");
  });

  it("does not carry the typed reason back through the URL", async () => {
    // Deliberate. A reason is free text that may quote contract terms or
    // name people, and a query parameter lands in server logs, proxy logs,
    // browser history and Referer headers. Retyping a sentence is the
    // cheaper failure; tracked as ugcportal-40s.
    const secret = "Contract clause 4.2 with Jane Doe";
    const response = await post(
      decisionForm({ reason: secret, validUntil: "whenever" }),
    );

    expect(response.headers.get("location")).not.toContain("Jane");
    expect(response.headers.get("location")).not.toContain("Contract");
  });
});

describe("evidence upload", () => {
  it("stores an attached file and records its hash", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "assignment.pdf", {
      type: "application/pdf",
    });

    expect(outcomeOf(await post(decisionForm({ evidence: file })))).toMatchObject(
      { rights: "recorded" },
    );
    expect(putRightsEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uploaderUserId: "uploader-1",
        filename: "assignment.pdf",
        contentType: "application/pdf",
      }),
    );
    expect(setResaleRightsStatusMock).toHaveBeenCalledWith(
      "uploader-1",
      expect.objectContaining({
        evidence: { key: "rights-evidence/uploader-1/x.pdf", sha256: "hash" },
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

    expectReopened(
      outcomeOf(await post(decisionForm({ evidence: file }))),
      "rights_evidence_failed",
    );
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  // The upload happens before the write so a clearance can never name
  // evidence that isn't there. When the write is then refused, the object
  // has nothing pointing at it — and it is a contract or a model release,
  // so leaving it in the bucket forever is not neutral.
  it("removes the uploaded file when the decision could not be recorded", async () => {
    setResaleRightsStatusMock.mockResolvedValue({
      outcome: "missing_reference",
    });
    const file = new File([new Uint8Array([1])], "a.pdf");

    await post(decisionForm({ evidence: file }));

    expect(deleteRightsEvidenceMock).toHaveBeenCalledWith(
      "rights-evidence/uploader-1/x.pdf",
    );
  });

  // Cleanup ran only for *mapped* failures, so any error the writer
  // re-throws — a real fault — left the contract orphaned, which is the
  // exact case the cleanup was added for.
  it("removes the uploaded file when the write throws outright", async () => {
    setResaleRightsStatusMock.mockRejectedValue(new Error("database is gone"));
    const file = new File([new Uint8Array([1])], "a.pdf");

    await expect(post(decisionForm({ evidence: file }))).rejects.toThrow(
      "database is gone",
    );

    expect(deleteRightsEvidenceMock).toHaveBeenCalledWith(
      "rights-evidence/uploader-1/x.pdf",
    );
  });

  it("keeps the uploaded file when the decision was recorded", async () => {
    const file = new File([new Uint8Array([1])], "a.pdf");

    await post(decisionForm({ evidence: file }));

    expect(deleteRightsEvidenceMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized file rather than uploading it", async () => {
    const tooBig = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "huge.pdf");

    expectReopened(
      outcomeOf(await post(decisionForm({ evidence: tooBig }))),
      "rights_evidence_too_large",
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

    // No uploader to reopen for: the body was refused before any field of
    // it was read, which is the whole point of the cap.
    expect(outcomeOf(response)).toEqual({
      error: "rights_evidence_too_large",
      rights: null,
      edit: null,
    });
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

  it("points at a route handler that exists", () => {
    // The comment above is the only thing carrying that reasoning forward,
    // and a comment naming a path that no longer exists sends the next
    // reader nowhere. This PR renamed the handler out from under it, so the
    // path is now checked rather than trusted: every src/ path named in
    // next.config.ts must resolve on disk.
    const config = readFileSync(
      resolve(process.cwd(), "next.config.ts"),
      "utf8",
    );
    const paths = [...config.matchAll(/src\/[\w./[\]-]+\.tsx?/g)].map(
      (match) => match[0],
    );

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect({ path, exists: existsSync(resolve(process.cwd(), path)) }).toEqual(
        { path, exists: true },
      );
    }
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
