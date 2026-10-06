import { createHash, randomUUID } from "node:crypto";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { parseEvidenceSSESetting } from "@/lib/evidence-encryption";
import { getBucketName, getS3Client } from "@/lib/s3";

/**
 * The rights-evidence store (ugcportal-0ss, checklist Part E.2; re-anchored
 * to uploaders by ugcportal-vsm).
 *
 * Signed instruments, model releases and filled-in checklists are contracts
 * and personal data. They live under their own private prefix, are never
 * recorded in the `Media` table (which is the table of *sellable* assets, and
 * whose rows are reachable from buyer-facing surfaces), and are never served
 * to anyone but an admin. Only the object key and a SHA-256 of the bytes go
 * into the database, on ResaleRightsReview.
 *
 * What this module guarantees and what it does not:
 *  - it always writes under `rights-evidence/<uploaderUserId>/`, and the id
 *    is checked against a strict pattern first, so a caller cannot traverse
 *    out of the prefix. Objects written before ugcportal-vsm sit under a
 *    connected account's id instead; nothing rewrites them, and the key on
 *    the audit row is still what finds them;
 *  - it sends no ACL at all (see the note at the PutObjectCommand) and asks
 *    for server-side encryption when `S3_EVIDENCE_SSE=AES256` is set (see
 *    below — off by default so the KMS-less dev MinIO works out of the box);
 *  - it does **not** make the bucket private on its own. If the bucket has a
 *    blanket public-read policy, nothing in application code can fix that —
 *    that is a deployment-level control (ugcportal-odx for DreamObjects,
 *    docker-compose.yml for local MinIO).
 */

export const RIGHTS_EVIDENCE_PREFIX = "rights-evidence";

/**
 * Server-side encryption to request, from `S3_EVIDENCE_SSE`.
 *
 * **Off by default, and that is a deployment requirement, not an oversight.**
 * The development stack is the MinIO in docker-compose.yml with no KMS
 * configured, and MinIO answers a `ServerSideEncryption: AES256` header with
 * an error rather than ignoring it — so defaulting it on would mean evidence
 * upload fails on a fresh checkout, which is how a feature ends up disabled
 * in production too. Defaulting it off keeps dev working and makes the
 * production setting an explicit, reviewable act:
 *
 *     S3_EVIDENCE_SSE=AES256
 *
 * **Production must set this** (DreamObjects, ugcportal-odx), or evidence —
 * contracts and personal data — sits unencrypted at rest at the object level.
 * Bucket-default encryption set on the storage side satisfies the same
 * requirement and is the better answer where it is available, since it cannot
 * be forgotten per-request.
 *
 * Documented in env.example, and a production start with neither this nor
 * `S3_EVIDENCE_ENCRYPTED_AT_BUCKET=true` logs a warning at boot (see
 * src/instrumentation.ts).
 *
 * The parsing itself — trim, then compare — lives in
 * `parseEvidenceSSESetting` (src/lib/evidence-encryption.ts), shared with
 * that boot check, so this function and the warning it can silence cannot
 * disagree about what counts as configured (ugcportal-gkj). `env` is a
 * parameter, defaulting to `process.env`, for the same reason the checks in
 * src/instrumentation.ts take one: so a test can hand this a fixture instead
 * of mutating the real environment.
 */
export function encryptionSetting(
  env: NodeJS.ProcessEnv = process.env,
): "AES256" | undefined {
  return parseEvidenceSSESetting(env.S3_EVIDENCE_SSE);
}

/** cuid/cuid2-ish: the ids this app generates, and nothing with a slash. */
const SAFE_SUBJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Object keys get a strict allowlist rather than a blocklist: `..`, slashes,
 * NUL and anything else that could change where the object lands all fall
 * outside `[A-Za-z0-9._-]`. The random prefix means two uploads of
 * `contract.pdf` never collide, so nothing is silently overwritten.
 */
function safeFilenamePart(filename: string): string {
  const cleaned = filename
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // S3 keys are flat, so `..` cannot traverse anything here — but plenty
    // of tools (mc mirror, an rclone sync, a support script) treat a key as
    // a path, and a segment containing `..` is a trap for them.
    .replace(/\.{2,}/g, "_")
    .slice(-100);
  // A name that sanitised down to punctuation is no name at all.
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "evidence";
}

export function rightsEvidenceKey(
  uploaderUserId: string,
  filename: string,
): string {
  if (!SAFE_SUBJECT_ID.test(uploaderUserId)) {
    throw new Error("Unsafe uploader id for an evidence key");
  }
  return `${RIGHTS_EVIDENCE_PREFIX}/${uploaderUserId}/${randomUUID()}-${safeFilenamePart(filename)}`;
}

export type StoredEvidence = { key: string; sha256: string };

/**
 * Removes an evidence object whose decision was never recorded.
 *
 * The upload happens before the database write so that a clearance can never
 * name evidence that isn't there. The cost is the opposite orphan — an
 * object with nothing pointing at it — and since these are contracts and
 * personal data, "left in the bucket forever" is not a neutral outcome.
 *
 * Best-effort and never thrown: the caller is already on an error path, and
 * failing to tidy up must not replace the message explaining what actually
 * went wrong. A failure is logged with the key so it can be found by hand.
 */
export async function deleteRightsEvidence(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }),
    );
  } catch (cause) {
    console.error("[resale-rights] failed to remove unused evidence object", {
      key,
      cause,
    });
  }
}

/**
 * Upload one evidence file and return what the review row records: where it
 * is, and a hash proving it is the file that was reviewed.
 */
export async function putRightsEvidence({
  uploaderUserId,
  filename,
  body,
  contentType,
}: {
  uploaderUserId: string;
  filename: string;
  body: Uint8Array;
  contentType?: string;
}): Promise<StoredEvidence> {
  const key = rightsEvidenceKey(uploaderUserId, filename);
  const sha256 = createHash("sha256").update(body).digest("hex");

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      ServerSideEncryption: encryptionSetting(),
      // No ACL header, deliberately. `ACL: "private"` looks like free
      // defence-in-depth but is not: a bucket with Object Ownership set to
      // "bucket owner enforced" — the modern default, and the configuration
      // you *want* for a private evidence store — rejects any ACL header
      // outright, which would make every evidence-bearing decision
      // unrecordable. The media upload path sends none either.
      //
      // Privacy here is the bucket's job: no public-read policy, no
      // anonymous access. Nothing in this application serves objects from
      // this prefix — there is no presign or download route for it — so the
      // only way one becomes readable is a bucket misconfiguration, which a
      // per-request header would not have fixed anyway.
    }),
  );

  return { key, sha256 };
}
