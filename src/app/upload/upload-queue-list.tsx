import { Button, buttonVariants } from "@/components/ui/button";
import { UPLOAD_PATH, mediaPreviewPath, signInPath } from "@/lib/routes";

import { formatBytes, mayRetry, secondsUntilRetry } from "./outcomes";
import {
  percentComplete,
  type QueueItem,
  type QueueMedia,
} from "./upload-queue";

/**
 * The queued files, rendered.
 *
 * Deliberately presentational and hook-free: every decision it makes is a
 * function of its props, so the whole of it can be rendered to static markup
 * in a test (the repo's vitest runs in a node environment — see
 * vitest.config.ts — so `renderToStaticMarkup` is the only rendering
 * available, and this is the shape that suits it).
 */

export type UploadQueueListProps = {
  items: QueueItem[];
  /**
   * The moment the list is being rendered at, for the retry countdown.
   *
   * Passed in rather than read from the clock inside, so the component stays
   * a pure function of its props: renderToStaticMarkup is the only rendering
   * this repo can do in tests, and a Date.now() inside would make the
   * throttled state unassertable.
   */
  now: number;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
};

/**
 * THE ONLY IMAGE SOURCE THIS PAGE MAY PRODUCE (ugcportal-n3c K3).
 *
 * `previewId` is an opaque handle with no derivation from the row, the
 * uploader or the storage layout; the delivery route resolves it server-side
 * (ugcportal-a2l). The two values that must never appear here are `key`, the
 * ungated original, and `previewKey`, whose path embeds the uploader's
 * account id — neither is even carried by QueueMedia, so there is nothing on
 * this component's props to render by accident.
 *
 * Returns null for a row with no preview (today, every VIDEO — ugcportal-pmb
 * owns poster frames). Null means "show no image". It must never mean "fall
 * back to something else".
 */
function previewSrc(media: QueueMedia | null): string | null {
  if (media === null || media.previewId === null) return null;
  return mediaPreviewPath(media.previewId);
}

/**
 * What to say beside a stored upload, and WHY THIS IS NOT ONE SENTENCE WITH A
 * FALLBACK.
 *
 * It used to be "is there a preview? no -> watermarked video stills are not
 * generated". That reads as a considered explanation and is one only for
 * VIDEO. A missing preview has a second, unrelated cause: `toQueueMedia`
 * refuses a 201 body it cannot read — truncated, or not JSON — and returns
 * null, so `media` is null and there is no `kind` at all. An image upload
 * then got a confident explanation about video stills, which is the kind of
 * wrong answer nobody debugs because it sounds deliberate.
 *
 * So each cause gets its own sentence, keyed off what is actually known.
 */
function successNote(item: QueueItem): string {
  const media = item.media;
  if (media === null) {
    // Stored — the 201 says so — but the body was unreadable, so there is no
    // previewId to render and nothing more this page can tell the user.
    return "Stored, but the server's reply could not be read, so there is no thumbnail to show. Check your library.";
  }
  if (previewSrc(media) !== null) {
    return "Stored. The thumbnail is the watermarked preview; the original is never shown here.";
  }
  if (media.kind === "VIDEO") {
    // The watermarked poster frame is ugcportal-pmb's job, and until it
    // exists there is nothing safe to show. Saying so is better than a blank
    // square that looks like a failure.
    return "Stored. No thumbnail yet — watermarked video stills are not generated.";
  }
  // An IMAGE with no preview should not happen: the route watermarks every
  // image or refuses it with a 422. If it does, say only what is true.
  return "Stored, but no thumbnail was returned for this image.";
}

function statusLabel(item: QueueItem): string {
  switch (item.status) {
    case "pending":
      return "Waiting";
    case "uploading": {
      const percent = percentComplete(item);
      return percent === null ? "Uploading" : `Uploading ${percent}%`;
    }
    case "succeeded":
      return "Uploaded";
    case "failed":
      return "Not uploaded";
  }
}

function ProgressBar({ item }: { item: QueueItem }) {
  const percent = percentComplete(item);
  return (
    <div
      role="progressbar"
      aria-label={`Upload progress for ${item.name}`}
      /*
        An indeterminate bar omits aria-valuenow entirely rather than sending
        0 — "we cannot tell" and "nothing has happened" are different facts,
        and a screen reader reading 0% forever is the wrong one.
      */
      {...(percent === null
        ? {}
        : { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 })}
      className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-200"
        /*
          Inline, because the value is per-row and continuous; there is no
          utility class for "37%". Width only — the colour is a token.
        */
        style={{ width: `${percent ?? 0}%` }}
      />
    </div>
  );
}

function Failure({
  now,
  item,
  onRetry,
  onDismiss,
}: {
  now: number;
  item: QueueItem;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const failure = item.failure;
  if (failure === null) return null;

  return (
    <div className="mt-2 rounded-md border border-destructive bg-destructive-surface px-3 py-2">
      <p className="text-sm text-destructive">{failure.message}</p>
      {failure.detail === null ? null : (
        /*
          The server's own words, kept separate from ours. It is our server
          writing them — the 413 that names the multipart field is often the
          most useful line on the screen — but they are written for a log
          reader, so they sit below the sentence rather than replacing it.
        */
        <p className="mt-1 font-mono text-xs text-ink-muted">
          {failure.detail}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {failure.needsSignIn ? (
          /*
            An anchor wearing the button's clothes, rather than the Button
            component: this navigates, and a real <a> is what gives
            middle-click, "open in new tab" and the browser's own affordances.
            The shared `buttonVariants` keeps it visually identical.

            target="_blank" IS LOAD-BEARING, not a preference. This queue is
            useReducer state plus two refs, none of it persisted, and a File
            handle cannot survive a navigation at all — so a same-tab sign-in
            discards every queued and completed upload on the page. The new
            tab gets the session cookie, which is shared, and this tab keeps
            its files so "Try again" can actually re-send them. The failure
            message says the link opens a tab, so this is not a surprise.

            rel="noopener noreferrer" because target="_blank" otherwise hands
            the opened page a reference to this one via window.opener.
          */
          <a
            href={signInPath(UPLOAD_PATH)}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "default", size: "sm" })}
          >
            Sign in
            {/* The accessible name has to carry it too, not just the prose. */}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
        {failure.retryable ? (
          /*
            Held shut for the window the server asked for. The 503 path
            already parsed, clamped and printed `Retry-After`, and then
            enabled this button immediately — so the page told the user about
            a shed window and handed them a control that walked straight back
            into it. `mayRetry` is the same predicate the handler uses, so a
            disabled button and a refused click cannot disagree.
          */
          <Button
            type="button"
            variant="outline"
            size="sm"
            /*
              ugcportal-rw9j review round 2: this button sits inside the
              bg-destructive-surface well above, not on --background, so the
              petrol outline treatment (border-primary/text-primary) is wrong
              here - border-primary measured only 1.87:1 against this well in
              light mode, below the 3:1 a control's boundary needs.
              Overridden back to the pre-rw9j outline treatment (border-input/
              text-ink, hover bg-accent/text-accent-foreground) for this one
              instance: border-input is --color-line-strong, already measured
              at 3:1+ against this exact well (control-edge-on-destructive-
              surface in contrast.ts). cn/tailwind-merge (see button.tsx)
              resolves the conflicting border/text/hover utilities in this
              className string's favour over PETROL_OUTLINE_STYLE's.
            */
            className="border-input bg-transparent text-ink hover:bg-accent hover:text-accent-foreground hover:no-underline aria-expanded:bg-accent"
            disabled={!mayRetry(failure, now)}
            onClick={() => onRetry(item.id)}
          >
            {secondsUntilRetry(failure, now) === 0
              ? "Try again"
              : `Try again in ${secondsUntilRetry(failure, now)}s`}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDismiss(item.id)}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

function Thumbnail({ item }: { item: QueueItem }) {
  const src = previewSrc(item.media);

  return (
    <div className="size-16 shrink-0 overflow-hidden rounded-md border border-line bg-surface-2">
      {src === null ? null : (
        /*
          A plain <img>, not next/image, and this is a decision rather than an
          omission. The optimizer fetches the source URL itself, server-side,
          without the visitor's cookies. The delivery route serves an
          UNPUBLISHED preview only to its own owner, identified by session —
          and everything on this page was uploaded seconds ago and is therefore
          unpublished — so a cookieless fetch 404s on every row here. There is
          nothing to optimise anyway: the bytes are an already-resized,
          already-encoded webp thumbnail.

          alt="" because this image is decorative HERE: the filename sits
          immediately beside it and says everything the picture would.
          Real alt text is a field the uploader fills in, and it belongs to
          ugcportal-gwr.
        */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          width={64}
          height={64}
          className="size-full object-cover"
        />
      )}
    </div>
  );
}

export function UploadQueueList({
  items,
  now,
  onRetry,
  onCancel,
  onDismiss,
}: UploadQueueListProps) {
  if (items.length === 0) return null;

  return (
    <ul className="mt-8 flex flex-col gap-3">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex gap-4 rounded-lg border border-line bg-surface-1 p-4"
        >
          <Thumbnail item={item} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-3">
              {/*
                min-w-0 and truncate together: a 200-character filename is
                ordinary, and without both the row grows instead of clipping.
              */}
              <p className="min-w-0 flex-1 truncate text-sm text-ink">
                {item.name}
              </p>
              <p className="shrink-0 text-xs text-ink-muted">
                {statusLabel(item)}
              </p>
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              {item.mimeType === "" ? "Unknown type" : item.mimeType} ·{" "}
              {formatBytes(item.sizeBytes)}
            </p>

            {item.status === "uploading" || item.status === "pending" ? (
              <ProgressBar item={item} />
            ) : null}

            {/*
              Offered while WAITING as well as while uploading. The form's
              cancel() has always handled both — the branch that takes a
              still-queued file back out of the queue was written, tested and
              then unreachable, because this condition was `uploading` alone.
              A 40-file mis-drop could only be undone by reloading the page,
              which also discarded the uploads that had already succeeded.
            */}
            {item.status === "uploading" || item.status === "pending" ? (
              <div className="mt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onCancel(item.id)}
                >
                  Cancel
                </Button>
              </div>
            ) : null}

            {item.status === "succeeded" ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="text-xs text-ink-muted">{successNote(item)}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDismiss(item.id)}
                >
                  Clear
                </Button>
              </div>
            ) : null}

            <Failure
              now={now}
              item={item}
              onRetry={onRetry}
              onDismiss={onDismiss}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
