import { MEDIA_UPLOAD_PATH } from "@/lib/routes";

import type { UploadResponseSummary } from "./outcomes";

/**
 * One file, one request, with progress — over XMLHttpRequest.
 *
 * WHY XHR AND NOT fetch(), since the rest of this codebase has no XHR in it:
 *
 * `fetch()` reports no upload progress at all. Its `Response.body` streams the
 * DOWNLOAD; there is no hook on the request side, so a 180 MB video would show
 * nothing between "started" and "done" — which is the one thing this page has
 * to show, on a connection slow enough for it to matter.
 *
 * The modern alternative is a fetch request whose body is a ReadableStream
 * (with `duplex: "half"`), counting bytes as the stream is pulled. It was
 * rejected rather than overlooked: it requires HTTP/2 in Chrome and is
 * unimplemented in Safari, so it would report nothing on a large share of
 * real traffic. XHR's `upload.onprogress` is specified and shipped
 * everywhere, and reports bytes the browser has transmitted.
 *
 * Neither mechanism can report bytes the SERVER has accepted — no browser API
 * exposes that — so the bar means "sent", not "stored". The success state,
 * which waits for the 201, is the only thing here that means stored.
 *
 * The cost is that this is callback-shaped and has to be wrapped in a Promise
 * by hand, which is what the rest of this file is.
 */

/** Bytes sent so far. `totalBytes` is null when the browser can't say. */
export type UploadProgress = { loadedBytes: number; totalBytes: number | null };

/** The request never completed: offline, DNS failure, a dropped socket. */
export class UploadNetworkError extends Error {
  constructor() {
    super("The upload request did not complete");
    this.name = "UploadNetworkError";
  }
}

/**
 * Nothing moved for long enough that the connection is presumed dead.
 *
 * Its own error, not a network error, because the cause and the advice differ:
 * a refused connection failed immediately and loudly, whereas this one looked
 * fine and then silently stopped.
 */
export class UploadStalledError extends Error {
  constructor(readonly afterMs: number) {
    super(`The upload sent nothing for ${afterMs}ms`);
    this.name = "UploadStalledError";
  }
}

/**
 * How long to wait for SOMETHING to happen before giving up on a request.
 *
 * WHY A WATCHDOG AND NOT `xhr.timeout`. XMLHttpRequest's own `timeout` is a
 * budget for the WHOLE request, start to finish. Any value large enough not
 * to kill a legitimate 200 MB video on a slow connection is far too large to
 * notice a dead one, so it cannot do this job — which is presumably why it
 * was left at its default of 0, meaning no timeout at all, with a "timeout"
 * listener below that could never fire.
 *
 * What that cost: on a half-open connection — wifi dropped, laptop slept, a
 * NAT entry expired — the socket is gone but neither `load` nor `error` ever
 * fires. The promise never settled. And because drainQueue is sequential by
 * design, one such request parked THE ENTIRE QUEUE: every remaining file sat
 * at "Waiting" forever with no error anywhere on the page. The server's own
 * stall timeout cannot rescue this, because the bytes never arrive for it to
 * time out on.
 *
 * So the bound is on INACTIVITY instead, which is what actually distinguishes
 * a slow upload from a dead one, and it is armed in two phases:
 */

/**
 * While the body is going out, `upload.progress` fires continuously — so any
 * real connection resets this long before it expires, however slow it is.
 */
export const UPLOAD_STALL_TIMEOUT_MS = 30_000;

/**
 * Once the last byte is sent, progress events stop and the server goes to
 * work: the watermark gate may queue an image behind others before the
 * S3 puts and the database write. That is legitimately quiet time, so it gets
 * its own, larger budget rather than tripping the sending timeout.
 */
export const RESPONSE_TIMEOUT_MS = 120_000;

/** The caller aborted it — a navigation, or a cancel control. */
export class UploadAbortedError extends Error {
  constructor() {
    super("The upload was aborted");
    this.name = "UploadAbortedError";
  }
}

export type UploadRequest = {
  file: File;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
};

/**
 * Injectable so the flow can be tested without a browser: vitest runs in a
 * node environment here (see vitest.config.ts) and there is no
 * XMLHttpRequest, so the tests pass a stand-in that replays the events a real
 * one would fire.
 */
export type XhrFactory = () => XMLHttpRequest;

export type UploadTransport = (
  request: UploadRequest,
) => Promise<UploadResponseSummary>;

/**
 * The multipart field name, and it must match POST /api/media's
 * UPLOAD_FIELD_NAME. The route peeks at the first few kilobytes of the body to
 * find this part and reads its declared Content-Type to decide how much memory
 * to reserve (ugcportal-05b); a part under any other name is not found, and the
 * upload is held to the much smaller undeclared-kind floor instead of its own
 * kind's cap.
 */
const UPLOAD_FIELD_NAME = "file";

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A body that isn't JSON is not a failure to report on its own — the
    // status is what carries the meaning, and `failureForResponse` copes with
    // a null body on every branch.
    return null;
  }
}

export function uploadFile(
  { file, onProgress, signal }: UploadRequest,
  createRequest: XhrFactory = () => new XMLHttpRequest(),
): Promise<UploadResponseSummary> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadAbortedError());
      return;
    }

    const form = new FormData();
    /*
      THE FILE PART GOES FIRST, AND NOTHING MAY BE APPENDED BEFORE IT.

      POST /api/media reserves memory for the body before reading it, and it
      sizes that reservation from the declared Content-Type of the `file`
      part, which it finds by peeking at the first PART_HEADER_PEEK_BYTES of
      the stream (ugcportal-05b). A caption or a CSRF token appended ahead of
      the file can push the file part's headers past that window; the peek
      then finds no declaration, and the request is capped at the floor for an
      unknown kind — so a perfectly ordinary video 413s with a message about
      multipart field ordering.

      There are no other fields today. If one is ever needed, append it AFTER
      this line.
    */
    form.append(UPLOAD_FIELD_NAME, file, file.name);

    const xhr = createRequest();
    let settled = false;

    /*
      The watchdog. `stalledAfterMs` doubles as the flag that tells the `abort`
      handler below which kind of abort this was: the only way to stop an XHR
      is xhr.abort(), so a timed-out request and a user-cancelled one arrive
      through the same event and would otherwise be reported identically —
      "You cancelled this upload" for a connection that died on its own.
    */
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let stalledAfterMs: number | null = null;

    const disarm = () => {
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };

    const arm = (afterMs: number) => {
      disarm();
      watchdog = setTimeout(() => {
        if (settled) return;
        stalledAfterMs = afterMs;
        // Goes through abort() so the request is actually torn down rather
        // than left running behind a rejected promise.
        xhr.abort();
      }, afterMs);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      disarm();
      xhr.abort();
      reject(new UploadAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      disarm();
      signal?.removeEventListener("abort", onAbort);
      settle();
    };

    xhr.upload.addEventListener("progress", (event: ProgressEvent) => {
      // Every byte acknowledged is proof the connection is alive, so a slow
      // upload is never mistaken for a dead one however long it takes.
      arm(UPLOAD_STALL_TIMEOUT_MS);
      onProgress?.({
        loadedBytes: event.loaded,
        // `lengthComputable` is the browser saying whether `total` means
        // anything. Reading `total` regardless is how a progress bar ends up
        // dividing by zero.
        totalBytes: event.lengthComputable ? event.total : null,
      });
    });

    xhr.addEventListener("load", () => {
      finish(() => {
        if (xhr.status === 0) {
          // A completed load with no status is not a response; the browser
          // reports some cross-origin and network failures this way.
          reject(new UploadNetworkError());
          return;
        }
        resolve({
          status: xhr.status,
          body: parseJson(xhr.responseText),
          retryAfter: xhr.getResponseHeader("Retry-After"),
        });
      });
    });

    // The body is fully sent; from here the server is thinking, and quiet is
    // expected. Hand over to the larger budget.
    xhr.upload.addEventListener("load", () => arm(RESPONSE_TIMEOUT_MS));

    xhr.addEventListener("error", () => {
      finish(() => reject(new UploadNetworkError()));
    });
    xhr.addEventListener("timeout", () => {
      // Only reachable if someone sets xhr.timeout; the watchdog above is what
      // actually bounds this request. Kept so that setting it later does not
      // produce an unhandled request.
      finish(() => reject(new UploadNetworkError()));
    });
    xhr.addEventListener("abort", () => {
      finish(() =>
        reject(
          stalledAfterMs === null
            ? new UploadAbortedError()
            : new UploadStalledError(stalledAfterMs),
        ),
      );
    });

    xhr.open("POST", MEDIA_UPLOAD_PATH);
    // Deliberately no Content-Type header: setting it by hand loses the
    // multipart boundary the FormData body generated, and the route's boundary
    // parse (multipartBoundary) then has nothing to split on.
    xhr.responseType = "text";
    // Armed before send, not on the first progress event: a connection that
    // dies during the handshake never produces one.
    arm(UPLOAD_STALL_TIMEOUT_MS);
    xhr.send(form);
  });
}
