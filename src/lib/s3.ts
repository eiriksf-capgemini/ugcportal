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
 *    already known to be absent, from the guard above) AND `attempts > 1` —
 *    covers whatever reaches here without having been renamed/coded that
 *    way yet. `@smithy/core`'s retry middleware stamps `$metadata` onto
 *    every error it gives up retrying; a response that was actually
 *    received always gets `httpStatusCode` set on it too (a service error
 *    like AccessDenied or NoSuchBucket always carries one), so by the time
 *    this branch runs, "no `httpStatusCode`" already means "no response".
 *    The `attempts > 1` half is round-5's own fix — see below.
 *
 * What this function can distinguish: "the SDK gave up without ever hearing
 * an HTTP response back" from "the backend answered, even with an error (or
 * cut short after answering)". What it CANNOT distinguish: *why* no response
 * came back. It also matches, for instance, a credential-signing failure, a
 * local TLS validation error, or a request aborted by a client-side timeout
 * wrapper — anything the SDK gave up on before or without a response, not
 * only an unreachable backend. That over-breadth is bounded two ways:
 *
 *  - by *where* this is called from: `sendWithTransportClassification`
 *    below only ever runs it against the error an S3 SDK call itself threw,
 *    so a DB/libSQL error that happens to carry a transport-shaped `code`
 *    (e.g. its own `ECONNRESET`) is never passed through this function in
 *    the first place, and therefore can never be mislabelled as "object
 *    storage unreachable" (round-1 finding 1);
 *  - by `attempts > 1` in the fallback branch (round-5 review finding): a
 *    signing failure (bad credentials) or a local TLS validation error is
 *    NOT a transport failure the SDK retries — `@smithy/core`'s retry
 *    middleware gives up after the first attempt for those, same as it
 *    would for a genuine one-shot configuration error, so `$metadata`
 *    reaches here with `attempts: 1`. Without this check such an error —
 *    permanent, not transient — was answered as a retryable 503, telling a
 *    caller to try again when trying again can never help. A real
 *    transport failure, by contrast, is exactly the case `@smithy/core`'s
 *    retry middleware DOES retry, so it always reaches here with
 *    `attempts > 1` (the SDK's default `maxAttempts` is 3). The accepted
 *    trade-off: a client explicitly configured with `maxAttempts: 1` loses
 *    this fallback branch entirely — its transport failures also stop at
 *    `attempts: 1`, indistinguishable from the permanent-failure case this
 *    check exists to exclude — and falls through to the generic,
 *    non-storage-unreachable error path instead. That is judged the lesser
 *    cost: it is a deliberate, unusual configuration choice, not the
 *    default, and this module cannot tell "one attempt because the client
 *    asked for one" apart from "one attempt because retrying would not have
 *    helped" from the error alone.
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

  // Computed once (ugcportal-qz1u item 5) rather than re-read in each of the
  // three branches below — `err.$metadata?.attempts` already reads as
  // `undefined` whenever `$metadata` itself is absent, so a branch testing
  // `attempts !== undefined` is testing both at once; it does not need its
  // own separate `err.$metadata !== undefined` guard in front of it.
  const attempts = err.$metadata?.attempts;

  if (err.name === "TimeoutError") {
    return { code: err.code ?? err.name, attempts };
  }
  if (err.code !== undefined && TRANSPORT_ERROR_CODES.has(err.code)) {
    return { code: err.code, attempts };
  }
  if (
    // Round-5 review finding: without this, a permanent, non-retryable
    // local failure (bad credentials failing to sign the request, a TLS
    // validation error) was indistinguishable from a genuine transport
    // failure the SDK gave up on — both reach here with `$metadata` and no
    // `httpStatusCode`. The SDK's own retry middleware is the discriminator:
    // it retries transport failures (this module's whole reason to exist)
    // but stops at the FIRST attempt for a local, non-retryable one, so
    // `attempts > 1` is true only for the case this branch should actually
    // match. See this function's own top doc comment for the accepted
    // trade-off (a client configured with `maxAttempts: 1` loses this
    // branch entirely).
    attempts !== undefined &&
    attempts > 1
  ) {
    // `?? err.name` used to fall back here, and for a plain `new Error(...)`
    // that is the literal string `"Error"` — a code that reads as
    // meaningful but names nothing (round-3 finding 3). `"unknown"` says
    // plainly that no real code was available; `message` and `cause` (see
    // the structured log in src/app/api/media/route.ts, which includes this
    // whole error as `cause`) are where the actual detail lives for this
    // branch regardless.
    return { code: err.code ?? "unknown", attempts };
  }
  return null;
}

/**
 * Which S3 call failed. A closed union rather than a plain `string`
 * (ugcportal-1b2c): the call sites are enumerable, so the type should say
 * so rather than accept anything a future one happens to type. Widen it
 * when a new one appears — as ugcportal-98rb did below — rather than
 * loosening it back to `string`.
 *
 * One member per CALL SITE, not per command type, and that is the whole
 * reason the label exists: a log line has to say which call failed, and two
 * different routes both issuing a `DeleteObjectCommand` (`cleanup` and
 * `media-delete` below) are exactly the pair that needs telling apart.
 *
 * The set below is the complete list of sites as of ugcportal-98rb, and it
 * is checked rather than asserted here: src/lib/s3-call-sites.test.ts walks
 * the AST of every source file and fails if a `getS3Client().send(...)`
 * exists outside `sendWithTransportClassification` (and so outside this
 * union) without a commented exception.
 */
export type ObjectStorageOperation =
  // POST /api/media (ugcportal-1b2c).
  | "original"
  | "preview"
  | "cleanup"
  // GET /api/media/preview/[previewId] — the preview bytes (ugcportal-98rb).
  | "preview-fetch"
  // POST /api/admin/rights/decision, via src/lib/rights-evidence.ts.
  | "evidence"
  | "evidence-cleanup"
  // DELETE /api/media/[id]'s best-effort object removal.
  | "media-delete";

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
 * The fields the three sibling "object storage unreachable" log lines
 * ugcportal-98rb added — in GET /api/media/preview/[previewId], DELETE
 * /api/media/[id] and src/lib/rights-evidence.ts — all report, built in one
 * place so they cannot drift apart in what they say about the same failure
 * (ugcportal-98rb K1/K2: "the SAME structured line is logged"). Not every
 * such line in the codebase: see the note at the end about POST
 * /api/media's, which is not one of this function's callers.
 *
 * What each field is for:
 *  - `operation` — which call site failed, since a route can make more than
 *    one S3 call inside the same try/catch;
 *  - `code` — the transport code `classifyTransportFailure` recognised
 *    (`ECONNREFUSED`, `ETIMEDOUT`, ...), which is what distinguishes this
 *    from a credentials or bucket-policy failure at a glance;
 *  - `attempts` — how many tries the SDK's own retry middleware made before
 *    giving up. `undefined` when the error carried no `$metadata` at all;
 *  - `message` — the underlying SDK error's message, for a quick scan;
 *  - `cause` — the `ObjectStorageUnreachableError` itself, so `console.error`
 *    has an Error object to print a stack from and Node unfolds the original
 *    SDK error through its own `cause` chain. Dropping it leaves an outage
 *    with no stack at all (ugcportal-1b2c).
 *
 * Deliberately NOT a console call of its own: the log PREFIX differs by
 * subsystem (`[media]`, `[resale-rights]`), one caller throttles the line
 * and the others must not, and two callers add their own context (the
 * uploader id, the orphaned key). Returning the fields lets each caller
 * spread them into its own line and keep the half that is genuinely its
 * own.
 *
 * POST /api/media's own storage-unreachable line is NOT a caller of this
 * function. It was written first (ugcportal-1b2c) and still builds the same
 * object inline, at the `console.error("[media] object storage unreachable"`
 * in src/app/api/media/route.ts's catch; ugcportal-98rb's scope freeze kept
 * this branch out of that file. The five field names are the same in both —
 * compare that call with the type below — but "the same" there means two
 * copies that agree, not one shared implementation, and nothing fails if
 * they stop agreeing. Migrating it is a follow-up, named in this PR body.
 */
export type ObjectStorageUnreachableLogFields = {
  operation: ObjectStorageOperation;
  code: string;
  attempts: number | undefined;
  message: string;
  cause: ObjectStorageUnreachableError;
};

export function objectStorageUnreachableLogFields(
  error: ObjectStorageUnreachableError,
): ObjectStorageUnreachableLogFields {
  return {
    operation: error.operation,
    code: error.code,
    attempts: error.attempts,
    message: error.message,
    cause: error,
  };
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
    // `error instanceof Error` is runtime-redundant here: `classifyTransportFailure`
    // already returns non-null (`info`) only when its own `error instanceof Error`
    // check passed, so `info` truthy implies this is already true. It is kept
    // purely to narrow `error`'s TYPE from `unknown` to `Error` for the
    // `ObjectStorageUnreachableError` constructor below, which requires one —
    // TypeScript cannot infer that narrowing across the separate `classifyTransportFailure`
    // call (round-5 review finding).
    if (info && error instanceof Error) {
      throw new ObjectStorageUnreachableError(operation, error, info);
    }
    throw error;
  }
}
