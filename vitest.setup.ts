import { beforeEach } from "vitest";

/**
 * Environment variables the test suite must not inherit from the host
 * (ugcportal-e86).
 *
 * Every one of these changes how src/lib/watermark.ts sizes its concurrency
 * gate, so a developer or CI runner that happens to export one turns a green
 * suite red for reasons that have nothing to do with the code under test.
 * Observed: `UV_THREADPOOL_SIZE=2` failed two concurrency tests, and
 * `WATERMARK_MEMORY_BUDGET_MB=512` failed two *pre-existing* watermark tests
 * with "Too many previews are being generated right now".
 *
 * Scrubbed rather than snapshotted, because the failure mode is inheriting a
 * value nobody in the test file knows about. A test that wants one of these
 * set says so itself; anything it does not set is absent, on every machine.
 *
 * UV_THREADPOOL_SIZE is included even though deleting it cannot resize
 * libuv's already-initialised pool: what matters here is that
 * resolveConcurrencyCeiling() reads it, so leaving it set would make the
 * derived ceiling depend on the host.
 */
const HOST_VARS_THE_SUITE_MUST_NOT_INHERIT = [
  "UV_THREADPOOL_SIZE",
  "WATERMARK_TEXT",
  "WATERMARK_MEMORY_BUDGET_MB",
  "WATERMARK_MAX_CONCURRENCY",
  "WATERMARK_QUEUE_LIMIT",
  "WATERMARK_QUEUE_TIMEOUT_MS",
  "WATERMARK_SHARP_THREADS",
] as const;

function scrub(): void {
  for (const name of HOST_VARS_THE_SUITE_MUST_NOT_INHERIT) {
    delete process.env[name];
  }
}

// Once at file load, before the test module is imported, so a `const env =
// { ...process.env }` snapshot taken at collection time is already clean...
scrub();

// ...and again before each test, so one test leaking a value cannot reach the
// next. Runs before any beforeEach the test file registers, and before the
// test body, so a test that sets one of these itself still wins.
beforeEach(scrub);
