import { S3Client } from "@aws-sdk/client-s3";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let client: S3Client | undefined;

// Same client works against local MinIO (dev) and DreamObjects (prod) —
// only the env vars differ, see env.example.
export function getS3Client(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: requireEnv("S3_ENDPOINT"),
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      credentials: {
        accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
      },
    });
  }
  return client;
}

export function getBucketName(): string {
  return requireEnv("S3_BUCKET_NAME");
}

/**
 * Node's own names for "the connection never worked at all" — as distinct
 * from a well-formed HTTP response the S3-compatible endpoint chose to send
 * back (AccessDenied, NoSuchBucket, ...), which never carries one of these.
 *
 * This is a LITERAL mirror of `@smithy/core`'s own two code lists —
 * `NODEJS_TIMEOUT_ERROR_CODES` and `NODEJS_NETWORK_ERROR_CODES` in
 * `@smithy/core/dist-cjs/submodules/retry/index.js`, the exact lists its
 * `isTransientError` checks `error.code` against to decide whether the SDK's
 * own retry middleware gives a failure another attempt — not an independent
 * judgement call about which codes "feel" transport-shaped. If a future
 * `@smithy/core` release changes either list, this one has drifted out of
 * sync with what it claims to mirror until it is updated to match (round-1
 * review finding 6: an earlier version of this list claimed the same thing
 * while actually omitting EPIPE, EHOSTUNREACH, ENETUNREACH and EAI_AGAIN).
 */
const TRANSPORT_ERROR_CODES = new Set([
  // @smithy/core's NODEJS_TIMEOUT_ERROR_CODES
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  // @smithy/core's NODEJS_NETWORK_ERROR_CODES
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

type TransportLikeError = Error & {
  code?: string;
  $metadata?: { httpStatusCode?: number; attempts?: number };
};

export type TransportFailureInfo = {
  code: string;
  attempts?: number;
};

/**
 * True when `error` looks like a failure to reach the storage backend at
 * all, rather than a response it sent back — e.g. a refused/reset/timed-out
 * connection, or the SDK's own classification of one (`name: "TimeoutError"`,
 * see `@smithy/node-http-handler`'s `NODEJS_TIMEOUT_ERROR_CODES` handling).
 *
 * Two genuinely independent signals, not one derived from the other:
 *
 *  - `name === "TimeoutError"` or `code` in `TRANSPORT_ERROR_CODES`: the
 *    exact shapes `@smithy/node-http-handler` and `@smithy/core`'s own retry
 *    middleware produce for this family of failure.
 *  - the fallback — `$metadata` present with no `httpStatusCode` — covers
 *    whatever reaches here without having been renamed/coded that way.
 *    `@smithy/core`'s retry middleware stamps `$metadata` onto every error it
 *    gives up retrying, but only a real HTTP response ever gets
 *    `httpStatusCode` set on it (a service error like AccessDenied or
 *    NoSuchBucket always carries one; nothing that never reached the network
 *    ever does).
 *
 * What the fallback can distinguish: "the SDK gave up without ever hearing
 * an HTTP response back" from "the backend answered, even with an error".
 * What it CANNOT distinguish: *why* no response came back. It also matches,
 * for instance, a credential-signing failure, a local TLS validation error,
 * or a request aborted by a client-side timeout wrapper — anything the SDK
 * gave up on before or without a response, not only an unreachable backend.
 * That over-breadth is bounded by *where* this is called from, not by the
 * check itself: `sendWithTransportClassification` below only ever runs it
 * against the error an S3 SDK call itself threw, so a DB/libSQL error that
 * happens to carry a transport-shaped `code` (e.g. its own `ECONNRESET`) is
 * never passed through this function in the first place, and therefore can
 * never be mislabelled as "object storage unreachable" (round-1 finding 1).
 */
export function classifyTransportFailure(
  error: unknown,
): TransportFailureInfo | null {
  if (!(error instanceof Error)) return null;
  const err = error as TransportLikeError;
  if (err.name === "TimeoutError") {
    return { code: err.code ?? err.name, attempts: err.$metadata?.attempts };
  }
  if (err.code !== undefined && TRANSPORT_ERROR_CODES.has(err.code)) {
    return { code: err.code, attempts: err.$metadata?.attempts };
  }
  if (err.$metadata !== undefined && err.$metadata.httpStatusCode === undefined) {
    return { code: err.code ?? err.name, attempts: err.$metadata.attempts };
  }
  return null;
}

/**
 * Thrown by `sendWithTransportClassification` in place of whatever the SDK
 * actually raised, exactly when `classifyTransportFailure` recognises that as
 * a transport failure rather than a response the backend sent.
 *
 * The `instanceof` check this gives callers is the point (round-1 finding
 * 1): a catch block that also wraps non-S3 work (a DB transaction, in
 * src/app/api/media/route.ts) cannot safely match on error SHAPE, because a
 * dropped libSQL connection can carry the exact same `code: "ECONNRESET"`
 * shape a reset S3 connection does. Classifying at the SOURCE — only ever
 * around the S3 send itself, in `sendWithTransportClassification` — and
 * rethrowing a type nothing else in this codebase constructs removes that
 * risk structurally, rather than relying on every caller's catch block being
 * careful about what else it wraps.
 */
export class ObjectStorageUnreachableError extends Error {
  readonly code: string;
  readonly attempts: number | undefined;
  /** Which S3 call failed — e.g. `"original"`, `"preview"`, `"cleanup"`. */
  readonly operation: string;

  constructor(operation: string, cause: Error, info: TransportFailureInfo) {
    super(cause.message);
    this.name = "ObjectStorageUnreachableError";
    this.operation = operation;
    this.code = info.code;
    this.attempts = info.attempts;
    this.cause = cause;
  }
}

/**
 * Runs one S3 SDK call and rethrows a transport failure as
 * `ObjectStorageUnreachableError`, labelled with `operation` so a caller's
 * log line can say which of several calls in the same try/catch actually
 * failed (round-1 finding 5).
 *
 * This is the one place that decides "object storage is unreachable" for
 * every caller, rather than each route reimplementing
 * `classifyTransportFailure` against its own catch block — round-1 finding 7:
 * this lived privately in src/app/api/media/route.ts until now, and the
 * sibling S3-touching routes tracked in ugcportal-98rb can call this
 * directly instead of copying it a third and fourth time.
 *
 * A non-transport error (a genuine service error, or anything unrelated)
 * passes through completely unchanged — only the shape
 * `classifyTransportFailure` actually recognises is ever rethrown as the new
 * type.
 */
export async function sendWithTransportClassification<T>(
  operation: string,
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    const info = classifyTransportFailure(error);
    if (info && error instanceof Error) {
      throw new ObjectStorageUnreachableError(operation, error, info);
    }
    throw error;
  }
}
