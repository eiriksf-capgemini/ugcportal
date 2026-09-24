export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Reads and JSON-parses a request body, never holding more than `limit`
 * bytes of it. App Router puts no default cap on a request body, so a route
 * that calls `request.json()` will happily buffer whatever the client sends.
 *
 * The Content-Length check is only a cheap early-out, deliberately not the
 * enforcement: the header is absent on a chunked request and can be
 * malformed, in which case `Number()` yields NaN and `NaN > limit` is false.
 * The read loop is what actually enforces the bound.
 *
 * This is the same logic as `readJsonBody` in
 * src/app/api/media/[id]/route.ts, lifted into a module so the next caller
 * has one to import rather than copy. It is not yet *shared* with that route:
 * that file is owned by an in-flight branch (ugcportal-r1d) and editing it
 * here would conflict. Switching it over is a follow-up bead — until then
 * there really are two copies, and a fix to one needs applying to both.
 */
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
