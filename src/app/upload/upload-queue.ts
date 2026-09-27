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
      return patch(items, action.id, (item) => ({
        ...item,
        status: "succeeded",
        loadedBytes: item.sizeBytes,
        failure: null,
        media: action.media,
      }));
    case "failed":
      return patch(items, action.id, (item) => ({
        ...item,
        status: "failed",
        failure: action.failure,
        media: null,
      }));
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

  const active = counts.pending + counts.uploading;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} uploading`);
  if (counts.succeeded > 0) parts.push(`${counts.succeeded} uploaded`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);

  return {
    total: items.length,
    ...counts,
    message:
      items.length === 0 ? "Nothing queued yet." : `${parts.join(", ")}.`,
  };
}
