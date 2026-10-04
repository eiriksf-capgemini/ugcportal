import { describe, expect, it } from "vitest";

import { trySilently } from "./try-silently";

/**
 * Review round 5, LOW finding 5: this is the one shared try/catch-and-
 * swallow helper now used by both src/lib/cookies.ts (around
 * document.cookie) and src/components/consent/analytics-loader.tsx's
 * withUmamiDisableFlag (around window.localStorage) — see each call site's
 * own comment pointing back here.
 */
describe("trySilently", () => {
  it("returns fn's return value when it does not throw", () => {
    expect(trySilently(() => 42)).toBe(42);
  });

  it("returns null through unchanged when fn itself returns null", () => {
    expect(trySilently(() => null)).toBeNull();
  });

  it("returns undefined, swallowing the error, when fn throws", () => {
    expect(() =>
      trySilently(() => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    expect(
      trySilently(() => {
        throw new Error("boom");
      }),
    ).toBeUndefined();
  });

  it("swallows a thrown DOMException specifically (the real SecurityError shape both call sites guard against)", () => {
    expect(() =>
      trySilently(() => {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      }),
    ).not.toThrow();
  });

  it("actually invokes fn — not a no-op that always returns undefined", () => {
    let calls = 0;
    trySilently(() => {
      calls += 1;
      return calls;
    });
    expect(calls).toBe(1);
  });

  it("MUTATION CHECK: a version that does not call fn at all would also 'pass' a less careful version of the test above", () => {
    // Fixture mutation, not a production-code change: reproduces a
    // plausible but wrong implementation (one that swallows everything
    // unconditionally, never actually running fn) and confirms the
    // side-effect assertion above is what catches it.
    function noopTrySilently<T>(fn: () => T): T | undefined {
      void fn; // deliberately never called — that is the bug being reproduced.
      return undefined;
    }
    let calls = 0;
    noopTrySilently(() => {
      calls += 1;
      return calls;
    });
    expect(calls).toBe(0); // the bug: fn was never actually invoked.
  });
});
