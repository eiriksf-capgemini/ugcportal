import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `checkS3Reachability` takes its collaborators (`probe`, `env`, `timeoutMs`)
 * as parameters, the same convention every check in src/instrumentation.ts
 * already uses — so these tests exercise it directly, with a fake probe,
 * rather than mocking `@/lib/s3` or `@aws-sdk/client-s3`. The one test that
 * DOES go through the real `@/lib/s3` wiring (`registerNodeOnlyChecks`,
 * below) mocks that module explicitly, scoped to this file only.
 */
import { S3_REACHABILITY_TIMEOUT_MS, checkS3Reachability } from "@/instrumentation-node";

const ENDPOINT = "http://localhost:9000";

/** `NODE_ENV` is unused by this check (unconditional, like the sign-in check); only here to satisfy `NodeJS.ProcessEnv`'s required field. */
function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "development", ...vars } as NodeJS.ProcessEnv;
}

function transportError(code: string, message = `connect ${code} 127.0.0.1:9000`) {
  return Object.assign(new Error(message), { code });
}

describe("the S3 reachability startup check (ugcportal-ze1o)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * K1: "Given a configured S3 endpoint that is unreachable, when the
   * server boots, exactly one warning line is logged naming object storage
   * and the failure class, and the server still reaches ready." The
   * "logged" and "server still reaches ready" halves are `registerNodeOnlyChecks`'s
   * job (exercised below); this is the message-producing half.
   */
  it("names the endpoint and failure class, and resolves rather than throwing, when unreachable (K1)", async () => {
    const warning = await checkS3Reachability({
      probe: () => Promise.reject(transportError("ECONNREFUSED")),
      env: env({ S3_ENDPOINT: ENDPOINT }),
    });

    expect(warning).toContain(ENDPOINT);
    expect(warning).toContain("ECONNREFUSED");
    expect(warning).toContain("unreachable");
    expect(warning).toContain("docker compose up -d");
  });

  it("is quiet when the endpoint answers (K1, the needle-can-be-absent control)", async () => {
    const warning = await checkS3Reachability({
      probe: () => Promise.resolve(undefined),
      env: env({ S3_ENDPOINT: ENDPOINT }),
    });

    expect(warning).toBeNull();
  });

  it("names S3_ENDPOINT as not set, rather than throwing, when it is unset", async () => {
    const warning = await checkS3Reachability({
      probe: () => Promise.reject(transportError("ENOTFOUND")),
      env: env({}),
    });

    expect(warning).toContain("S3_ENDPOINT not set");
  });

  /**
   * Found by driving `npm run dev` with S3 entirely unconfigured (pre-review
   * step 6): `@/lib/s3`'s `requireEnv` throws a plain `Error` in that case
   * (before any network call is attempted), whose `.name` is the literal
   * string "Error" -- a code that reads as meaningful but names nothing,
   * same defect `classifyTransportFailure`'s own fallback in src/lib/s3.ts
   * already exists to avoid. This is the fixture-mutation check for that:
   * reverting `describeS3Failure` to a bare `error.name` fallback makes this
   * fail with "Error" where it expects "unknown".
   */
  it("falls back to \"unknown\", not the bare word \"Error\", for a plain Error", async () => {
    const warning = await checkS3Reachability({
      probe: () => Promise.reject(new Error("Missing required environment variable: S3_ENDPOINT")),
      env: env({}),
    });

    expect(warning).toContain("unknown");
    expect(warning).not.toMatch(/\(Error\)/);
  });

  it("names a timeout the same way a real one would be named, not by inventing a second label", async () => {
    vi.useFakeTimers();
    const resultPromise = checkS3Reachability({
      probe: () => new Promise(() => {}),
      env: env({ S3_ENDPOINT: ENDPOINT }),
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    const warning = await resultPromise;

    expect(warning).toContain("TimeoutError");
  });

  /**
   * K2: "Following should never happen: the check delaying or blocking
   * startup. An unreachable or hanging endpoint must not add more than the
   * configured timeout to boot, and must never prevent the server becoming
   * ready." Both halves of that are asserted directly: `settled` is false
   * one tick before the timeout and true the instant it elapses, so a
   * removed or lengthened timeout fails the first assertion, and a probe
   * that truly hung forever without the guard would fail the second (the
   * `await resultPromise` below would never resolve at all).
   */
  it("resolves within the configured timeout when the probe never settles, and still warns (K2)", async () => {
    vi.useFakeTimers();
    let settled = false;
    const resultPromise = checkS3Reachability({
      probe: () => new Promise(() => {}),
      env: env({ S3_ENDPOINT: ENDPOINT }),
      timeoutMs: 3_000,
    }).then((warning) => {
      settled = true;
      return warning;
    });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const warning = await resultPromise;
    expect(settled).toBe(true);
    expect(warning).toContain("unreachable");
  });

  it("uses the three-second default when no timeout is given (K2)", () => {
    expect(S3_REACHABILITY_TIMEOUT_MS).toBe(3_000);
  });

  /**
   * K3: "Following should never happen: this check running on a schedule,
   * retrying, or logging more than once per process." Advancing well past
   * any plausible interval or retry delay, with no second boot, is the
   * fixture that would catch a reintroduced `setInterval` or retry loop —
   * advancing by 0ms (or not at all) would not.
   */
  it("never invokes the probe again, however long the process keeps running (K3)", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(undefined);

    await checkS3Reachability({ probe, env: env({ S3_ENDPOINT: ENDPOINT }) });
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  /**
   * K3's other half: the test above uses a probe that resolves, so it only
   * proves there is no *scheduled* re-check after success. A single eager
   * retry on FAILURE (no loop, no timer — just calling `probe()` a second
   * time from inside the catch block) is the gap this closes directly on
   * the failure path: found and confirmed by fixture-mutating
   * `checkS3Reachability` to retry once inline on failure (pre-review),
   * this test fails as expected against that mutation. (Round-1 review
   * finding 4: a prior version of this suite also had a static source-regex
   * check here for `setInterval(`/`while(`, which this call-count assertion
   * already subsumes — it catches any retry shape, not just those two — so
   * the regex check was removed rather than kept as a narrower duplicate.)
   */
  it("never invokes the probe again after a failure, either (K3 failure-path)", async () => {
    const probe = vi.fn().mockRejectedValue(transportError("ECONNREFUSED"));

    await checkS3Reachability({ probe, env: env({ S3_ENDPOINT: ENDPOINT }) });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("never logs the probe error's message or a credential-shaped env value", async () => {
    const leaky = Object.assign(
      new Error(
        "SignatureDoesNotMatch: a leaked-looking-message with AKIAFAKEFAKEFAKE1234 inside it",
      ),
      { name: "CredentialsError" },
    );

    const warning = await checkS3Reachability({
      probe: () => Promise.reject(leaky),
      env: env({
        S3_ENDPOINT: ENDPOINT,
        S3_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE1234",
      }),
    });

    expect(warning).toContain("CredentialsError");
    expect(warning).not.toContain("AKIAFAKEFAKEFAKE1234");
    expect(warning).not.toContain("leaked-looking-message");
  });

  /**
   * Round-1 review finding 3: a configuration failure must not be reported
   * as "unreachable" — `getBucketName()` (`@/lib/s3`'s `requireEnv`) throws
   * a plain `Error` synchronously, before any network call, when
   * `S3_BUCKET_NAME` is unset; `classifyTransportFailure` does not
   * recognise it (no `$metadata`, no transport `code`), so this is exactly
   * the non-transport branch `checkS3Reachability` must word differently.
   * Fixture-mutated: reverting `checkS3Reachability` to always use the
   * "looks unreachable ... docker compose up -d" wording makes the second
   * assertion below fail.
   */
  it("names a missing S3_BUCKET_NAME as a configuration problem, not unreachable", async () => {
    const warning = await checkS3Reachability({
      probe: () =>
        Promise.reject(new Error("Missing required environment variable: S3_BUCKET_NAME")),
      env: env({ S3_ENDPOINT: ENDPOINT }),
    });

    expect(warning).toContain("rejected the request or is misconfigured");
    expect(warning).toContain("S3_* environment variables");
    expect(warning).not.toContain("unreachable");
    expect(warning).not.toContain("docker compose up -d");
  });

  /**
   * Round-1 review finding 3's other case: a reachable endpoint that
   * answers with a well-formed `AccessDenied` is not unreachable either —
   * `classifyTransportFailure` returns `null` for it (it has
   * `$metadata.httpStatusCode` set, which is the function's own signal that
   * a response was actually received). Fixture-mutated the same way as the
   * missing-bucket test above: reverting to the unconditional "looks
   * unreachable" wording makes the second assertion below fail.
   */
  it("names an AccessDenied response as a request rejection, not unreachable", async () => {
    const accessDenied = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403, attempts: 1 },
    });

    const warning = await checkS3Reachability({
      probe: () => Promise.reject(accessDenied),
      env: env({ S3_ENDPOINT: ENDPOINT }),
    });

    expect(warning).toContain("AccessDenied");
    expect(warning).toContain("rejected the request or is misconfigured");
    expect(warning).toContain("credentials");
    expect(warning).not.toContain("unreachable");
    expect(warning).not.toContain("docker compose up -d");
  });
});

/**
 * registerNodeOnlyChecks() is what src/instrumentation.ts's register()
 * actually calls; the tests above exercise checkS3Reachability's own logic
 * directly, so this one test proves the wiring instead — that
 * registerNodeOnlyChecks really does call through the real `@/lib/s3`
 * client (mocked here, scoped to this file only) and that a failure there
 * becomes exactly one logged `[storage]` line, same as every other check in
 * this module.
 */
describe("registerNodeOnlyChecks() wiring the S3 check through @/lib/s3 (ugcportal-ze1o)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("logs one [storage] line and resolves when the real S3 client rejects", async () => {
    // The top-level import of @/instrumentation-node above this describe
    // block already cached a real, unmocked instance; clear it before
    // doMock-ing its dependencies, or the dynamic import below would just
    // hand back that cached instance.
    vi.resetModules();
    vi.doMock("@/lib/s3", () => ({
      getS3Client: () => ({
        send: () => Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
      }),
      getBucketName: () => "ugcportal-dev",
      classifyTransportFailure: (error: unknown) =>
        error instanceof Error && "code" in error ? { code: String((error as { code: unknown }).code) } : null,
    }));
    vi.doMock("@/lib/legal/pages", () => ({ LEGAL_PAGES: [] }));
    vi.doMock("@/lib/legal/publishable", () => ({ checkLegalPagesPublishable: () => null }));

    const { registerNodeOnlyChecks } = await import("@/instrumentation-node");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(registerNodeOnlyChecks()).resolves.toBeUndefined();

    const storageLines = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[storage]"));
    expect(storageLines).toHaveLength(1);
    expect(storageLines[0]).toContain("ECONNREFUSED");
  });
});
