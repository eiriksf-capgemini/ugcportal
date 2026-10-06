import { createHash } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

// Only the client and the bucket are stubbed; `sendWithTransportClassification`
// and `classifyTransportFailure` stay real, because the classification is
// what ugcportal-98rb's tests below are about.
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...actual,
    getS3Client: () => ({ send: sendMock }),
    getBucketName: () => "ugcportal-test",
  };
});

const {
  RIGHTS_EVIDENCE_PREFIX,
  deleteRightsEvidence,
  putRightsEvidence,
  rightsEvidenceKey,
} = await import("@/lib/rights-evidence");
const { ObjectStorageUnreachableError } = await import("@/lib/s3");

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
  it("puts every file under the uploader's own private prefix", () => {
    const key = rightsEvidenceKey("uploader-1", "assignment.pdf");
    expect(key.startsWith(`${RIGHTS_EVIDENCE_PREFIX}/uploader-1/`)).toBe(true);
    expect(key.endsWith("-assignment.pdf")).toBe(true);
  });

  it("cannot be walked out of the prefix by a hostile filename", () => {
    const key = rightsEvidenceKey("uploader-1", "../../../uploads/original.jpg");
    expect(key).not.toContain("..");
    // prefix / uploader / object — three segments, no more.
    expect(key.split("/")).toHaveLength(3);
  });

  it("keeps a usable name when the filename sanitises to nothing", () => {
    const key = rightsEvidenceKey("uploader-1", "…");
    expect(key.endsWith("-evidence")).toBe(true);
  });

  it("rejects an uploader id that isn't one", () => {
    for (const id of ["../user-2", "user/1", "", "a".repeat(65), "user 1"]) {
      expect(() => rightsEvidenceKey(id, "x.pdf")).toThrow("Unsafe");
    }
  });

  it("never collides two uploads of the same filename", () => {
    expect(rightsEvidenceKey("uploader-1", "c.pdf")).not.toBe(
      rightsEvidenceKey("uploader-1", "c.pdf"),
    );
  });
});

describe("putRightsEvidence", () => {
  const body = new Uint8Array([1, 2, 3, 4]);

  it("stores the file privately and returns its hash", async () => {
    const result = await putRightsEvidence({
      uploaderUserId: "uploader-1",
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
    });
    expect(input.Key?.startsWith("rights-evidence/uploader-1/")).toBe(true);
  });

  // A bucket with Object Ownership = "bucket owner enforced" rejects any ACL
  // header outright, and that is the configuration a private evidence store
  // should be running. Sending `ACL: private` would make every
  // evidence-bearing decision unrecordable there, for no gain: privacy is
  // the bucket's job. The media upload path sends none either.
  it("sends no ACL header at all", async () => {
    await putRightsEvidence({
      uploaderUserId: "uploader-1",
      filename: "a.pdf",
      body,
    });

    expect(lastPutInput().ACL).toBeUndefined();
    expect("ACL" in lastPutInput()).toBe(false);
  });

  // The dev stack is a KMS-less MinIO, which rejects the SSE header rather
  // than ignoring it. Sending it by default would break evidence upload on a
  // fresh checkout, so it is opt-in.
  it("sends no encryption header unless one is configured", async () => {
    await putRightsEvidence({
      uploaderUserId: "uploader-1",
      filename: "a.pdf",
      body,
    });

    expect(lastPutInput().ServerSideEncryption).toBeUndefined();
  });

  it("asks for SSE-S3 when production configures it", async () => {
    process.env.S3_EVIDENCE_SSE = "AES256";

    await putRightsEvidence({
      uploaderUserId: "uploader-1",
      filename: "a.pdf",
      body,
    });

    expect(lastPutInput().ServerSideEncryption).toBe("AES256");
  });

  it("ignores a value it does not understand rather than sending it", async () => {
    // A typo'd or unsupported algorithm must not reach S3 as a header that
    // fails the whole upload.
    process.env.S3_EVIDENCE_SSE = "aes256";

    await putRightsEvidence({
      uploaderUserId: "uploader-1",
      filename: "a.pdf",
      body,
    });

    expect(lastPutInput().ServerSideEncryption).toBeUndefined();
  });

  it("falls back to a neutral content type", async () => {
    await putRightsEvidence({
      uploaderUserId: "uploader-1",
      filename: "a.pdf",
      body,
      contentType: "",
    });
    expect(lastPutInput().ContentType).toBe("application/octet-stream");
  });

  it("uploads nothing when the uploader id is unsafe", async () => {
    await expect(
      putRightsEvidence({
        uploaderUserId: "../media",
        filename: "a.pdf",
        body,
      }),
    ).rejects.toThrow("Unsafe");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

/**
 * ugcportal-98rb: both halves of this module classify a transport failure,
 * so the route above can tell a storage outage from a refusal — and so the
 * best-effort cleanup says which of the two left the object behind.
 */
describe("object storage unreachable (ugcportal-98rb)", () => {
  const body = new Uint8Array([1, 2, 3]);

  /** As @smithy's retry middleware leaves one it gave up on. */
  function transportError(): Error {
    return Object.assign(new Error("socket hang up"), {
      code: "ECONNREFUSED",
      $metadata: { attempts: 3 },
    });
  }

  /** A reachable endpoint refusing the request itself. */
  function serviceError(): Error {
    return Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403, attempts: 1 },
    });
  }

  it("rethrows an unreachable endpoint as ObjectStorageUnreachableError", async () => {
    sendMock.mockRejectedValue(transportError());

    const thrown = await putRightsEvidence({
      uploaderUserId: "uploader-1",
      filename: "a.pdf",
      body,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ObjectStorageUnreachableError);
    expect(thrown).toMatchObject({
      operation: "evidence",
      code: "ECONNREFUSED",
      attempts: 3,
    });
    // The SDK error is kept, not swallowed, so a log line that dumps this
    // object still has a stack to print.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  it("passes a refusal from the endpoint through unchanged", async () => {
    // The other half of the distinction: an AccessDenied must NOT become
    // an ObjectStorageUnreachableError, or the route answers "try again
    // shortly" to a problem retrying can never fix.
    const refusal = serviceError();
    sendMock.mockRejectedValue(refusal);

    const thrown = await putRightsEvidence({
      uploaderUserId: "uploader-1",
      filename: "a.pdf",
      body,
    }).catch((error: unknown) => error);

    expect(thrown).not.toBeInstanceOf(ObjectStorageUnreachableError);
    expect(thrown).toBe(refusal);
  });

  it("logs the cleanup failure distinguishably, and still never throws", async () => {
    sendMock.mockRejectedValue(transportError());
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      deleteRightsEvidence("rights-evidence/uploader-1/x.pdf"),
    ).resolves.toBeUndefined();
    const transportCalls = [...consoleError.mock.calls];
    // mockClear, not mockReset: in vitest a spy's `mockReset` also puts the
    // original `console.error` back, which would let the second half of
    // this test print to stderr.
    consoleError.mockClear();

    sendMock.mockRejectedValue(serviceError());
    await expect(
      deleteRightsEvidence("rights-evidence/uploader-1/x.pdf"),
    ).resolves.toBeUndefined();
    const refusalCalls = [...consoleError.mock.calls];
    consoleError.mockRestore();

    expect(transportCalls).toEqual([
      [
        "[resale-rights] object storage unreachable",
        expect.objectContaining({
          key: "rights-evidence/uploader-1/x.pdf",
          operation: "evidence-cleanup",
          code: "ECONNREFUSED",
          attempts: 3,
        }),
      ],
    ]);
    expect(refusalCalls).toEqual([
      [
        "[resale-rights] failed to remove unused evidence object",
        expect.objectContaining({ key: "rights-evidence/uploader-1/x.pdf" }),
      ],
    ]);
  });
});

