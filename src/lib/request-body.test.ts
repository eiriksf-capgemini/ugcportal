import { describe, expect, it } from "vitest";

import {
  PART_HEADER_PEEK_BYTES,
  peekFirstMultipartPart,
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
  filename = "photo.png",
  contentType = "image/png" as string | null,
} = {}) {
  return (
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
    (contentType === null ? "" : `Content-Type: ${contentType}\r\n`) +
    `\r\n`
  );
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

describe("peekFirstMultipartPart", () => {
  it("reads the declared media type without consuming the body", async () => {
    const whole = partHeader() + "PAYLOAD" + `\r\n--${BOUNDARY}--\r\n`;
    const peeked = await peekFirstMultipartPart(streamOf([whole]), "file");

    expect(peeked.declaredContentType).toBe("image/png");
    // The replayed stream is the *whole* body, head included. A parser handed
    // a body missing its first chunk would fail in a way that looked like a
    // malformed upload rather than like this function.
    await expect(drain(peeked.body)).resolves.toBe(whole);
  });

  it("finds a header block split across chunk boundaries", async () => {
    // The terminator is four bytes and a chunk boundary can land inside it,
    // which is why the search runs over the accumulated text rather than over
    // each chunk. Split here between the two CRLFs.
    const header = partHeader();
    const peeked = await peekFirstMultipartPart(
      streamOf([
        header.slice(0, header.length - 2),
        header.slice(header.length - 2),
        "PAYLOAD",
      ]),
      "file",
    );

    expect(peeked.declaredContentType).toBe("image/png");
    await expect(drain(peeked.body)).resolves.toBe(header + "PAYLOAD");
  });

  it("lower-cases the declared type", async () => {
    const peeked = await peekFirstMultipartPart(
      streamOf([partHeader({ contentType: "IMAGE/PNG" })]),
      "file",
    );

    expect(peeked.declaredContentType).toBe("image/png");
  });

  it.each([
    ["the first part is a different field", partHeader({ name: "caption" })],
    ["the part declares no Content-Type", partHeader({ contentType: null })],
    ["the body is not multipart at all", '{"json":true}\r\n\r\nmore'],
  ])("reports nothing when %s", async (_label, head) => {
    const peeked = await peekFirstMultipartPart(
      streamOf([head, "PAYLOAD"]),
      "file",
    );

    // Null, not a guess: the caller falls back to the cap that applied before
    // this existed, so an unreadable declaration is never *worse* than none.
    expect(peeked.declaredContentType).toBeNull();
    await expect(drain(peeked.body)).resolves.toBe(head + "PAYLOAD");
  });

  it("gives up after the peek budget rather than buffering the body", async () => {
    // A client that never sends a terminator must not be able to make this
    // accumulate its whole upload looking for one.
    const filler = "x".repeat(4096);
    const chunks = Array.from({ length: 64 }, () => filler);
    const peeked = await peekFirstMultipartPart(streamOf(chunks), "file", 8192);

    expect(peeked.declaredContentType).toBeNull();
    // Everything read while looking is still replayed, so nothing is lost.
    await expect(drain(peeked.body)).resolves.toHaveLength(64 * 4096);
  });

  it("replays a body shorter than the peek budget", async () => {
    const peeked = await peekFirstMultipartPart(streamOf(["tiny"]), "file");

    expect(peeked.declaredContentType).toBeNull();
    await expect(drain(peeked.body)).resolves.toBe("tiny");
  });

  it("does not corrupt a non-ASCII filename on its way through", async () => {
    // The header search decodes latin1 so a multi-byte sequence straddling a
    // chunk boundary cannot shift the terminator index. That decoding must
    // never reach the replayed bytes, which are passed through untouched.
    const header = partHeader({ filename: "sølvfjell-😀.png" });
    const encoded = new TextEncoder().encode(header + "PAYLOAD");
    const peeked = await peekFirstMultipartPart(
      streamOf([encoded.slice(0, 40), encoded.slice(40)]),
      "file",
    );

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

    const peeked = await peekFirstMultipartPart(failing, "file");

    expect(peeked.declaredContentType).toBeNull();
    await expect(drain(peeked.body)).resolves.toBe("--boundary\r\n");
  });

  it("defaults to a peek budget far below any upload cap", () => {
    expect(PART_HEADER_PEEK_BYTES).toBe(8 * 1024);
  });
});
