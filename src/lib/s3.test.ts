import { createRequire } from "node:module";

import { isTransientError } from "@smithy/core/retry";
import { describe, expect, it } from "vitest";

import {
  ObjectStorageUnreachableError,
  TRANSPORT_ERROR_CODES,
  objectStorageUnreachableLogFields,
} from "./s3";

/**
 * Pins TRANSPORT_ERROR_CODES (src/lib/s3.ts) against the INSTALLED
 * `@smithy/core` package, rather than against a second hand-copied list in
 * this test file (round-3 review finding 2).
 *
 * TRANSPORT_ERROR_CODES already drifted out of sync with what it claimed to
 * mirror once (round-1 finding 6: it omitted EPIPE, EHOSTUNREACH,
 * ENETUNREACH and EAI_AGAIN while its own doc comment said it mirrored
 * `@smithy/core`'s lists exactly). A hand-copied second list here would only
 * catch THIS file and the production list disagreeing with each other, not
 * either of them disagreeing with the real SDK — so this test imports the
 * real, installed `isTransientError` and asserts it accepts every code this
 * module's own exported set contains. A future `@smithy/core` upgrade that
 * narrows either of its internal code lists then fails this test directly,
 * rather than silently reopening the same drift a second time.
 *
 * `isTransientError` is deliberately not used in production code instead of
 * TRANSPORT_ERROR_CODES — see that export's own doc comment in src/lib/s3.ts
 * for why it is not a drop-in (it also treats a RECEIVED 5xx response, among
 * other things, as transient, which does not belong in "object storage is
 * unreachable"). This test uses it only as an independent oracle to check
 * against, never as the classifier itself.
 */
describe("TRANSPORT_ERROR_CODES stays aligned with the installed SDK (round-3 finding 2)", () => {
  it.each([...TRANSPORT_ERROR_CODES])(
    "%s is accepted by @smithy/core/retry's isTransientError",
    (code) => {
      // `Error`'s own `.cause` is typed `unknown` in lib.es2022, which is
      // narrower than what `SdkError` (`@smithy/types`) declares for it —
      // an incompatibility that exists purely because this is a plain
      // `Error` standing in for an SDK one, not because the values involved
      // disagree. The cast says so.
      const syntheticError = Object.assign(new Error(`synthetic ${code}`), {
        code,
      }) as unknown as Parameters<typeof isTransientError>[0];

      expect(isTransientError(syntheticError)).toBe(true);
    },
  );
});

/**
 * ugcportal-qz1u item 2: the test above only pins ONE direction — every code
 * TRANSPORT_ERROR_CODES claims is accepted by the installed SDK's own
 * classifier. It says nothing about the other direction: a code the SDK's
 * own `NODEJS_TIMEOUT_ERROR_CODES`/`NODEJS_NETWORK_ERROR_CODES` lists add in
 * a future release, which this module's hand-kept mirror would then be
 * missing, with nothing here to catch it.
 *
 * That reverse assertion needs the real lists to compare against, and they
 * are not part of `@smithy/core`'s public surface: `@smithy/core/retry`'s
 * own index (node_modules/@smithy/core/dist-types/submodules/retry/index.d.ts)
 * re-exports the classification FUNCTIONS (`isTransientError` and friends)
 * but never the underlying constant arrays, and the package's own `exports`
 * map (node_modules/@smithy/core/package.json) has no entry for the
 * `service-error-classification/constants` module they live in — so even a
 * deep import of it is rejected by Node's own package-exports enforcement,
 * not merely undocumented. Confirmed directly against the installed
 * `@smithy/core@3.34.1` below, rather than asserted from reading the
 * `package.json` alone: if a future `@smithy/core` release ever does expose
 * these constants, the assertion below starts failing (the import stops
 * throwing), which is the prompt to replace it with the real reverse
 * comparison this item asks for.
 */
describe("the reverse direction (every @smithy/core transport code is in TRANSPORT_ERROR_CODES) is not checkable today", () => {
  it("the installed @smithy/core does not expose NODEJS_TIMEOUT_ERROR_CODES/NODEJS_NETWORK_ERROR_CODES for import", () => {
    // A real `require(...)` to a real Node module-resolution error, not a
    // Vite-bundler-time one: a literal `import("@smithy/core/dist-cjs/...")`
    // here gets rejected by Vite's OWN static import analysis before the
    // test ever runs (it fails the whole file, un-catchably, the moment
    // this file is transformed) — a different failure from the one this
    // test exists to prove, which is specifically Node's package-exports
    // enforcement. Built from concatenated parts and resolved through
    // Node's real `createRequire`, which this repo's runtime (and the real
    // app) also goes through, so Vite has no static specifier to analyse.
    const require = createRequire(import.meta.url);
    const subpath =
      "@smithy/core/" +
      "dist-cjs/submodules/retry/service-error-classification/constants.js";

    expect(() => require(subpath)).toThrowError(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
    );
  });
});

describe("objectStorageUnreachableLogFields (ugcportal-98rb)", () => {
  // Each caller's log line adds its own prefix and its own extra context,
  // so the only thing holding them in agreement about the FAILURE itself is
  // that they all spread this one object. If a field is dropped here it is
  // dropped from every one of them at once, which is the point — and is why
  // the field set is pinned exactly rather than spot-checked. The callers
  // are deliberately not counted or named here: round-1 review finding 3
  // was this comment saying "three" when there were four. The authoritative
  // list is the "lists every caller of objectStorageUnreachableLogFields"
  // assertion in src/lib/s3-call-sites.test.ts, which derives it from the
  // AST.
  const cause = Object.assign(new Error("socket hang up"), {
    code: "ECONNREFUSED",
  });
  const error = new ObjectStorageUnreachableError("preview-fetch", cause, {
    code: "ECONNREFUSED",
    attempts: 3,
  });

  it("reports exactly the operation, code, attempts, message and cause", () => {
    expect(objectStorageUnreachableLogFields(error)).toEqual({
      operation: "preview-fetch",
      code: "ECONNREFUSED",
      attempts: 3,
      message: "socket hang up",
      cause: error,
    });
  });

  it("carries the error itself as `cause`, so a log line has a stack to print", () => {
    // Not the raw SDK error: that one is reachable from here as
    // `cause.cause`, and Node's own cause-chain printing unfolds both.
    const fields = objectStorageUnreachableLogFields(error);
    expect(fields.cause).toBe(error);
    expect(fields.cause.cause).toBe(cause);
  });

  it("reports an absent attempt count as undefined rather than inventing one", () => {
    const noAttempts = new ObjectStorageUnreachableError("evidence", cause, {
      code: "ECONNRESET",
    });
    expect(objectStorageUnreachableLogFields(noAttempts).attempts).toBeUndefined();
  });
});

