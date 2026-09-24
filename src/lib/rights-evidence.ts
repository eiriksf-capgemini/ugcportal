import { createHash, randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";

import { getBucketName, getS3Client } from "@/lib/s3";

/**
 * The rights-evidence store (ugcportal-0ss, checklist Part E.2).
 *
 * Signed instruments, model releases and filled-in checklists are contracts
 * and personal data. They live under their own private prefix, are never
 * recorded in the `Media` table (which is the table of *sellable* assets, and
 * whose rows are reachable from buyer-facing surfaces), and are never served
 * to anyone but an admin. Only the object key and a SHA-256 of the bytes go
 * into the database, on ResaleRightsReview.
 *
 * What this module guarantees and what it does not:
 *  - it always writes under `rights-evidence/<instagramAccountId>/`, and the
 *    account id is checked against a strict pattern first, so a caller cannot
 *    traverse out of the prefix;
 *  - it never sets a public-read ACL, and asks for server-side encryption;
 *  - it does **not** make the bucket private on its own. If the bucket has a
 *    blanket public-read policy, nothing in application code can fix that —
 *    that is a deployment-level control (ugcportal-odx for DreamObjects,
 *    docker-compose.yml for local MinIO).
 */

export const RIGHTS_EVIDENCE_PREFIX = "rights-evidence";

/**
 * Server-side encryption to request. SSE-S3 (`AES256`) by default; set
 * `S3_EVIDENCE_SSE=none` for a local MinIO without a KMS configured, which
 * rejects the header rather than ignoring it.
 *
 * Not yet in env.example: that file is owned by another in-flight branch
 * (ugcportal-e86, PR #31) and editing it here would conflict. Documented in
 * the follow-up bead instead.
 */
function encryptionSetting(): "AES256" | undefined {
  const configured = process.env.S3_EVIDENCE_SSE?.trim();
  if (configured === "none") {
    return undefined;
  }
  return "AES256";
}

/** cuid/cuid2-ish: the ids this app generates, and nothing with a slash. */
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
  instagramAccountId: string,
  filename: string,
): string {
  if (!SAFE_ACCOUNT_ID.test(instagramAccountId)) {
    throw new Error("Unsafe Instagram account id for an evidence key");
  }
  return `${RIGHTS_EVIDENCE_PREFIX}/${instagramAccountId}/${randomUUID()}-${safeFilenamePart(filename)}`;
}

export type StoredEvidence = { key: string; sha256: string };

/**
 * Upload one evidence file and return what the review row records: where it
 * is, and a hash proving it is the file that was reviewed.
 */
export async function putRightsEvidence({
  instagramAccountId,
  filename,
  body,
  contentType,
}: {
  instagramAccountId: string;
  filename: string;
  body: Uint8Array;
  contentType?: string;
}): Promise<StoredEvidence> {
  const key = rightsEvidenceKey(instagramAccountId, filename);
  const sha256 = createHash("sha256").update(body).digest("hex");

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      ServerSideEncryption: encryptionSetting(),
      // Belt and braces against a bucket whose default ACL is public-read.
      ACL: "private",
    }),
  );

  return { key, sha256 };
}
