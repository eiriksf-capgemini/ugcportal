import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Envelope for secrets that must not sit in the clear at rest — currently
// Instagram long-lived access tokens (ugcportal-5ce). AES-256-GCM, so the
// ciphertext is authenticated: a tampered row fails to decrypt rather than
// silently yielding attacker-chosen bytes.
//
// Serialised as `v1.<iv>.<authTag>.<ciphertext>`, each part base64url. The
// version prefix exists so a future key rotation or algorithm change can be
// told apart from the current format instead of guessing at the length.
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for.
const KEY_BYTES = 32;

export const TOKEN_ENCRYPTION_KEY_ENV = "INSTAGRAM_TOKEN_ENCRYPTION_KEY";

// Read lazily rather than at module load: `next build` (and CI) import this
// module without the key present, and a missing key should fail the one
// request that needs it, not the whole build.
function getKey(): Buffer {
  const raw = process.env[TOKEN_ENCRYPTION_KEY_ENV];
  if (!raw) {
    throw new Error(
      `Missing required environment variable: ${TOKEN_ENCRYPTION_KEY_ENV}. ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${TOKEN_ENCRYPTION_KEY_ENV} must decode to ${KEY_BYTES} bytes ` +
        `(got ${key.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}

/** Seal a secret for storage. Never log or return the input alongside this. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Reverse of {@link encryptSecret}. Throws if the envelope is malformed or tampered with. */
export function decryptSecret(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed encrypted secret envelope");
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const authTag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || authTag.length !== 16) {
    throw new Error("Malformed encrypted secret envelope");
  }

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Constant-time string comparison, for OAuth `state` and other values where a
 * length-or-prefix-revealing `===` would leak more than the answer.
 */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
