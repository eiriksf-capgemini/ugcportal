/**
 * Bounded request-body readers for route handlers.
 *
 * Route handlers get no body cap from the framework: `request.json()` and
 * `request.formData()` will buffer whatever the client sends. These two
 * helpers are the only sanctioned way to read a body in this codebase, so
 * that "how big may this be" is a number at the call site rather than an
 * omission.
 *
 * In both, the Content-Length check is a cheap early-out and deliberately
 * **not** the enforcement (see ugcportal-i04, where exactly that mistake was
 * shipped): the header is absent on a chunked request — `Number(null)` is 0 —
 * and can be malformed, where `Number()` yields NaN and `NaN > limit` is
 * false. The wrapped stream is what holds the line.
 *
 * `src/app/api/media/route.ts` used to carry its own copy of
 * readCappedFormData and now imports this one (ugcportal-05b had to change
 * that reader, and maintaining the change in two places was not an option).
 * `src/app/api/media/[id]/route.ts` still has a private `readJsonBody`;
 * switching it over and deleting that copy is the rest of ugcportal-e15.
 * Until then a fix to readJsonBody here needs applying there too.
 */

/** Thrown from inside the body stream, so it surfaces out of the parser. */
class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Wraps a body stream so it errors the moment more than `limit` bytes have
 * gone through it, rather than letting the parser downstream buffer whatever
 * the client feels like sending.
 */
function cappedBody(
  source: ReadableStream<Uint8Array>,
  limit: number,
): ReadableStream<Uint8Array> {
  let received = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit) {
          controller.error(new BodyTooLargeError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function isBodyTooLarge(error: unknown): boolean {
  // undici sometimes surfaces a stream error wrapped in its own TypeError,
  // so follow the cause chain rather than checking only the top.
  for (let cursor = error, depth = 0; cursor && depth < 5; depth += 1) {
    if (cursor instanceof BodyTooLargeError) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

/** Reads and JSON-parses a request body, holding at most `limit` bytes. */
export async function readJsonBody(
  request: Request,
  limit: number,
): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, status: 413, error: "Request body too large" };
  }

  if (!request.body) {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      received += value.byteLength;
      if (received > limit) {
        // Swallowed deliberately: cancel() can reject when the connection is
        // already gone, and the shared catch below answers 400. The cap has
        // been decided by this point, so letting a failed teardown rewrite a
        // correct 413 would report the wrong thing.
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: "Request body too large" };
      }

      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // A truncated or reset connection is the client's problem, not a 500.
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
}

export type FormDataResult =
  | { ok: true; value: FormData }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Reads a multipart body, never letting more than `limit` bytes through.
 *
 * The body is re-framed onto a new Request so the platform still does the
 * multipart parsing — this bounds what the parser is fed, it does not
 * reimplement it. Content-Length is dropped from the copied headers because
 * it describes the original framing, not this one.
 */
export async function readCappedFormData(
  request: Request,
  limit: number,
): Promise<FormDataResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, status: 413, error: "Request body too large" };
  }

  if (!request.body) {
    return { ok: false, status: 400, error: "Expected a multipart form body" };
  }

  return readCappedFormDataFrom(request, request.body, limit);
}

/**
 * {@link readCappedFormData} for a body stream the caller is already holding.
 *
 * Split out for {@link peekFirstMultipartPart}, which has to consume the head
 * of `request.body` to learn what the upload declares itself to be *before*
 * the cap can be chosen (ugcportal-05b). Once that has happened
 * `request.body` is disturbed and cannot be read again, so the peeked stream
 * — head replayed, remainder live — is what gets parsed.
 *
 * Deliberately takes the body as a parameter rather than reading it back off
 * `request`: passing the original `request` here after peeking it would parse
 * a body missing its first few kilobytes, which is exactly the kind of quiet
 * wrongness this signature makes impossible to express.
 */
export async function readCappedFormDataFrom(
  request: Pick<Request, "url" | "method" | "headers">,
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<FormDataResult> {
  const headers = new Headers(request.headers);
  headers.delete("content-length");

  const reframed = new Request(request.url, {
    method: request.method,
    headers,
    body: cappedBody(body, limit),
    // Required by the fetch spec for a streaming request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  try {
    return { ok: true, value: await reframed.formData() };
  } catch (error) {
    if (isBodyTooLarge(error)) {
      return { ok: false, status: 413, error: "Request body too large" };
    }
    return { ok: false, status: 400, error: "Malformed multipart form body" };
  }
}

/**
 * How far into the body the first part's header block is looked for.
 *
 * A part header block is a boundary line plus two short header lines — a few
 * hundred bytes for anything a browser sends. 8 KiB is generous room for a
 * long filename without being a meaningful allocation, and the give-up
 * behaviour is a *looser* cap rather than a rejection, so a client with an
 * unusual preamble still uploads.
 *
 * A threshold rather than a hard byte bound: a chunk cannot be half-read, so
 * the search stops at the first chunk that takes it past this and the bytes
 * held can exceed it by one chunk. That matters only to the accounting in
 * src/lib/upload-memory.ts, which says so.
 */
export const PART_HEADER_PEEK_BYTES = 8 * 1024;

export interface PeekedMultipartBody {
  /**
   * Lower-cased media type declared by the first part, when that part is the
   * one named `fieldName`. Null when the header block could not be found
   * within {@link PART_HEADER_PEEK_BYTES}, when the first part is some other
   * field, or when it carries no Content-Type.
   *
   * Client-controlled, and only ever used to choose a **smaller** cap than
   * the caller's fallback — see the note on uploadReadLimitBytes in
   * src/lib/upload-memory.ts for why that makes a lying value harmless.
   */
  declaredContentType: string | null;
  /** The whole body, head included, ready to be parsed exactly once. */
  body: ReadableStream<Uint8Array>;
}

const HEADER_TERMINATOR = "\r\n\r\n";

/**
 * Reads the *declaration* at the front of a multipart body without reading
 * the body.
 *
 * Multipart sends each part's headers before its data, so the first part's
 * `Content-Disposition` and `Content-Type` arrive in the first few hundred
 * bytes. Knowing them lets the caller size the cap (and its memory
 * reservation) for the kind of file this actually claims to be, instead of
 * for the largest upload the route accepts from anyone. That is the whole
 * difference between rejecting an oversized image at ~10 MB and rejecting it
 * at ~205 MB, which is what this route used to do (ugcportal-05b).
 *
 * This is a peek, not a parser: it locates one CRLFCRLF and reads two header
 * values out of the bytes before it. The platform still does the real
 * multipart parsing, on a stream that replays everything read here. Anything
 * unexpected — no terminator in range, a different field first, no
 * Content-Type — yields `null` and the caller's fallback cap, so a body this
 * cannot read is bounded exactly as well as it was before, never worse.
 */
export async function peekFirstMultipartPart(
  body: ReadableStream<Uint8Array>,
  fieldName: string,
  maxHeaderBytes: number = PART_HEADER_PEEK_BYTES,
): Promise<PeekedMultipartBody> {
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let text = "";
  let terminator = -1;
  let ended = false;

  try {
    while (terminator < 0 && headBytes < maxHeaderBytes) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      head.push(value);
      headBytes += value.byteLength;
      // Latin-1 rather than UTF-8 so a multi-byte sequence straddling a chunk
      // boundary cannot turn into a replacement character and shift the index
      // this search returns. Header names, the boundary and the media type
      // are all ASCII; a non-ASCII filename simply decodes to mojibake we
      // never look at.
      text += Buffer.from(value).toString("latin1");
      terminator = text.indexOf(HEADER_TERMINATOR);
    }
  } catch {
    // A broken or reset connection is the caller's problem to report from the
    // parse below, on the replayed stream, rather than a distinct error here.
    ended = true;
  }

  return {
    declaredContentType:
      terminator < 0 ? null : parseDeclaredContentType(text.slice(0, terminator), fieldName),
    body: replay(head, ended ? null : reader),
  };
}

/** `name="file"` out of a Content-Disposition line (RFC 7578 quoted-string). */
const DISPOSITION_NAME = /;\s*name\s*=\s*"([^"]*)"/i;
const CONTENT_TYPE_LINE = /^content-type:[ \t]*([^\r\n]+)$/im;
const CONTENT_DISPOSITION_LINE = /^content-disposition:[ \t]*([^\r\n]+)$/im;

function parseDeclaredContentType(
  headerBlock: string,
  fieldName: string,
): string | null {
  const disposition = CONTENT_DISPOSITION_LINE.exec(headerBlock)?.[1];
  if (!disposition) return null;
  // Only the named field's declaration is usable: a leading text field says
  // nothing about how big the file behind it is, and treating its (absent)
  // type as the file's would cap the request on unrelated information.
  if (DISPOSITION_NAME.exec(disposition)?.[1] !== fieldName) return null;

  const contentType = CONTENT_TYPE_LINE.exec(headerBlock)?.[1];
  return contentType ? contentType.trim().toLowerCase() : null;
}

/**
 * A stream that emits the already-consumed chunks, then whatever is left.
 *
 * `reader` is null when the source is already exhausted (or errored), in
 * which case the replayed head is the whole body.
 */
function replay(
  head: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < head.length) {
        controller.enqueue(head[index++]);
        return;
      }
      if (!reader) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}
