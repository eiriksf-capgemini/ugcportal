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
 *
 * `isTransientError` itself is deliberately NOT called here instead of
 * hand-mirroring its lists (round-3 finding 2): it also treats a RECEIVED
 * 5xx response, a clock-skew-corrected error, and a handful of named SDK
 * error codes as transient, none of which belong in "object storage is
 * unreachable" — so it is not a drop-in replacement for this set. What it
 * IS good for is pinning this hand-kept mirror against the installed
 * package: src/lib/s3.test.ts imports `isTransientError` from
 * `@smithy/core/retry` and asserts it accepts every code in this exact set,
 * so a future `@smithy/core` upgrade that changes either list fails that
 * test instead of silently drifting a second time. Exported so that test can
 * iterate the real list rather than a hand-copied second one.
 */
export const TRANSPORT_ERROR_CODES = new Set([
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
 * `$metadata.httpStatusCode` is checked FIRST, and its absence is required
 * for every one of the three classifications below it, not only the
 * fallback — round-2 finding 1: an earlier version checked it only in the
 * fallback branch, while the `name`/`code` branches matched on shape alone.
 * That let a connection reset while reading an already-received response
 * body — which keeps its Node error `code` (e.g. `ECONNRESET`) AND has
 * `$metadata.httpStatusCode` set, because a real response header's worth of
 * bytes did arrive before the socket reset — slip through the `code` branch
 * and get classified as "unreachable" even though the backend plainly was
 * reached. Requiring `httpStatusCode === undefined` everywhere is a
 * deliberate choice, not the only one that could have been made: this
 * function reserves "storage unreachable" for "no response was ever
 * received", and treats a reset mid-body as a different failure (the
 * backend answered; the bytes just didn't all arrive) rather than folding
 * it into this one. A caller more interested in "did this write definitely
 * NOT happen" than in "was the backend reachable at all" would want the
 * opposite choice; this module does not need that distinction today.
 *
 * With that settled up front, the three classifications below are:
 *
 *  - `name === "TimeoutError"` or `code` in `TRANSPORT_ERROR_CODES`: the
 *    exact shapes `@smithy/node-http-handler` and `@smithy/core`'s own retry
 *    middleware produce for this family of failure.
 *  - the fallback — `$metadata` present at all (its `httpStatusCode` is
 *    already known to be absent, from the guard above) — covers whatever
 *    reaches here without having been renamed/coded that way yet.
 *    `@smithy/core`'s retry middleware stamps `$metadata` onto every error it
 *    gives up retrying; a response that was actually received always gets
 *    `httpStatusCode` set on it too (a service error like AccessDenied or
 *    NoSuchBucket always carries one), so by the time this branch runs, "no
 *    `httpStatusCode`" already means "no response".
 *
 * What this function can distinguish: "the SDK gave up without ever hearing
 * an HTTP response back" from "the backend answered, even with an error (or
 * cut short after answering)". What it CANNOT distinguish: *why* no response
 * came back. It also matches, for instance, a credential-signing failure, a
 * local TLS validation error, or a request aborted by a client-side timeout
 * wrapper — anything the SDK gave up on before or without a response, not
 * only an unreachable backend. That over-breadth is bounded by *where* this
 * is called from, not by the check itself: `sendWithTransportClassification`
 * below only ever runs it against the error an S3 SDK call itself threw, so
 * a DB/libSQL error that happens to carry a transport-shaped `code` (e.g.
 * its own `ECONNRESET`) is never passed through this function in the first
 * place, and therefore can never be mislabelled as "object storage
 * unreachable" (round-1 finding 1).
 */
export function classifyTransportFailure(
  error: unknown,
): TransportFailureInfo | null {
  if (!(error instanceof Error)) return null;
  const err = error as TransportLikeError;
  // A response was received — even one cut short mid-body by a later reset
  // — so the backend was reached. Not "storage unreachable", whatever `code`
  // or `name` the error otherwise carries. See the doc comment above for why
  // this is a deliberate choice, checked once so the three branches below
  // cannot drift out of agreement with it or with each other.
  if (err.$metadata?.httpStatusCode !== undefined) return null;

  if (err.name === "TimeoutError") {
    return { code: err.code ?? err.name, attempts: err.$metadata?.attempts };
  }
  if (err.code !== undefined && TRANSPORT_ERROR_CODES.has(err.code)) {
    return { code: err.code, attempts: err.$metadata?.attempts };
  }
  if (err.$metadata !== undefined) {
    // `?? err.name` used to fall back here, and for a plain `new Error(...)`
    // that is the literal string `"Error"` — a code that reads as
    // meaningful but names nothing (round-3 finding 3). `"unknown"` says
    // plainly that no real code was available; `message` and `cause` (see
    // the structured log in src/app/api/media/route.ts, which includes this
    // whole error as `cause`) are where the actual detail lives for this
    // branch regardless.
    return { code: err.code ?? "unknown", attempts: err.$metadata.attempts };
  }
  return null;
}

/**
 * Which S3 call failed. A closed union rather than a plain `string`
 * (round-2 finding 3) — the three call sites that exist today
 * (src/app/api/media/route.ts's original PutObject, preview PutObject, and
 * the compensating cleanup DeleteObject) are enumerable, so the type should
 * say so rather than accept anything a future call site happens to type.
 * Widen it when a sibling route (ugcportal-98rb) adds a genuinely new
 * operation — e.g. the preview GET route's `GetObjectCommand` — rather than
 * loosening it back to `string`.
 */
export type ObjectStorageOperation = "original" | "preview" | "cleanup";

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
 *
 * The original SDK error is never discarded: it is preserved as this error's
 * own `.cause`, one property access away from any caller (or any log line
 * that dumps this object whole, which `console.error` then unfolds into the
 * printed stack via Node's own `cause`-chain support) — see
 * `sendWithTransportClassification`'s own doc comment for where that is set.
 */
export class ObjectStorageUnreachableError extends Error {
  readonly code: string;
  readonly attempts: number | undefined;
  readonly operation: ObjectStorageOperation;

  constructor(
    operation: ObjectStorageOperation,
    cause: Error,
    info: TransportFailureInfo,
  ) {
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
 * type. The raw SDK error this function caught is never lost in that
 * rethrow — it is set as `error.cause` on the `ObjectStorageUnreachableError`
 * below.
 */
export async function sendWithTransportClassification<T>(
  operation: ObjectStorageOperation,
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
