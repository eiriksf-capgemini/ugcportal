import type { MediaKind } from "@/generated/prisma/enums";
import {
  ACCEPTED_MIME_TYPES,
  MAX_SIZE_BYTES,
  kindForDeclaredType,
  validateUpload,
} from "@/lib/media-rules";

/**
 * What went wrong with one file, in words the person who picked it can act on
 * (ugcportal-n3c K2).
 *
 * The whole reason this file exists is that POST /api/media answers with
 * SEVEN distinguishable refusals, and a single "upload failed" would flatten
 * all of them into one shrug. Two of those refusals — the 503 under load
 * (ugcportal-u7g / ugcportal-e86) and the 408 on a stalled body
 * (ugcportal-05b) — were built specifically so a client could tell "try again
 * in a moment" from "this file will never work". Reporting them generically
 * would throw that away.
 *
 * So every status the route can produce gets its own code and its own
 * sentence, and a test asserts the sentences are all different.
 */
export type UploadFailureCode =
  // Refused here, before anything is sent.
  | "client_unsupported_type"
  | "client_empty_file"
  | "client_too_large"
  /**
   * `validateUpload` refused it for a reason this file has not been taught to
   * phrase. Its own message is shown; the code says only "refused", because a
   * code is a machine label and labelling an unknown refusal as a type
   * problem makes the label and the visible sentence disagree.
   */
  | "client_refused"
  // Refused by POST /api/media.
  | "unauthenticated" // 401
  | "bad_request" // 400
  | "stalled" // 408
  | "too_large" // 413
  | "unsupported_type" // 415
  | "unprocessable" // 422
  | "busy" // 503
  | "server_error" // other 5xx
  | "unexpected_status" // anything else, including a 2xx that isn't 201
  // Never reached the server, or the answer never came back.
  | "network_error"
  /** Stopped moving mid-flight and never recovered. See UPLOAD_STALL_TIMEOUT_MS. */
  | "connection_stalled"
  // Stopped by the person doing it, before the body had all gone out.
  | "cancelled"
  /**
   * The file had already been sent when this went wrong, so whether it was
   * stored is not something the client can know. See unknownOutcomeFailure.
   */
  | "outcome_unknown";

export type UploadFailure = {
  code: UploadFailureCode;
  /** The sentence shown to the user. */
  message: string;
  /**
   * Whether re-sending the very same bytes could plausibly succeed. Drives
   * whether a "Try again" control is offered at all — offering it on a 415 is
   * an invitation to do the same thing and get the same answer.
   */
  retryable: boolean;
  /**
   * How long to wait first, when the server said. Honoured from the
   * `Retry-After` header POST /api/media sends with its 503s, falling back to
   * the `retryAfterSeconds` field in the body.
   */
  retryAfterSeconds: number | null;
  /**
   * The wall-clock moment before which a retry must not be offered, or null
   * when there is nothing to wait for.
   *
   * A separate field rather than something derived on the fly from
   * `retryAfterSeconds`, because that number is a duration measured from when
   * the RESPONSE ARRIVED, and the UI needs to know how much of it is left now.
   * Printing "try again in 12 seconds" while enabling the button immediately
   * — which is what this page did — tells the user about a shed window and
   * then walks them straight back into it.
   */
  retryNotBefore: number | null;
  /** Whether the only way forward is signing in again. */
  needsSignIn: boolean;
  /**
   * The server's own `error` string, when it sent one worth repeating.
   * Secondary to `message`, never a replacement for it: it is written for
   * whoever is reading logs, and some of it (the 413 that names the multipart
   * field, for instance) is genuinely the most useful thing on the screen.
   */
  detail: string | null;
};

/**
 * Sizes, with the conventional labels.
 *
 * Divides by 1024, because the caps in src/lib/media-rules.ts are written as
 * binary multiples (`10 * 1024 * 1024`) and the point of this function is to
 * print those caps back as the "10 MB" the code comment already calls them.
 * The labels are therefore the customary ones rather than the strictly
 * correct KiB/MiB — a deliberate choice, not an oversight.
 */
export function formatBytes(bytes: number): string {
  // Not `bytes < 0`: that comparison is false for NaN, so a NaN size would
  // fall through and print "NaN B".
  if (!Number.isFinite(bytes) || !(bytes >= 0)) return "unknown size";

  const units = ["B", "KB", "MB", "GB", "TB"];

  /**
   * One decimal below 10 (1.4 MB reads better than 1 MB), none above, and
   * never a trailing ".0".
   */
  const display = (value: number): number =>
    value < 10 ? Math.round(value * 10) / 10 : Math.round(value);

  /*
    THE LOOP TESTS THE ROUNDED VALUE, NOT THE RAW ONE, and that is the whole
    subtlety here. Rounding after the loop has stopped lets a value just under
    the boundary print the NEXT unit's magnitude: 1 048 300 bytes is 1023.73
    KB, which does not clear the `>= 1024` test, and then rounds to the string
    "1024 KB". Deciding on the number that will actually be printed makes the
    two agree, and 1 048 300 comes out as "1 MB".

    Starting at "B" with no unconditional first division, because the same
    boundary exists between bytes and kilobytes. The previous shape divided
    once before the loop and had `units[0]` one step ahead of `value`, which
    printed the 10 MB image cap as "10 GB".
  */
  let value = bytes;
  let unit = 0;
  while (display(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Bytes are whole things; "1.5 B" is not a size.
  return unit === 0
    ? `${Math.round(value)} B`
    : `${display(value)} ${units[unit]}`;
}

/**
 * `video/quicktime` is the only accepted type whose subtype is not already
 * the name people know it by. Everything else uppercases correctly
 * (`image/jpeg` -> JPEG, `video/webm` -> WEBM), so this is an override table
 * rather than a second list of accepted types — which is the point: the list
 * itself still comes from ACCEPTED_MIME_TYPES.
 */
const SUBTYPE_LABELS: Record<string, string> = { quicktime: "MOV" };

/** The accepted types of one kind, as labels, e.g. ["JPEG", "PNG", ...]. */
export function acceptedTypeLabels(kind: MediaKind): string[] {
  return ACCEPTED_MIME_TYPES.filter(
    (mimeType) => kindForDeclaredType(mimeType) === kind,
  ).map((mimeType) => {
    const subtype = mimeType.slice(mimeType.indexOf("/") + 1);
    return SUBTYPE_LABELS[subtype] ?? subtype.toUpperCase();
  });
}

/** "JPEG, PNG, WebP, GIF up to 10 MB" — every number imported, none typed. */
export function acceptedTypesSummary(kind: MediaKind): string {
  return `${acceptedTypeLabels(kind).join(", ")} up to ${formatBytes(
    MAX_SIZE_BYTES[kind],
  )}`;
}

/**
 * The size cap that applies to a file of this declared type, or null when no
 * cap applies because the type is refused outright.
 */
function capForDeclaredType(mimeType: string): number | null {
  const kind = kindForDeclaredType(mimeType);
  return kind === undefined ? null : MAX_SIZE_BYTES[kind];
}

/**
 * Would POST /api/media refuse this file on sight? Runs the SERVER'S OWN
 * `validateUpload` — not a matching copy of its rules — so the answer cannot
 * drift from the one the API would give (K4).
 *
 * Returns null for a file worth sending. What this deliberately cannot check
 * is the magic-byte sniff: the server reads the actual bytes and refuses a
 * `.png` that is really a text file with a 415. That check needs the file
 * contents, so it stays server-side and its refusal is surfaced by
 * `failureForResponse` below.
 */
export function precheckFile(file: {
  type: string;
  size: number;
}): UploadFailure | null {
  const validation = validateUpload(file);
  if (validation.ok) return null;

  switch (validation.status) {
    case 400:
      return {
        code: "client_empty_file",
        message: "This file is empty, so there is nothing to upload.",
        retryable: false,
        retryAfterSeconds: null,
        retryNotBefore: null,
        needsSignIn: false,
        detail: null,
      };
    case 413: {
      const cap = capForDeclaredType(file.type);
      return {
        code: "client_too_large",
        message:
          cap === null
            ? `This file is ${formatBytes(file.size)}, which is over the limit.`
            : `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(
                cap,
              )}, so it was not sent.`,
        retryable: false,
        retryAfterSeconds: null,
        retryNotBefore: null,
        needsSignIn: false,
        detail: null,
      };
    }
    case 415:
      return {
        code: "client_unsupported_type",
        message: `${
          file.type || "This file's type"
        } is not a type this site accepts, so it was not sent.`,
        retryable: false,
        retryAfterSeconds: null,
        retryNotBefore: null,
        needsSignIn: false,
        detail: null,
      };
    default:
      /*
        `validateUpload` produces only 400, 413 and 415 today. A status it
        grows later must not be silently relabelled as one of those, so this
        branch repeats what it actually said rather than inventing a reason —
        AND carries its own code. Passing the message through while stamping
        it `client_unsupported_type` would leave the label and the sentence on
        screen saying different things, which is the one thing a code is for.
      */
      return {
        code: "client_refused",
        message: validation.message,
        retryable: false,
        retryAfterSeconds: null,
        retryNotBefore: null,
        needsSignIn: false,
        detail: null,
      };
  }
}

/**
 * Longest wait this will ever show. A server that says "come back in nine
 * hours" is either broken or under an outage, and repeating the number to the
 * user as though it were a plan is worse than saying "in a moment".
 */
export const MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * RFC 9110 `Retry-After`: either delta-seconds or an HTTP-date. POST
 * /api/media sends the former, but a proxy in front of it may rewrite it to
 * the latter, so both are read.
 *
 * Every failure path returns null rather than a number, because a wrong
 * number is acted on and a missing one is not.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    // A 400-digit run of 9s matches the pattern above and parses to Infinity;
    // `Math.min(Infinity, MAX)` would quietly turn that into a real-looking
    // wait. Refuse it instead.
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
  }

  /*
    Not `Date.parse` on whatever is left. `Date.parse("-5")` is a VALID date
    in V8 (year -5, or thereabouts) — so a malformed header that is merely a
    negative number came back as a date decades in the past, got clamped to
    zero below, and told the caller to retry immediately during exactly the
    overload the header exists to spread out. Caught by the "returns null for
    everything it cannot read" test.

    So: require a clock time first. Every form of Retry-After date has one —
    RFC 9110's IMF-fixdate ("Sun, 06 Nov 1994 08:49:37 GMT") and the two
    obsolete formats it also permits — and no bare number does.
  */
  if (!/\d{1,2}:\d{2}/.test(trimmed)) return null;

  const at = Date.parse(trimmed);
  // `Number.isNaN`, not `at === NaN`, which is false for every value.
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - now) / 1000);
  // A date already in the past means "now"; clamp rather than count down.
  return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER_SECONDS);
}

/**
 * A positive, finite number of seconds from the response body's
 * `retryAfterSeconds`, or null. Used only when the header is missing.
 */
function retryAfterFromBody(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  /*
    All three clauses earn their place.

    `typeof value !== "number"` is doing real work: `"9" > 0` is TRUE in
    JavaScript, so a JSON body carrying the seconds as a string would sail
    past the comparison and end up interpolated into the sentence as whatever
    the server chose to type there.

    `Number.isFinite` excludes Infinity, which `> 0` accepts.

    `!(value > 0)`, rather than `value <= 0`, so NaN lands on the reject side
    — `NaN <= 0` is false, and a NaN would be printed verbatim.
  */
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0)) {
    return null;
  }
  return Math.min(value, MAX_RETRY_AFTER_SECONDS);
}

/** How long this one is worth repeating; the server writes these, not a user. */
const MAX_DETAIL_LENGTH = 300;

function detailFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "string") return null;
  const trimmed = error.trim();
  if (trimmed === "" || trimmed.length > MAX_DETAIL_LENGTH) return null;
  return trimmed;
}

export type UploadResponseSummary = {
  status: number;
  /** The parsed JSON body, or null when there wasn't one. */
  body: unknown;
  /** The `Retry-After` response header, verbatim. */
  retryAfter: string | null;
};

/**
 * One response, one failure.
 *
 * Deliberately exhaustive over the statuses POST /api/media can return rather
 * than a `status >= 400` catch-all with a couple of special cases. The
 * statuses are not interchangeable: 415 means stop, 503 means wait, 422 means
 * re-export the image, 401 means sign in. Someone adding a new refusal to the
 * route should find themselves in this switch.
 */
export function failureForResponse(
  response: UploadResponseSummary,
  now: number = Date.now(),
): UploadFailure | null {
  const { status } = response;
  // The route answers 201 on success. Anything else in the 2xx range is not
  // a success this client knows how to read, and must not be shown as one.
  if (status === 201) return null;

  const detail = detailFrom(response.body);
  const base = {
    retryable: false,
    retryAfterSeconds: null,
    retryNotBefore: null,
    needsSignIn: false,
    detail,
  } as const;

  switch (status) {
    case 400:
      return {
        ...base,
        code: "bad_request",
        message:
          "The server could not read the upload it was sent. Reload the page and try again.",
        // Reloading is the advice, so re-sending the identical request is not.
        retryable: false,
      };
    case 401:
      return {
        ...base,
        code: "unauthenticated",
        /*
          THE SECOND SENTENCE IS A PROMISE THE MARKUP HAS TO KEEP.

          It used to read "Sign in and the file is still here to retry",
          alongside a same-tab link. That was false, and expensively so: the
          whole queue is useReducer state plus two refs, nothing is persisted,
          and a File handle cannot survive a navigation even if the rest were
          — so following that link destroyed every queued upload and landed
          the user back on a freshly mounted, empty page. The sentence only
          held for someone who thought to middle-click it.

          The fix is the link, not the words: it opens in a new tab (see
          upload-queue-list.tsx), the session cookie it sets is shared with
          this one, and "Try again" then re-sends the File this tab is still
          holding. The copy says which, because a link that steals a tab
          without warning is its own small betrayal.
        */
        message:
          "You are not signed in any more, so nothing was uploaded. Sign in — the link opens a new tab, so nothing here is lost — then try again.",
        needsSignIn: true,
        retryable: true,
      };
    case 408:
      return {
        ...base,
        code: "stalled",
        message:
          "The upload stopped part-way and the server gave up waiting. Check your connection and try again.",
        retryable: true,
      };
    case 413:
      return {
        ...base,
        code: "too_large",
        message: "The server refused this file for being too large.",
        retryable: false,
      };
    case 415:
      return {
        ...base,
        code: "unsupported_type",
        message:
          "The server rejected this file's type — either it is not one of the accepted formats, or its contents are not really what the extension says.",
        retryable: false,
      };
    case 422:
      return {
        ...base,
        code: "unprocessable",
        message:
          "This image could not be processed into a watermarked preview, so it was not kept. Re-exporting it from your editor usually fixes it.",
        retryable: false,
      };
    case 503: {
      /*
        A header that resolves to ZERO is not a plan, and `??` does not treat
        it as one: 0 is not nullish, so it short-circuited the body fallback
        and produced the sentence "try again in 0 seconds".

        Two inputs reach it. `Retry-After: 0` is literally "now". A date
        already in the past — a proxy rewrote the delta into an absolute time,
        and the response then sat in a queue or the clocks disagree — clamps
        to the same 0. In both cases the route's own `retryAfterSeconds` in
        the body is the better number, and it is discarded by a `??` chain.

        So the header wins only when it says something POSITIVE. Since
        retryAfterFromBody already refuses anything that is not a positive
        finite number, `seconds` here is either null or a real wait, and the
        "in 0 seconds" sentence is now unspellable.
      */
      const fromHeader = parseRetryAfter(response.retryAfter, now);
      const seconds =
        fromHeader !== null && fromHeader > 0
          ? fromHeader
          : retryAfterFromBody(response.body);
      return {
        ...base,
        code: "busy",
        message:
          seconds === null
            ? "The server is handling too many uploads right now. Nothing is wrong with this file — try again shortly."
            : `The server is handling too many uploads right now. Nothing is wrong with this file — try again in ${seconds} ${
                seconds === 1 ? "second" : "seconds"
              }.`,
        retryable: true,
        retryAfterSeconds: seconds,
        /*
          The moment the retry becomes available, so the control can be held
          shut for the window the header describes. Printing the number while
          enabling the button immediately told the user about the shed window
          and then walked them straight back into it — the header exists to
          spread load out, and nothing was spreading anything.
        */
        retryNotBefore: seconds === null ? null : now + seconds * 1000,
      };
    }
    default:
      if (status >= 500) {
        return {
          ...base,
          code: "server_error",
          message:
            "Something went wrong on the server and the upload was not kept. Trying again is worth one attempt.",
          retryable: true,
        };
      }
      return {
        ...base,
        code: "unexpected_status",
        message: `The server answered with an unexpected ${status}, so it is not clear whether the file was kept. Reload the page before retrying.`,
        retryable: false,
      };
  }
}

/**
 * Seconds still to wait before a retry may be offered; 0 when it may be now.
 *
 * Computed against a `now` passed in rather than read from the clock, so both
 * the component and its tests are looking at the same moment.
 */
export function secondsUntilRetry(failure: UploadFailure, now: number): number {
  if (failure.retryNotBefore === null) return 0;
  // Math.max, so a window that has passed reads 0 rather than a negative
  // count that would render as "try again in -3s".
  return Math.max(0, Math.ceil((failure.retryNotBefore - now) / 1000));
}

/**
 * May a retry be offered for this failure at this moment?
 *
 * Both halves matter: `retryable` is about whether re-sending could ever
 * work, and the window is about whether now is the time. The control and the
 * handler both ask this, so a disabled button and a refused click cannot
 * disagree.
 */
export function mayRetry(failure: UploadFailure, now: number): boolean {
  return failure.retryable && secondsUntilRetry(failure, now) === 0;
}

/** The request never completed — offline, DNS, a dropped socket, a timeout. */
export function networkFailure(): UploadFailure {
  return {
    code: "network_error",
    message:
      "The upload could not reach the server. Check your connection and try again.",
    retryable: true,
    retryAfterSeconds: null,
    retryNotBefore: null,
    needsSignIn: false,
    detail: null,
  };
}

/**
 * The connection went quiet and stayed quiet, and the client gave up on it.
 *
 * Distinct from `network_error`, which is a request that failed loudly and
 * at once. This one looked healthy and then stopped — the half-open socket a
 * dropped wifi connection or a slept laptop leaves behind — and until the
 * transport grew a watchdog it did not fail at all: it hung, and took the
 * rest of the sequential queue with it.
 */
export function stalledConnectionFailure(afterMs: number): UploadFailure {
  return {
    code: "connection_stalled",
    message: `The upload stopped sending and nothing happened for ${Math.round(
      afterMs / 1000,
    )} seconds, so it was given up on. Check your connection and try again.`,
    retryable: true,
    retryAfterSeconds: null,
    retryNotBefore: null,
    needsSignIn: false,
    detail: null,
  };
}

/** What interrupted an upload whose body had already been delivered. */
export type UnknownOutcomeCause = "cancelled" | "stalled" | "network";

const UNKNOWN_OUTCOME_CAUSES: Record<UnknownOutcomeCause, string> = {
  cancelled: "You cancelled this upload after the file had finished sending.",
  stalled:
    "The connection went quiet after the file had finished sending, and the answer never arrived.",
  network:
    "The connection failed after the file had finished sending, so the answer never arrived.",
};

/**
 * THE HONEST ANSWER WHEN THE CLIENT CANNOT KNOW.
 *
 * `POST /api/media` does not read `request.signal` (ugcportal-ax3). Once the
 * last byte is delivered, the handler runs to completion whatever the browser
 * does: it watermarks, writes both objects to storage and inserts the Media
 * row. So for anything that goes wrong from that moment on, the client has
 * two facts — the file was sent, and no response came back — and the one
 * thing it does NOT have is whether the upload was stored.
 *
 * Both of the confident answers are wrong here, in opposite directions:
 *
 *   "You cancelled this upload, so nothing was kept" says the file is not
 *   there when it very likely is. That is the message this replaces.
 *
 *   "Upload failed, try again" is worse. The route has no idempotency key, so
 *   a retry inserts a SECOND Media row for the same file, and the user has no
 *   way to tell the duplicate from the original.
 *
 * Hence `retryable: false` — not because retrying could not work, but because
 * this client cannot offer it without risking a silent duplicate. The row
 * tells the user where to look instead. That is a worse experience than a
 * working retry and a better one than either lie; a real retry needs the
 * route to accept an idempotency key, which is ugcportal-ax3's business.
 */
export function unknownOutcomeFailure(
  cause: UnknownOutcomeCause,
): UploadFailure {
  return {
    code: "outcome_unknown",
    message: `${UNKNOWN_OUTCOME_CAUSES[cause]} The server does not stop working when the browser gives up, so this file may or may not have been stored. Check your library before uploading it again — retrying now could store it twice.`,
    retryable: false,
    retryAfterSeconds: null,
    retryNotBefore: null,
    needsSignIn: false,
    detail: null,
  };
}

/**
 * Stopped deliberately, and early enough to say so.
 *
 * Only for an upload whose body had NOT finished sending: the request is cut
 * off mid-stream, the route's multipart read fails, and nothing is stored. A
 * cancellation after the last byte goes to unknownOutcomeFailure above,
 * because it is not this.
 */
export function cancelledFailure(): UploadFailure {
  return {
    code: "cancelled",
    message: "You cancelled this upload, so nothing was kept.",
    retryable: true,
    retryAfterSeconds: null,
    retryNotBefore: null,
    needsSignIn: false,
    detail: null,
  };
}
