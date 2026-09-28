import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MAX_SIZE_BYTES } from "@/lib/media";

import { UploadQueueList } from "./upload-queue-list";
import {
  percentComplete,
  uploadQueueReducer,
  type QueueItem,
} from "./upload-queue";
import { drainQueue, enqueueFiles } from "./upload-runner";
import { uploadFile, type UploadTransport } from "./upload-transport";

/**
 * One file, all the way through (ugcportal-n3c K1, K2, K3).
 *
 * This drives the real transport, the real runner, the real reducer and the
 * real list component against a stand-in XMLHttpRequest — so the thing under
 * test is the whole client path, not a mock of it. What it cannot reach is
 * React's event wiring: the repo's vitest runs in a node environment (see
 * vitest.config.ts) with no DOM to dispatch a `drop` or a `change` into, so
 * the component's handlers are covered only as far as the functions they
 * call. That gap is recorded as ugcportal-2al's business (cross-browser
 * verification) and as a known gap on this bead.
 */

type FakeListener = (event: unknown) => void;

class FakeEventTarget {
  private listeners = new Map<string, FakeListener[]>();

  addEventListener(type: string, listener: FakeListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((each) => each !== listener),
    );
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

/** Replays the events a real XMLHttpRequest fires, in the order it fires them. */
class FakeXhr extends FakeEventTarget {
  readonly upload = new FakeEventTarget();
  status = 0;
  responseText = "";
  responseType = "";
  method: string | null = null;
  url: string | null = null;
  sentBody: FormData | null = null;
  aborted = false;
  private readonly headers = new Map<string, string>();

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: FormData): void {
    this.sentBody = body;
  }

  abort(): void {
    this.aborted = true;
    this.emit("abort");
  }

  getResponseHeader(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  // --- test-side drivers ---------------------------------------------------

  sendProgress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.emit("progress", { loaded, total, lengthComputable });
  }

  respond(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    this.status = status;
    this.responseText =
      body === undefined || body === null ? "" : JSON.stringify(body);
    for (const [name, value] of Object.entries(headers)) {
      this.headers.set(name.toLowerCase(), value);
    }
    this.emit("load");
  }

  respondWithRawBody(status: number, text: string): void {
    this.status = status;
    this.responseText = text;
    this.emit("load");
  }

  failToConnect(): void {
    this.emit("error");
  }
}

function transportFor(xhr: FakeXhr): UploadTransport {
  return (request) =>
    uploadFile(request, () => xhr as unknown as XMLHttpRequest);
}

function imageFile(name = "photo.png", size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

/**
 * A fixed render moment. The retry countdown is a function of `now`, so the
 * list takes it as a prop rather than reading the clock — which is what makes
 * the throttled state assertable at all.
 */
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

function idSequence(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `q${n}`;
  };
}

function render(items: QueueItem[]): string {
  return renderToStaticMarkup(
    <UploadQueueList
      items={items}
      onRetry={() => {}}
      onCancel={() => {}}
      onDismiss={() => {}}
      now={NOW}
    />,
  );
}

/**
 * A harness that runs one file through the queue, letting the caller drive
 * the fake request in between.
 */
function startUpload(files: File[], tags: readonly string[] = []) {
  let state: QueueItem[] = [];
  const dispatch = (action: Parameters<typeof uploadQueueReducer>[1]) => {
    state = uploadQueueReducer(state, action);
  };

  const { items, entries } = enqueueFiles(files, idSequence(), tags);
  dispatch({ type: "queued", items });

  const xhr = new FakeXhr();
  const pending = [...entries];
  const settled = drainQueue(
    () => pending.shift(),
    dispatch,
    transportFor(xhr),
  );

  return { xhr, settled, state: () => state };
}

/**
 * Every `media/...` path in the markup that is NOT under `/api/`.
 *
 * The naive form of this check — `expect(markup).not.toContain("media/")` —
 * cannot be used, because the ONE legitimate media URL this page produces is
 * `/api/media/preview/{previewId}` and it contains that substring. A check
 * that cannot pass is a check that gets deleted, so this one is precise
 * instead: an original's key looks like `media/{userId}/{uuid}-{name}` and is
 * never reached through `/api/`.
 *
 * There is a test below asserting this function actually flags such a path,
 * because a scanner that can only return an empty array is worse than none.
 */
function originalMediaPaths(markup: string): string[] {
  const found: string[] = [];
  for (const match of markup.matchAll(/media\/[^"'\s<>]*/g)) {
    const index = match.index ?? 0;
    if (markup.slice(Math.max(0, index - 5), index) !== "/api/") {
      found.push(match[0]);
    }
  }
  return found;
}

/**
 * The 201 body, as the database row rather than as the projection
 * MEDIA_OWNER_SELECT returns — a deliberately hostile fixture. `key`,
 * `previewKey` and `userId` are all present, so "the markup does not contain
 * them" is a fact about this page rather than about what the API happened to
 * send.
 */
const CREATED_BODY = {
  id: "media-1",
  kind: "IMAGE",
  previewId: "preview-abc",
  originalName: "photo.png",
  key: "media/user-9/11111111-2222-3333-4444-555555555555-photo.png",
  previewKey: "previews/user-9/66666666-7777-8888-9999-000000000000.webp",
  userId: "user-9",
  mimeType: "image/png",
  sizeBytes: 2048,
  publishedAt: null,
};

describe("a valid image uploads, with progress, and shows its preview (K1)", () => {
  it("reports progress while it is in flight", async () => {
    const run = startUpload([imageFile("photo.png", 2048)]);

    expect(run.state()[0].status).toBe("uploading");
    run.xhr.sendProgress(512, 2048);
    expect(run.state()[0].loadedBytes).toBe(512);
    expect(percentComplete(run.state()[0])).toBe(25);

    run.xhr.sendProgress(2048, 2048);
    expect(percentComplete(run.state()[0])).toBe(100);

    run.xhr.respond(201, CREATED_BODY);
    await run.settled;

    expect(run.state()[0].status).toBe("succeeded");
  });

  it("puts the file part first in the multipart body", async () => {
    // POST /api/media peeks at the first few kilobytes to find this part and
    // size its memory reservation from the type it declares (ugcportal-05b).
    // A field appended ahead of it pushes the declaration out of that window,
    // and an ordinary video then 413s.
    const run = startUpload([imageFile()]);
    const keys = [...(run.xhr.sentBody as FormData).keys()];
    expect(keys[0]).toBe("file");
    expect(keys).toEqual(["file"]);

    run.xhr.respond(201, CREATED_BODY);
    await run.settled;
  });

  it("still puts the file first once tags are attached (ugcportal-jsc)", async () => {
    /*
     * The case the comment above warns about, now that there IS another
     * field. A `tags` part appended BEFORE the file pushes the file part's
     * Content-Type declaration past PART_HEADER_PEEK_BYTES, the route finds
     * no declaration, and a perfectly ordinary video is held to the
     * undeclared-kind floor and 413s with a message about field ordering.
     * The order is the assertion, not an incidental property of it.
     */
    const run = startUpload([imageFile()], ["Food", "Books"]);
    const keys = [...(run.xhr.sentBody as FormData).keys()];

    expect(keys[0]).toBe("file");
    expect(keys).toEqual(["file", "tags", "tags"]);

    run.xhr.respond(201, CREATED_BODY);
    await run.settled;
  });

  it("sends each tag as its own part, with the names as typed", async () => {
    // One repeated field rather than a JSON array in one part, which is what
    // the route reads with `getAll` — and NAMES rather than slugs, because
    // the server normalises and the browser must not be a second authority
    // on what a tag is called.
    const run = startUpload([imageFile()], ["Wine & drink", "Food"]);

    expect((run.xhr.sentBody as FormData).getAll("tags")).toEqual([
      "Wine & drink",
      "Food",
    ]);

    run.xhr.respond(201, CREATED_BODY);
    await run.settled;
  });

  it("sends no tags part at all when nothing is selected", async () => {
    // The untagged upload has to be byte-for-byte the request it always was:
    // an empty `tags` part would arrive as the empty string, which the tag
    // validator refuses — turning every untagged upload into a 400.
    const run = startUpload([imageFile()], []);

    expect((run.xhr.sentBody as FormData).has("tags")).toBe(false);

    run.xhr.respond(201, CREATED_BODY);
    await run.settled;
  });

  it("gives the same tags to every file in the batch", async () => {
    const files = [imageFile("first.png"), imageFile("second.png")];
    const { entries } = enqueueFiles(files, idSequence(), ["Food"]);

    expect(entries.map((entry) => entry.tags)).toEqual([["Food"], ["Food"]]);
  });

  it("copies the selection into each entry rather than sharing it", async () => {
    /*
     * The queue drains one file at a time and a large video can hold it for
     * minutes, with the picker still live. If the entries shared the caller's
     * array, ticking another box mid-queue would retag every file still
     * waiting — including ones the user had already chosen subjects for.
     */
    const selection = ["Food"];
    const { entries } = enqueueFiles([imageFile()], idSequence(), selection);

    selection.push("Books");

    expect(entries[0].tags).toEqual(["Food"]);
  });

  it("POSTs to the upload route", async () => {
    const run = startUpload([imageFile()]);
    expect(run.xhr.method).toBe("POST");
    expect(run.xhr.url).toBe("/api/media");
    run.xhr.respond(201, CREATED_BODY);
    await run.settled;
  });

  it("renders the watermarked preview in the success state", async () => {
    const run = startUpload([imageFile()]);
    run.xhr.respond(201, CREATED_BODY);
    await run.settled;

    const markup = render(run.state());
    expect(markup).toContain('src="/api/media/preview/preview-abc"');
    expect(markup).toContain("Uploaded");
    expect(markup).toContain("photo.png");
  });

  it("shows no thumbnail, and says why, for a kind with no preview", async () => {
    const run = startUpload([imageFile()]);
    // Every VIDEO today — ugcportal-pmb owns the watermarked poster frame.
    run.xhr.respond(201, {
      ...CREATED_BODY,
      kind: "VIDEO",
      previewId: null,
    });
    await run.settled;

    const markup = render(run.state());
    expect(markup).not.toContain("<img");
    expect(markup).toContain("No thumbnail yet");
  });
});

describe("the upload page never shows an original (K3)", () => {
  it("renders no original-key path and no preview storage path", async () => {
    const run = startUpload([imageFile()]);
    run.xhr.respond(201, CREATED_BODY);
    await run.settled;

    const markup = render(run.state());
    expect(originalMediaPaths(markup)).toEqual([]);
    expect(markup).not.toContain("previews/");
    // The storage paths embed the uploader's account id; that is the whole
    // reason previewId exists.
    expect(markup).not.toContain("user-9");
    expect(markup).not.toContain("key");
  });

  it("flags an original-key path when one is present", () => {
    // The scanner above, proved able to fail. Without this, a regex that
    // matched nothing at all would keep the test green forever.
    expect(
      originalMediaPaths(
        '<img src="/media/user-9/1111-photo.png" alt="" />',
      ),
    ).toEqual(["media/user-9/1111-photo.png"]);
    // And the one legitimate URL is not flagged.
    expect(
      originalMediaPaths('<img src="/api/media/preview/preview-abc" alt="" />'),
    ).toEqual([]);
  });
});

describe("each refusal reaches the screen as its own sentence (K2)", () => {
  async function markupForStatus(
    status: number,
    body: unknown = { error: "nope" },
    headers: Record<string, string> = {},
  ): Promise<string> {
    const run = startUpload([imageFile()]);
    run.xhr.respond(status, body, headers);
    await run.settled;
    return render(run.state());
  }

  it("says the session is gone, and offers a way back in, on 401", async () => {
    const markup = await markupForStatus(401);
    expect(markup).toContain("not signed in any more");
    expect(markup).toContain('href="/api/auth/signin?callbackUrl=%2Fupload"');
  });

  it("opens sign-in in a new tab, because the queue cannot survive leaving", async () => {
    /*
      The 401 copy promises "nothing here is lost". The queue is useReducer
      state plus two refs and nothing is persisted — and a File handle cannot
      survive a navigation at all — so a same-tab link makes that sentence
      false and destroys every queued upload on the way out.

      Asserted on the markup rather than trusted to the copy, because the
      sentence and the anchor are in different files and only one of them was
      right.
    */
    const markup = await markupForStatus(401);
    const anchor = /<a[^>]*href="\/api\/auth\/signin[^"]*"[^>]*>/.exec(markup);
    expect(anchor).not.toBe(null);
    expect(anchor?.[0]).toContain('target="_blank"');
    // window.opener would otherwise be handed to the opened page.
    expect(anchor?.[0]).toContain("noopener");
    // And the accessible name has to carry the warning too, not just the prose.
    expect(markup).toContain("opens in a new tab");
  });

  it("offers a retry on 401, since the file is still in hand", async () => {
    const markup = await markupForStatus(401);
    expect(markup).toContain("Try again");
  });

  it("blames the size on 413", async () => {
    expect(await markupForStatus(413)).toContain("too large");
  });

  it("blames the type, and says the contents may be lying, on 415", async () => {
    const markup = await markupForStatus(415);
    expect(markup).toContain("not really what the extension says");
  });

  it("blames the watermarking step, not the user, on 422", async () => {
    const markup = await markupForStatus(422);
    expect(markup).toContain("watermarked preview");
    expect(markup).toContain("Re-exporting it");
  });

  it("says reload on 400", async () => {
    expect(await markupForStatus(400)).toContain("Reload the page");
  });

  it("says the connection stalled on 408", async () => {
    const markup = await markupForStatus(408);
    expect(markup).toContain("stopped part-way");
    expect(markup).toContain("Try again");
  });

  it("says how long to wait on 503, from the Retry-After header", async () => {
    const markup = await markupForStatus(
      503,
      { error: "Too many uploads are being processed right now" },
      { "Retry-After": "12" },
    );
    expect(markup).toContain("try again in 12 seconds");
    // The distinction ugcportal-u7g paid for: busy is not broken.
    expect(markup).toContain("Nothing is wrong with this file");
    expect(markup).toContain("Try again");
  });

  it("offers no retry for a refusal that would be refused again", async () => {
    const markup = await markupForStatus(415);
    expect(markup).not.toContain("Try again");
    expect(markup).toContain("Remove");
  });

  it("blames the server on a 500", async () => {
    expect(await markupForStatus(500)).toContain("went wrong on the server");
  });

  it("does not claim success for a 2xx that is not 201", async () => {
    const markup = await markupForStatus(200, CREATED_BODY);
    expect(markup).toContain("unexpected 200");
    expect(markup).not.toContain("src=");
  });

  it("copes with a refusal whose body is not JSON", async () => {
    const run = startUpload([imageFile()]);
    run.xhr.respondWithRawBody(502, "<html>Bad Gateway</html>");
    await run.settled;

    const markup = render(run.state());
    expect(markup).toContain("went wrong on the server");
    expect(markup).not.toContain("Bad Gateway");
  });

  it("says the request never arrived when the connection fails", async () => {
    const run = startUpload([imageFile()]);
    run.xhr.failToConnect();
    await run.settled;

    expect(run.state()[0].failure?.code).toBe("network_error");
    expect(render(run.state())).toContain("could not reach the server");
  });

  it("repeats the server's own explanation below ours", async () => {
    const markup = await markupForStatus(413, {
      // Verbatim from POST /api/media's undeclared-kind 413 branch.
      error:
        "Could not find the 'file' field near the start of the request, so this upload was limited to 15728640 bytes. Put that field earlier in the form.",
    });
    expect(markup).toContain("too large");
    expect(markup).toContain("Put that field earlier");
  });
});

describe("a file the server would refuse is never sent (K2)", () => {
  it("makes no request for an unsupported type", async () => {
    const transport = vi.fn<UploadTransport>();
    const files = [
      new File(["hello"], "notes.txt", { type: "text/plain" }),
      imageFile("photo.png"),
    ];
    const { items, entries } = enqueueFiles(files, idSequence());

    expect(items[0].status).toBe("failed");
    expect(items[0].failure?.code).toBe("client_unsupported_type");
    expect(entries.map((entry) => entry.file.name)).toEqual(["photo.png"]);

    transport.mockResolvedValue({
      status: 201,
      body: CREATED_BODY,
      retryAfter: null,
    });
    const pending = [...entries];
    await drainQueue(() => pending.shift(), () => {}, transport);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].file.name).toBe("photo.png");
  });

  it("DOES send the same file once its type is one the server takes", async () => {
    /*
      The fixture mutation for the test above. Changing the production code
      proves an assertion is wired to the behaviour; it does not prove the
      assertion is wired to a case that can FAIL. So the same two files, with
      the only difference being the first one's declared type — and now both
      are sent.
    */
    const transport = vi.fn<UploadTransport>();
    const files = [
      new File(["hello"], "notes.txt", { type: "image/png" }),
      imageFile("photo.png"),
    ];
    const { items, entries } = enqueueFiles(files, idSequence());

    expect(items[0].status).toBe("pending");
    expect(entries.map((entry) => entry.file.name)).toEqual([
      "notes.txt",
      "photo.png",
    ]);

    transport.mockResolvedValue({
      status: 201,
      body: CREATED_BODY,
      retryAfter: null,
    });
    const pending = [...entries];
    await drainQueue(() => pending.shift(), () => {}, transport);

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("makes no request for a file over its kind's cap", async () => {
    const transport = vi.fn<UploadTransport>();
    const huge = new File([""], "huge.png", { type: "image/png" });
    // `File.size` is read-only, so the cap is crossed by declaring it rather
    // than by allocating 10 MB in a unit test.
    Object.defineProperty(huge, "size", { value: MAX_SIZE_BYTES.IMAGE + 1 });

    const { items, entries } = enqueueFiles([huge], idSequence());
    expect(items[0].failure?.code).toBe("client_too_large");
    expect(entries).toEqual([]);

    const pending = [...entries];
    await drainQueue(() => pending.shift(), () => {}, transport);
    expect(transport).not.toHaveBeenCalled();
  });

  it("DOES send the same file one byte under the cap", async () => {
    // The fixture mutation: only the size changes.
    const transport = vi.fn<UploadTransport>();
    const large = new File([""], "huge.png", { type: "image/png" });
    Object.defineProperty(large, "size", { value: MAX_SIZE_BYTES.IMAGE });

    const { items, entries } = enqueueFiles([large], idSequence());
    expect(items[0].status).toBe("pending");
    expect(entries).toHaveLength(1);

    transport.mockResolvedValue({
      status: 201,
      body: CREATED_BODY,
      retryAfter: null,
    });
    const pending = [...entries];
    await drainQueue(() => pending.shift(), () => {}, transport);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("a stored upload with no thumbnail says why, correctly (round 3, 3)", () => {
  it("blames video stills only when the row is actually a video", async () => {
    const run = startUpload([imageFile()]);
    run.xhr.respond(201, { ...CREATED_BODY, kind: "VIDEO", previewId: null });
    await run.settled;

    const markup = render(run.state());
    expect(markup).toContain("watermarked video stills are not generated");
  });

  it("does NOT blame video stills when the 201 body could not be read", async () => {
    /*
      The bug. The note fired on `previewSrc === null`, which is also true
      when toQueueMedia refuses an unreadable 201 body — so an IMAGE upload
      was given a confident, video-specific explanation for something else
      entirely. The kind of wrong answer nobody debugs, because it sounds
      deliberate.
    */
    const run = startUpload([imageFile()]);
    run.xhr.respondWithRawBody(201, "{truncated");
    await run.settled;

    expect(run.state()[0].status).toBe("succeeded");
    expect(run.state()[0].media).toBe(null);

    const markup = render(run.state());
    expect(markup).not.toContain("video");
    // No apostrophe in the needle: React escapes it to &#x27; in the markup,
    // so matching the prose as written compares the wrong two strings.
    expect(markup).toContain("reply could not be read");
    // Still says it was stored, because the 201 said so.
    expect(markup).toContain("Stored");
  });

  it("does not blame video stills for an image with no preview either", async () => {
    // Should not happen — the route watermarks every image or 422s — but if
    // it does, the sentence must not invent a reason.
    const run = startUpload([imageFile()]);
    run.xhr.respond(201, { ...CREATED_BODY, kind: "IMAGE", previewId: null });
    await run.settled;

    const markup = render(run.state());
    expect(markup).not.toContain("video");
    expect(markup).toContain("no thumbnail was returned for this image");
  });

  it("STILL describes the preview when there is one", async () => {
    // The fixture mutation: only previewId changes, and the ordinary sentence
    // must come back. A rewrite that always hedged would pass the three above.
    const run = startUpload([imageFile()]);
    run.xhr.respond(201, CREATED_BODY);
    await run.settled;

    const markup = render(run.state());
    expect(markup).toContain("the watermarked preview");
    expect(markup).not.toContain("could not be read");
  });
});

describe("the 503's Retry-After actually throttles the retry (round 3, 4)", () => {
  /**
   * The Try again button's own attributes.
   *
   * NOT `markup.toContain("disabled")`. Every Button in this design system
   * ships `disabled:pointer-events-none disabled:opacity-50` in its class
   * list, so that needle is present whatever the button's state — an
   * assertion that passes in both directions and proves nothing. This reads
   * the attributes of the one element in question.
   */
  function tryAgainAttributes(markup: string): string {
    const match = /<button([^>]*)>Try again[^<]*<\/button>/.exec(markup);
    if (match === null) throw new Error("no Try again button in the markup");
    return match[1];
  }

  function isDisabled(markup: string): boolean {
    return /\sdisabled(=|\s|$)/.test(tryAgainAttributes(markup));
  }

  async function shedRow(retryAfter: string) {
    const run = startUpload([imageFile()]);
    run.xhr.respond(
      503,
      { error: "Too many uploads are being processed right now" },
      { "Retry-After": retryAfter },
    );
    await run.settled;
    return run.state();
  }

  it("disables Try again for as long as the server asked", async () => {
    /*
      The page parsed, clamped and PRINTED the number, then enabled the button
      immediately — telling the user about a shed window and handing them the
      control that walks straight back into it. The header exists to spread
      load out; nothing was spreading anything.
    */
    const state = await shedRow("12");
    const failure = state[0].failure;
    expect(failure?.code).toBe("busy");
    expect(failure?.retryAfterSeconds).toBe(12);

    // Rendered the instant the response arrived.
    const markup = renderToStaticMarkup(
      <UploadQueueList
        items={state}
        now={Date.now()}
        onRetry={() => {}}
        onCancel={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(isDisabled(markup)).toBe(true);
    expect(markup).toMatch(/Try again in 1[12]s/);
  });

  it("re-enables it once the window has passed", async () => {
    // The fixture mutation: the same row, rendered at a later moment. A
    // button disabled for good would pass the test above and break the retry.
    const state = await shedRow("12");
    const past = (state[0].failure?.retryNotBefore ?? 0) + 1;

    const markup = renderToStaticMarkup(
      <UploadQueueList
        items={state}
        now={past}
        onRetry={() => {}}
        onCancel={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(isDisabled(markup)).toBe(false);
    expect(markup).toContain(">Try again<");
  });

  it("does not throttle a retryable failure the server set no window on", async () => {
    // A stall or a network failure has no Retry-After, so there is nothing to
    // wait for and the button must be live at once.
    const run = startUpload([imageFile()]);
    run.xhr.failToConnect();
    await run.settled;

    expect(run.state()[0].failure?.retryNotBefore).toBe(null);
    const markup = render(run.state());
    expect(markup).toContain(">Try again<");
    expect(isDisabled(markup)).toBe(false);
  });
});

describe("a queued file can be taken back out before it is sent", () => {
  it("offers Cancel on a row that is only waiting, not just one in flight", () => {
    /*
      The form's cancel() has always had a branch for a file still waiting its
      turn — it drops the entry before any request is made. Nothing could
      reach it: this list rendered Cancel for `uploading` alone, so a 40-file
      mis-drop could only be undone by reloading the page, which also
      discarded whatever had already uploaded.
    */
    const { items } = enqueueFiles(
      [imageFile("first.png"), imageFile("second.png")],
      idSequence(),
    );
    const waiting = uploadQueueReducer(
      uploadQueueReducer([], { type: "queued", items }),
      { type: "started", id: "q1" },
    );

    expect(waiting[1].status).toBe("pending");
    const markup = render(waiting);
    // Two rows, two Cancel controls: the one uploading and the one waiting.
    expect([...markup.matchAll(/>Cancel</g)]).toHaveLength(2);
  });

  it("offers no Cancel once a row has settled", async () => {
    // The fixture mutation: the same list, with the row settled instead of
    // waiting. A control shown on a finished row is the stale-button problem
    // the reducer guard exists to survive.
    const run = startUpload([imageFile()]);
    run.xhr.respond(201, CREATED_BODY);
    await run.settled;

    expect(render(run.state())).not.toContain(">Cancel<");
  });
});

describe("the queue is worked one file at a time", () => {
  it("does not start the second file until the first has settled", async () => {
    // Parallel uploads from one tab are the burst POST /api/media's memory
    // budget exists to shed (ugcportal-e86, ugcportal-05b).
    const inFlight: string[] = [];
    const releases: Array<() => void> = [];

    const transport: UploadTransport = ({ file }) => {
      inFlight.push(file.name);
      return new Promise((resolve) => {
        releases.push(() =>
          resolve({ status: 201, body: CREATED_BODY, retryAfter: null }),
        );
      });
    };

    const { entries } = enqueueFiles(
      [imageFile("first.png"), imageFile("second.png")],
      idSequence(),
    );
    const pending = [...entries];
    const settled = drainQueue(() => pending.shift(), () => {}, transport);

    // Both files are queued, and only the first has been handed to the
    // transport.
    expect(inFlight).toEqual(["first.png"]);
    expect(releases).toHaveLength(1);

    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight).toEqual(["first.png", "second.png"]);

    releases[1]();
    await settled;
    expect(inFlight).toEqual(["first.png", "second.png"]);
  });
});
