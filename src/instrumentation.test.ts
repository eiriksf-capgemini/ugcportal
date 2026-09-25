import { describe, expect, it } from "vitest";

import { checkEvidenceEncryption } from "@/instrumentation";

const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

describe("the evidence-encryption startup check", () => {
  it("warns when production declares no encryption at all", () => {
    // The case the check exists for: a deployment provisioned from
    // env.example, where the variable is commented out, silently storing
    // contracts and model releases in the clear.
    const warning = checkEvidenceEncryption(PROD);

    expect(warning).toContain("WITHOUT server-side encryption");
    expect(warning).toContain("S3_EVIDENCE_SSE=AES256");
  });

  it("is quiet when the request header is configured", () => {
    expect(
      checkEvidenceEncryption({ ...PROD, S3_EVIDENCE_SSE: "AES256" }),
    ).toBeNull();
  });

  it("is quiet when the bucket encrypts everything and the operator says so", () => {
    // Bucket-level default encryption satisfies the same requirement and is
    // the better answer — it cannot be forgotten per-request.
    expect(
      checkEvidenceEncryption({
        ...PROD,
        S3_EVIDENCE_ENCRYPTED_AT_BUCKET: "true",
      }),
    ).toBeNull();
  });

  it("still warns on a value that rights-evidence would ignore", () => {
    // Only the exact "AES256" is sent as a header, so a typo means no
    // encryption — and the warning has to agree with that, not with the
    // operator's intent.
    expect(
      checkEvidenceEncryption({ ...PROD, S3_EVIDENCE_SSE: "aes256" }),
    ).not.toBeNull();
  });

  it("says nothing outside production", () => {
    // Dev runs against a KMS-less MinIO; warning there would train people
    // to ignore it.
    expect(checkEvidenceEncryption({ NODE_ENV: "development" })).toBeNull();
    expect(checkEvidenceEncryption({ NODE_ENV: "test" })).toBeNull();
  });
});
