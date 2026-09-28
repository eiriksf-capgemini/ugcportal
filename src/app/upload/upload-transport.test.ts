import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadQueueReducer, type QueueItem } from "./upload-queue";
import {
  drainQueue,
  failureForTransportError,
  uploadItem,
} from "./upload-runner";
import {
  RESPONSE_TIMEOUT_MS,
  UPLOAD_STALL_TIMEOUT_MS,
  UploadAbortedError,
  UploadNetworkError,
  UploadStalledError,
  uploadFile,
} from "./upload-transport";

/**
 * The XMLHttpRequest wrapper's own edges: the events that are not "it worked"
 * and not "the server said no", which the flow test covers.
 */

type Listener = (event: unknown) => void;

class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
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

  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

class FakeXhr extends Emitter {
  readonly upload = new Emitter();
  status = 0;
  responseText = "";
  responseType = "";
  aborts = 0;
  readonly requestHeaders = new Map<string, string>();

  open(): void {}
  send(): void {}
  setRequestHeader(name: string, value: string): void {
    this.requestHeaders.set(name.toLowerCase(), value);
  }
  abort(): void {
    this.aborts += 1;
    this.emit("abort");
  }
  getResponseHeader(): string | null {
    return null;
  }
}

function send(xhr: FakeXhr, signal?: AbortSignal) {
  return uploadFile(
    {
      file: new File([new Uint8Array(4)], "photo.png", { type: "image/png" }),
      signal,
    },
    () => xhr as unknown as XMLHttpRequest,
  );
}

describe("uploadFile", () => {
  it("sets no Content-Type, so the multipart boundary survives", async () => {
    // Setting it by hand drops the boundary FormData generated, and the
    // route's multipartBoundary() then has nothing to split the body on.
    const xhr = new FakeXhr();
    const promise = send(xhr);
    expect(xhr.requestHeaders.has("content-type")).toBe(false);

    xhr.status = 201;
    xhr.responseText = "{}";
    xhr.emit("load");
    await promise;
  });

  it("reports an indeterminate total when the browser cannot compute one", async () => {
    const xhr = new FakeXhr();
    const onProgress = vi.fn();
    const promise = uploadFile(
      {
        file: new File(["x"], "photo.png", { type: "image/png" }),
        onProgress,
      },
      () => xhr as unknown as XMLHttpRequest,
    );

    xhr.upload.emit("progress", {
      loaded: 10,
      total: 0,
      lengthComputable: false,
    });
    // Reading `total` regardless of `lengthComputable` is how a bar ends up
    // dividing by zero.
    expect(onProgress).toHaveBeenCalledWith({
      loadedBytes: 10,
      totalBytes: null,
    });

    xhr.status = 201;
    xhr.responseText = "{}";
    xhr.emit("load");
    await promise;
  });

  it("treats a load with no status as a network failure, not a response", async () => {
    const xhr = new FakeXhr();
    const promise = send(xhr);
    xhr.status = 0;
    xhr.emit("load");
    await expect(promise).rejects.toBeInstanceOf(UploadNetworkError);
  });

  it("rejects on error and on timeout", async () => {
    const failed = new FakeXhr();
    const onError = send(failed);
    failed.emit("error");
    await expect(onError).rejects.toBeInstanceOf(UploadNetworkError);

    const timedOut = new FakeXhr();
    const onTimeout = send(timedOut);
    timedOut.emit("timeout");
    await expect(onTimeout).rejects.toBeInstanceOf(UploadNetworkError);
  });

  it("aborts the request when its signal fires", async () => {
    const xhr = new FakeXhr();
    const controller = new AbortController();
    const promise = send(xhr, controller.signal);

    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(UploadAbortedError);
    expect(xhr.aborts).toBe(1);
  });

  it("refuses before opening anything if the signal is already aborted", async () => {
    const xhr = new FakeXhr();
    const controller = new AbortController();
    controller.abort();

    await expect(send(xhr, controller.signal)).rejects.toBeInstanceOf(
      UploadAbortedError,
    );
    expect(xhr.aborts).toBe(0);
  });

  it("settles once, so a late event cannot overwrite the outcome", async () => {
    const xhr = new FakeXhr();
    const promise = send(xhr);

    xhr.status = 201;
    xhr.responseText = JSON.stringify({ id: "media-1" });
    xhr.emit("load");
    // A browser may fire `error` after `loadend` in some teardown paths; the
    // promise is already resolved and must stay that way.
    xhr.emit("error");

    await expect(promise).resolves.toMatchObject({ status: 201 });
  });

  it("stops listening to its signal once it has settled", async () => {
    // Otherwise a long-lived controller accumulates one listener per upload.
    const xhr = new FakeXhr();
    const controller = new AbortController();
    const promise = send(xhr, controller.signal);

    xhr.status = 201;
    xhr.responseText = "{}";
    xhr.emit("load");
    await promise;

    controller.abort();
    expect(xhr.aborts).toBe(0);
  });
});

describe("a connection that goes quiet is given up on (round 2, finding 1)", () => {
  /*
    `xhr.timeout` defaults to 0 — no timeout — so before the watchdog, a
    half-open connection (wifi dropped, laptop slept, NAT entry expired)
    produced no `load`, no `error` and no `timeout`: the promise simply never
    settled.

    These tests assert the REQUEST IS BOUNDED, not that a listener is
    registered. The listener was registered before, and was dead code.
  */
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects once nothing has happened for the stall timeout", async () => {
    const xhr = new FakeXhr();
    /*
      The expectation is attached BEFORE the clock is advanced, because the
      rejection happens inside advanceTimersByTimeAsync. Attaching it
      afterwards leaves the promise rejected with no handler across an await
      boundary, which Node reports as an unhandled rejection even though the
      test then passes.
    */
    const rejects = expect(send(xhr)).rejects.toBeInstanceOf(UploadStalledError);

    // Not yet: a slow connection is not a dead one.
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS - 1);
    expect(xhr.aborts).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await rejects;
    // Torn down, not just abandoned behind a rejected promise.
    expect(xhr.aborts).toBe(1);
  });

  it("KEEPS WAITING while bytes are still going out", async () => {
    /*
      The fixture mutation for the test above, and the one that matters: the
      only difference is that this connection is alive. A watchdog that fired
      regardless would pass the previous test and break every upload slower
      than 30 seconds — which is most 200 MB videos.
    */
    const xhr = new FakeXhr();
    const promise = send(xhr);

    // Five times the stall timeout, with a trickle of progress throughout.
    for (let elapsed = 0; elapsed < 5; elapsed += 1) {
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS - 1000);
      xhr.upload.emit("progress", {
        loaded: elapsed,
        total: 100,
        lengthComputable: true,
      });
    }
    expect(xhr.aborts).toBe(0);

    xhr.status = 201;
    xhr.responseText = "{}";
    xhr.emit("load");
    await expect(promise).resolves.toMatchObject({ status: 201 });
  });

  it("allows the server longer to answer once the body is sent", async () => {
    // Progress events stop when the last byte goes out, and the watermark
    // gate may queue the image behind others. That quiet is expected, so it
    // must not trip the sending timeout.
    const xhr = new FakeXhr();
    const promise = send(xhr);
    xhr.upload.emit("load");

    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS * 2);
    expect(xhr.aborts).toBe(0);

    xhr.status = 201;
    xhr.responseText = "{}";
    xhr.emit("load");
    await expect(promise).resolves.toMatchObject({ status: 201 });
  });

  it("gives up if the server never answers at all", async () => {
    const xhr = new FakeXhr();
    const rejects = expect(send(xhr)).rejects.toBeInstanceOf(UploadStalledError);
    xhr.upload.emit("load");

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    await rejects;
  });

  it("stops the watchdog once the request has settled", async () => {
    // Or a finished request would abort itself half a minute later.
    const xhr = new FakeXhr();
    const promise = send(xhr);
    xhr.status = 201;
    xhr.responseText = "{}";
    xhr.emit("load");
    await promise;

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS * 2);
    expect(xhr.aborts).toBe(0);
  });

  it("does not park the rest of the queue behind the dead request", async () => {
    /*
      THE REASON THIS IS A MEDIUM AND NOT A COSMETIC ISSUE. drainQueue is
      sequential by design, so it awaits each upload before taking the next.
      A promise that never settles therefore stops not just its own file but
      every file behind it — all of them sitting at "Waiting" forever, with no
      error anywhere on the page.
    */
    const dead = new FakeXhr();
    const live = new FakeXhr();
    const requests = [dead, live];

    const seen: string[] = [];
    let state: QueueItem[] = [];
    const dispatch = (action: Parameters<typeof uploadQueueReducer>[1]) => {
      state = uploadQueueReducer(state, action);
    };

    const entries = [
      { id: "q1", file: new File(["a"], "first.png", { type: "image/png" }) },
      { id: "q2", file: new File(["b"], "second.png", { type: "image/png" }) },
    ];
    state = entries.map((entry) => ({
      id: entry.id,
      name: entry.file.name,
      sizeBytes: 1,
      mimeType: "image/png",
      status: "pending" as const,
      loadedBytes: 0,
      failure: null,
      media: null,
    }));

    const pending = [...entries];
    const settled = drainQueue(
      () => pending.shift(),
      dispatch,
      (request) => {
        seen.push(request.file.name);
        const xhr = requests.shift();
        return uploadFile(request, () => xhr as unknown as XMLHttpRequest);
      },
    );

    expect(seen).toEqual(["first.png"]);

    // The first connection dies silently — no load, no error, ever.
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS);

    // The queue moved on.
    expect(seen).toEqual(["first.png", "second.png"]);
    expect(state[0].status).toBe("failed");
    expect(state[0].failure?.code).toBe("connection_stalled");
    // And it is honest about being worth another go.
    expect(state[0].failure?.retryable).toBe(true);
    expect(state[0].failure?.message).toContain("stopped sending");

    live.status = 201;
    live.responseText = JSON.stringify({ id: "m2", kind: "IMAGE" });
    live.emit("load");
    await settled;
    expect(state[1].status).toBe("succeeded");
  });

  it("tells a stall apart from a cancellation, though both are aborts", async () => {
    /*
      xhr.abort() is the only way to stop a request, so the watchdog and the
      Cancel button arrive through the same event. Without the distinction, a
      connection that died on its own would be reported as "You cancelled this
      upload" — wrong, and unactionable.
    */
    const stalled = new FakeXhr();
    const stalledRejects = expect(send(stalled)).rejects.toBeInstanceOf(
      UploadStalledError,
    );
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS);
    await stalledRejects;

    const cancelled = new FakeXhr();
    const controller = new AbortController();
    const cancelledPromise = send(cancelled, controller.signal);
    controller.abort();
    await expect(cancelledPromise).rejects.toBeInstanceOf(UploadAbortedError);

    expect(failureForTransportError(new UploadStalledError(30_000)).code).toBe(
      "connection_stalled",
    );
    expect(failureForTransportError(new UploadAbortedError()).code).toBe(
      "cancelled",
    );
    expect(failureForTransportError(new UploadNetworkError()).code).toBe(
      "network_error",
    );
  });
});

describe("a cancelled upload is reported as cancelled, not as an error", () => {
  it("turns the abort into the cancelled failure", async () => {
    let state: QueueItem[] = [
      {
        id: "q1",
        name: "photo.png",
        sizeBytes: 4,
        mimeType: "image/png",
        status: "pending",
        loadedBytes: 0,
        failure: null,
        media: null,
      },
    ];
    const dispatch = (action: Parameters<typeof uploadQueueReducer>[1]) => {
      state = uploadQueueReducer(state, action);
    };

    const xhr = new FakeXhr();
    const controller = new AbortController();
    const settled = uploadItem(
      "q1",
      new File([new Uint8Array(4)], "photo.png", { type: "image/png" }),
      dispatch,
      (request) => uploadFile(request, () => xhr as unknown as XMLHttpRequest),
      controller.signal,
    );

    controller.abort();
    await settled;

    expect(state[0].status).toBe("failed");
    // Not network_error: the user did this on purpose, and the sentence they
    // get should say so.
    expect(state[0].failure?.code).toBe("cancelled");
    expect(state[0].failure?.retryable).toBe(true);
  });
});
