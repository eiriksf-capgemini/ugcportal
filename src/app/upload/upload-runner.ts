import {
  cancelledFailure,
  failureForResponse,
  networkFailure,
  stalledConnectionFailure,
  unknownOutcomeFailure,
  type UploadFailure,
} from "./outcomes";
import {
  makeQueueItem,
  toQueueMedia,
  type QueueAction,
  type QueueItem,
} from "./upload-queue";
import {
  UploadAbortedError,
  UploadNetworkError,
  UploadStalledError,
  uploadFile,
  type UploadTransport,
} from "./upload-transport";

/**
 * Turning one transport call into the four dispatches a row goes through.
 *
 * Separated from the component so the whole path — started, progress,
 * status-to-message, success-projection — can be driven in a test with a
 * stand-in transport, which is what K1 and K2 are verified against. The form
 * contributes only React state and event wiring on top of this.
 */
export type Dispatch = (action: QueueAction) => void;

/**
 * The ways a request can fail without ever producing a status, told apart on
 * TWO axes — what interrupted it, and whether the file had already been sent.
 *
 * The second axis is the one that decides what may be claimed at all. POST
 * /api/media does not read `request.signal` (ugcportal-2u9), so once the body
 * is delivered the handler watermarks, stores both objects and inserts the
 * Media row no matter what the browser does. Past that point the client knows
 * the file was sent and that no answer came back, and does NOT know whether it
 * was stored — so all three causes collapse onto one honest outcome rather
 * than three confident wrong ones.
 *
 * Before the body is delivered, the distinctions are real and worth drawing:
 * a stall and a user cancellation both arrive as an `abort`, because
 * xhr.abort() is the only way to stop a request, and without the transport's
 * flag a connection that died on its own would read "You cancelled this
 * upload".
 */
export function failureForTransportError(error: unknown): UploadFailure {
  if (error instanceof UploadStalledError) {
    return error.bodyDelivery === "fully-sent"
      ? unknownOutcomeFailure("stalled")
      : stalledConnectionFailure(error.afterMs);
  }
  if (error instanceof UploadAbortedError) {
    return error.bodyDelivery === "fully-sent"
      ? unknownOutcomeFailure("cancelled")
      : cancelledFailure();
  }
  if (error instanceof UploadNetworkError) {
    return error.bodyDelivery === "fully-sent"
      ? unknownOutcomeFailure("network")
      : networkFailure();
  }
  // Something threw that is not one of the transport's own errors — a bug
  // rather than a connection problem. Reported as a network failure because
  // that is the truthful shape (no response arrived) and it is retryable;
  // nothing was sent, so a retry cannot duplicate anything.
  return networkFailure();
}

export async function uploadItem(
  id: string,
  file: File,
  dispatch: Dispatch,
  transport: UploadTransport = uploadFile,
  signal?: AbortSignal,
  /**
   * The subject tags chosen for this file (ugcportal-jsc). LAST and optional,
   * so every existing caller and every existing test keeps working unchanged
   * and an untagged upload is still literally the same request.
   */
  tags: readonly string[] = [],
  /** Alt text and caption chosen for this file (ugcportal-gwr). */
  altText = "",
  caption = "",
): Promise<void> {
  dispatch({ type: "started", id });

  let response;
  try {
    response = await transport({
      file,
      tags,
      altText,
      caption,
      signal,
      onProgress: ({ loadedBytes }) =>
        dispatch({ type: "progress", id, loadedBytes }),
    });
  } catch (error) {
    dispatch({
      type: "failed",
      id,
      failure: failureForTransportError(error),
    });
    return;
  }

  const failure = failureForResponse(response);
  if (failure !== null) {
    dispatch({ type: "failed", id, failure });
    return;
  }

  dispatch({ type: "succeeded", id, media: toQueueMedia(response.body) });
}

/**
 * `signal` is per entry, not per drain: cancelling one file must not tear
 * down the queue behind it.
 */
export type QueueEntry = {
  id: string;
  file: File;
  signal?: AbortSignal;
  /**
   * The tags chosen at the moment the file was ADDED, captured per entry
   * rather than read from the form when the file's turn comes round.
   *
   * The queue is drained one file at a time and a large video can hold it for
   * minutes, during which the picker is still live. Reading the current
   * selection at send time would mean changing it mid-queue silently
   * retagged everything still waiting — including files the user had already
   * chosen tags for and moved on from. Captured per entry, the selection the
   * user could see when they dropped the files is the one those files get.
   */
  tags: readonly string[];
  /**
   * Alt text and caption chosen at the moment the file was ADDED
   * (ugcportal-gwr), captured per entry for the same reason `tags` is: a
   * retry has to resend what the original attempt sent, not whatever is
   * typed into the form now.
   */
  altText: string;
  caption: string;
};

/**
 * Files in, rows and work out — and the gap between the two lists is the
 * point.
 *
 * `items` is every file the user chose, including the ones already refused.
 * `entries` is only the ones worth sending. A file the client-side pre-check
 * rejected appears in the first and not the second, so it is shown with its
 * reason and no request is ever made for it (K2: "rejected client-side before
 * any request is sent").
 *
 * Extracted from the component so that gap can be asserted. Inside an event
 * handler it would be unreachable — vitest runs in a node environment here,
 * with no DOM to dispatch a change event into.
 */
export function enqueueFiles(
  files: File[],
  nextId: () => string,
  /**
   * The tags to attach to this batch (ugcportal-jsc). Copied into each entry
   * rather than shared, so a later change to the picker cannot reach back
   * into work already queued — see `QueueEntry.tags`.
   */
  tags: readonly string[] = [],
  /**
   * The alt text and caption for this batch (ugcportal-gwr), copied into each
   * entry for the same reason `tags` is. See the module docstring in
   * upload-form.tsx for why these are batch-level rather than per-file today.
   */
  altText = "",
  caption = "",
): { items: QueueItem[]; entries: QueueEntry[] } {
  const pairs = files.map((file) => ({
    item: makeQueueItem(nextId(), file),
    file,
  }));

  return {
    items: pairs.map((pair) => pair.item),
    entries: pairs
      .filter((pair) => pair.item.status === "pending")
      .map((pair) => ({
        id: pair.item.id,
        file: pair.file,
        tags: [...tags],
        altText,
        caption,
      })),
  };
}

/**
 * Works the queue to empty, ONE FILE AT A TIME.
 *
 * Sequential on purpose, and it is not just politeness. POST /api/media
 * reserves process-wide memory per in-flight upload and answers 503 once the
 * budget is spent (ugcportal-e86, ugcportal-05b); six parallel requests from a
 * single tab is precisely the burst that budget exists to refuse, so a
 * parallel uploader would spend its afternoon retrying itself. Sequential also
 * means the one visible progress bar is the one actually moving, instead of
 * several bars sharing a connection and each lying about its own speed.
 *
 * `take` is a callback rather than an array so the caller can keep the
 * authoritative queue outside React state: reading the next item from a
 * rendered snapshot races the re-render that the previous file's dispatches
 * caused, and picks the same file twice.
 */
export async function drainQueue(
  take: () => QueueEntry | undefined,
  dispatch: Dispatch,
  transport: UploadTransport = uploadFile,
): Promise<void> {
  for (;;) {
    const entry = take();
    if (entry === undefined) return;
    await uploadItem(
      entry.id,
      entry.file,
      dispatch,
      transport,
      entry.signal,
      entry.tags,
      entry.altText,
      entry.caption,
    );
  }
}
