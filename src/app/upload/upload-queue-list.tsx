import { Button, buttonVariants } from "@/components/ui/button";
import { UPLOAD_PATH, mediaPreviewPath, signInPath } from "@/lib/routes";

import { formatBytes } from "./outcomes";
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
  item,
  onRetry,
  onDismiss,
}: {
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
            component: this navigates, and a real <a> is what gives middle-
            click, "open in new tab" and the browser's own affordances. The
            shared `buttonVariants` keeps it visually identical.
          */
          <a
            href={signInPath(UPLOAD_PATH)}
            className={buttonVariants({ variant: "default", size: "sm" })}
          >
            Sign in
          </a>
        ) : null}
        {failure.retryable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRetry(item.id)}
          >
            Try again
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

            {item.status === "uploading" ? (
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
                <p className="text-xs text-ink-muted">
                  {previewSrc(item.media) === null
                    ? // Today this is every VIDEO: the watermarked poster
                      // frame is ugcportal-pmb's job, and until it exists
                      // there is nothing safe to show. Saying so is better
                      // than a blank square that looks like a failure.
                      "Stored. No thumbnail yet — watermarked video stills are not generated."
                    : "Stored. The thumbnail is the watermarked preview; the original is never shown here."}
                </p>
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

            <Failure item={item} onRetry={onRetry} onDismiss={onDismiss} />
          </div>
        </li>
      ))}
    </ul>
  );
}
