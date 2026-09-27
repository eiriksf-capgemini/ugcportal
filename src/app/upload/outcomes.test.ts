import { describe, expect, it } from "vitest";

import { MAX_SIZE_BYTES } from "@/lib/media";

import {
  MAX_RETRY_AFTER_SECONDS,
  acceptedTypeLabels,
  acceptedTypesSummary,
  cancelledFailure,
  failureForResponse,
  formatBytes,
  networkFailure,
  parseRetryAfter,
  precheckFile,
  type UploadFailure,
} from "./outcomes";

/**
 * ugcportal-n3c K2: every failure the API can produce says something
 * different, and something the person holding the file can act on.
 *
 * The 503 and the 408 are the two that make this more than tidiness. Both
 * were added deliberately — the shed-under-load answer by ugcportal-u7g and
 * ugcportal-e86, the stalled-body answer by ugcportal-05b — precisely so a
 * client could tell "wait and it will work" from "this file never will".
 * Folding them into a generic 5xx would discard the work that made them
 * distinguishable in the first place.
 */

const JPEG = { type: "image/jpeg", size: 1024 };

function failureFor(status: number, body: unknown = null): UploadFailure {
  const failure = failureForResponse({ status, body, retryAfter: null });
  if (failure === null) throw new Error(`status ${status} produced no failure`);
  return failure;
}

describe("every refusal POST /api/media can send is told apart", () => {
  it("maps each status to its own code", () => {
    expect(failureFor(400).code).toBe("bad_request");
    expect(failureFor(401).code).toBe("unauthenticated");
    expect(failureFor(408).code).toBe("stalled");
    expect(failureFor(413).code).toBe("too_large");
    expect(failureFor(415).code).toBe("unsupported_type");
    expect(failureFor(422).code).toBe("unprocessable");
    expect(failureFor(503).code).toBe("busy");
    expect(failureFor(500).code).toBe("server_error");
    expect(failureFor(502).code).toBe("server_error");
  });

  it("gives each one a different sentence", () => {
    // The assertion K2 is actually about. Distinct codes with one shared
    // message would satisfy the test above and fail the user.
    const messages = [400, 401, 408, 413, 415, 422, 503, 500].map(
      (status) => failureFor(status).message,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("says which of those are worth retrying, and which are not", () => {
    // Offering "Try again" on a 415 invites doing the same thing and getting
    // the same answer.
    expect(failureFor(415).retryable).toBe(false);
    expect(failureFor(413).retryable).toBe(false);
    expect(failureFor(422).retryable).toBe(false);
    expect(failureFor(400).retryable).toBe(false);

    expect(failureFor(503).retryable).toBe(true);
    expect(failureFor(408).retryable).toBe(true);
    expect(failureFor(500).retryable).toBe(true);
    expect(failureFor(401).retryable).toBe(true);
  });

  it("routes only the 401 to sign-in", () => {
    expect(failureFor(401).needsSignIn).toBe(true);
    for (const status of [400, 408, 413, 415, 422, 500, 503]) {
      expect(failureFor(status).needsSignIn).toBe(false);
    }
  });

  it("treats 201 as success and any other 2xx as unexplained", () => {
    expect(failureForResponse({ status: 201, body: {}, retryAfter: null })).toBe(
      null,
    );
    // A 200 from this route means something changed that this client has not
    // been taught about. Reporting it as a success would show an "uploaded"
    // row for a file that may not exist.
    expect(failureFor(200).code).toBe("unexpected_status");
    expect(failureFor(302).code).toBe("unexpected_status");
  });

  it("repeats the server's own error string as a secondary detail", () => {
    // The 413 the route sends when the file part was not found near the start
    // of the body names the field and the limit; that is genuinely the most
    // useful line on the screen.
    const failure = failureForResponse({
      status: 413,
      body: {
        error: "Could not find the 'file' field near the start of the request",
        maxBytes: 1024,
      },
      retryAfter: null,
    });
    expect(failure?.detail).toContain("'file' field");
    // Never in place of our own sentence.
    expect(failure?.message).not.toBe(failure?.detail);
  });

  it("drops a detail that is missing, blank, non-string or absurdly long", () => {
    expect(failureFor(500, {}).detail).toBe(null);
    expect(failureFor(500, { error: "   " }).detail).toBe(null);
    expect(failureFor(500, { error: 42 }).detail).toBe(null);
    expect(failureFor(500, { error: "x".repeat(301) }).detail).toBe(null);
    expect(failureFor(500, null).detail).toBe(null);
  });

  it("names the two failures that never reached a status", () => {
    expect(networkFailure().code).toBe("network_error");
    expect(cancelledFailure().code).toBe("cancelled");
    expect(networkFailure().message).not.toBe(cancelledFailure().message);
  });
});

describe("the 503 carries its Retry-After through to the sentence", () => {
  it("honours delta-seconds from the header", () => {
    const failure = failureForResponse({
      status: 503,
      body: { error: "Too many uploads are being processed right now" },
      retryAfter: "12",
    });
    expect(failure?.retryAfterSeconds).toBe(12);
    expect(failure?.message).toContain("12 seconds");
  });

  it("reads a singular second as a singular word", () => {
    expect(
      failureForResponse({ status: 503, body: null, retryAfter: "1" })?.message,
    ).toContain("1 second.");
  });

  it("falls back to the body's retryAfterSeconds when there is no header", () => {
    // The route sets both; a proxy that strips the header must not cost the
    // user the number.
    const failure = failureForResponse({
      status: 503,
      body: { retryAfterSeconds: 7 },
      retryAfter: null,
    });
    expect(failure?.retryAfterSeconds).toBe(7);
  });

  it("prefers the body when the header resolves to zero", () => {
    /*
      `Retry-After: 0` is "now", and a `??` chain treats 0 as a perfectly good
      answer because it is not nullish — so the body's real number was thrown
      away and the sentence read "try again in 0 seconds".
    */
    const failure = failureForResponse({
      status: 503,
      body: { retryAfterSeconds: 9 },
      retryAfter: "0",
    });
    expect(failure?.retryAfterSeconds).toBe(9);
    expect(failure?.message).toContain("9 seconds");
  });

  it("prefers the body when a proxy left a stale date in the header", () => {
    // The same zero by a different road: an absolute time already in the
    // past, which parseRetryAfter clamps.
    const failure = failureForResponse(
      {
        status: 503,
        body: { retryAfterSeconds: 9 },
        retryAfter: "Sun, 27 Sep 2026 11:00:00 GMT",
      },
      Date.parse("2026-09-27T12:00:00.000Z"),
    );
    expect(failure?.retryAfterSeconds).toBe(9);
  });

  it("STILL prefers the header when it says something positive", () => {
    // The fixture mutation for the two above: only the header changes, from
    // a zero to a real wait, and the body's 9 must now lose.
    const failure = failureForResponse({
      status: 503,
      body: { retryAfterSeconds: 9 },
      retryAfter: "30",
    });
    expect(failure?.retryAfterSeconds).toBe(30);
  });

  it("never says to try again in zero seconds", () => {
    for (const retryAfter of ["0", "Sun, 27 Sep 2026 11:00:00 GMT"]) {
      const failure = failureForResponse(
        { status: 503, body: null, retryAfter },
        Date.parse("2026-09-27T12:00:00.000Z"),
      );
      expect(failure?.retryAfterSeconds).toBe(null);
      expect(failure?.message).not.toContain("0 seconds");
      expect(failure?.message).toContain("try again shortly");
    }
  });

  it("still says something useful when neither is present", () => {
    const failure = failureForResponse({
      status: 503,
      body: null,
      retryAfter: null,
    });
    expect(failure?.retryAfterSeconds).toBe(null);
    expect(failure?.retryable).toBe(true);
    expect(failure?.message).toContain("Nothing is wrong with this file");
  });

  it("ignores a body value that is not a positive finite number", () => {
    for (const retryAfterSeconds of [
      0,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "9",
      null,
      undefined,
    ]) {
      expect(
        failureForResponse({
          status: 503,
          body: { retryAfterSeconds },
          retryAfter: null,
        })?.retryAfterSeconds,
      ).toBe(null);
    }
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-09-27T12:00:00.000Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30);
    expect(parseRetryAfter("  30  ", NOW)).toBe(30);
    expect(parseRetryAfter("0", NOW)).toBe(0);
  });

  it("reads an HTTP-date, which a proxy may have rewritten it into", () => {
    expect(parseRetryAfter("Sun, 27 Sep 2026 12:00:45 GMT", NOW)).toBe(45);
  });

  it("clamps a date already in the past to zero rather than counting down", () => {
    expect(parseRetryAfter("Sun, 27 Sep 2026 11:59:00 GMT", NOW)).toBe(0);
  });

  it("returns null for everything it cannot read", () => {
    // Null, not zero: a wrong number gets acted on, a missing one does not.
    expect(parseRetryAfter(null, NOW)).toBe(null);
    expect(parseRetryAfter(undefined, NOW)).toBe(null);
    expect(parseRetryAfter("", NOW)).toBe(null);
    expect(parseRetryAfter("   ", NOW)).toBe(null);
    expect(parseRetryAfter("soon", NOW)).toBe(null);
    expect(parseRetryAfter("-5", NOW)).toBe(null);
    expect(parseRetryAfter("3.5", NOW)).toBe(null);
  });

  it("refuses a digit run that parses to Infinity", () => {
    // Matches /^\d+$/ and is not a number. Without the isFinite check,
    // Math.min(Infinity, MAX) would turn it into a real-looking wait.
    expect(parseRetryAfter("9".repeat(400), NOW)).toBe(null);
  });

  it("caps an implausible wait rather than repeating it", () => {
    expect(parseRetryAfter("999999", NOW)).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(parseRetryAfter("Mon, 28 Sep 2026 12:00:00 GMT", NOW)).toBe(
      MAX_RETRY_AFTER_SECONDS,
    );
  });
});

describe("the pre-check refuses what the server would refuse", () => {
  it("passes a file the API would accept", () => {
    expect(precheckFile(JPEG)).toBe(null);
  });

  it("names an unsupported type", () => {
    const failure = precheckFile({ type: "text/plain", size: 10 });
    expect(failure?.code).toBe("client_unsupported_type");
    expect(failure?.message).toContain("text/plain");
    // Nothing to retry: the same file would be refused identically.
    expect(failure?.retryable).toBe(false);
  });

  it("copes with a file the browser gave no type at all", () => {
    const failure = precheckFile({ type: "", size: 10 });
    expect(failure?.code).toBe("client_unsupported_type");
    expect(failure?.message).not.toContain("undefined");
  });

  it("does not accept a type that is only a name on Object.prototype", () => {
    // `new File([], "x", { type: "constructor" }).type` is the string
    // "constructor", and a bare index into the table answers with the Object
    // constructor. src/lib/media-rules.ts guards this; the client inherits
    // the guard by running that same function.
    for (const type of ["constructor", "toString", "hasOwnProperty"]) {
      expect(precheckFile({ type, size: 10 })?.code).toBe(
        "client_unsupported_type",
      );
    }
  });

  it("names an empty file", () => {
    expect(precheckFile({ type: "image/png", size: 0 })?.code).toBe(
      "client_empty_file",
    );
  });

  it("quotes the real cap when a file is too big, never a typed-in number", () => {
    const failure = precheckFile({
      type: "image/png",
      size: MAX_SIZE_BYTES.IMAGE + 1,
    });
    expect(failure?.code).toBe("client_too_large");
    expect(failure?.message).toContain(formatBytes(MAX_SIZE_BYTES.IMAGE));
  });

  it("applies the video cap to video, not the image one", () => {
    // Straight from MAX_SIZE_BYTES: an image-sized video must pass.
    expect(
      precheckFile({ type: "video/mp4", size: MAX_SIZE_BYTES.IMAGE + 1 }),
    ).toBe(null);
    expect(
      precheckFile({ type: "video/mp4", size: MAX_SIZE_BYTES.VIDEO + 1 })?.code,
    ).toBe("client_too_large");
  });

  it("accepts a file exactly at the cap, because the server does", () => {
    expect(precheckFile({ type: "image/png", size: MAX_SIZE_BYTES.IMAGE })).toBe(
      null,
    );
  });
});

describe("formatBytes", () => {
  it("prints the caps the way the code comments name them", () => {
    expect(formatBytes(MAX_SIZE_BYTES.IMAGE)).toBe("10 MB");
    expect(formatBytes(MAX_SIZE_BYTES.VIDEO)).toBe("200 MB");
  });

  it("keeps one decimal below ten", () => {
    expect(formatBytes(1_500_000)).toBe("1.4 MB");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("says so rather than printing NaN", () => {
    // `bytes < 0` is false for NaN, so a naive guard lets it through and the
    // row reads "NaN B".
    expect(formatBytes(Number.NaN)).toBe("unknown size");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("unknown size");
    expect(formatBytes(-1)).toBe("unknown size");
  });
});

describe("the accepted-type hint is derived, not written out", () => {
  it("labels each kind's types", () => {
    expect(acceptedTypeLabels("IMAGE")).toEqual(["JPEG", "PNG", "WEBP", "GIF"]);
    // `video/quicktime` is the one subtype nobody calls by its subtype.
    expect(acceptedTypeLabels("VIDEO")).toEqual(["MP4", "WEBM", "MOV"]);
  });

  it("prints each kind's real cap beside it", () => {
    expect(acceptedTypesSummary("IMAGE")).toBe(
      `JPEG, PNG, WEBP, GIF up to ${formatBytes(MAX_SIZE_BYTES.IMAGE)}`,
    );
    expect(acceptedTypesSummary("VIDEO")).toBe(
      `MP4, WEBM, MOV up to ${formatBytes(MAX_SIZE_BYTES.VIDEO)}`,
    );
  });
});
