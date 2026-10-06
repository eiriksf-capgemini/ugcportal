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
 * Both `src/app/api/media/route.ts` and `src/app/api/media/[id]/route.ts` now
 * import these helpers; maintaining duplicate implementations was not an option
 * when either one needed to change (ugcportal-05b, ugcportal-e15).
 */

/** Thrown from inside the body stream, so it surfaces out of the parser. */
class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * The caller has run out of room for this body part-way through it.
 *
 * Distinct from {@link BodyTooLargeError} because the two are different
 * answers: too large is about this request and is a 413, out of budget is
 * about the process and is a retryable 503.
 */
class BodyOverBudgetError extends Error {
  constructor() {
    super("Upload buffers are at capacity");
    this.name = "BodyOverBudgetError";
  }
}

function isOverBudget(error: unknown): boolean {
  for (let cursor = error, depth = 0; cursor && depth < 5; depth += 1) {
    if (cursor instanceof BodyOverBudgetError) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Wraps a body stream so it errors the moment more than `limit` bytes have
 * gone through it, rather than letting the parser downstream buffer whatever
 * the client feels like sending.
 *
 * `admitBytes`, when supplied, is called with the running total *before* each
 * chunk is passed on, and may refuse it. That is what lets a caller commit
 * memory in step with what has actually arrived rather than up front from
 * what the request claimed it would send (ugcportal-05b round 2): the chunk
 * is not forwarded, so nothing downstream ever holds bytes the caller did not
 * agree to.
 */
function cappedBody(
  source: ReadableStream<Uint8Array>,
  limit: number,
  admitBytes?: (received: number) => "ok" | "over-budget" | "too-large",
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
        if (admitBytes) {
          const verdict = admitBytes(received);
          if (verdict === "too-large") {
            controller.error(new BodyTooLargeError());
            return;
          }
          if (verdict === "over-budget") {
            controller.error(new BodyOverBudgetError());
            return;
          }
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
  | { ok: false; status: 400 | 408 | 413 | 503; error: string };

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
 * Longest a request body may go without delivering a single byte.
 *
 * An *idle* timeout, not a deadline: it is reset by every chunk, so a genuinely
 * slow 200 MB upload on a bad connection is unaffected, while a client that
 * sends its part headers and then stops is cut off in seconds instead of
 * holding its reservation until Node's 300-second `requestTimeout`
 * (ugcportal-05b round 1). That difference matters because a reservation is
 * held across the read: one stalled client used to be able to hold a whole
 * container's upload budget, and every other upload took a 503 for five
 * minutes. 30 seconds is far longer than any real pause in a TCP stream that
 * is still alive.
 *
 * It applies from the first read of the body, including
 * {@link peekDeclaredPartType}'s (ugcportal-dvb). The peek runs before any
 * reservation exists, so a stall there costs no bytes — but it cost a request
 * slot for the whole of `requestTimeout`, and N connections sending a valid
 * multipart Content-Type plus a few bytes held N slots. The byte bounds above
 * said nothing about that, because nothing had been reserved to bound.
 */
export const BODY_STALL_TIMEOUT_MS = 30_000;

/** Thrown from inside the body stream when it goes silent for too long. */
class BodyStalledError extends Error {
  constructor() {
    super("Request body stalled");
    this.name = "BodyStalledError";
  }
}

function isBodyStalled(error: unknown): boolean {
  for (let cursor = error, depth = 0; cursor && depth < 5; depth += 1) {
    if (cursor instanceof BodyStalledError) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Wraps a stream so a read that never produces a chunk fails instead of
 * waiting forever.
 *
 * Deliberately a wrapper around the reader rather than a `TransformStream`
 * like {@link cappedBody}: a transform's `transform()` only runs when a chunk
 * arrives, which is exactly the event that is not happening, so a stall is
 * the one condition a transform structurally cannot observe.
 */
function stallGuarded(
  source: ReadableStream<Uint8Array>,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new BodyStalledError()),
                timeoutMs,
              );
              // Never hold the event loop open for a timer nobody is waiting
              // on.
              timer.unref?.();
            }),
          ]);
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          // Tear the source down explicitly. Erroring *this* stream does not
          // propagate upstream, and `cancel` below only runs when the
          // teardown came from downstream — so without this the source stays
          // locked with a read outstanding, and the request body is left
          // un-torn-down after the 408. That is half the point of not waiting
          // for requestTimeout. Rejections are swallowed because the error
          // being reported is the stall, not whatever cancelling a
          // possibly-already-dead stream does.
          //
          // REQUESTED, NOT AWAITED (ugcportal-dvb). `cancel()` closes this
          // reader's stream and settles its pending read before it returns;
          // the promise it hands back only tracks the *source's* own teardown,
          // and for an incoming HTTP body that one does not settle while the
          // client holds the connection open. So awaiting it made the 408 wait
          // for the client to disconnect — the exact behaviour this timeout
          // exists to stop waiting for — which no test with an instantly
          // cancelling stream could see, and a stalled upload on a real socket
          // got no answer until Node's requestTimeout. The bead has the
          // before/after measurement off `next dev`; the behaviour is pinned
          // by "answers without waiting for the source's own teardown" and by
          // "returns on the timeout even when the body's teardown never
          // finishes".
          void reader.cancel(error).catch(() => {});
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    // No read-ahead of its own. A ReadableStream fills its queue as soon as
    // it has one, so the default strategy would pull a chunk the consumer has
    // not asked for and hold it here — one chunk more of the client's body
    // resident than before this wrapper existed, on a path whose whole
    // purpose is to decide what may be held before holding it. With a
    // high-water mark of 0 the guard pulls only when something reads, so it
    // observes the silence without adding to what is buffered. Pinned by
    // route.test.ts "refuses a burst without buffering it", which counts
    // pulls off the request body.
    { highWaterMark: 0 },
  );
}

/**
 * {@link readCappedFormData} for a body stream the caller is already holding.
 *
 * Split out for {@link peekDeclaredPartType}, which has to consume the head
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
export interface CappedReadOptions {
  /** Overrides {@link BODY_STALL_TIMEOUT_MS}; exposed for tests. */
  stallTimeoutMs?: number;
  /**
   * Called with the running byte total before each chunk is forwarded.
   *
   * `"ok"` forwards it. `"over-budget"` refuses the rest of the body with a
   * 503 — the caller cannot spare the memory now. `"too-large"` refuses it
   * with a 413 — this body is bigger than the caller could ever hold, which
   * is a fact about the request rather than about the moment.
   *
   * This is how the upload route keeps its memory reservation in step with
   * what has actually been delivered, and how it reaches a 413 from bytes
   * that arrived rather than from what the request claimed to be. See
   * cappedBody.
   */
  admitBytes?: (received: number) => "ok" | "over-budget" | "too-large";
}

export async function readCappedFormDataFrom(
  request: Pick<Request, "url" | "method" | "headers">,
  body: ReadableStream<Uint8Array>,
  limit: number,
  options: CappedReadOptions = {},
): Promise<FormDataResult> {
  const headers = new Headers(request.headers);
  headers.delete("content-length");

  const reframed = new Request(request.url, {
    method: request.method,
    headers,
    // Stall guard outside the cap, so the byte counter only ever sees chunks
    // that actually arrived.
    //
    // A body handed over by peekDeclaredPartType is already guarded, so on the
    // upload path two guards cover the same bytes. Deliberate: both raise the
    // same BodyStalledError and both land on the 408 below, so the overlap
    // changes no answer and costs one extra timer per chunk — while dropping
    // this one would leave readCappedFormData (no peek, see above) and any
    // future caller depending on a guard installed somewhere else.
    body: cappedBody(
      stallGuarded(body, options.stallTimeoutMs ?? BODY_STALL_TIMEOUT_MS),
      limit,
      options.admitBytes,
    ),
    // Required by the fetch spec for a streaming request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  try {
    return { ok: true, value: await reframed.formData() };
  } catch (error) {
    if (isBodyTooLarge(error)) {
      return { ok: false, status: 413, error: "Request body too large" };
    }
    if (isOverBudget(error)) {
      // The body outgrew what the caller could commit to. A load condition,
      // not a fault of this request, so the same retryable answer a refused
      // admission gets.
      return {
        ok: false,
        status: 503,
        error: "Too many uploads are being processed right now",
      };
    }
    if (isBodyStalled(error)) {
      // 408, not 400: the request was well-formed as far as it got, and the
      // caller may legitimately retry it. Distinguishing it also means a
      // stalled upload is diagnosable as a stall rather than showing up in
      // the same bucket as malformed multipart.
      return { ok: false, status: 408, error: "Request body stalled" };
    }
    return { ok: false, status: 400, error: "Malformed multipart form body" };
  }
}

/**
 * How far into the body the declared part's header block is looked for.
 *
 * A part header block is a boundary line plus two short header lines — a few
 * hundred bytes for anything a browser sends — and this searches *every* part
 * in range, not just the first, so a form with a caption or tags field ahead
 * of the file input is still read correctly. 8 KiB is generous room for those
 * plus a long filename without being a meaningful allocation, and the give-up
 * behaviour is the caller's fallback rather than a rejection.
 *
 * A threshold rather than a hard byte bound: a chunk cannot be half-read, so
 * the search stops at the first chunk that takes it past this and the bytes
 * held can exceed it by one chunk. That matters only to the accounting in
 * src/lib/upload-memory.ts, which says so.
 */
export const PART_HEADER_PEEK_BYTES = 8 * 1024;

export interface PeekedMultipartBody {
  /**
   * Lower-cased media type declared by the part named `fieldName`, with any
   * parameters left on. Null when that part's header block was not found
   * within {@link PART_HEADER_PEEK_BYTES}, when the boundary could not be
   * read, or when the part carries no Content-Type.
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

/** `boundary=...`, quoted or bare, out of a multipart Content-Type header. */
const BOUNDARY_PARAM = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^\s;]+))/i;

/**
 * The multipart boundary a request declares, or null if it declares none.
 *
 * Exported because the peek below is useless without it and the caller is
 * the one holding the headers.
 */
export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = BOUNDARY_PARAM.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  return boundary ? boundary : null;
}

/**
 * Reads the *declaration* on one named part without reading the body.
 *
 * Multipart sends each part's headers before its data, so the headers of
 * every part up to and including the file arrive in the first few hundred
 * bytes. Knowing what the file part declares lets the caller size the cap
 * (and its memory reservation) for the kind of file this actually claims to
 * be, instead of for the largest upload the route accepts from anyone. That
 * is the difference between rejecting an oversized image at ~10 MB and
 * rejecting it at ~205 MB, which is what this route used to do
 * (ugcportal-05b).
 *
 * Framing is split on the declared `boundary`, not guessed, and every part in
 * range is searched rather than only the first. The earlier version read the
 * first part and gave up if it was some other field — so a form that rendered
 * a caption input before the file input fell back to the whole-request cap
 * and, on a chunked request, reserved ~430 MB for a 100 KB photo. An ordinary
 * form shape must not cost that.
 *
 * This is still a peek and not a parser: it finds header blocks and reads two
 * header values out of them. The platform does the real multipart parsing, on
 * a stream that replays everything read here. Anything unexpected — no
 * boundary, the part not reached in range, no Content-Type — yields `null`
 * and the caller's fallback, so a body this cannot read is bounded exactly as
 * well as it was before, never worse.
 *
 * The read is idle-bounded by {@link BODY_STALL_TIMEOUT_MS}, which is what
 * ugcportal-dvb was about: this await happens before the caller has reserved
 * anything, so a client that sends a valid multipart Content-Type and ~100
 * bytes and then goes quiet costs no memory at all — but it used to hold the
 * request slot until Node's `requestTimeout`, because the only stall guard on
 * the path was installed afterwards, by {@link readCappedFormDataFrom}. A
 * stall now cancels the request body here and is re-raised on the returned
 * stream, where the caller's existing handling answers 408.
 */
export async function peekDeclaredPartType(
  body: ReadableStream<Uint8Array>,
  options: {
    fieldName: string;
    boundary: string | null;
    maxHeaderBytes?: number;
    /** Overrides {@link BODY_STALL_TIMEOUT_MS}; exposed for tests. */
    stallTimeoutMs?: number;
  },
): Promise<PeekedMultipartBody> {
  const maxHeaderBytes = options.maxHeaderBytes ?? PART_HEADER_PEEK_BYTES;
  // The guard goes on before the first read and before the boundary early-out
  // below, so every stream this function returns carries it and no path
  // through here can read the body unguarded (ugcportal-dvb). It used to be
  // installed by readCappedFormDataFrom, which runs after this function has
  // already awaited the client.
  const guarded = stallGuarded(
    body,
    options.stallTimeoutMs ?? BODY_STALL_TIMEOUT_MS,
  );
  const reader = guarded.getReader();
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let text = "";
  let declaredContentType: string | null = null;
  let ended = false;
  let stall: unknown = null;

  if (options.boundary === null) {
    reader.releaseLock();
    return { declaredContentType: null, body: guarded };
  }

  try {
    while (declaredContentType === null && headBytes < maxHeaderBytes) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      head.push(value);
      headBytes += value.byteLength;
      // Latin-1 rather than UTF-8 so a multi-byte sequence straddling a chunk
      // boundary cannot turn into a replacement character and shift the
      // indices this search returns. Header names, the boundary and the media
      // type are all ASCII; a non-ASCII filename decodes to mojibake we never
      // look at.
      text += Buffer.from(value).toString("latin1");
      declaredContentType = findDeclaredType(
        text,
        options.boundary,
        options.fieldName,
      );
    }
  } catch (error) {
    // A broken or reset connection is reported by the parse below, on the
    // replayed stream, rather than as a distinct error here.
    ended = true;
    // A stall is the exception, and is carried rather than flattened into a
    // truncated body: the guard has already cancelled the source, and a
    // truncated body would be parsed as malformed multipart and answered 400.
    // Re-emitted after the head so the single reader of this stream reaches
    // the same 408 as a stall anywhere else in the read.
    if (isBodyStalled(error)) stall = error;
  }

  return {
    declaredContentType,
    body: replay(head, ended ? null : reader, stall),
  };
}

/** `name="file"` out of a Content-Disposition line (RFC 7578 quoted-string). */
const DISPOSITION_NAME = /;\s*name\s*=\s*"([^"]*)"/i;
const CONTENT_TYPE_LINE = /^content-type:[ \t]*([^\r\n]+)$/im;
const CONTENT_DISPOSITION_LINE = /^content-disposition:[ \t]*([^\r\n]+)$/im;

/**
 * The media type declared by `fieldName`, from as much of the body as has
 * arrived, or null if that part's headers are not complete yet.
 *
 * Anchored on the delimiter so a part *body* that happens to contain
 * something shaped like a header cannot be mistaken for one: only the bytes
 * immediately after a delimiter, up to the first blank line, are read as
 * headers. Without that, a caption field whose value contained
 * "Content-Disposition: form-data; name=\"file\"" would choose this
 * request's cap.
 */
function findDeclaredType(
  text: string,
  boundary: string,
  fieldName: string,
): string | null {
  const delimiter = `--${boundary}\r\n`;
  let cursor = text.indexOf(delimiter);
  while (cursor >= 0) {
    const blockStart = cursor + delimiter.length;
    const blockEnd = text.indexOf(HEADER_TERMINATOR, blockStart);
    // Headers not fully arrived; a later chunk may complete them.
    if (blockEnd < 0) return null;

    const block = text.slice(blockStart, blockEnd);
    const disposition = CONTENT_DISPOSITION_LINE.exec(block)?.[1];
    if (disposition && DISPOSITION_NAME.exec(disposition)?.[1] === fieldName) {
      const contentType = CONTENT_TYPE_LINE.exec(block)?.[1];
      // The named part was found. Whether or not it declared a type, there is
      // nothing further to look for — returning "" rather than null says
      // "found, declared nothing", which the caller prices differently from
      // "not found".
      return contentType ? contentType.trim().toLowerCase() : "";
    }

    cursor = text.indexOf(delimiter, blockEnd);
  }
  return null;
}

/**
 * A stream that emits the already-consumed chunks, then whatever is left.
 *
 * `reader` is null when the source is already exhausted (or errored), in
 * which case the replayed head is the whole body.
 *
 * `failure`, when given, is raised once the head has been replayed instead of
 * closing the stream — so a read that ended in a stall ends this stream in a
 * stall too, rather than looking to the parser like a body that simply
 * stopped. The head is still emitted first: it is the bytes the client really
 * sent, and withholding them would change what the error is about.
 */
function replay(
  head: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
  failure: unknown = null,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < head.length) {
        controller.enqueue(head[index++]);
        return;
      }
      if (failure !== null) {
        controller.error(failure);
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
