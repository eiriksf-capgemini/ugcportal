/**
 * Next's boot hook. Runs once per server start, before any request.
 *
 * Used here for configuration warnings that would otherwise only surface as
 * a quiet difference in how data is stored — the kind nobody discovers until
 * an audit.
 */

/**
 * Resale-rights evidence (ugcportal-0ss) is contracts and personal data:
 * signed instruments, model releases, filled-in checklists. It should be
 * encrypted at rest.
 *
 * The request-level header is off by default because the dev MinIO has no
 * KMS and rejects it (see src/lib/rights-evidence.ts), so a deployment
 * provisioned from env.example would silently store this in the clear. This
 * says so, loudly, once, at startup.
 *
 * A warning rather than a refusal to boot: bucket-level default encryption
 * satisfies the same requirement without the header, and taking a
 * correctly-configured deployment offline over an unset variable would be
 * the wrong trade. `S3_EVIDENCE_ENCRYPTED_AT_BUCKET` is how an operator
 * declares that, and silences this.
 */
export function checkEvidenceEncryption(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== "production") {
    return null;
  }
  if (
    env.S3_EVIDENCE_SSE === "AES256" ||
    env.S3_EVIDENCE_ENCRYPTED_AT_BUCKET === "true"
  ) {
    return null;
  }
  return (
    "[resale-rights] Evidence objects under rights-evidence/ will be stored " +
    "WITHOUT server-side encryption. These are contracts and personal data " +
    "(signed instruments, model releases). Set S3_EVIDENCE_SSE=AES256, or " +
    "enable default encryption on the bucket and set " +
    "S3_EVIDENCE_ENCRYPTED_AT_BUCKET=true to record that. See env.example."
  );
}

export async function register(): Promise<void> {
  const warning = checkEvidenceEncryption();
  if (warning) {
    console.error(warning);
  }
}
