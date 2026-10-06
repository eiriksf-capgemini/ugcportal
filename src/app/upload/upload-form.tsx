"use client";

import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";

import { TEXT_INPUT_CLASS } from "@/components/ui/text-input";
import { ACCEPTED_MIME_TYPES } from "@/lib/media-rules";

import { altTextFieldError, captionFieldError } from "./alt-text";
import {
  acceptedTypesSummary,
  cancelledFailure,
  mayRetry,
  secondsUntilRetry,
} from "./outcomes";
import { UploadQueueList } from "./upload-queue-list";
import {
  queueSummary,
  releasedFileId,
  settledChange,
  uploadQueueReducer,
  type QueueAction,
  type QueueItem,
} from "./upload-queue";
import { drainQueue, enqueueFiles, type QueueEntry } from "./upload-runner";
import {
  tagCapMessage,
  tagPickerRows,
  toggleTagSlug,
  type SelectableTag,
} from "./tag-selection";

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

export type { SelectableTag };

export type UploadFormProps = {
  /**
   * The subject vocabulary (ugcportal-jsc), read on the server and handed
   * down — this component never fetches it. Empty is a legitimate state and
   * the picker says so rather than rendering an empty fieldset.
   */
  availableTags?: readonly SelectableTag[];
};

export function UploadForm({ availableTags = [] }: UploadFormProps) {
  const inputId = useId();
  const [items, dispatch] = useReducer(uploadQueueReducer, [] as QueueItem[]);
  const [isDraggingOver, setDraggingOver] = useState(false);
  /**
   * Which subjects the next batch of files gets, by slug.
   *
   * Slugs rather than names, because that is what the checkbox inputs are
   * keyed on and what survives a tag being renamed underneath the page. The
   * NAMES are what goes on the wire — POST /api/media validates and
   * normalises the name itself, so the browser is not a second authority on
   * what a tag is called.
   */
  const [selectedSlugs, setSelectedSlugs] = useState<readonly string[]>([]);

  /**
   * Alt text and caption for the next batch of files (ugcportal-gwr), the
   * same "applies to files you add next" timing the tag picker uses, and for
   * the same reason — see alt-text.ts's module docstring for why these are
   * batch-level rather than per-file today.
   */
  const [altText, setAltText] = useState("");
  const [caption, setCaption] = useState("");
  /**
   * ONE piece of state, not two (review round 4 finding 7 — `altTextTouched`
   * and a separate `attemptedFilenames` used to be written together on every
   * path, which is the same "two state variables representing one fact"
   * shape this file's own comment, a few lines below, already warns against
   * when justifying merging `filesRef`/`tagsRef` into one `Map`). `null`
   * means "nothing attempted yet, or the field changed since" — the state
   * `showAltTextError` used to carry as `false`. A non-null array means
   * `addFiles` refused with exactly those filenames, which the live error
   * display below reads with the SAME `altTextFieldError` call the gate
   * made, so "why this was blocked" and "what the message says" cannot
   * disagree.
   */
  const [attemptedFilenames, setAttemptedFilenames] = useState<
    readonly string[] | null
  >(null);

  /**
   * The authoritative work queue, OUTSIDE React state on purpose.
   *
   * Picking the next file out of the rendered `items` races the re-render the
   * previous file's dispatches caused: `started` has not landed yet, the row
   * still reads "pending", and the same file is uploaded twice. A ref is read
   * at the instant it is asked, which is what the loop needs.
   */
  const queueRef = useRef<QueueEntry[]>([]);
  /**
   * Everything a RETRY needs to re-send exactly what the original attempt
   * sent, keyed by queue id: the `File` itself (not serialisable into reducer
   * state), the tags it was added with (ugcportal-jsc), and its alt text and
   * caption (ugcportal-gwr). Reading the form's CURRENT state on retry would
   * silently re-tag, or re-describe, a file the user chose subjects and
   * wording for minutes ago with whatever happens to be ticked or typed now —
   * an edit to a request they are asking to repeat, not a retry of it.
   *
   * ONE MAP, NOT THREE. An earlier version of this kept `filesRef`, `tagsRef`
   * and `altCaptionRef` as three separate `Map`s, each written at the same
   * four call sites (add, release-on-settle, retry-read, dismiss) — a shape a
   * review round flagged as the same sibling-omission risk already fixed once
   * for `filesRef` alone: a future per-file field (ugcportal-hf5u) would have
   * paid the same four-site tax a fourth time, and a missed delete at either
   * teardown site leaks that one map's entry while the other two are cleaned
   * up correctly. One map means one set/get/delete per site instead of three.
   *
   * The value type is `Omit<QueueEntry, "id" | "signal">` — reusing
   * upload-runner.ts's own type rather than a second, hand-written literal
   * (review round 2 finding) — so the exact sibling-omission risk finding 9
   * closed one level down cannot reopen one level up: a field added to
   * `QueueEntry` later is a compile error here until this map's callers
   * are updated too, rather than a silently-dropped field with nothing to
   * flag the gap.
   */
  const queuedFilesRef = useRef(
    new Map<string, Omit<QueueEntry, "id" | "signal">>(),
  );
  const drainingRef = useRef(false);
  const inFlightRef = useRef<{ id: string; controller: AbortController } | null>(
    null,
  );

  /**
   * Keyboard focus handoff for "Try again" (ugcportal-ff2a) — the same shape
   * ugcportal-jx4 fixed for the gallery's "Load more", one level down: that
   * page has a single button and a single landing spot, so one ref each was
   * enough; this page has one of each PER ROW, so these are keyed by queue
   * id instead. `UploadQueueList` stays hook-free (see its own docstring) —
   * it only forwards the element through the ref callbacks below, never
   * reads from these maps itself.
   */
  const retryButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const statusLineRefs = useRef(new Map<string, HTMLParagraphElement>());

  const registerRetryButtonRef = useCallback(
    (id: string, element: HTMLButtonElement | null) => {
      if (element === null) retryButtonRefs.current.delete(id);
      else retryButtonRefs.current.set(id, element);
    },
    [],
  );

  const registerStatusLineRef = useCallback(
    (id: string, element: HTMLParagraphElement | null) => {
      if (element === null) statusLineRefs.current.delete(id);
      else statusLineRefs.current.set(id, element);
    },
    [],
  );

  /**
   * Which rows have reached an outcome, tracked from the ACTIONS rather than
   * from the rendered list.
   *
   * An event handler closes over the `items` array of the render that drew its
   * button. A guard written as `items.find(...)` inside a handler therefore
   * re-reads the very snapshot the stale button came from, and in the one race
   * it exists to catch — a file's `succeeded` dispatched, React not yet
   * committed, that file's old Cancel clicked — it agrees with the stale
   * button and waves it through. It looks like a second lock and is a copy of
   * the first one's key.
   *
   * This set is written synchronously as each action is dispatched, so it is
   * current regardless of what React has committed.
   */
  const settledRef = useRef(new Set<string>());

  /**
   * A clock, read fresh at every dispatch (ugcportal-ggw) and otherwise
   * ticking only while some row is inside a Retry-After window — see the
   * effect below, and `dispatchQueue`, which is where it is actually kept
   * current.
   *
   * Initialised from a function so the first value is read at mount rather
   * than at module scope, and never rendered when the queue is empty — which
   * it always is on the server — so there is nothing here to mismatch during
   * hydration.
   */
  const [now, setNow] = useState(() => Date.now());

  /**
   * The single door every dispatch goes through, so the two things that have
   * to track the action stream actually see all of it.
   *
   * Besides the settled set, it releases the row's File once nothing can ask
   * for it again. `filesRef` used to be pruned only by `dismiss`, so every
   * succeeded row and every non-retryable failure kept its File — and its
   * backing blob, up to 200 MB for a video — alive for the tab's lifetime with
   * no reader left.
   *
   * IT ALSO REFRESHES `now` (ugcportal-ggw), and doing it here rather than in
   * an effect is the fix. `now` used to be refreshed only by the interval
   * further down, which itself runs only while `throttled` is true — and
   * `throttled` is computed FROM that same `now`. A 503 with a Retry-After
   * landing long after mount (the user picked tags, read the page, walked
   * away) was rendered on the very next commit with `now` still sitting at
   * whatever it was when the interval last ran, or at mount if it never has
   * — turning a real 12-second window into "Try again in 312s" for the up to
   * 500ms until the interval's own first tick caught up.
   *
   * An effect cannot close that window: an effect runs AFTER the browser has
   * already committed the stale render once. `dispatchQueue` is called
   * synchronously from the same event (a promise resolving, a click) that is
   * about to make `items` carry the new failure, so reading the clock HERE —
   * before `dispatch(action)` schedules the re-render that will need it — is
   * what makes the very first render of that failure already correct, rather
   * than a second render moments later. Calling `Date.now()` directly in the
   * component body instead (a natural-looking alternative) is what this repo's
   * react-hooks/purity rule exists to catch: a component's render must be a
   * pure function of its props and state, and this is a callback, not render.
   */
  const dispatchQueue = useCallback((action: QueueAction) => {
    const { settled, unsettled } = settledChange(action);
    for (const id of settled) settledRef.current.add(id);
    for (const id of unsettled) settledRef.current.delete(id);

    const released = releasedFileId(action);
    if (released !== null) {
      // One delete, not three: a row whose File is gone can never be
      // retried, so keeping any of its other fields is a leak of exactly the
      // same shape, just smaller.
      queuedFilesRef.current.delete(released);
    }

    setNow(Date.now());
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
    }, dispatchQueue).finally(() => {
      drainingRef.current = false;
      inFlightRef.current = null;
    });
  }, [dispatchQueue]);

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      const files = fileList === null ? [] : Array.from(fileList);
      if (files.length === 0) return;

      /*
       * ALT TEXT IS REQUIRED TO ADD FILES ON THIS PAGE (ugcportal-gwr), and
       * checked HERE — before anything is queued or sent — rather than left
       * to the server. See alt-text.ts's docstring on `altTextFieldError`
       * for why this page's gate is stricter than POST /api/media's own.
       *
       * Refusing the whole drop/pick rather than queueing the files as
       * `failed`: those rows exist to report something the SERVER would
       * refuse about the FILE itself (precheckFile) — a type, a size — not a
       * field on the form that has nothing to do with any particular file.
       *
       * The actual filenames are passed here (review round 3 finding 4) so
       * the K2 filename-equality rule is caught before anything uploads,
       * not only after — see alt-text.ts's own docstring on why this is the
       * one point in this component that can supply them at all.
       */
      const filenames = files.map((file) => file.name);
      if (altTextFieldError(altText, filenames) !== null) {
        setAttemptedFilenames(filenames);
        return;
      }
      /*
       * The caption gets the same gate (review round 1, finding 5) —
       * `AltTextFields` already shows this message live, unconditionally,
       * the moment the caption is invalid (unlike alt text's "touched"
       * gating, there is nothing to wait for: a caption is never required,
       * so there is no "merely empty" state this would prematurely flag).
       * Without this check the files still queued and uploaded in full —
       * the whole point of a CLIENT-side precheck is to refuse before
       * paying for the request, and an invalid caption reaching the server
       * is exactly the 413/400-after-the-upload shape this page's other
       * prechecks exist to avoid.
       */
      if (captionFieldError(caption) !== null) {
        return;
      }

      /*
       * CLEAR a stale refusal (round 5 finding): `attemptedFilenames` is only
       * ever WRITTEN by the gate above, on refusal — nothing on this success
       * path used to touch it. So a visitor who hit the K2 filename-equality
       * refusal once, then fixed it not by editing the alt text but by
       * swapping in a different file whose name no longer collides, reached
       * here with the OLD failing filenames still sitting in state. The live
       * error display a few lines down in `AltTextFields` recomputes from
       * whatever `attemptedFilenames` holds, so it kept re-running
       * `altTextFieldError` against that stale filename and kept showing
       * "must describe the photo, not repeat its filename" under a field
       * whose files had just been queued successfully — a real refusal
       * banner left on screen describing an attempt that already succeeded.
       * Resetting here, the one place a success is known, is what `null`'s
       * own docstring above already promises: "nothing attempted yet, OR THE
       * FIELD CHANGED SINCE" — a successful add is exactly that, for the
       * files if not for the field itself.
       */
      if (attemptedFilenames !== null) setAttemptedFilenames(null);

      /*
       * The tag NAMES for this batch, resolved from the ticked slugs at the
       * moment the files are added. A slug that is no longer in
       * `availableTags` resolves to nothing and is dropped rather than sent
       * as a slug — sending "wine-drink" where the vocabulary says
       * "Wine & drink" would create a second tag whose name is a slug.
       */
      const tagNames = availableTags
        .filter((tag) => selectedSlugs.includes(tag.slug))
        .map((tag) => tag.name);

      // `entries` omits anything the pre-check already refused, so no request
      // is ever made for those files (K2). See enqueueFiles.
      const { items: queued, entries } = enqueueFiles(
        files,
        nextQueueId,
        tagNames,
        altText.trim(),
        caption.trim(),
      );
      dispatchQueue({ type: "queued", items: queued });

      for (const entry of entries) {
        queuedFilesRef.current.set(entry.id, {
          file: entry.file,
          tags: entry.tags,
          altText: entry.altText,
          caption: entry.caption,
        });
        queueRef.current.push(entry);
      }

      drain();
    },
    [
      altText,
      attemptedFilenames,
      availableTags,
      caption,
      drain,
      dispatchQueue,
      selectedSlugs,
    ],
  );

  const removeFromQueue = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((entry) => entry.id !== id);
  }, []);

  const cancel = useCallback(
    (id: string) => {
      /*
        Read from the settled SET, not from `items`. A Cancel button painted
        in a previous commit — the drain loop settles one file and moves to
        the next before React commits either — calls this with the id of a row
        that has since finished. `items` here is that same stale render's
        array, so it would report the row as still uploading and agree with
        the button; the set was written when `succeeded` was dispatched and
        says otherwise.

        Without this, the call falls through the in-flight check below to
        `failed`, and an upload the server has already stored is relabelled
        "You cancelled this upload, so nothing was kept". The reducer refuses
        that too, and would have caught it — but a guard here that cannot
        disagree with the thing it is guarding is not a second lock, and
        leaving it looking like one invites someone to remove the first.
      */
      if (settledRef.current.has(id)) return;

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
      dispatchQueue({ type: "failed", id, failure: cancelledFailure() });
    },
    [dispatchQueue, removeFromQueue],
  );

  const retry = useCallback(
    (id: string) => {
      const queued = queuedFilesRef.current.get(id);
      if (queued === undefined) return;
      /*
        Must be settled to be retried, read from the set rather than from
        `items` for the same reason cancel() does — and `retried` removes the
        id from the set, so a second click on the same button finds it absent
        and stops here rather than queueing the file twice.
      */
      if (!settledRef.current.has(id)) return;

      /*
        The retryable flag still comes from `items`, because it is the
        reducer's own record of WHY the row failed and there is nowhere
        fresher to read it: a row that is failed-and-retryable cannot become
        failed-and-not while the user is clicking. The reducer applies the
        same condition to "retried"; this stops the file being pushed onto the
        work queue for a refusal that would only be repeated.
      */
      const item = items.find((each) => each.id === id);
      if (item?.status !== "failed" || item.failure === null) return;
      /*
        `mayRetry`, not `retryable` alone — the same predicate the button's
        disabled state uses, so the control and the handler cannot disagree
        about whether the server's Retry-After window has passed. Read against
        Date.now() rather than the ticking `now` below, because this runs on a
        click and should judge the moment of the click.
      */
      if (!mayRetry(item.failure, Date.now())) return;

      /*
        Keyboard focus handoff (ugcportal-ff2a K1), before the dispatch below
        rather than after it, and for the same reason gallery.tsx's own
        pre-dispatch check gives: `dispatchQueue` only QUEUES the re-render
        that unmounts "Try again" (the item's `failure` goes to null on
        "retried" — see uploadQueueReducer), it does not commit it, so
        `document.activeElement` here still reflects whatever the visitor's
        last real action left it as. Checked against THIS row's own button,
        not against `document.body`: a visitor who activated this with a
        mouse, or who is on a different row entirely, must not have their
        focus moved anywhere (K2) — only a visitor who was actually on this
        button gets handed somewhere else. The status line is the landing
        spot because, like the gallery's paging status, it is never
        conditionally rendered (see UploadQueueList), so it already exists
        for `.focus()` to find.
      */
      if (document.activeElement === retryButtonRefs.current.get(id)) {
        statusLineRefs.current.get(id)?.focus();
      }

      dispatchQueue({ type: "retried", id });
      // The tags, alt text and caption the FIRST attempt carried, not
      // whatever is ticked or typed now.
      queueRef.current.push({
        id,
        file: queued.file,
        tags: queued.tags,
        altText: queued.altText,
        caption: queued.caption,
      });
      drain();
    },
    [dispatchQueue, drain, items],
  );

  const dismiss = useCallback(
    (id: string) => {
      if (inFlightRef.current?.id === id) {
        inFlightRef.current.controller.abort();
      }
      removeFromQueue(id);
      queuedFilesRef.current.delete(id);
      dispatchQueue({ type: "dismissed", id });
    },
    [dispatchQueue, removeFromQueue],
  );

  /*
    A depth counter, not a boolean. `dragenter`/`dragleave` fire for every
    descendant the pointer crosses, so a plain `setDraggingOver(false)` on
    leave un-highlights the zone the moment the cursor passes over the label
    inside it.
  */
  const dragDepth = useRef(0);

  const summary = queueSummary(items);

  const throttled = items.some(
    (item) =>
      item.failure !== null && secondsUntilRetry(item.failure, now) > 0,
  );

  useEffect(() => {
    if (!throttled) return;
    // Twice a second, so the displayed number is never more than half a
    // second stale.
    const ticker = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(ticker);
  }, [throttled]);

  /*
    Swallows dragover/drop anywhere on the DOCUMENT, for the lifetime of this
    page (ugcportal-juo).

    The drop zone's own onDragOver/onDrop below already preventDefault, but
    only for drops that land ON the zone. The zone is a few hundred pixels
    tall on a page that is full height, so a drop a few pixels outside it is
    ordinary, not a rare edge case -- and without this, THAT drop hits the
    browser's default handling: navigate to the dropped file, which replaces
    the entire page and destroys the queue, including anything mid-upload.

    This only has to make a miss inert, not treat it as a hit (that is a
    separate, larger decision about the page's target area -- explicitly out
    of scope here). So these two listeners do nothing but preventDefault;
    they never call addFiles, and the zone's own handlers above are
    unaffected by them regardless of listener order -- neither this listener
    nor the browser's default action stops other listeners from running, so
    the zone's onDragOver/onDrop still fire and still do their own work
    (including calling addFiles) exactly as before a drop that lands on the
    zone. (Next.js's App Router hydrates onto `document` itself -- see
    `appElement` in next's client/app-index.js -- so React's own delegated
    listener for these events lives on the same node as this one, not on an
    ancestor; ordering between the two is registration order, not DOM
    nesting, and this effect relies on neither.)

    Attached with a plain useEffect with no dependencies, so it is installed
    once on mount and removed once on unmount (K2) -- it must not outlive
    this page and swallow a drop on whatever route is rendered next.
  */
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      event.preventDefault();
    };
    document.addEventListener("dragover", swallow);
    document.addEventListener("drop", swallow);
    return () => {
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    };
  }, []);

  return (
    <div>
      {/*
        ABOVE THE DROP ZONE, and the order is the feature rather than a
        layout preference.

        There is no staging step on this page: dropping a file starts its
        upload immediately. So a picker rendered after the drop zone is a
        control the user meets only once it can no longer affect anything
        they have done — drop four photographs, scroll past the queue, find
        the checkboxes, and those four are permanently untagged, because
        there is no owner-facing retag screen yet (ugcportal-1wz).

        Its own copy already says "Applies to files you add from now on",
        which is only an honest sentence if the reader has met it before they
        add anything. Rendered second, the sentence was true and useless.

        AltTextFields is rendered first of the two, for the same reason: it
        is the one that can actually refuse to let files be added at all
        (ugcportal-gwr), so it has to be the thing a visitor meets before the
        drop zone, not something discovered only after a drop was refused.
      */}
      <AltTextFields
        altText={altText}
        caption={caption}
        attemptedFilenames={attemptedFilenames}
        onAltTextChange={(value) => {
          setAltText(value);
          // Typing clears the "you have to fill this in" message; it comes
          // back only if the visitor tries to add files again while it is
          // still blank or invalid.
          if (attemptedFilenames !== null) setAttemptedFilenames(null);
        }}
        onCaptionChange={setCaption}
      />

      <TagPicker
        availableTags={availableTags}
        selectedSlugs={selectedSlugs}
        onToggle={(slug) =>
          setSelectedSlugs((current) => toggleTagSlug(current, slug))
        }
      />

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
          /*
            bg-petrol-400/text-petrol-900, not bg-primary/text-primary-
            foreground (ugcportal-rw9j review round 5, code-review): this
            label sits inside the dropzone panel above (bg-surface-1
            resting, bg-surface-2 dragging), the untouched near-black
            surface scale - --primary measured 2.03:1 / 1.81:1 there in
            light mode. --color-petrol-400/--petrol-900 is the same
            old-surface-safe fill/label pair button.tsx's default-neutral
            variant uses (6.02:1); this is a plain label, not a Button, so
            the tokens are applied directly rather than importing the
            component for one call site.
          */
          className="cursor-pointer rounded-lg bg-petrol-400 px-3 py-2 text-sm font-medium text-petrol-900 transition-colors hover:brightness-95"
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
      {/*
        text-muted-foreground, not text-ink-muted (ugcportal-rw9j review
        round 4): this sits after the dropzone div closes, directly on
        --background, unlike the "or drag them here"/accepted-types copy
        above it which is genuinely inside the dropzone's bg-surface-1/2.
      */}
      <p role="status" aria-live="polite" className="mt-4 text-sm text-muted-foreground">
        {summary.message}
      </p>

      <UploadQueueList
        items={items}
        now={now}
        onRetry={retry}
        onCancel={cancel}
        onDismiss={dismiss}
        onRetryButtonRef={registerRetryButtonRef}
        onStatusLineRef={registerStatusLineRef}
      />
    </div>
  );
}

/**
 * Alt text (required) and caption (optional) for the next files added
 * (ugcportal-gwr). See alt-text.ts's module docstring for why these are
 * batch-level — the same timing the tag picker already uses — rather than
 * per file.
 *
 * `attemptedFilenames` is a PROP, not state read inside this component,
 * because the question "has the visitor tried and failed" belongs to the
 * thing that actually tried — `addFiles` in the parent — not to a field
 * watching its own value change. A component that showed the error the
 * moment the field was merely empty would announce "required" before anyone
 * had done anything. `null` means "nothing attempted yet, or the value
 * changed since"; a (possibly empty) array means `addFiles` refused with
 * exactly those filenames, which this component reads with the SAME
 * `altTextFieldError` call the gate made, so "why this was blocked" and
 * "what the message says" cannot disagree (review round 3 finding 4's own
 * follow-on — see the state declaring this in the parent for why it has to
 * be passed down rather than recomputed here from nothing).
 */
function AltTextFields({
  altText,
  caption,
  attemptedFilenames,
  onAltTextChange,
  onCaptionChange,
}: {
  altText: string;
  caption: string;
  attemptedFilenames: readonly string[] | null;
  onAltTextChange: (value: string) => void;
  onCaptionChange: (value: string) => void;
}) {
  const altTextId = useId();
  const altTextErrorId = useId();
  const captionId = useId();
  const captionErrorId = useId();

  const altTextError =
    attemptedFilenames !== null
      ? altTextFieldError(altText, attemptedFilenames)
      : null;
  const captionError = captionFieldError(caption);

  return (
    <div className="mt-6" data-upload-alt-text-fields="">
      <label htmlFor={altTextId} className="block text-sm font-medium text-ink">
        Alt text
        {/* Visual asterisk plus a spoken word, so the requirement survives
            whether the label is seen or heard. */}
        <span aria-hidden="true"> *</span>
        <span className="sr-only"> (required)</span>
      </label>
      <p className="mt-1 max-w-prose text-xs text-ink-muted">
        Describe what the photo shows, for people using a screen reader and
        for search. Applies to files you add next.
      </p>
      <input
        id={altTextId}
        type="text"
        required
        // No `maxLength` attribute (review round 3 finding 2): the browser's
        // own `maxlength` counts UTF-16 CODE UNITS, while
        // MAX_ALT_TEXT_LENGTH and `altTextFieldError` count CODE POINTS (the
        // same unit `Array.from(x).length` uses throughout this codebase, so
        // a surrogate pair is never split) — an astral character such as an
        // emoji is two code units but one code point, so the native
        // attribute would silently stop accepting input at roughly HALF the
        // length the server actually allows. The live error message below,
        // driven by the same code-point-counting validator the server uses,
        // is the real limit; a native `maxlength` here would just be a
        // second, wrong one.
        value={altText}
        onChange={(event) => onAltTextChange(event.target.value)}
        aria-invalid={altTextError !== null}
        aria-describedby={altTextError !== null ? altTextErrorId : undefined}
        className={TEXT_INPUT_CLASS}
      />
      {/* Rendered unconditionally, empty when there is nothing wrong — the
          same rule GalleryPaging and the tag picker's cap message follow, so
          the error is announced rather than silently inserted. */}
      <p
        id={altTextErrorId}
        role="alert"
        className="mt-1 text-xs text-destructive"
      >
        {altTextError ?? ""}
      </p>

      <label
        htmlFor={captionId}
        className="mt-4 block text-sm font-medium text-ink"
      >
        Caption <span className="text-ink-muted">(optional)</span>
      </label>
      <textarea
        id={captionId}
        rows={2}
        // No `maxLength` here either — same code-unit-vs-code-point reason
        // the alt text input's own comment gives.
        value={caption}
        onChange={(event) => onCaptionChange(event.target.value)}
        aria-invalid={captionError !== null}
        aria-describedby={captionError !== null ? captionErrorId : undefined}
        className={TEXT_INPUT_CLASS}
      />
      {/* `id` + `aria-describedby` above, matching the alt text field's own
          pattern (review round 3 finding 3) — without it, `aria-invalid`
          alone tells a screen-reader user THAT the caption is invalid but
          never associates WHY, which is a real gap in a bead whose entire
          purpose is accessibility text. */}
      <p id={captionErrorId} role="alert" className="mt-1 text-xs text-destructive">
        {captionError ?? ""}
      </p>
    </div>
  );
}

/**
 * Which subjects the next files get (ugcportal-jsc).
 *
 * IT APPLIES TO WHAT YOU ADD NEXT, not to what is already in the queue, and
 * the wording says so out loud because the alternative reading is the one a
 * user would otherwise make. The queue starts uploading the instant a file is
 * dropped — there is no staging step to attach tags to afterwards — so the
 * only honest thing a picker above the drop zone can mean is "from here on".
 * Files already sent are re-tagged through PUT /api/media/[id]/tags, not
 * here.
 *
 * Checkboxes rather than a combo box or a free-text field: the list is short
 * and bounded (MAX_PICKER_TAGS), all of it is worth seeing at once, and a
 * text field would put the browser in the business of deciding what a valid
 * tag name IS — which is the server's job (src/lib/tags.ts) and must not
 * have a second implementation. Creating a subject that is not in this list
 * is an API-level capability today; who may do it is ugcportal-x0l.
 *
 * THE CAP IS A SHARED CONSTANT, NOT A SECOND RULE, and the distinction is
 * the one that decides what may live in a client component at all. This does
 * not re-implement `parseTagNames`; it reads the same `MAX_TAGS_PER_ITEM`
 * the server enforces, out of the dependency-free module that exists for
 * exactly that (the upload rules do the same with `validateUpload`). Without
 * it a seventh tick is accepted here and refused by POST /api/media — after
 * the entire multipart body has been buffered, once per file in the batch,
 * and again on every retry, with nothing on screen suggesting the tag picker
 * is the cause. Unreachable with the four seeded subjects and reachable the
 * moment the vocabulary grows past six.
 *
 * Enforced by disabling the UNTICKED boxes at the cap, never by refusing a
 * click silently and never by disabling the ticked ones — the way out of the
 * cap has to stay available, or the control becomes a trap. The server still
 * enforces the same number: a disabled checkbox is an affordance, not a
 * security boundary.
 *
 * A `<fieldset>` with a `<legend>`, so a screen reader announces what the
 * group of checkboxes is FOR before reading the first one. `aria-labelledby`
 * on the list is not a substitute: a legend is what associates a name with a
 * set of form controls.
 *
 * And the legend carries NO `id`, because nothing points at one. An earlier
 * version generated one with `useId`, threaded it down as a prop and wrote
 * it out — the leftover of the `aria-labelledby` approach this rejected. An
 * unused id on an accessibility element is worse than no id: the next reader
 * has to go and find out what depends on it, and nothing does.
 */
function TagPicker({
  availableTags,
  selectedSlugs,
  onToggle,
}: {
  availableTags: readonly SelectableTag[];
  selectedSlugs: readonly string[];
  onToggle: (slug: string) => void;
}) {
  if (availableTags.length === 0) {
    /*
     * No vocabulary yet. Rendering an empty fieldset would be a group
     * control with nothing in it — announced as a group, focusable past,
     * and meaningless. Say what is going on instead.
     *
     * Reachable in practice: the four subjects are seeded by a migration, so
     * this is what a database that has not been migrated, or one where they
     * were deleted, looks like.
     */
    return (
      <p className="mt-4 max-w-prose text-sm text-muted-foreground">
        No subjects have been set up yet, so these uploads will have no tags.
      </p>
    );
  }

  const rows = tagPickerRows(availableTags, selectedSlugs);
  const capMessage = tagCapMessage(selectedSlugs.length);

  return (
    // text-foreground/text-muted-foreground throughout this fieldset, not
    // text-ink/text-ink-muted (ugcportal-rw9j review round 4): it renders
    // directly on --background, not inside any near-black well.
    <fieldset className="mt-6" data-upload-tag-picker="">
      <legend className="text-sm font-medium text-foreground">
        Tag what you add next
      </legend>
      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
        Applies to files you add from now on. Tags are shown under the
        photograph in the gallery.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {rows.map((row) => (
          <label
            key={row.slug}
            className={[
              "flex items-center gap-2 text-sm",
              row.disabled
                ? "cursor-not-allowed text-muted-foreground"
                : "cursor-pointer text-foreground",
            ].join(" ")}
          >
            <input
              type="checkbox"
              name="upload-tag"
              value={row.slug}
              checked={row.checked}
              disabled={row.disabled}
              onChange={() => onToggle(row.slug)}
              className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            {row.name}
          </label>
        ))}
      </div>
      {/*
        Says WHY the boxes went grey, and only while they are. A control that
        stops responding without explaining itself reads as a bug, and this
        one would be an especially confusing one — the boxes are greyed by
        something the user did to a different box.

        `aria-live` so it is announced rather than only seen: the change a
        screen-reader user notices is the next checkbox reporting itself as
        disabled, with no stated reason anywhere near it. Rendered
        unconditionally, empty when there is nothing to say, because a live
        region inserted at the same moment as its text is frequently not
        announced at all — the same rule GalleryPaging follows.
      */}
      <p aria-live="polite" className="mt-2 text-xs text-muted-foreground">
        {capMessage}
      </p>
    </fieldset>
  );
}
