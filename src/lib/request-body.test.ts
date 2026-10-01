import { describe, expect, it, vi } from "vitest";

import {
  BODY_STALL_TIMEOUT_MS,
  PART_HEADER_PEEK_BYTES,
  multipartBoundary,
  peekDeclaredPartType,
  readCappedFormDataFrom,
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
    // The stream is handed straight back undisturbed — not even locked — so a
    // request whose Content-Type has no boundary is parsed exactly as before.
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

describe("readCappedFormDataFrom — stalls and metered reads", () => {
  const request = {
    url: "http://localhost/api/media",
    method: "POST",
    headers: new Headers({
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    }),
  };

  /** Sends the part headers, then never another byte. */
  function stalledBody(): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          // The shape that matters: a pull that never settles, which is what
          // a client holding a connection open without sending looks like.
          return new Promise<void>(() => {});
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode(partHeader()));
      },
    });
  }

  it("answers 408 instead of holding the read open", async () => {
    const result = await readCappedFormDataFrom(
      request,
      stalledBody(),
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
      let index = 0;
      const slow = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= pieces.length) {
            controller.close();
            return;
          }
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(pieces[index++]));
              resolve();
            }, 15);
          });
        },
      });

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
    let sent = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => {});
        sent = true;
        controller.enqueue(new TextEncoder().encode(partHeader()));
      },
      cancel: cancelled,
    });

    const result = await readCappedFormDataFrom(request, source, 10 * 1024 * 1024, {
      stallTimeoutMs: 25,
    });

    expect(result).toMatchObject({ ok: false, status: 408 });
    expect(cancelled).toHaveBeenCalledTimes(1);
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
