import { describe, expect, it } from "vitest";

import { MAX_SIZE_BYTES } from "@/lib/media";

import { cancelledFailure, networkFailure, precheckFile } from "./outcomes";
import {
  makeQueueItem,
  percentComplete,
  pendingItems,
  queueSummary,
  releasedFileId,
  settledChange,
  toQueueMedia,
  uploadQueueReducer,
  type QueueItem,
} from "./upload-queue";

const PNG = { name: "photo.png", type: "image/png", size: 2048 };

function queued(file = PNG, id = "f1"): QueueItem {
  return makeQueueItem(id, file);
}

describe("a file is judged as it is queued", () => {
  it("queues an acceptable file as pending, with nothing to say yet", () => {
    const item = queued();
    expect(item.status).toBe("pending");
    expect(item.failure).toBe(null);
    expect(item.media).toBe(null);
  });

  it("queues a file the server would refuse as already failed", () => {
    const item = queued({ name: "notes.txt", type: "text/plain", size: 10 });
    expect(item.status).toBe("failed");
    expect(item.failure?.code).toBe("client_unsupported_type");
  });

  it("keeps the file's own name and size on the row", () => {
    const item = queued({ name: "a b.png", type: "image/png", size: 7 });
    expect(item.name).toBe("a b.png");
    expect(item.sizeBytes).toBe(7);
    expect(item.mimeType).toBe("image/png");
  });

  it("offers only the acceptable ones for upload", () => {
    const items = [
      queued(PNG, "f1"),
      queued({ name: "notes.txt", type: "text/plain", size: 10 }, "f2"),
      queued({ name: "huge.png", type: "image/png", size: MAX_SIZE_BYTES.IMAGE + 1 }, "f3"),
    ];
    expect(pendingItems(items).map((item) => item.id)).toEqual(["f1"]);
  });
});

describe("the queue reducer", () => {
  it("appends rather than replaces, so a second drop keeps the first", () => {
    const first = uploadQueueReducer([], {
      type: "queued",
      items: [queued(PNG, "f1")],
    });
    const second = uploadQueueReducer(first, {
      type: "queued",
      items: [queued(PNG, "f2")],
    });
    expect(second.map((item) => item.id)).toEqual(["f1", "f2"]);
  });

  it("clears a stale failure when a retried row starts", () => {
    let state = [queued()];
    state = uploadQueueReducer(state, {
      type: "failed",
      id: "f1",
      failure: networkFailure(),
    });
    state = uploadQueueReducer(state, { type: "retried", id: "f1" });
    state = uploadQueueReducer(state, { type: "started", id: "f1" });
    expect(state[0].status).toBe("uploading");
    expect(state[0].failure).toBe(null);
  });

  it("will not start a row that is not waiting", () => {
    // The route back into the queue is "retried", which is where the decision
    // about whether a failure is worth retrying lives. A bare "started" must
    // not go round it.
    let state = [queued()];
    state = uploadQueueReducer(state, {
      type: "failed",
      id: "f1",
      failure: networkFailure(),
    });
    state = uploadQueueReducer(state, { type: "started", id: "f1" });
    expect(state[0].status).toBe("failed");
  });

  it("ignores progress for a row that has already settled", () => {
    // A late event from a request that has finished would drag a completed
    // row back to a partial bar.
    let state = [queued()];
    state = uploadQueueReducer(state, { type: "started", id: "f1" });
    state = uploadQueueReducer(state, {
      type: "succeeded",
      id: "f1",
      media: null,
    });
    state = uploadQueueReducer(state, {
      type: "progress",
      id: "f1",
      loadedBytes: 1,
    });
    expect(state[0].loadedBytes).toBe(PNG.size);
    expect(state[0].status).toBe("succeeded");
  });

  it("will not relabel a stored upload as a failure", () => {
    /*
      The regression test for the live defect. The drain loop settles file A
      and advances to file B before React commits either, so A's Cancel button
      is still painted; clicking it reaches cancel() naming a row that has
      already succeeded. Before the guard, that turned a file the server had
      STORED into "You cancelled this upload, so nothing was kept", and nulled
      its preview on the way past.
    */
    const stored = {
      id: "m1",
      kind: "IMAGE" as const,
      previewId: "p1",
      originalName: "a",
    };
    let state = uploadQueueReducer([queued()], {
      type: "succeeded",
      id: "f1",
      media: stored,
    });
    state = uploadQueueReducer(state, {
      type: "failed",
      id: "f1",
      failure: cancelledFailure(),
    });

    expect(state[0].status).toBe("succeeded");
    expect(state[0].media).toBe(stored);
    expect(state[0].failure).toBe(null);
  });

  it("will not turn a settled failure into a success either", () => {
    // The mirror of the above, and the same one-line guard. A late 201 from a
    // request whose row was already cancelled must not resurrect it.
    let state = uploadQueueReducer([queued()], {
      type: "failed",
      id: "f1",
      failure: cancelledFailure(),
    });
    state = uploadQueueReducer(state, {
      type: "succeeded",
      id: "f1",
      media: { id: "m1", kind: "IMAGE", previewId: "p1", originalName: "a" },
    });

    expect(state[0].status).toBe("failed");
    expect(state[0].media).toBe(null);
  });

  it("STILL settles a row that has not settled yet", () => {
    /*
      The fixture mutation for the two tests above: the only change is the
      row's starting status. A guard that refused everything would pass both
      of them and break the feature, so the same transitions have to be shown
      working from an unsettled row.
    */
    const uploading = uploadQueueReducer([queued()], {
      type: "started",
      id: "f1",
    });

    const succeeded = uploadQueueReducer(uploading, {
      type: "succeeded",
      id: "f1",
      media: { id: "m1", kind: "IMAGE", previewId: "p1", originalName: "a" },
    });
    expect(succeeded[0].status).toBe("succeeded");

    const failed = uploadQueueReducer(uploading, {
      type: "failed",
      id: "f1",
      failure: networkFailure(),
    });
    expect(failed[0].status).toBe("failed");
    // And a row still waiting its turn may be cancelled out of the queue.
    const cancelled = uploadQueueReducer([queued()], {
      type: "failed",
      id: "f1",
      failure: cancelledFailure(),
    });
    expect(cancelled[0].status).toBe("failed");
  });

  it("only re-queues a failure that said it was worth retrying", () => {
    const refused = makeQueueItem("f1", {
      name: "notes.txt",
      type: "text/plain",
      size: 10,
    });
    const after = uploadQueueReducer([refused], { type: "retried", id: "f1" });
    // client_unsupported_type is retryable: false — re-sending it would be
    // refused identically.
    expect(after[0].status).toBe("failed");

    let retryable = uploadQueueReducer([queued()], {
      type: "failed",
      id: "f1",
      failure: networkFailure(),
    });
    retryable = uploadQueueReducer(retryable, { type: "retried", id: "f1" });
    expect(retryable[0].status).toBe("pending");
    expect(retryable[0].loadedBytes).toBe(0);
  });

  it("touches only the row it names", () => {
    const state = uploadQueueReducer(
      [queued(PNG, "f1"), queued(PNG, "f2")],
      { type: "started", id: "f2" },
    );
    expect(state[0].status).toBe("pending");
    expect(state[1].status).toBe("uploading");
  });

  it("removes a dismissed row", () => {
    const state = uploadQueueReducer([queued(PNG, "f1"), queued(PNG, "f2")], {
      type: "dismissed",
      id: "f1",
    });
    expect(state.map((item) => item.id)).toEqual(["f2"]);
  });
});

describe("releasedFileId", () => {
  /*
    The File handles live in a ref beside the reducer, and `retry` is the only
    reader. They used to be pruned on dismissal alone, so a succeeded row and
    a non-retryable failure each kept their file — and its backing blob, up to
    200 MB for a video — for the tab's lifetime, unreachable and unbounded.
  */
  it("lets go once a row has succeeded", () => {
    expect(releasedFileId({ type: "succeeded", id: "f1", media: null })).toBe(
      "f1",
    );
  });

  it("lets go of a failure that is not worth retrying", () => {
    const refused = precheckFile({ type: "text/plain", size: 10 });
    expect(refused?.retryable).toBe(false);
    expect(
      releasedFileId({
        type: "failed",
        id: "f1",
        failure: refused ?? networkFailure(),
      }),
    ).toBe("f1");
  });

  it("KEEPS the file for a failure the user can retry", () => {
    /*
      The fixture mutation, and the case that matters: the only difference
      from the test above is which failure the action carries. Releasing here
      would make Try again silently do nothing — the button would render,
      because the failure says retryable, and the file it needs would be gone.
    */
    expect(networkFailure().retryable).toBe(true);
    expect(
      releasedFileId({ type: "failed", id: "f1", failure: networkFailure() }),
    ).toBe(null);
    // A cancelled upload is retryable too, and keeps its file for the same
    // reason.
    expect(
      releasedFileId({ type: "failed", id: "f1", failure: cancelledFailure() }),
    ).toBe(null);
  });

  it("keeps the file through every transition that is not an outcome", () => {
    expect(releasedFileId({ type: "started", id: "f1" })).toBe(null);
    expect(
      releasedFileId({ type: "progress", id: "f1", loadedBytes: 1 }),
    ).toBe(null);
    expect(releasedFileId({ type: "retried", id: "f1" })).toBe(null);
    // `queued` carries no id at all — the reason this returns an id rather
    // than a boolean.
    expect(releasedFileId({ type: "queued", items: [] })).toBe(null);
  });
});

describe("settledChange", () => {
  /*
    The form keeps a set of finished ids built from these, because a guard
    written as `items.find(...)` inside an event handler re-reads the same
    render snapshot the stale button came from — so in the exact race it
    exists to catch, it agrees with the stale button and waves it through.
  */
  it("records a row as settled when it succeeds or fails", () => {
    expect(settledChange({ type: "succeeded", id: "f1", media: null })).toEqual(
      { settled: ["f1"], unsettled: [] },
    );
    expect(
      settledChange({ type: "failed", id: "f1", failure: networkFailure() }),
    ).toEqual({ settled: ["f1"], unsettled: [] });
  });

  it("puts a row back in play when it is retried or dismissed", () => {
    // Retry needs this, or a second click on Try again would find the row
    // still settled and queue the same file twice.
    expect(settledChange({ type: "retried", id: "f1" })).toEqual({
      settled: [],
      unsettled: ["f1"],
    });
    expect(settledChange({ type: "dismissed", id: "f1" })).toEqual({
      settled: [],
      unsettled: ["f1"],
    });
  });

  it("records a pre-check refusal, which never gets a 'failed' action", () => {
    /*
      The case that would otherwise be missed entirely: makeQueueItem bakes
      the refusal into the row at enqueue time, so the id never appears as the
      subject of a `failed` action and would look unsettled for the session.
    */
    const refused = makeQueueItem("f1", {
      name: "notes.txt",
      type: "text/plain",
      size: 10,
    });
    const accepted = makeQueueItem("f2", PNG);

    expect(
      settledChange({ type: "queued", items: [refused, accepted] }),
    ).toEqual({ settled: ["f1"], unsettled: [] });
  });

  it("leaves a row alone while it is still in flight", () => {
    expect(settledChange({ type: "started", id: "f1" })).toEqual({
      settled: [],
      unsettled: [],
    });
    expect(
      settledChange({ type: "progress", id: "f1", loadedBytes: 1 }),
    ).toEqual({ settled: [], unsettled: [] });
  });
});

describe("percentComplete", () => {
  function uploading(loadedBytes: number, sizeBytes: number): QueueItem {
    return {
      ...queued({ name: "x.png", type: "image/png", size: sizeBytes }),
      status: "uploading",
      loadedBytes,
    };
  }

  it("reports the fraction sent", () => {
    expect(percentComplete(uploading(512, 2048))).toBe(25);
  });

  it("is 0 before it starts and 100 once it is done", () => {
    expect(percentComplete(queued())).toBe(0);
    expect(
      percentComplete({ ...queued(), status: "succeeded", loadedBytes: 0 }),
    ).toBe(100);
  });

  it("clamps rather than exceeding 100", () => {
    // A browser that reports more sent than the file holds (chunked encoding
    // overhead has done it) must not produce a bar wider than its track.
    expect(percentComplete(uploading(4096, 2048))).toBe(100);
    expect(percentComplete(uploading(-1, 2048))).toBe(0);
  });

  it("is indeterminate, not zero, when the size is unusable", () => {
    // `!(size > 0)` rather than `size !== 0`, so NaN lands here too — a NaN
    // width is an invisible bar with no indication anything is wrong.
    expect(percentComplete(uploading(10, 0))).toBe(null);
    expect(percentComplete(uploading(10, Number.NaN))).toBe(null);
    expect(percentComplete(uploading(Number.NaN, 2048))).toBe(null);
  });
});

describe("queueSummary", () => {
  it("counts from the rows themselves", () => {
    let state = uploadQueueReducer([], {
      type: "queued",
      items: [queued(PNG, "f1"), queued(PNG, "f2"), queued(PNG, "f3")],
    });
    state = uploadQueueReducer(state, {
      type: "succeeded",
      id: "f1",
      media: null,
    });
    state = uploadQueueReducer(state, {
      type: "failed",
      id: "f2",
      failure: networkFailure(),
    });

    const summary = queueSummary(state);
    expect(summary).toMatchObject({
      total: 3,
      pending: 1,
      uploading: 0,
      succeeded: 1,
      failed: 1,
    });
    // "waiting", not "uploading": nothing is in flight in this state.
    expect(summary.message).toBe("1 waiting, 1 uploaded, 1 failed.");
  });

  it("never announces more uploads in flight than there can be", () => {
    /*
      The queue is strictly sequential, so at most one file is ever uploading.
      This used to add pending to uploading and announce "5 uploading" into a
      live region while four of the five rows on screen said "Waiting".
    */
    let state = uploadQueueReducer([], {
      type: "queued",
      items: [
        queued(PNG, "f1"),
        queued(PNG, "f2"),
        queued(PNG, "f3"),
        queued(PNG, "f4"),
        queued(PNG, "f5"),
      ],
    });
    state = uploadQueueReducer(state, { type: "started", id: "f1" });

    const summary = queueSummary(state);
    expect(summary.uploading).toBe(1);
    expect(summary.message).toBe("1 uploading, 4 waiting.");
  });

  it("says nothing is queued when nothing is", () => {
    expect(queueSummary([]).message).toBe("Nothing queued yet.");
  });
});

describe("toQueueMedia keeps the original out of the page (K3)", () => {
  /**
   * A HOSTILE FIXTURE: the full database row, not the projection
   * MEDIA_OWNER_SELECT actually returns. If the API ever widens — or if this
   * module starts spreading the response instead of naming its fields — the
   * paid original's storage key arrives in page state, and from there in the
   * markup.
   */
  const FULL_ROW = {
    id: "media-1",
    kind: "IMAGE",
    previewId: "preview-1",
    originalName: "photo.png",
    // None of the following may survive.
    key: "media/user-1/11111111-2222-3333-4444-555555555555-photo.png",
    previewKey: "previews/user-1/66666666-7777-8888-9999-000000000000.webp",
    userId: "user-1",
    sizeBytes: 2048,
    mimeType: "image/png",
    publishedAt: null,
  };

  it("keeps the four fields the success row renders", () => {
    expect(toQueueMedia(FULL_ROW)).toEqual({
      id: "media-1",
      kind: "IMAGE",
      previewId: "preview-1",
      originalName: "photo.png",
    });
  });

  it("carries neither the original's key nor the preview's storage path", () => {
    const media = toQueueMedia(FULL_ROW);
    expect(Object.keys(media ?? {}).sort()).toEqual([
      "id",
      "kind",
      "originalName",
      "previewId",
    ]);
    expect(JSON.stringify(media)).not.toContain("media/user-1");
    expect(JSON.stringify(media)).not.toContain("previews/");
    expect(JSON.stringify(media)).not.toContain("user-1");
  });

  it("treats a missing preview as no preview, never as a fallback", () => {
    // Every VIDEO today: ugcportal-pmb owns the watermarked poster frame.
    expect(toQueueMedia({ ...FULL_ROW, kind: "VIDEO", previewId: null })).toEqual(
      {
        id: "media-1",
        kind: "VIDEO",
        previewId: null,
        originalName: "photo.png",
      },
    );
    expect(toQueueMedia({ ...FULL_ROW, previewId: "" })?.previewId).toBe(null);
  });

  it("refuses a body it cannot read rather than half-building a row", () => {
    expect(toQueueMedia(null)).toBe(null);
    expect(toQueueMedia("created")).toBe(null);
    expect(toQueueMedia({})).toBe(null);
    expect(toQueueMedia({ ...FULL_ROW, id: 7 })).toBe(null);
    expect(toQueueMedia({ ...FULL_ROW, kind: "AUDIO" })).toBe(null);
  });

  it("falls back to a label rather than rendering a blank name", () => {
    expect(toQueueMedia({ ...FULL_ROW, originalName: null })?.originalName).toBe(
      "Untitled",
    );
  });
});
