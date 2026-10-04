import { isTransientError } from "@smithy/core/retry";
import { describe, expect, it } from "vitest";

import { TRANSPORT_ERROR_CODES } from "./s3";

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
