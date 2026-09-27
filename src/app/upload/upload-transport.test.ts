import { describe, expect, it, vi } from "vitest";

import { uploadQueueReducer, type QueueItem } from "./upload-queue";
import { uploadItem } from "./upload-runner";
import {
  UploadAbortedError,
  UploadNetworkError,
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
