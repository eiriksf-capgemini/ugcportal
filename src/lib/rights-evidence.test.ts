import { createHash } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: sendMock }),
  getBucketName: () => "ugcportal-test",
}));

const { RIGHTS_EVIDENCE_PREFIX, putRightsEvidence, rightsEvidenceKey } =
  await import("@/lib/rights-evidence");

function lastPutInput() {
  const command = sendMock.mock.calls.at(-1)?.[0];
  expect(command).toBeInstanceOf(PutObjectCommand);
  return (command as PutObjectCommand).input;
}

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({});
  delete process.env.S3_EVIDENCE_SSE;
});

describe("rightsEvidenceKey", () => {
  it("puts every file under the account's own private prefix", () => {
    const key = rightsEvidenceKey("acc-1", "assignment.pdf");
    expect(key.startsWith(`${RIGHTS_EVIDENCE_PREFIX}/acc-1/`)).toBe(true);
    expect(key.endsWith("-assignment.pdf")).toBe(true);
  });

  it("cannot be walked out of the prefix by a hostile filename", () => {
    const key = rightsEvidenceKey("acc-1", "../../../uploads/original.jpg");
    expect(key).not.toContain("..");
    // prefix / account / object — three segments, no more.
    expect(key.split("/")).toHaveLength(3);
  });

  it("keeps a usable name when the filename sanitises to nothing", () => {
    const key = rightsEvidenceKey("acc-1", "…");
    expect(key.endsWith("-evidence")).toBe(true);
  });

  it("rejects an account id that isn't one", () => {
    for (const id of ["../acc-2", "acc/1", "", "a".repeat(65), "acc 1"]) {
      expect(() => rightsEvidenceKey(id, "x.pdf")).toThrow("Unsafe");
    }
  });

  it("never collides two uploads of the same filename", () => {
    expect(rightsEvidenceKey("acc-1", "c.pdf")).not.toBe(
      rightsEvidenceKey("acc-1", "c.pdf"),
    );
  });
});

describe("putRightsEvidence", () => {
  const body = new Uint8Array([1, 2, 3, 4]);

  it("stores the file privately, encrypted, and returns its hash", async () => {
    const result = await putRightsEvidence({
      instagramAccountId: "acc-1",
      filename: "assignment.pdf",
      body,
      contentType: "application/pdf",
    });

    expect(result.sha256).toBe(
      createHash("sha256").update(body).digest("hex"),
    );

    const input = lastPutInput();
    expect(input).toMatchObject({
      Bucket: "ugcportal-test",
      Key: result.key,
      ContentType: "application/pdf",
      ServerSideEncryption: "AES256",
      ACL: "private",
    });
    expect(input.Key?.startsWith("rights-evidence/acc-1/")).toBe(true);
  });

  it("can drop the encryption header for a MinIO without a KMS", async () => {
    process.env.S3_EVIDENCE_SSE = "none";

    await putRightsEvidence({
      instagramAccountId: "acc-1",
      filename: "a.pdf",
      body,
    });

    expect(lastPutInput().ServerSideEncryption).toBeUndefined();
    // Still private: the opt-out is about encryption at rest, not access.
    expect(lastPutInput().ACL).toBe("private");
  });

  it("falls back to a neutral content type", async () => {
    await putRightsEvidence({
      instagramAccountId: "acc-1",
      filename: "a.pdf",
      body,
      contentType: "",
    });
    expect(lastPutInput().ContentType).toBe("application/octet-stream");
  });

  it("uploads nothing when the account id is unsafe", async () => {
    await expect(
      putRightsEvidence({
        instagramAccountId: "../media",
        filename: "a.pdf",
        body,
      }),
    ).rejects.toThrow("Unsafe");
    expect(sendMock).not.toHaveBeenCalled();
  });
});
