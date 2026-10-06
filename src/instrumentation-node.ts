/**
 * Boot checks that only run, or only compile, under the Node runtime
 * (ugcportal-177y).
 *
 * Next compiles src/instrumentation.ts's `register()` for BOTH runtimes it
 * instruments — node and edge — because `register()` is the one hook Next
 * calls in each. A static import from that file reaches into both compiled
 * bundles, whatever the import is actually used for at runtime. This module
 * exists so the Node-only checks live somewhere a *static* import never
 * reaches: src/instrumentation.ts loads it with a dynamic `import()` gated
 * on `process.env.NEXT_RUNTIME === "nodejs"` (the pattern Next's own docs
 * recommend for this), so the edge compile never even asks for this file,
 * let alone bundles what it imports — see the K4 static-import-graph test
 * and the K1/K2 build and dev output checked in this PR for the evidence.
 *
 * `checkLegalPagesPublishable` is the reason this module needs to exist at
 * all: at the time of ugcportal-177y's investigation it (via
 * `@/lib/legal/pages` and `@/lib/legal/publishable`) was the only path from
 * src/instrumentation.ts to a Node built-in — `node:crypto`, used by
 * `authoredDigest` to hash each legal page's authored prose (bd notes on
 * ugcportal-177y; reconfirmed by the K4 test, which walks the whole graph
 * rather than trusting that investigation to still hold). That digest is
 * also called synchronously while building `LEGAL_PAGES` itself (consumed
 * by src/app/privacy/content.ts and src/app/licence/content.ts), so
 * replacing `createHash` with the async Web Crypto `subtle` digest would
 * ripple into both of those call sites instead of staying contained here —
 * moving the import, not the implementation, is the smaller change.
 *
 * `checkS3Reachability` (ugcportal-ze1o) belongs here for the same reason,
 * not a second one: `@/lib/s3` and `@aws-sdk/client-s3` reach deep into
 * Node's own networking stack, the same category of thing as `node:crypto`
 * even though no single `node:` specifier names it, so this module is where
 * every check this repository has needed so far that isn't safe to bundle
 * for the edge compile has ended up.
 */
import { HeadBucketCommand } from "@aws-sdk/client-s3";

import { LEGAL_PAGES } from "@/lib/legal/pages";
import { checkLegalPagesPublishable } from "@/lib/legal/publishable";
import { classifyTransportFailure, getBucketName, getS3Client } from "@/lib/s3";

/**
 * How long the boot check waits for object storage to answer before giving
 * up and warning anyway (ugcportal-ze1o, K2: "following should never
 * happen: the check delaying or blocking startup"). Three seconds is far
 * longer than a HeadBucket against a reachable endpoint ever takes and far
 * shorter than anyone would wait on a boot log before suspecting the
 * deployment is stuck.
 */
export const S3_REACHABILITY_TIMEOUT_MS = 3_000;

/** Thrown by `withTimeout` below; never thrown by the SDK itself. */
class S3ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for a response`);
    // Deliberately the same `name` `@smithy/node-http-handler` uses for its
    // own timeout errors, so `classifyTransportFailure` (src/lib/s3.ts)
    // reports this the same way it reports a real one, without a second
    // branch here that has to be kept in sync with that function's own.
    this.name = "TimeoutError";
  }
}

/**
 * Races `promise` against a timer, WITHOUT cancelling `promise` itself —
 * there is no portable way to cancel an arbitrary promise, and the default
 * probe below does not pass an `AbortSignal` into the SDK call for the same
 * reason `classifyTransportFailure`'s doc comment gives for not reusing
 * `isTransientError`: a client-aborted request surfaces as `AbortError`,
 * not one of the shapes that function (and therefore this check's message)
 * already knows how to classify, and inventing a second classification path
 * here is more to keep in sync than it is worth for a boot-time warning.
 * The practical effect is that a probe which eventually does settle, after
 * this function has already returned, settles into a promise nothing reads
 * again — not a leaked timer or a retry, just one abandoned result, exactly
 * once (K3).
 *
 * The `.then(resolve, reject)` below is itself what keeps that abandoned
 * settlement from becoming an `unhandledRejection`: `promise` always has a
 * rejection handler attached, whether or not this races it after the timer
 * already fired.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new S3ProbeTimeoutError(timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One HeadBucket against the configured bucket — the cheapest call that proves the endpoint answers and the bucket exists. */
function defaultS3Probe(): Promise<unknown> {
  return getS3Client().send(new HeadBucketCommand({ Bucket: getBucketName() }));
}

/**
 * The failure-class word the boot warning names (ugcportal-ze1o K1): never
 * the raw error, which for an AWS SDK call can carry request internals, and
 * on a signing failure could echo back configuration this must not log —
 * `classifyTransportFailure` (src/lib/s3.ts) already reduces a transport
 * failure to a short code (`ECONNREFUSED`, `ETIMEDOUT`, ...) for exactly
 * this reason, reused here rather than re-decided. A failure it does not
 * recognise (a well-formed S3 error response, a client-side abort, a plain
 * misconfiguration) falls back to the error's own `name` — still never its
 * `message` — or "unknown" if even that is missing.
 *
 * `isTransportFailure` is `classifyTransportFailure` actually having
 * recognised the failure as transport-shaped, not a guess inferred from
 * `className` after the fact — round-1 review finding 3: the boot warning
 * used to say "looks unreachable" unconditionally, including for a
 * reachable endpoint that answered with a well-formed `AccessDenied`, and
 * for `getBucketName()`/`requireEnv` throwing because `S3_BUCKET_NAME` (or
 * another S3_* variable) was never set at all — neither is a connectivity
 * problem, and telling an operator to `docker compose up -d` for either
 * sends them to fix the wrong thing. `checkS3Reachability` below branches
 * the warning's wording on this flag so only a genuine transport failure
 * gets the "unreachable" / `docker compose` wording.
 */
function describeS3Failure(error: unknown): { className: string; isTransportFailure: boolean } {
  if (!(error instanceof Error)) {
    return { className: "unknown", isTransportFailure: false };
  }
  const info = classifyTransportFailure(error);
  if (info) {
    return { className: info.code, isTransportFailure: true };
  }
  // A plain `new Error(...)` -- e.g. `@/lib/s3`'s `requireEnv` throwing
  // because S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_BUCKET_NAME/etc. are unset
  // entirely, thrown before any network call is attempted -- has
  // `.name === "Error"`: a code that reads as meaningful but names nothing,
  // the same defect `classifyTransportFailure`'s own fallback in
  // src/lib/s3.ts already exists to avoid. Treated the same way here:
  // generic "Error" reports as "unknown", confirmed by this file's "falls
  // back to unknown..." test, which fixture-mutates by reverting to a bare
  // `error.name` fallback and checking that test fails. Either way this
  // branch is not transport-shaped: `classifyTransportFailure` above has
  // already said so by returning `null`.
  const className = error.name && error.name !== "Error" ? error.name : "unknown";
  return { className, isTransportFailure: false };
}

/**
 * Boot-time object storage reachability (ugcportal-ze1o). Split out of
 * `registerNodeOnlyChecks` so it is unit-testable with the probe and the
 * endpoint it names both substitutable, the same `env`-as-parameter
 * convention every check in src/instrumentation.ts already uses.
 *
 * Same bargain as every other check in this file: a warning, never a
 * refusal to boot. A forgotten `docker compose up -d` (env.example's own
 * words for local dev) is exactly the case this exists to surface, and
 * failing the whole server over it would be a worse outcome than an upload
 * that fails later with this warning already in the log explaining why.
 */
export async function checkS3Reachability({
  probe = defaultS3Probe,
  env = process.env,
  timeoutMs = S3_REACHABILITY_TIMEOUT_MS,
}: {
  probe?: () => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<string | null> {
  try {
    await withTimeout(probe(), timeoutMs);
    return null;
  } catch (error) {
    const endpoint = env.S3_ENDPOINT || "(S3_ENDPOINT not set)";
    const { className, isTransportFailure } = describeS3Failure(error);
    // Round-1 review finding 3: a configuration failure (a missing S3_*
    // environment variable, caught before any network call) or an
    // authorization/response failure (a reachable endpoint's own
    // `AccessDenied`) is not "unreachable", and naming it that way sends an
    // operator to run `docker compose up -d` when the actual fix is
    // elsewhere. Only a failure `classifyTransportFailure` itself recognised
    // as transport-shaped gets that wording; everything else gets wording
    // that names the problem without claiming a connectivity failure it
    // cannot show, and points at configuration/credentials instead.
    return isTransportFailure
      ? `[storage] Object storage at ${endpoint} looks unreachable ` +
          `(${className}). Uploads will fail until it is reachable ` +
          "— if this is local development, check `docker compose up -d`. See env.example."
      : `[storage] Object storage at ${endpoint} rejected the request or is ` +
          `misconfigured (${className}). This is not a connectivity problem — ` +
          "uploads will fail until the S3_* environment variables, credentials, " +
          "and bucket permissions are correct. See env.example.";
  }
}

/**
 * Every boot check that belongs behind the Node-runtime guard. Called once
 * from src/instrumentation.ts's `register()`.
 */
export async function registerNodeOnlyChecks(): Promise<void> {
  // Awaited before the loop, not inside it: every other check here is
  // synchronous, and spreading one async call into the array under test
  // would not change the warning's shape, only how it is computed.
  const s3Warning = await checkS3Reachability();
  for (const warning of [
    // ugcportal-qnq9.4: while a LEGAL_* variable is unset (env.example) the
    // legal pages refuse to render in production (src/lib/legal/
    // publishable.ts); say which at boot rather than leaving it to the
    // first visitor to find.
    checkLegalPagesPublishable(LEGAL_PAGES),
    s3Warning,
  ]) {
    if (warning) {
      console.error(warning);
    }
  }
}
