import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const deleteManyMock = vi.fn();
const revalidatePathMock = vi.fn();
const setResaleRightsStatusMock = vi.fn();
const putRightsEvidenceMock = vi.fn();

// redirect() throws in Next so the caller stops; the tests rely on that, so
// the stand-in has to throw too or every assertion after a redirect would be
// testing code that never runs in production.
const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma", () => ({
  prisma: { instagramAccount: { deleteMany: deleteManyMock } },
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/lib/resale-rights-review", () => ({
  setResaleRightsStatus: setResaleRightsStatusMock,
}));
vi.mock("@/lib/rights-evidence", () => ({
  putRightsEvidence: putRightsEvidenceMock,
}));

const { disconnectInstagramAccount, recordResaleRightsDecision } = await import(
  "@/app/admin/settings/instagram/actions"
);

function form(id?: string) {
  const data = new FormData();
  if (id !== undefined) data.set("id", id);
  return data;
}

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

beforeEach(() => {
  authMock.mockReset();
  deleteManyMock.mockReset().mockResolvedValue({ count: 1 });
  revalidatePathMock.mockReset();
  redirectMock.mockClear();
  setResaleRightsStatusMock
    .mockReset()
    .mockResolvedValue({ outcome: "recorded", reviewId: "rev-1", selfReview: false });
  putRightsEvidenceMock
    .mockReset()
    .mockResolvedValue({ key: "rights-evidence/acc-1/x.pdf", sha256: "hash" });
});

describe("disconnectInstagramAccount", () => {
  // A server action is a public endpoint — reachable without the page that
  // renders its form, so it carries its own admin check (ugcportal-5ce K2).
  it("refuses an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);

    await expect(disconnectInstagramAccount(form("acc-1"))).rejects.toThrow(
      "Forbidden",
    );
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin caller", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    await expect(disconnectInstagramAccount(form("acc-1"))).rejects.toThrow(
      "Forbidden",
    );
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("deletes the account for an admin and revalidates the settings page", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    await disconnectInstagramAccount(form("acc-1"));

    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: "acc-1" } });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/instagram");
  });

  it("rejects a missing id without touching the database", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    await expect(disconnectInstagramAccount(form())).rejects.toThrow(
      "Missing account id",
    );
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});

describe("recordResaleRightsDecision", () => {
  // ugcportal-0ss K4: this action is the only path to CLEARED, so its own
  // admin check is the lock on it. A server action is a public endpoint.
  it("refuses an unauthenticated caller", async () => {
    authMock.mockResolvedValue(null);

    await expect(recordResaleRightsDecision(decisionForm())).rejects.toThrow(
      "Forbidden",
    );
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
    expect(putRightsEvidenceMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-admin caller", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", role: "USER" } });

    await expect(recordResaleRightsDecision(decisionForm())).rejects.toThrow(
      "Forbidden",
    );
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("refuses a session with no role at all", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });

    await expect(recordResaleRightsDecision(decisionForm())).rejects.toThrow(
      "Forbidden",
    );
  });

  it("records the decision against the signed-in admin", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(
      recordResaleRightsDecision(
        decisionForm({
          route: "CONTRACT",
          validUntil: "2027-06-01",
          conditions: "  Editorial use only.  ",
          reason: "  Signed assignment on file.  ",
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT /admin/settings/instagram?rights=recorded");

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
      evidence: undefined,
      // Absent checkbox means "I did not re-run the checklist", so the
      // stored version is left alone.
      restampChecklist: false,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/settings/instagram");
  });

  it("passes the re-stamp through only when the box was ticked", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(
      recordResaleRightsDecision(decisionForm({ restampChecklist: "yes" })),
    ).rejects.toThrow("rights=recorded");

    expect(setResaleRightsStatusMock).toHaveBeenCalledWith(
      "acc-1",
      expect.objectContaining({ restampChecklist: true }),
    );
  });

  it("treats any other value for the re-stamp as not ticked", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    // Fails closed on a tampered or unexpected value: the only thing that
    // re-validates a retired checklist version is the exact value the
    // checkbox submits.
    for (const value of ["on", "true", "1", ""]) {
      setResaleRightsStatusMock.mockClear();
      await expect(
        recordResaleRightsDecision(decisionForm({ restampChecklist: value })),
      ).rejects.toThrow("rights=recorded");

      expect(setResaleRightsStatusMock).toHaveBeenCalledWith(
        "acc-1",
        expect.objectContaining({ restampChecklist: false }),
      );
    }
  });

  it("rejects a tampered status without writing anything", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(
      recordResaleRightsDecision(decisionForm({ status: "SUPERCLEARED" })),
    ).rejects.toThrow("Unknown resale-rights status");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("rejects a tampered route without writing anything", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(
      recordResaleRightsDecision(decisionForm({ route: "HANDSHAKE" })),
    ).rejects.toThrow("Unknown resale-rights route");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("insists on a reason", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(
      recordResaleRightsDecision(decisionForm({ reason: "   " })),
    ).rejects.toThrow("error=rights_reason_required");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("rejects an unparseable validUntil", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(
      recordResaleRightsDecision(decisionForm({ validUntil: "whenever" })),
    ).rejects.toThrow("error=rights_invalid_valid_until");
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("stores an attached evidence file and records its hash", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    const file = new File([new Uint8Array([1, 2, 3])], "assignment.pdf", {
      type: "application/pdf",
    });

    await expect(
      recordResaleRightsDecision(decisionForm({ evidence: file })),
    ).rejects.toThrow("rights=recorded");

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
    authMock.mockResolvedValue(ADMIN_SESSION);

    await expect(
      recordResaleRightsDecision(
        decisionForm({ evidence: new File([], "") }),
      ),
    ).rejects.toThrow("rights=recorded");

    expect(putRightsEvidenceMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized evidence file before uploading it", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    const tooBig = new File(
      [new Uint8Array(20 * 1024 * 1024 + 1)],
      "huge.pdf",
    );

    await expect(
      recordResaleRightsDecision(decisionForm({ evidence: tooBig })),
    ).rejects.toThrow("error=rights_evidence_too_large");

    expect(putRightsEvidenceMock).not.toHaveBeenCalled();
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  // Ordering matters: a clearance that names evidence which was never
  // stored is worse than no clearance at all.
  it("records nothing when the evidence upload fails", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    putRightsEvidenceMock.mockRejectedValue(new Error("bucket on fire"));
    const file = new File([new Uint8Array([1])], "a.pdf");

    await expect(
      recordResaleRightsDecision(decisionForm({ evidence: file })),
    ).rejects.toThrow("error=rights_evidence_failed");

    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });

  it("surfaces an account that disappeared", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    setResaleRightsStatusMock.mockResolvedValue({
      outcome: "account_not_found",
    });

    await expect(recordResaleRightsDecision(decisionForm())).rejects.toThrow(
      "error=rights_account_not_found",
    );
  });

  it("surfaces an admin whose role was revoked mid-session", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    setResaleRightsStatusMock.mockResolvedValue({ outcome: "actor_not_admin" });

    await expect(recordResaleRightsDecision(decisionForm())).rejects.toThrow(
      "error=rights_actor_not_admin",
    );
  });

  it("rejects a missing account id", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    const data = decisionForm();
    data.delete("instagramAccountId");

    await expect(recordResaleRightsDecision(data)).rejects.toThrow(
      "Missing account id",
    );
    expect(setResaleRightsStatusMock).not.toHaveBeenCalled();
  });
});
