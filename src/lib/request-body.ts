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
 * These are lifted from `src/app/api/media/route.ts` and
 * `src/app/api/media/[id]/route.ts`, which still carry their own copies:
 * both files belong to an in-flight branch (ugcportal-r1d) that this one must
 * not edit. Switching them over and deleting the copies is ugcportal-e15.
 * Until then a fix here needs applying there too.
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

  const headers = new Headers(request.headers);
  headers.delete("content-length");

  const reframed = new Request(request.url, {
    method: request.method,
    headers,
    body: cappedBody(request.body, limit),
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
