import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  BODY_STALL_TIMEOUT_MS,
  PART_HEADER_PEEK_BYTES,
  multipartBoundary,
  peekDeclaredPartType,
  readCappedFormDataFrom,
  readJsonBody,
} from "@/lib/request-body";

const BOUNDARY = "----ugcportalpeektest";

/** A stream that hands out exactly these chunks, so chunk splits are testable. */
function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++];
      controller.enqueue(
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      );
    },
  });
}

function partHeader({
  name = "file",
  filename = "photo.png" as string | null,
  contentType = "image/png" as string | null,
} = {}) {
  return (
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="${name}"` +
    (filename === null ? "" : `; filename="${filename}"`) +
    `\r\n` +
    (contentType === null ? "" : `Content-Type: ${contentType}\r\n`) +
    `\r\n`
  );
}

/** A complete text field, headers and value, as it appears on the wire. */
function textField(name: string, value: string) {
  return partHeader({ name, filename: null, contentType: null }) + value + "\r\n";
}

/**
 * Sends these pieces, then holds the connection open without another byte.
 *
 * Shared by the peek's tests and the read's: a stall before any reservation
 * exists and a stall in the middle of the body are the same client behaviour
 * seen at two points on the path (ugcportal-dvb), and writing it twice is how
 * one of them ends up subtly easier to survive than the other.
 */
function silentAfter(
  pieces: string[],
  cancel?: (reason: unknown) => void | Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= pieces.length) {
        // The shape that matters: a pull that never settles, which is what a
        // client holding a connection open without sending looks like.
        return new Promise<void>(() => {});
      }
      controller.enqueue(encoder.encode(pieces[index++]));
    },
    cancel,
  });
}

/**
 * What a real request body's `cancel()` does while the client is still there.
 *
 * Measured on `next dev` (ugcportal-dvb): cancelling the body of a live
 * request returns a promise that does not settle until the client actually
 * disconnects, which is the one thing a stalled client is not doing. A test
 * stream's cancel resolves immediately, so this shape is the difference
 * between the guard working in a test and working on a socket.
 */
const cancelThatNeverSettles = () => new Promise<void>(() => {});

/** A body that delivers one piece every `gapMs`, and ends. */
function trickle(pieces: string[], gapMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= pieces.length) {
        controller.close();
        return;
      }
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.enqueue(encoder.encode(pieces[index++]));
          resolve();
        }, gapMs);
      });
    },
  });
}

/** The headers the upload route reads a multipart body under. */
const multipartRequest = {
  url: "http://localhost/api/media",
  method: "POST",
  headers: new Headers({
    "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
  }),
};

async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

const peek = (
  chunks: Array<string | Uint8Array>,
  options: { boundary?: string | null; maxHeaderBytes?: number } = {},
) =>
  peekDeclaredPartType(streamOf(chunks), {
    fieldName: "file",
    boundary: options.boundary === undefined ? BOUNDARY : options.boundary,
    maxHeaderBytes: options.maxHeaderBytes,
  });

describe("multipartBoundary", () => {
  it("reads a bare boundary parameter", () => {
    expect(
      multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`),
    ).toBe(BOUNDARY);
  });

  it("reads a quoted boundary parameter", () => {
    expect(multipartBoundary('multipart/form-data; boundary="a b c"')).toBe(
      "a b c",
    );
  });

  it.each([
    ["no header at all", null],
    ["no boundary parameter", "multipart/form-data"],
    ["an empty boundary", "multipart/form-data; boundary="],
    ["an empty quoted boundary", 'multipart/form-data; boundary=""'],
  ])("returns null for %s", (_label, header) => {
    expect(multipartBoundary(header)).toBeNull();
  });
});

describe("peekDeclaredPartType", () => {
  it("reads the declared media type without consuming the body", async () => {
    const whole = partHeader() + "PAYLOAD" + `\r\n--${BOUNDARY}--\r\n`;
    const peeked = await peek([whole]);

    expect(peeked.declaredContentType).toBe("image/png");
    // The replayed stream is the *whole* body, head included. A parser handed
    // a body missing its first chunk would fail in a way that looked like a
    // malformed upload rather than like this function.
    await expect(drain(peeked.body)).resolves.toBe(whole);
  });

  // Round-1 finding 1. Reading only the first part meant an ordinary form —
  // a caption input rendered above the file input — fell through to the
  // whole-request cap, and on a chunked request reserved ~430 MB for a
  // 100 KB photo. Every part in range is searched now.
  it("finds the file part behind other fields", async () => {
    const whole =
      textField("caption", "a day at the beach") +
      textField("tags", "summer,sea") +
      partHeader() +
      "PAYLOAD";
    const peeked = await peek([whole]);

    expect(peeked.declaredContentType).toBe("image/png");
    await expect(drain(peeked.body)).resolves.toBe(whole);
  });

  it("finds it even when every part lands in its own chunk", async () => {
    const chunks = [
      textField("caption", "hello"),
      textField("tags", "a,b"),
      partHeader({ contentType: "video/mp4", filename: "clip.mp4" }),
      "PAYLOAD",
    ];
    const peeked = await peek(chunks);

    expect(peeked.declaredContentType).toBe("video/mp4");
    await expect(drain(peeked.body)).resolves.toBe(chunks.join(""));
  });

  it("finds a header block split across chunk boundaries", async () => {
    // The terminator is four bytes and a chunk boundary can land inside it,
    // which is why the search runs over the accumulated text rather than over
    // each chunk. Split here between the two CRLFs.
    const header = partHeader();
    const peeked = await peek([
      header.slice(0, header.length - 2),
      header.slice(header.length - 2),
      "PAYLOAD",
    ]);

    expect(peeked.declaredContentType).toBe("image/png");
    await expect(drain(peeked.body)).resolves.toBe(header + "PAYLOAD");
  });

  it("lower-cases the declared type", async () => {
    const peeked = await peek([partHeader({ contentType: "IMAGE/PNG" })]);

    expect(peeked.declaredContentType).toBe("image/png");
  });

  // Anchoring on the delimiter is what makes this safe: only the bytes
  // immediately after a delimiter, up to the first blank line, are read as
  // headers. Without it, a caption whose *value* looked like a part header
  // would choose this request's cap.
  it("does not read a part's body as if it were headers", async () => {
    const forged =
      `Content-Disposition: form-data; name="file"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`;
    const whole =
      textField("caption", forged) + partHeader({ contentType: "image/png" });
    const peeked = await peek([whole]);

    expect(peeked.declaredContentType).toBe("image/png");
  });

  it("reports an empty string when the file part declares no type", async () => {
    // Found, but silent. RFC 7578 makes that text/plain, which no kind
    // accepts — a certain 415 — so the caller prices it as the smallest
    // possible read rather than as "unknown".
    const peeked = await peek([
      textField("caption", "hi"),
      partHeader({ contentType: null }),
      "PAYLOAD",
    ]);

    expect(peeked.declaredContentType).toBe("");
  });

  it.each([
    ["the body is not multipart at all", '{"json":true}\r\n\r\nmore'],
    ["the file field never appears", textField("caption", "just a caption")],
  ])("reports nothing when %s", async (_label, head) => {
    const peeked = await peek([head, "PAYLOAD"]);

    // Null, not a guess: the caller falls back to a cap that does not depend
    // on a declaration it could not read.
    expect(peeked.declaredContentType).toBeNull();
    await expect(drain(peeked.body)).resolves.toBe(head + "PAYLOAD");
  });

  it("reports nothing, and reads nothing, without a boundary", async () => {
    const peeked = await peek([partHeader(), "PAYLOAD"], { boundary: null });

    expect(peeked.declaredContentType).toBeNull();
    // Nothing is consumed: the whole body still comes back out, in order, so
    // a request whose Content-Type has no boundary is parsed exactly as it
    // was before the peek existed. What comes back is the stall-guard wrapper
    // rather than the identical object (ugcportal-dvb), which is why this
    // asserts on the bytes and not on the stream — the guard on this branch
    // is pinned by "guards the body it hands back even with no boundary"
    // below.
    await expect(drain(peeked.body)).resolves.toBe(partHeader() + "PAYLOAD");
  });

  it("gives up after the peek budget rather than buffering the body", async () => {
    // A client that buries the file part behind kilobytes of other fields
    // must not be able to make this accumulate its whole upload looking.
    const filler = "x".repeat(4096);
    const chunks = Array.from({ length: 64 }, () => filler);
    const peeked = await peek(chunks, { maxHeaderBytes: 8192 });

    expect(peeked.declaredContentType).toBeNull();
    // Everything read while looking is still replayed, so nothing is lost.
    await expect(drain(peeked.body)).resolves.toHaveLength(64 * 4096);
  });

  it("replays a body shorter than the peek budget", async () => {
    const peeked = await peek(["tiny"]);

    expect(peeked.declaredContentType).toBeNull();
    await expect(drain(peeked.body)).resolves.toBe("tiny");
  });

  it("does not corrupt a non-ASCII filename on its way through", async () => {
    // The header search decodes latin1 so a multi-byte sequence straddling a
    // chunk boundary cannot shift the terminator index. That decoding must
    // never reach the replayed bytes, which are passed through untouched.
    const header = partHeader({ filename: "sølvfjell-😀.png" });
    const encoded = new TextEncoder().encode(header + "PAYLOAD");
    const peeked = await peek([encoded.slice(0, 40), encoded.slice(40)]);

    expect(peeked.declaredContentType).toBe("image/png");
    await expect(drain(peeked.body)).resolves.toBe(header + "PAYLOAD");
  });

  it("surfaces a broken stream as a truncated body, not as a throw", async () => {
    // A reset connection is the parser's to report on the replayed stream,
    // where it becomes a 400, rather than an exception escaping admission.
    let pulls = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("--boundary\r\n"));
          return;
        }
        controller.error(new Error("connection reset"));
      },
    });

    const peeked = await peekDeclaredPartType(failing, {
      fieldName: "file",
      boundary: BOUNDARY,
    });

    expect(peeked.declaredContentType).toBeNull();
    await expect(drain(peeked.body)).resolves.toBe("--boundary\r\n");
  });

  it("defaults to a peek budget far below any upload cap", () => {
    expect(PART_HEADER_PEEK_BYTES).toBe(8 * 1024);
  });
});

/*
 * ugcportal-dvb. The peek is the first read of the body and it happens before
 * the caller has reserved anything, so a client that stalled here cost no
 * bytes and tripped no byte bound — it held the request slot until Node's
 * `requestTimeout`, because the only stall guard on the path was installed
 * after the peek had already awaited the client.
 *
 * Every timing fact below is on fake timers: the budgets are tens of
 * milliseconds apart and a loaded machine would otherwise decide the
 * outcome. Where a stall is read back through readCappedFormDataFrom, that
 * read is given an idle budget three orders of magnitude longer than the
 * peek's and the clock never advances near it, so a 408 can only have come
 * from the guard the peek installed.
 */
describe("peekDeclaredPartType — idle timeout", () => {
  const PEEK_IDLE_MS = 25;
  /** Long enough that the read's own guard cannot be what fired. */
  const READ_IDLE_MS = 25_000;
  /** A field ahead of the file part, so the peek is still looking. */
  const LEADING_FIELD = textField("caption", "a day at the beach");

  const stalledPeek = (cancel?: (reason: unknown) => void) =>
    peekDeclaredPartType(silentAfter([LEADING_FIELD], cancel), {
      fieldName: "file",
      boundary: BOUNDARY,
      stallTimeoutMs: PEEK_IDLE_MS,
    });

  it("stops looking on the idle timeout instead of awaiting a silent client (K1)", async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      const pending = stalledPeek(cancelled);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      // Still waiting one millisecond short of the budget — the guard is the
      // configured idle timeout, not "gives up on the second read".
      await vi.advanceTimersByTimeAsync(PEEK_IDLE_MS - 1);
      expect(settled).toBe(false);
      expect(cancelled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const peeked = await pending;

      // The request body is torn down at the timeout, not left outstanding
      // for the response to collect later: that is the request slot being
      // released, which is the entire cost this bead is about.
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(peeked.declaredContentType).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns on the timeout even when the body's teardown never finishes (K1)", async () => {
    vi.useFakeTimers();
    try {
      const pending = peekDeclaredPartType(
        silentAfter([LEADING_FIELD], cancelThatNeverSettles),
        {
          fieldName: "file",
          boundary: BOUNDARY,
          stallTimeoutMs: PEEK_IDLE_MS,
        },
      );
      await vi.advanceTimersByTimeAsync(PEEK_IDLE_MS);

      // The peek is the first await on the request. If it waited for the
      // source's cancel to complete, a stalled client would hold this frame
      // — and with it the request slot — for as long as it stayed connected,
      // which is the whole failure, just moved one line down.
      await expect(pending).resolves.toMatchObject({
        declaredContentType: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays what did arrive and then raises the stall, rather than looking truncated", async () => {
    vi.useFakeTimers();
    try {
      const pending = stalledPeek();
      await vi.advanceTimersByTimeAsync(PEEK_IDLE_MS);
      const peeked = await pending;

      const reader = peeked.body.getReader();
      // The bytes the client really sent still come out first — the error is
      // about the body stopping, not about those bytes.
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: new TextEncoder().encode(LEADING_FIELD),
      });
      // And then the stall, instead of `done: true`. A clean close here would
      // be parsed as malformed multipart and answered 400, which says the
      // client sent something wrong rather than that it sent nothing.
      await expect(reader.read()).rejects.toThrow("Request body stalled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaches the 408 the route already answers, from the peek's own guard (K1)", async () => {
    vi.useFakeTimers();
    try {
      const pending = stalledPeek();
      await vi.advanceTimersByTimeAsync(PEEK_IDLE_MS);
      const peeked = await pending;

      const result = await readCappedFormDataFrom(
        multipartRequest,
        peeked.body,
        10 * 1024 * 1024,
        { stallTimeoutMs: READ_IDLE_MS },
      );

      expect(result).toEqual({
        ok: false,
        status: 408,
        error: "Request body stalled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards the rest of the body too, not only the bytes it read", async () => {
    vi.useFakeTimers();
    try {
      // The file part arrives in the first chunk, so the peek answers
      // immediately and the silence falls in the bytes the parser reads. The
      // guard has to travel with the replayed stream for that to be caught
      // within the peek's budget rather than the read's.
      const peeked = await peekDeclaredPartType(silentAfter([partHeader()]), {
        fieldName: "file",
        boundary: BOUNDARY,
        stallTimeoutMs: PEEK_IDLE_MS,
      });
      expect(peeked.declaredContentType).toBe("image/png");

      const pending = readCappedFormDataFrom(
        multipartRequest,
        peeked.body,
        10 * 1024 * 1024,
        { stallTimeoutMs: READ_IDLE_MS },
      );
      await vi.advanceTimersByTimeAsync(PEEK_IDLE_MS);

      await expect(pending).resolves.toEqual({
        ok: false,
        status: 408,
        error: "Request body stalled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards the body it hands back even with no boundary to peek at", async () => {
    vi.useFakeTimers();
    try {
      // The branch that reads nothing at all. It returns before the loop, so
      // it is the one path where a guard installed inside the loop would
      // leave the body unguarded — and a request whose Content-Type carries
      // no boundary is both the easiest thing for a client to send and the
      // one the parser will reject anyway, which makes it the cheapest slot
      // to hold.
      const peeked = await peekDeclaredPartType(silentAfter([LEADING_FIELD]), {
        fieldName: "file",
        boundary: null,
        stallTimeoutMs: PEEK_IDLE_MS,
      });

      const pending = readCappedFormDataFrom(
        multipartRequest,
        peeked.body,
        10 * 1024 * 1024,
        { stallTimeoutMs: READ_IDLE_MS },
      );
      await vi.advanceTimersByTimeAsync(PEEK_IDLE_MS);

      await expect(pending).resolves.toEqual({
        ok: false,
        status: 408,
        error: "Request body stalled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cut off a peek that is merely slow", async () => {
    vi.useFakeTimers();
    try {
      // An idle timeout, not a deadline, on this read as much as on the one
      // after it: three fields ahead of the file part, one piece every 15 ms,
      // so the peek spends 60 ms looking — past the 40 ms budget — with no
      // single gap near it.
      const pieces = [
        textField("caption", "a"),
        textField("tags", "b"),
        textField("altText", "c"),
        partHeader(),
        "PAYLOAD",
      ];
      const pending = peekDeclaredPartType(trickle(pieces, 15), {
        fieldName: "file",
        boundary: BOUNDARY,
        stallTimeoutMs: 40,
      });

      for (let piece = 0; piece < pieces.length; piece += 1) {
        await vi.advanceTimersByTimeAsync(15);
      }

      await expect(pending).resolves.toMatchObject({
        declaredContentType: "image/png",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readCappedFormDataFrom — stalls and metered reads", () => {
  const request = multipartRequest;

  it("answers 408 instead of holding the read open", async () => {
    const result = await readCappedFormDataFrom(
      request,
      silentAfter([partHeader()]),
      10 * 1024 * 1024,
      { stallTimeoutMs: 25 },
    );

    expect(result).toEqual({
      ok: false,
      status: 408,
      error: "Request body stalled",
    });
  });

  it("distinguishes a stall from malformed multipart", async () => {
    // Same route, same reader, two different causes — if both collapsed to
    // 400 there would be nothing to tell a slow-client incident apart from
    // clients sending garbage.
    const malformed = streamOf(["not multipart at all"]);
    const result = await readCappedFormDataFrom(
      request,
      malformed,
      10 * 1024 * 1024,
      { stallTimeoutMs: 25 },
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Malformed multipart form body",
    });
  });

  it("does not fire on a body that is merely slow", async () => {
    // An idle timeout, not a deadline: every chunk resets it, so a large
    // upload on a bad connection is unaffected however long it takes in
    // total. Fake timers make the 15 ms-per-chunk / 40 ms-idle-budget
    // relationship an exact, controlled fact instead of a wall-clock margin
    // that a busy test machine (72 files competing for the event loop) can
    // eat — nothing here waits on the real clock, so nothing here can be
    // slowed down by load. Widening the margin would not fix that; it would
    // just raise the bar the machine has to clear.
    vi.useFakeTimers();
    try {
      const boundaryTail = `\r\n--${BOUNDARY}--\r\n`;
      const pieces = [partHeader(), "AA", "BB", "CC", "DD", boundaryTail];
      const slow = trickle(pieces, 15);

      const resultPromise = readCappedFormDataFrom(
        request,
        slow,
        10 * 1024 * 1024,
        { stallTimeoutMs: 40 },
      );

      // Advance past every chunk's 15 ms delay — each one well inside the
      // 40 ms idle budget — in virtual lockstep rather than hoping the real
      // clock keeps pace.
      for (let chunk = 0; chunk < pieces.length; chunk += 1) {
        await vi.advanceTimersByTimeAsync(15);
      }

      const result = await resultPromise;
      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tears the source down on a stall rather than leaving it locked", async () => {
    // Round-2 finding 4. Erroring the guarded stream does not propagate
    // upstream, and the stream's own `cancel` only runs on a teardown that
    // came from downstream — so without an explicit cancel the request body
    // was left locked with a read outstanding after the 408, which is half
    // the point of not waiting for requestTimeout.
    const cancelled = vi.fn();
    const source = silentAfter([partHeader()], cancelled);

    const result = await readCappedFormDataFrom(request, source, 10 * 1024 * 1024, {
      stallTimeoutMs: 25,
    });

    expect(result).toMatchObject({ ok: false, status: 408 });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("answers without waiting for the source's own teardown", async () => {
    // The guard asks the source to tear down and does NOT wait for it. On a
    // real socket that promise settles when the client disconnects, so
    // awaiting it made the 408 wait for the client to go away — exactly what
    // the idle timeout exists to stop waiting for, and invisible to every
    // test whose stream cancels instantly.
    const result = await readCappedFormDataFrom(
      request,
      silentAfter([partHeader()], cancelThatNeverSettles),
      10 * 1024 * 1024,
      { stallTimeoutMs: 25 },
    );

    expect(result).toEqual({
      ok: false,
      status: 408,
      error: "Request body stalled",
    });
  });

  it("answers 503 when the caller cannot commit to the rest of the body", async () => {
    // The metered path (round-2 finding 1): the upload route grows its memory
    // reservation as bytes arrive and refuses here when it cannot. A 503,
    // distinct from the 413 for a body that is simply too large — one is
    // about the process, the other about this request.
    const seen: number[] = [];
    const body = streamOf([partHeader(), "A".repeat(200), "B".repeat(200)]);

    const result = await readCappedFormDataFrom(request, body, 10 * 1024 * 1024, {
      admitBytes: (received) => {
        seen.push(received);
        return received <= 300 ? "ok" : "over-budget";
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "Too many uploads are being processed right now",
    });
    // Called with the running total, and stopped at the first refusal rather
    // than draining the rest of the body.
    expect(seen).toHaveLength(2);
    expect(seen[seen.length - 1]).toBeGreaterThan(300);
  });

  it("forwards nothing once the caller has refused", async () => {
    // The refusal has to prevent the bytes reaching the parser, not merely
    // report them afterwards — otherwise the reservation and what is
    // actually resident disagree, which is the whole failure this bead is
    // about.
    const body = streamOf([partHeader(), "A".repeat(4096)]);
    const result = await readCappedFormDataFrom(request, body, 10 * 1024 * 1024, {
      admitBytes: () => "over-budget",
    });

    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it("defaults to an idle budget far longer than any real pause", () => {
    expect(BODY_STALL_TIMEOUT_MS).toBe(30_000);
  });
});

describe("readJsonBody — size and idle bounds", () => {
  const LIMIT = 4096;
  const JSON_IDLE_MS = 25;

  /**
   * A real `Request`, not a stand-in: `readJsonBody` reads `request.body`,
   * and whether a streaming body survives the platform's own wrapping is
   * part of what these tests are for.
   */
  function jsonRequest(
    body: ReadableStream<Uint8Array> | null,
    headers: Record<string, string> = {},
  ): Request {
    return new Request("http://localhost/api/media/abc", {
      method: "PATCH",
      headers: new Headers({ "content-type": "application/json", ...headers }),
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  }

  const read = (request: Request, limit = LIMIT) =>
    readJsonBody(request, limit, { stallTimeoutMs: JSON_IDLE_MS });

  it("answers 408 when the client sends nothing at all (K1)", async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      const pending = read(jsonRequest(silentAfter([], cancelled)));
      const settled = vi.fn();
      void pending.then(settled);

      await vi.advanceTimersByTimeAsync(JSON_IDLE_MS - 1);
      // Unsettled one millisecond before the budget: the answer is on the
      // timeout, not merely eventually.
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({
        ok: false,
        status: 408,
        error: "Request body stalled",
      });
      // The socket is released here rather than at Node's requestTimeout,
      // which is the entire point of answering early.
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 408 when the client goes quiet mid-body, under the limit (K1)", async () => {
    // The measured shape (ugcportal-8hsf): a short, valid JSON prefix well
    // under the cap, then a held socket. The size cap never sees this client
    // because it only acts on bytes that arrive, and none do.
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      const body = silentAfter(['{"originalName":"ab'], cancelled);
      const pending = read(jsonRequest(body));
      const settled = vi.fn();
      void pending.then(settled);

      await vi.advanceTimersByTimeAsync(JSON_IDLE_MS - 1);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({
        ok: false,
        status: 408,
        error: "Request body stalled",
      });
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 408 without waiting for the body's own teardown (K1)", async () => {
    // The teardown shape measured on a real socket (ugcportal-dvb): with
    // the guard's own `reader.read()` still outstanding — which is exactly
    // the state a stall leaves it in — cancelling the source returns a
    // promise that does not settle, so awaiting it inside the guard gave no
    // answer at all. The 413 path below is the same call with no read
    // pending, and there it settles; the outstanding read is what separates
    // them, not the client being gone.
    vi.useFakeTimers();
    try {
      const body = silentAfter(['{"a":'], cancelThatNeverSettles);
      const pending = read(jsonRequest(body));

      await vi.advanceTimersByTimeAsync(JSON_IDLE_MS);

      expect(await pending).toEqual({
        ok: false,
        status: 408,
        error: "Request body stalled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cut off a body that is merely slow (K1)", async () => {
    // An idle timeout, not a deadline. Each chunk lands one millisecond
    // inside the budget and the body takes four times the budget in total,
    // so a pass here means the timer is genuinely reset per chunk rather
    // than the whole read finishing inside one window. `vi.useFakeTimers`
    // below means nothing here reads the real clock, so a loaded test
    // machine cannot change the outcome.
    vi.useFakeTimers();
    try {
      const pieces = ['{"originalNa', 'me":"ph', 'oto.p', 'ng"}'];
      const pending = read(jsonRequest(trickle(pieces, JSON_IDLE_MS - 1)));

      for (let chunk = 0; chunk <= pieces.length; chunk += 1) {
        await vi.advanceTimersByTimeAsync(JSON_IDLE_MS - 1);
      }

      expect(await pending).toEqual({
        ok: true,
        value: { originalName: "photo.png" },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still answers 413 from Content-Length without touching the body", async () => {
    // `silentAfter([])` never settles a read, so a result at all proves the
    // early-out answered without one.
    const request = jsonRequest(silentAfter([]), {
      "content-length": String(LIMIT + 1),
    });

    const result = await read(request);

    expect(result).toEqual({
      ok: false,
      status: 413,
      error: "Request body too large",
    });
    // The early-out is unchanged: the stream is not even locked, so no guard
    // was armed and nothing was waited for.
    expect(request.bodyUsed).toBe(false);
    expect(request.body?.locked).toBe(false);
  });

  it("still answers 413 from the stream when Content-Length is absent", async () => {
    // Chunked requests carry no Content-Length, so `Number(null)` is 0 and
    // the early-out above cannot fire. The stream cap is what holds the line
    // (ugcportal-i04).
    const result = await read(
      jsonRequest(streamOf([`{"originalName":"${"a".repeat(LIMIT)}"}`])),
    );

    expect(result).toEqual({
      ok: false,
      status: 413,
      error: "Request body too large",
    });
  });

  it("answers 413 without waiting for the body's own teardown, and arms nothing further", async () => {
    // Awaiting the teardown on this line would not in fact hang a real
    // server — see the comment beside it — so what this pins is the
    // property and not a duration: the answer does not depend on the
    // source's teardown settling, demonstrated with one that never does.
    //
    // It is also the one place the timer-leak check can fail. On the stall
    // path the guard's timer has already fired by the time the answer
    // lands, so a count of zero there holds whatever the guard does with
    // it; here the read resolved while the timer was still armed, and only
    // `clearTimeout` in stallGuarded's `finally` disarms it. Deleting that
    // line turns the last assertion red (and the trickle test above, which
    // is the other place it bites).
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn(cancelThatNeverSettles);
      const oversize = silentAfter(["x".repeat(LIMIT + 1)], cancelled);

      const result = await read(jsonRequest(oversize));

      expect(result).toEqual({
        ok: false,
        status: 413,
        error: "Request body too large",
      });
      // Requested, not awaited: the teardown is asked for and the answer
      // does not wait on it.
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a reset connection as 400, not as a stall", async () => {
    // The payload is valid JSON on purpose: a body that merely ended here
    // would parse and answer `ok`, so only the stream's error can produce
    // the 400 below. With an unparseable payload this assertion would hold
    // whether or not the reset was noticed at all.
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}'));
        controller.error(new Error("connection reset"));
      },
    });

    expect(await read(jsonRequest(broken))).toEqual({
      ok: false,
      status: 400,
      error: "Invalid JSON body",
    });
  });

  it("reports unparseable JSON as 400", async () => {
    expect(await read(jsonRequest(streamOf(["not json"])))).toEqual({
      ok: false,
      status: 400,
      error: "Invalid JSON body",
    });
  });
});

/**
 * Strips comments so the scan below reads code rather than prose.
 *
 * Necessary, not cosmetic: this module's own docstring contains the words
 * `request.json()` and `request.formData()`, which the scan would otherwise
 * count as unguarded body reads.
 */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Each top-level `function` in the module, with the span it occupies. */
function topLevelFunctions(
  code: string,
): Array<{ name: string; start: number; end: number; text: string }> {
  const blocks = [];
  const heading = /^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/gm;
  for (let m = heading.exec(code); m !== null; m = heading.exec(code)) {
    const close = code.indexOf("\n}\n", m.index);
    const end = close < 0 ? code.length : close + 3;
    blocks.push({ name: m[1], start: m.index, end, text: code.slice(m.index, end) });
  }
  return blocks;
}

/** The `const <name> = ...` initializer inside one function block. */
function initializerOf(block: string, name: string): string | null {
  const declaration = new RegExp(
    `\\bconst ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} = `,
  );
  const at = block.search(declaration);
  if (at < 0) return null;
  const rest = block.slice(at);
  const next = rest.search(/\n {2}(?:const |let |return |try )/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Whether `name`'s stream came, directly or via a reader, from the guard. */
function tracesToStallGuard(block: string, name: string, depth = 0): boolean {
  if (depth > 4) return false;
  const initializer = initializerOf(block, name);
  if (initializer === null) return false;
  if (/\bstallGuarded\(/.test(initializer)) return true;
  const via = /\b([A-Za-z_$][\w$.]*)\.getReader\(\)/.exec(initializer);
  return via !== null && tracesToStallGuard(block, via[1], depth + 1);
}

/**
 * Whether the expression a body was read through is one the guard wrapped.
 *
 * Either the guard is applied right there (`cappedBody(stallGuarded(body,
 * ...))`), or the expression is a plain name whose own initializer traces
 * back to it. Anything else — a call this does not recognise, a property of
 * something it cannot follow — counts as unguarded, which is the direction
 * an omission guard has to fail in.
 */
function guardsBody(block: string, expression: string): boolean {
  const trimmed = expression.trim();
  if (/\bstallGuarded\(/.test(trimmed)) return true;
  return (
    /^[A-Za-z_$][\w$.]*$/.test(trimmed) && tracesToStallGuard(block, trimmed)
  );
}

/** The text between a `(` at `open` and its matching `)`, quotes respected. */
function balancedArgs(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/**
 * Every call in the module that pulls bytes off a body, with its verdict.
 *
 * Scans the whole file and then asks which function each hit fell inside,
 * rather than scanning function bodies and ignoring the gaps. A read placed
 * at module scope, or in an arrow function this does not recognise as a
 * block, is reported under `module:` and counted as unguarded.
 *
 * Three shapes are recognised, and that list is the guard's actual reach —
 * it is pattern-matching over source text, not a type checker, so it can
 * only promise to catch the ways a body is drained in practice:
 *
 *  - a method call that consumes a body — `x.getReader()`, `x.read()`,
 *    `x.formData()`, `x.json()`, `x.text()`, `x.arrayBuffer()`, `x.bytes()`,
 *    `x.blob()`;
 *  - `for await (const chunk of x)`, which drains a stream with no method
 *    call at all;
 *  - `new Request(...)` / `new Response(...)`, which hand a stream to the
 *    platform to drain — the argument text is what gets checked, so an
 *    inline `new Response(request.body).text()` is caught even though its
 *    `.text()` hangs off a parenthesis rather than a name.
 *
 * All three are here because the first version — the method call alone —
 * was green against a top-level `for await` over `request.body` and against
 * `new Response(request.body).text()` (ugcportal-8hsf).
 *
 * One sorted line per site, verdict included, rather than a map keyed by
 * site. A map was last-write-wins, and the constructor label carries no
 * receiver name to tell two of them apart, so a second unguarded
 * `new Request(...)` in a function that already had a guarded one was
 * swallowed when it came first in the file and reported when it came
 * second — the same code, two verdicts, decided by source order. A list
 * has no key to collide on, so no site can hide behind another; pinned by
 * "reports two constructor sites in one function separately, in either
 * order", which fails if this goes back to a keyed collection.
 */
function bodyReadSites(source: string): string[] {
  const code = stripComments(source);
  const blocks = topLevelFunctions(code);
  const sites: string[] = [];
  const owner = (index: number) =>
    blocks.find((block) => index >= block.start && index < block.end);
  const record = (index: number, label: string, expression: string) => {
    const block = owner(index);
    const guarded = block !== undefined && guardsBody(block.text, expression);
    sites.push(
      `${block ? block.name : "module"}:${label} -> ${
        guarded ? "stall-guarded" : "UNGUARDED"
      }`,
    );
  };

  const consumers =
    /([A-Za-z_$][\w$.]*)\.(getReader|read|formData|json|text|arrayBuffer|bytes|blob)\(/g;
  for (let m = consumers.exec(code); m !== null; m = consumers.exec(code)) {
    record(m.index, `${m[1]}.${m[2]}`, m[1]);
  }

  const forAwait =
    /for await \(\s*(?:const|let|var)\s+[\w$]+\s+of\s+([A-Za-z_$][\w$.]*)/g;
  for (let m = forAwait.exec(code); m !== null; m = forAwait.exec(code)) {
    record(m.index, `for await of ${m[1]}`, m[1]);
  }

  const constructed = /new (Request|Response)\(/g;
  for (let m = constructed.exec(code); m !== null; m = constructed.exec(code)) {
    const args = balancedArgs(code, m.index + m[0].length - 1);
    record(m.index, `new ${m[1]}`, args);
  }

  return sites.sort();
}

describe("request-body.ts — every body read is stall-guarded", () => {
  /**
   * The sibling-omission guard.
   *
   * `readJsonBody` went unguarded through two beads and five review rounds on
   * its sibling precisely because nothing enumerated the module's body reads:
   * the multipart path got an idle timeout, the JSON path was simply not
   * looked at. This fails when a read is added that is neither guarded nor
   * deliberately excepted, rather than waiting for someone to notice.
   *
   * Each line is `<function>:<read site> -> stall-guarded` when the stream
   * being read traces back to stallGuarded in the same function, or
   * `-> UNGUARDED` otherwise; the UNGUARDED lines are the exception list, and
   * each one carries, in the comment above it, why that read is allowed.
   */
  const EXPECTED = [
    // The peek, guarded before its first read (ugcportal-dvb).
    "peekDeclaredPartType:guarded.getReader -> stall-guarded",
    "peekDeclaredPartType:reader.read -> stall-guarded",
    // The multipart reader: the platform parses a re-framed Request whose
    // body is capped and guarded (gh-38). Two sites, because handing the
    // stream to the constructor and reading it back off the result are both
    // points where an unguarded body could be let through.
    "readCappedFormDataFrom:new Request -> stall-guarded",
    "readCappedFormDataFrom:reframed.formData -> stall-guarded",
    // The JSON reader (ugcportal-8hsf).
    "readJsonBody:guarded.getReader -> stall-guarded",
    "readJsonBody:reader.read -> stall-guarded",
    // EXCEPTION. Replays a reader its caller already took off a guarded
    // stream; it has no stream of its own to guard, and guarding here would
    // double-arm the same bytes.
    "replay:reader.read -> UNGUARDED",
    // EXCEPTION. The guard itself is what makes the others guarded, so it
    // necessarily holds the one unguarded reader in the module.
    "stallGuarded:reader.read -> UNGUARDED",
    "stallGuarded:source.getReader -> UNGUARDED",
  ];

  it("has no body read that is neither guarded nor on the exception list", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./request-body.ts", import.meta.url)),
      "utf8",
    );

    expect(bodyReadSites(source)).toEqual(EXPECTED);
  });

  it("would catch a new unguarded reader", () => {
    // The guard above is only worth its line count if it actually fails on
    // the thing it is watching for, so run the same scanner over a sibling
    // shaped like the one this bead fixed.
    const sibling = `
/** Reads a body the way readJsonBody used to. */
export async function readSomeOtherBody(request: Request) {
  const reader = request.body.getReader();
  return reader.read();
}
`;

    expect(bodyReadSites(sibling)).toEqual([
      "readSomeOtherBody:reader.read -> UNGUARDED",
      "readSomeOtherBody:request.body.getReader -> UNGUARDED",
    ]);
  });

  it("catches a body drained without a method call at all", () => {
    // The first version of this scanner was green against both of these,
    // because neither reaches the body through a named method on a named
    // receiver (ugcportal-8hsf). They are the two realistic ways to drain a
    // request body in this codebase that the method list cannot see.
    const sneaky = `
export async function countBytes(request: Request) {
  let n = 0;
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    n += chunk.byteLength;
  }
  return n;
}

export async function readAsText(request: Request) {
  return await new Response(request.body).text();
}
`;

    expect(bodyReadSites(sneaky)).toEqual([
      "countBytes:for await of request.body -> UNGUARDED",
      "readAsText:new Response -> UNGUARDED",
    ]);
  });

  it("does not flag those two shapes when they are guarded", () => {
    // The mirror of the test above: the scanner has to separate the two,
    // or it would force every such read onto the exception list and stop
    // meaning anything.
    const guarded = `
export async function countBytes(request: Request) {
  let n = 0;
  const bounded = stallGuarded(request.body, 1);
  for await (const chunk of bounded as unknown as AsyncIterable<Uint8Array>) {
    n += chunk.byteLength;
  }
  return n;
}

export async function readAsText(request: Request) {
  return await new Response(stallGuarded(request.body, 1)).text();
}
`;

    expect(bodyReadSites(guarded)).toEqual([
      "countBytes:for await of bounded -> stall-guarded",
      "readAsText:new Response -> stall-guarded",
    ]);
  });

  it("reports two constructor sites in one function separately, in either order", () => {
    // A constructor hit carries no receiver name to tell two of them
    // apart, and the scanner used to collect sites into a map keyed on the
    // label:
    // an unguarded `new Request(...)` beside a guarded one in the same
    // function was swallowed when it came first in the file and reported
    // when it came second. Same code, two verdicts, decided by source
    // order — and the swallowing direction is the silent one. Both orders
    // must report both sites.
    const body = (order: "unguarded-first" | "guarded-first") => {
      const raw =
        '  const raw = new Request(request.url, { method: "POST", body, duplex: "half" } as RequestInit);';
      const safe =
        '  const safe = new Request(request.url, { method: "POST", body: stallGuarded(body, 1), duplex: "half" } as RequestInit);';
      const lines =
        order === "unguarded-first" ? [raw, safe] : [safe, raw];
      return [
        "export function reframe(request: Request, body: ReadableStream<Uint8Array>) {",
        ...lines,
        "  return [raw, safe];",
        "}",
        "",
      ].join("\n");
    };

    const expected = [
      "reframe:new Request -> UNGUARDED",
      "reframe:new Request -> stall-guarded",
    ].sort();

    expect(bodyReadSites(body("unguarded-first"))).toEqual(expected);
    expect(bodyReadSites(body("guarded-first"))).toEqual(expected);
  });

  it("does not mistake a comment for a body read", () => {
    // What stripComments is for: this module's docstring names
    // request.json() and request.formData() as the thing it exists to
    // replace.
    const prose = `
/** Replaces request.json() and request.formData(). */
export async function guardedReader(request: Request) {
  const guarded = stallGuarded(request.body, 1);
  const reader = guarded.getReader();
  return reader.read();
}
`;

    expect(bodyReadSites(prose)).toEqual([
      "guardedReader:guarded.getReader -> stall-guarded",
      "guardedReader:reader.read -> stall-guarded",
    ]);
  });
});
