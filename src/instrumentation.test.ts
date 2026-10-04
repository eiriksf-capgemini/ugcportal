import { describe, expect, it } from "vitest";

import {
  checkContactEmailConfiguration,
  checkEvidenceEncryption,
  checkSignInConfiguration,
} from "@/instrumentation";
import { CONTACT_EMAIL_PLACEHOLDER } from "@/lib/contact";
import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";

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

/**
 * ugcportal-egp: sign-in is refused by default, which is the correct default
 * and the wrong thing to be quiet about. Both configuration states that
 * permit nobody are announced before the first request.
 */
describe("the sign-in configuration startup check", () => {
  it("says loudly that nobody can sign in when nothing is configured", () => {
    const warning = checkSignInConfiguration({ NODE_ENV: "production" });

    expect(warning).toContain("NOBODY can sign in");
    expect(warning).toContain(PERMITTED_EMAILS_VAR);
    expect(warning).toContain("docs/access-control.md");
  });

  it("is quiet once an address is permitted", () => {
    // The needle-can-be-absent control for every case in this block.
    expect(
      checkSignInConfiguration({
        [PERMITTED_EMAILS_VAR]: "owner@example.com",
      }),
    ).toBeNull();
  });

  it("is quiet when only the bootstrap variable is set", () => {
    // A fresh deployment following env.example's ugcportal-lu7 instructions
    // is configured, not broken.
    expect(
      checkSignInConfiguration({ ADMIN_BOOTSTRAP_EMAILS: "admin@example.com" }),
    ).toBeNull();
  });

  it("explains the provider prefix when an entry cannot be used (ugcportal-1551)", () => {
    const message = checkSignInConfiguration({
      ALLOWED_SIGNIN_EMAILS: "twitter:someone@example.com",
    });
    expect(message).toContain("twitter:someone@example.com");
    expect(message).toContain("google:");
    expect(message).toContain("facebook:");
    expect(message).toContain("NOBODY can sign in");
  });

  it("names an entry it cannot use rather than silently permitting nobody", () => {
    // The more dangerous of the two quiet states: `*@example.com` reads like
    // it works, and would otherwise look configured while permitting nobody.
    const warning = checkSignInConfiguration({
      [PERMITTED_EMAILS_VAR]: "*@example.com",
    });

    expect(warning).toContain("*@example.com");
    expect(warning).toContain("wildcards and domain patterns are not supported");
    expect(warning).toContain("NOBODY can sign in");
  });

  it("reports a partly-usable list without claiming nobody can sign in", () => {
    // The claim has to match the situation: one bad entry alongside a good
    // one is worth reporting, but "NOBODY can sign in" would be false.
    const warning = checkSignInConfiguration({
      [PERMITTED_EMAILS_VAR]: "nobody, owner@example.com",
    });

    expect(warning).toContain("nobody");
    expect(warning).not.toContain("NOBODY can sign in");
    expect(warning).toContain("1 address(es) remain permitted");
  });

  it("warns outside production too", () => {
    // Unlike the encryption check above: a fresh local checkout is exactly
    // where this is hit first, and env.example ships the variable empty.
    expect(checkSignInConfiguration({ NODE_ENV: "development" })).toContain(
      "NOBODY can sign in",
    );
    expect(checkSignInConfiguration({})).toContain("NOBODY can sign in");
  });
});

/**
 * ugcportal-qnq9.7 round-1 review: moved out of src/lib/contact.ts's own
 * `resolveContactEmail`, which used to throw at render time. Same shape as
 * the two checks above — a warning at boot, not a refusal to boot.
 */
describe("the contact-email startup check", () => {
  it("warns when production has nothing configured", () => {
    const warning = checkContactEmailConfiguration({
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);

    expect(warning).toContain("CONTACT_EMAIL is not set");
    expect(warning).toContain(CONTACT_EMAIL_PLACEHOLDER);
    expect(warning).toContain("env.example");
  });

  it("warns when production's CONTACT_EMAIL is whitespace-only", () => {
    expect(
      checkContactEmailConfiguration({
        NODE_ENV: "production",
        CONTACT_EMAIL: "   ",
      } as NodeJS.ProcessEnv),
    ).toContain("CONTACT_EMAIL is not set");
  });

  it("is quiet once a real address is configured", () => {
    expect(
      checkContactEmailConfiguration({
        NODE_ENV: "production",
        CONTACT_EMAIL: "owner@example.com",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("says nothing outside production when simply unset", () => {
    // Local dev and CI never set CONTACT_EMAIL; warning there would train
    // people to ignore it, same reasoning as the evidence-encryption check.
    expect(
      checkContactEmailConfiguration({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      checkContactEmailConfiguration({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  // Round-2 review: a malformed value is a real mistake the moment it is
  // made, so — unlike "simply unset" above — this is flagged in every
  // environment, the same way the sign-in check's own malformed-entry case
  // is unconditional.
  describe("rejects anything that is not a bare address", () => {
    it('warns on "Name <addr>" even outside production', () => {
      const warning = checkContactEmailConfiguration({
        NODE_ENV: "development",
        CONTACT_EMAIL: "Jane Doe <jane@example.com>",
      } as NodeJS.ProcessEnv);

      expect(warning).toContain("not a");
      expect(warning).toContain("bare email address");
      expect(warning).toContain("Jane Doe <jane@example.com>");
    });

    it("warns on a value containing any whitespace", () => {
      expect(
        checkContactEmailConfiguration({
          NODE_ENV: "development",
          CONTACT_EMAIL: "jane doe@example.com",
        } as NodeJS.ProcessEnv),
      ).toContain("bare email address");
    });

    it("still warns in production, in place of the usual 'is not set' message", () => {
      const warning = checkContactEmailConfiguration({
        NODE_ENV: "production",
        CONTACT_EMAIL: "Jane Doe <jane@example.com>",
      } as NodeJS.ProcessEnv);

      expect(warning).toContain("bare email address");
      expect(warning).not.toContain("CONTACT_EMAIL is not set");
    });

    it("is quiet for an ordinary bare address", () => {
      expect(
        checkContactEmailConfiguration({
          NODE_ENV: "development",
          CONTACT_EMAIL: "jane@example.com",
        } as NodeJS.ProcessEnv),
      ).toBeNull();
    });
  });
});
