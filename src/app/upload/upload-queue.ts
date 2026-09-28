import type { MediaKind } from "@/generated/prisma/enums";

import { precheckFile, type UploadFailure } from "./outcomes";

/**
 * The upload queue, as data.
 *
 * All of it is pure: no React, no DOM, no network. The form is a thin shell
 * over this, so the parts worth testing — which files never get sent, what a
 * given failure says, what the success state holds — are testable in the
 * repo's node-environment vitest without a browser.
 */

/**
 * What the success state is allowed to remember about an upload.
 *
 * THE FIELD LIST IS EXHAUSTIVE AND HAND-WRITTEN, AND THAT IS THE POINT
 * (ugcportal-n3c K3). `toQueueMedia` below never spreads the response, so a
 * column that appears in a future API payload does not appear here, in state,
 * or in the markup until someone adds it deliberately.
 *
 * `key` — the ungated original (ugcportal-5d6) — is the field that must never
 * arrive. MEDIA_OWNER_SELECT does not select it today, so this is a second
 * lock on a door already shut; the reason for the second lock is that the
 * first one lives in a different file, owned by a different bead, and "the API
 * doesn't send it" is not a property this page can enforce.
 *
 * `previewKey` is excluded for the same reason at one remove: it is a storage
 * path of the form `previews/{userId}/{uuid}.webp`, so rendering it would put
 * the uploader's account id in the markup — the exact disclosure `previewId`
 * exists to prevent.
 */
export type QueueMedia = {
  id: string;
  kind: MediaKind;
  /**
   * The opaque handle for the watermarked preview, or null when there isn't
   * one — today, every VIDEO (ugcportal-pmb owns poster frames). Null means
   * "show no image", never "fall back to the original".
   */
  previewId: string | null;
  originalName: string;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Projects the 201 body down to the four fields the success state renders.
 *
 * Field by field, never `...payload`. A spread here would be the whole K3
 * invariant undone in one character, and it would look tidier than this does.
 */
export function toQueueMedia(payload: unknown): QueueMedia | null {
  if (typeof payload !== "object" || payload === null) return null;
  const row = payload as Record<string, unknown>;

  const id = stringOrNull(row.id);
  if (id === null) return null;

  const kind = row.kind === "IMAGE" || row.kind === "VIDEO" ? row.kind : null;
  if (kind === null) return null;

  return {
    id,
    kind,
    previewId: stringOrNull(row.previewId),
    originalName: stringOrNull(row.originalName) ?? "Untitled",
  };
}

export type QueueItemStatus = "pending" | "uploading" | "succeeded" | "failed";

export type QueueItem = {
  /** Local to this page — not the Media row's id, which only exists after. */
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  status: QueueItemStatus;
  /** Bytes acknowledged by the transport so far. */
  loadedBytes: number;
  failure: UploadFailure | null;
  media: QueueMedia | null;
};

/**
 * One file, already judged.
 *
 * The client-side pre-check runs HERE, at enqueue time, rather than in the
 * uploader — so a file the server would refuse on sight is `failed` before
 * anything is sent, and `pendingItems` below simply never offers it. K2 asks
 * for exactly that: "rejected client-side before any request is sent".
 */
export function makeQueueItem(
  id: string,
  file: { name: string; type: string; size: number },
): QueueItem {
  const failure = precheckFile(file);
  return {
    id,
    name: file.name,
    sizeBytes: file.size,
    mimeType: file.type,
    status: failure === null ? "pending" : "failed",
    loadedBytes: 0,
    failure,
    media: null,
  };
}

export type QueueAction =
  | { type: "queued"; items: QueueItem[] }
  | { type: "started"; id: string }
  | { type: "progress"; id: string; loadedBytes: number }
  | { type: "succeeded"; id: string; media: QueueMedia | null }
  | { type: "failed"; id: string; failure: UploadFailure }
  | { type: "retried"; id: string }
  | { type: "dismissed"; id: string };

function patch(
  items: QueueItem[],
  id: string,
  change: (item: QueueItem) => QueueItem,
): QueueItem[] {
  return items.map((item) => (item.id === id ? change(item) : item));
}

/**
 * Has this row reached an outcome it should keep?
 *
 * THE POINT IS THAT A SETTLED ROW IS FINISHED WITH. Every dispatch in this
 * reducer is fired from an async callback, and React does not commit state
 * between the `succeeded` for one file and the drain loop advancing to the
 * next — so a control rendered from a *previous* commit is still on screen,
 * still clickable, and still naming a row that has since finished.
 *
 * That is not hypothetical, and it was live here: file A's 201 resolves,
 * `succeeded` dispatches, `take()` advances the in-flight pointer to B, and
 * A's stale Cancel button is still painted. Clicking it missed the in-flight
 * check, fell through to `failed`, and relabelled a file that WAS STORED ON
 * THE SERVER as "You cancelled this upload, so nothing was kept" — nulling
 * the preview with it. The row lied about the one thing it exists to report.
 *
 * `started`, `progress` and `retried` each had a guard of their own; the two
 * that could destroy an outcome did not.
 */
function isSettled(item: QueueItem): boolean {
  return item.status === "succeeded" || item.status === "failed";
}

export function uploadQueueReducer(
  items: QueueItem[],
  action: QueueAction,
): QueueItem[] {
  switch (action.type) {
    case "queued":
      return [...items, ...action.items];
    case "started":
      return patch(items, action.id, (item) =>
        // Only a row that is waiting may start. A failed row reaches this by
        // way of "retried", which decides whether the failure was worth
        // retrying at all; without this guard a start dispatched for a
        // non-retryable row would quietly reopen it.
        item.status === "pending"
          ? { ...item, status: "uploading", loadedBytes: 0, failure: null }
          : item,
      );
    case "progress":
      return patch(items, action.id, (item) =>
        // A progress event after the request settled would drag a finished
        // row back to a partial bar.
        item.status === "uploading"
          ? { ...item, loadedBytes: action.loadedBytes }
          : item,
      );
    case "succeeded":
      return patch(items, action.id, (item) =>
        // A row that has already settled keeps its outcome. See isSettled.
        isSettled(item)
          ? item
          : {
              ...item,
              status: "succeeded",
              loadedBytes: item.sizeBytes,
              failure: null,
              media: action.media,
            },
      );
    case "failed":
      return patch(items, action.id, (item) =>
        // The one that was live: a stale Cancel relabelling a stored upload.
        isSettled(item)
          ? item
          : {
              ...item,
              status: "failed",
              failure: action.failure,
              media: null,
            },
      );
    case "retried":
      return patch(items, action.id, (item) =>
        // Only a failure may be retried, and only one the failure itself said
        // was worth retrying. Without this, "Try again" on a 415 would put the
        // row back in the queue to be refused identically.
        item.status === "failed" && item.failure?.retryable === true
          ? { ...item, status: "pending", loadedBytes: 0, failure: null }
          : item,
      );
    case "dismissed":
      return items.filter((item) => item.id !== action.id);
  }
}

/**
 * The row whose File this action makes unreachable, or null.
 *
 * The queue keeps the File objects in a ref, because they are not
 * serialisable into reducer state, and exactly one thing reads that map:
 * `retry`. Retry refuses a row that succeeded, and refuses a failure whose own
 * `retryable` flag says re-sending is pointless — so for those two outcomes
 * the entry is not merely unused, it is unreachable, while still pinning the
 * file's backing blob (up to 200 MB for a video) for the lifetime of the tab.
 *
 * Returns the id rather than a boolean for two reasons: it is what the caller
 * actually needs, and `QueueAction` is a union in which `queued` carries no
 * `id` at all — so a boolean would leave the component reaching for a
 * property the type does not have.
 *
 * A function rather than a line inside the component, so the rule can be
 * stated once and checked. The component cannot be driven in this repo's
 * node-environment tests; this can.
 */
export function releasedFileId(action: QueueAction): string | null {
  if (action.type === "succeeded") return action.id;
  // The flag, not a second opinion about which failures are final: it is the
  // same one the Try again control and the reducer's "retried" guard read, so
  // the three cannot disagree about which failures keep their file.
  if (action.type === "failed") return action.failure.retryable ? null : action.id;
  return null;
}

/**
 * Which rows this action settles, and which it reopens.
 *
 * Exists so the component can keep a set of finished ids that is updated AT
 * DISPATCH TIME rather than at render time.
 *
 * The distinction is the whole point. An event handler closes over the
 * `items` array from the render that produced its button, so a guard written
 * as `items.find(...)` inside a handler re-reads the SAME stale snapshot the
 * stale button came from — it cannot possibly disagree with it. In the exact
 * race it was meant to catch (a file's `succeeded` dispatched, React not yet
 * committed, that file's old Cancel button clicked) such a guard passes,
 * every time. It reads like a second lock and is a copy of the first one's
 * key.
 *
 * A set maintained from the action stream has no such problem: `succeeded`
 * has already gone through by the time the click is handled, whatever React
 * has or has not committed.
 */
export type SettledChange = { settled: string[]; unsettled: string[] };

export function settledChange(action: QueueAction): SettledChange {
  switch (action.type) {
    case "succeeded":
    case "failed":
      return { settled: [action.id], unsettled: [] };
    // Both put a row back in play: retried re-queues it, dismissed removes it
    // from the list entirely and frees the id's bookkeeping.
    case "retried":
    case "dismissed":
      return { settled: [], unsettled: [action.id] };
    case "queued":
      // A file the pre-check refused arrives ALREADY failed, without ever
      // being the subject of a `failed` action — so it has to be recorded
      // here or it would look unsettled for the rest of the session.
      return {
        settled: action.items
          .filter((item) => item.status === "failed")
          .map((item) => item.id),
        unsettled: [],
      };
    default:
      return { settled: [], unsettled: [] };
  }
}

/** Files still waiting to be sent, oldest first. */
export function pendingItems(items: QueueItem[]): QueueItem[] {
  return items.filter((item) => item.status === "pending");
}

/**
 * How far along one row is, 0-100, or null when that cannot be known.
 *
 * Null rather than 0 for an unknown total: a bar stuck at 0% and a bar that
 * cannot be drawn are different states, and the second one should render as
 * indeterminate rather than as "no progress".
 */
export function percentComplete(item: QueueItem): number | null {
  if (item.status === "succeeded") return 100;
  if (item.status === "pending") return 0;
  // `> 0` rather than `!== 0`, so a negative or NaN size is indeterminate
  // rather than producing a negative or NaN width.
  if (!(item.sizeBytes > 0)) return null;
  if (!Number.isFinite(item.loadedBytes)) return null;
  const percent = Math.round((item.loadedBytes / item.sizeBytes) * 100);
  return Math.min(Math.max(percent, 0), 100);
}

export type QueueSummary = {
  total: number;
  pending: number;
  uploading: number;
  succeeded: number;
  failed: number;
  /** One sentence for the page's live region. */
  message: string;
};

/**
 * The overall state, for the `aria-live` region.
 *
 * Counted from the items rather than tracked alongside them, so it cannot
 * disagree with what is on screen.
 */
export function queueSummary(items: QueueItem[]): QueueSummary {
  const counts = {
    pending: 0,
    uploading: 0,
    succeeded: 0,
    failed: 0,
  };
  for (const item of items) counts[item.status] += 1;

  /*
    Waiting is counted separately from uploading, because the queue is
    strictly sequential: at most ONE file is ever in flight (see drainQueue).
    Folding the two together announced "5 uploading" to a screen-reader user
    while four of the five rows on screen read "Waiting" — a live region
    contradicting the thing it is describing is worse than no live region,
    because it is believed.
  */
  const parts: string[] = [];
  if (counts.uploading > 0) parts.push(`${counts.uploading} uploading`);
  if (counts.pending > 0) parts.push(`${counts.pending} waiting`);
  if (counts.succeeded > 0) parts.push(`${counts.succeeded} uploaded`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);

  return {
    total: items.length,
    ...counts,
    message:
      items.length === 0 ? "Nothing queued yet." : `${parts.join(", ")}.`,
  };
}
