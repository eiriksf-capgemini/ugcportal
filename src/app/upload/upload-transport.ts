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

    const onAbort = () => {
      if (settled) return;
      settled = true;
      xhr.abort();
      reject(new UploadAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      settle();
    };

    xhr.upload.addEventListener("progress", (event: ProgressEvent) => {
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

    xhr.addEventListener("error", () => {
      finish(() => reject(new UploadNetworkError()));
    });
    xhr.addEventListener("timeout", () => {
      finish(() => reject(new UploadNetworkError()));
    });
    xhr.addEventListener("abort", () => {
      finish(() => reject(new UploadAbortedError()));
    });

    xhr.open("POST", MEDIA_UPLOAD_PATH);
    // Deliberately no Content-Type header: setting it by hand loses the
    // multipart boundary the FormData body generated, and the route's boundary
    // parse (multipartBoundary) then has nothing to split on.
    xhr.responseType = "text";
    xhr.send(form);
  });
}
