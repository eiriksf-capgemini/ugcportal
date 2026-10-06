/**
 * Shared parsing for `S3_EVIDENCE_SSE` (ugcportal-gkj).
 *
 * Two call sites each need to answer "is evidence-object encryption
 * configured?" from the same environment variable, and until this module
 * existed they answered it with two different comparisons:
 *
 *  - `src/lib/rights-evidence.ts`'s `encryptionSetting()`, which decides the
 *    `ServerSideEncryption` header actually sent on every evidence
 *    `PutObject`, trimmed the raw value before comparing;
 *  - `src/instrumentation.ts`'s `checkEvidenceEncryption()`, the production
 *    boot check that warns when evidence would be stored unencrypted, did
 *    not.
 *
 * `S3_EVIDENCE_SSE="AES256 "` (trailing whitespace — an easy mistake in a
 * `.env` file or a copy-pasted secret) sent the header while still logging
 * the loud "stored WITHOUT server-side encryption" warning at every
 * production boot, which is exactly backwards: the one message operators are
 * meant to trust unconditionally cried wolf. A single parser, imported by
 * both, is the design that keeps the two from drifting apart again —
 * enforced, not just hoped for, by src/instrumentation.test.ts's "the shared
 * S3_EVIDENCE_SSE parser" describe block, a table-driven test that calls
 * this function and both call sites over every env state and fails if any
 * of the three stops agreeing with the others.
 *
 * This module has no imports of its own and must stay that way:
 * `src/instrumentation.ts` imports it statically, and that file is compiled
 * by Next for BOTH the node and edge runtimes (see its own doc comment and
 * the K4 guardrail in src/instrumentation.test.ts). `src/lib/rights-evidence.ts`
 * is Node-only (it imports `node:crypto` and `@aws-sdk/client-s3`) and is
 * exactly the kind of module that file must never statically reach — this
 * one stays safe for both by doing nothing but string parsing.
 */
export function parseEvidenceSSESetting(
  raw: string | undefined,
): "AES256" | undefined {
  return raw?.trim() === "AES256" ? "AES256" : undefined;
}
