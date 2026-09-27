import {
  cancelledFailure,
  failureForResponse,
  networkFailure,
} from "./outcomes";
import {
  makeQueueItem,
  toQueueMedia,
  type QueueAction,
  type QueueItem,
} from "./upload-queue";
import {
  UploadAbortedError,
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

export async function uploadItem(
  id: string,
  file: File,
  dispatch: Dispatch,
  transport: UploadTransport = uploadFile,
  signal?: AbortSignal,
): Promise<void> {
  dispatch({ type: "started", id });

  let response;
  try {
    response = await transport({
      file,
      signal,
      onProgress: ({ loadedBytes }) =>
        dispatch({ type: "progress", id, loadedBytes }),
    });
  } catch (error) {
    dispatch({
      type: "failed",
      id,
      failure:
        error instanceof UploadAbortedError
          ? cancelledFailure()
          : networkFailure(),
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
export type QueueEntry = { id: string; file: File; signal?: AbortSignal };

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
): { items: QueueItem[]; entries: QueueEntry[] } {
  const pairs = files.map((file) => ({
    item: makeQueueItem(nextId(), file),
    file,
  }));

  return {
    items: pairs.map((pair) => pair.item),
    entries: pairs
      .filter((pair) => pair.item.status === "pending")
      .map((pair) => ({ id: pair.item.id, file: pair.file })),
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
    await uploadItem(entry.id, entry.file, dispatch, transport, entry.signal);
  }
}
