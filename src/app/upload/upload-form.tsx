"use client";

import { useCallback, useId, useReducer, useRef, useState } from "react";

import { ACCEPTED_MIME_TYPES } from "@/lib/media-rules";

import { acceptedTypesSummary, cancelledFailure } from "./outcomes";
import { UploadQueueList } from "./upload-queue-list";
import {
  queueSummary,
  releasedFileId,
  uploadQueueReducer,
  type QueueAction,
  type QueueItem,
} from "./upload-queue";
import { drainQueue, enqueueFiles, type QueueEntry } from "./upload-runner";

/**
 * The upload surface (ugcportal-n3c) — and the app's first client component.
 *
 * It deliberately holds almost no logic. Which files are refused before
 * sending, what each HTTP status means, how a response becomes a success row,
 * and how the queue is worked all live in the four sibling modules, because
 * the repo's vitest runs in a node environment with no DOM: anything that can
 * only be reached through a React event handler is, in practice, untested
 * here. What is left in this file is state wiring and drag-and-drop plumbing.
 */

/**
 * Local, per-page ids for queue rows. Not `crypto.randomUUID()`, which is
 * unavailable on an insecure origin (a LAN dev host over plain http is the
 * ordinary case), and a counter is sufficient: these ids never leave the tab
 * and never reach the server.
 */
let queueSequence = 0;
function nextQueueId(): string {
  queueSequence += 1;
  return `queued-${queueSequence}`;
}

const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(",");

export function UploadForm() {
  const inputId = useId();
  const [items, dispatch] = useReducer(uploadQueueReducer, [] as QueueItem[]);
  const [isDraggingOver, setDraggingOver] = useState(false);

  /**
   * The authoritative work queue, OUTSIDE React state on purpose.
   *
   * Picking the next file out of the rendered `items` races the re-render the
   * previous file's dispatches caused: `started` has not landed yet, the row
   * still reads "pending", and the same file is uploaded twice. A ref is read
   * at the instant it is asked, which is what the loop needs.
   */
  const queueRef = useRef<QueueEntry[]>([]);
  /** The File objects, which are not serialisable into reducer state. */
  const filesRef = useRef(new Map<string, File>());
  const drainingRef = useRef(false);
  const inFlightRef = useRef<{ id: string; controller: AbortController } | null>(
    null,
  );

  /**
   * Dispatch, plus releasing the File once nothing can ask for it again.
   *
   * `filesRef` used to be pruned only by `dismiss`, so every succeeded row and
   * every non-retryable failure kept its File — and therefore its backing
   * blob, which for video is the whole 200 MB — alive for the lifetime of the
   * tab, with no remaining reader. `retry` is the only thing that reads the
   * map, and it refuses both of those states, so the entries were unreachable
   * as well as unbounded.
   */
  const dispatchAndRelease = useCallback((action: QueueAction) => {
    const released = releasedFileId(action);
    if (released !== null) filesRef.current.delete(released);
    dispatch(action);
  }, []);

  const drain = useCallback(() => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    void drainQueue(() => {
      const entry = queueRef.current.shift();
      if (entry === undefined) {
        inFlightRef.current = null;
        return undefined;
      }
      const controller = new AbortController();
      inFlightRef.current = { id: entry.id, controller };
      return { ...entry, signal: controller.signal };
    }, dispatchAndRelease).finally(() => {
      drainingRef.current = false;
      inFlightRef.current = null;
    });
  }, [dispatchAndRelease]);

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      const files = fileList === null ? [] : Array.from(fileList);
      if (files.length === 0) return;

      // `entries` omits anything the pre-check already refused, so no request
      // is ever made for those files (K2). See enqueueFiles.
      const { items: queued, entries } = enqueueFiles(files, nextQueueId);
      dispatch({ type: "queued", items: queued });

      for (const entry of entries) {
        filesRef.current.set(entry.id, entry.file);
        queueRef.current.push(entry);
      }

      drain();
    },
    [drain],
  );

  const removeFromQueue = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((entry) => entry.id !== id);
  }, []);

  const cancel = useCallback(
    (id: string) => {
      /*
        The same condition the reducer now applies, checked here so the two
        agree rather than one catching the other. Without it, a Cancel button
        painted in a previous commit — the drain loop settles one file and
        moves to the next before React commits either — reaches this function
        naming a row that has since finished, misses the in-flight check
        below, and falls through to `failed` on an upload the server has
        already stored.
      */
      const item = items.find((each) => each.id === id);
      if (item?.status !== "uploading" && item?.status !== "pending") return;

      if (inFlightRef.current?.id === id) {
        // The transport rejects with UploadAbortedError, which uploadItem
        // turns into the cancelled failure — one path, not two.
        inFlightRef.current.controller.abort();
        return;
      }
      // Still waiting its turn: take it out of the queue before it is ever
      // sent. This branch is what the Cancel control on a pending row
      // reaches.
      removeFromQueue(id);
      dispatch({ type: "failed", id, failure: cancelledFailure() });
    },
    [items, removeFromQueue],
  );

  const retry = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id);
      if (file === undefined) return;
      const item = items.find((each) => each.id === id);
      /*
        The same condition the reducer applies to "retried", checked here too
        so the two cannot disagree. The reducer would refuse to reopen a
        non-retryable row, but this function would still have pushed the file
        onto the work queue — and the uploader would then send a file whose
        row says, correctly, that sending it is pointless.
      */
      if (item?.status !== "failed" || item.failure?.retryable !== true) return;

      dispatch({ type: "retried", id });
      queueRef.current.push({ id, file });
      drain();
    },
    [drain, items],
  );

  const dismiss = useCallback(
    (id: string) => {
      if (inFlightRef.current?.id === id) {
        inFlightRef.current.controller.abort();
      }
      removeFromQueue(id);
      filesRef.current.delete(id);
      dispatch({ type: "dismissed", id });
    },
    [removeFromQueue],
  );

  /*
    A depth counter, not a boolean. `dragenter`/`dragleave` fire for every
    descendant the pointer crosses, so a plain `setDraggingOver(false)` on
    leave un-highlights the zone the moment the cursor passes over the label
    inside it.
  */
  const dragDepth = useRef(0);

  const summary = queueSummary(items);

  return (
    <div>
      <div
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDraggingOver(true);
        }}
        onDragOver={(event) => {
          // Required: without preventDefault on dragover the browser refuses
          // the drop and navigates to the file instead.
          event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(dragDepth.current - 1, 0);
          if (dragDepth.current === 0) setDraggingOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDraggingOver(false);
          addFiles(event.dataTransfer.files);
        }}
        className={[
          "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center transition-colors",
          // has-[:focus-visible], because the real control is a visually
          // hidden <input type="file">: keeping it in the DOM is what keeps
          // the keyboard and the file picker working, and this is how its
          // focus becomes visible on the thing the eye is actually on.
          "has-[:focus-visible]:border-ring has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
          isDraggingOver
            ? "border-ring bg-surface-2"
            : "border-line-strong bg-surface-1",
        ].join(" ")}
      >
        <input
          id={inputId}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          onChange={(event) => {
            addFiles(event.target.files);
            // Reset, or picking the same file twice in a row fires no change
            // event the second time.
            event.target.value = "";
          }}
        />
        <label
          htmlFor={inputId}
          className="cursor-pointer rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Choose files
        </label>
        <p className="text-sm text-ink-muted">or drag them here</p>
        <p className="max-w-prose text-xs text-ink-muted">
          {acceptedTypesSummary("IMAGE")}. {acceptedTypesSummary("VIDEO")}.
        </p>
      </div>

      {/*
        The overall state, announced. Counted from the rows rather than kept
        beside them, so it cannot disagree with what is on screen.
      */}
      <p role="status" aria-live="polite" className="mt-4 text-sm text-ink-muted">
        {summary.message}
      </p>

      <UploadQueueList
        items={items}
        onRetry={retry}
        onCancel={cancel}
        onDismiss={dismiss}
      />
    </div>
  );
}
