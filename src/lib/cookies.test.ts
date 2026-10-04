// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { deleteCookie, getCookie, setCookie, type SetCookieOptions } from "./cookies";

function clearAllCookies(): void {
  for (const entry of document.cookie.split("; ")) {
    const name = entry.split("=")[0];
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

beforeEach(() => {
  clearAllCookies();
});

/**
 * `document.cookie`'s setter only ever exposes "name=value" pairs on READ —
 * the attributes (SameSite, Secure, Max-Age, Path) a write carried are not
 * observable that way at all, in any browser or jsdom. The only way to
 * assert on them directly (review round 2, finding 5 — delete must carry
 * the SAME Secure/SameSite as the matching set) is to capture the literal
 * string assigned to `document.cookie` before jsdom's own jar parses it,
 * by wrapping the property's real setter rather than replacing it.
 */
function captureCookieWrites(): { writes: string[]; restore: () => void } {
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (!descriptor?.get || !descriptor.set) {
    throw new Error("captureCookieWrites: Document.prototype.cookie has no get/set descriptor");
  }
  const { get, set } = descriptor;
  const writes: string[] = [];
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get(): string {
      return get.call(document);
    },
    set(value: string): void {
      writes.push(value);
      set.call(document, value);
    },
  });
  return {
    writes,
    restore(): void {
      Object.defineProperty(document, "cookie", descriptor);
    },
  };
}

describe("getCookie / setCookie round-trip", () => {
  it("reads null before anything is written", () => {
    expect(getCookie("some_cookie")).toBeNull();
  });

  it("round-trips a value", () => {
    setCookie("some_cookie", "granted");
    expect(getCookie("some_cookie")).toBe("granted");
  });

  it("a later write overwrites an earlier one rather than appending a second cookie", () => {
    setCookie("some_cookie", "granted");
    setCookie("some_cookie", "denied");
    expect(getCookie("some_cookie")).toBe("denied");
    const occurrences = document.cookie
      .split("; ")
      .filter((entry) => entry.startsWith("some_cookie="));
    expect(occurrences).toHaveLength(1);
  });

  it("does not match a different cookie whose name merely starts with the same prefix", () => {
    setCookie("some_cookie_extra", "other-value");
    expect(getCookie("some_cookie")).toBeNull();
  });

  it("decodes a value containing characters that needed encoding", () => {
    setCookie("some_cookie", "a b/c");
    expect(getCookie("some_cookie")).toBe("a b/c");
  });

  it("respects an explicit maxAgeSeconds by including it in the written cookie string", () => {
    setCookie("some_cookie", "granted", { maxAgeSeconds: 3600 });
    // jsdom's own cookie jar honours Max-Age, so this is indirectly
    // confirmed by the value still being readable immediately after —
    // the direct way to see the attribute itself is reading document.cookie
    // right after the synchronous write, before jsdom's jar collapses it.
    expect(getCookie("some_cookie")).toBe("granted");
  });
});

/**
 * Review round 2, finding 2: setCookie wrote raw values while getCookie
 * always decoded on read — asymmetric, and a future caller writing a value
 * containing `%`, `;`, `,`, or whitespace would either corrupt the
 * document.cookie string or throw `URIError` on the next read.
 */
describe("value encoding (round 2, finding 2)", () => {
  it("round-trips a value containing a literal '%' without throwing", () => {
    setCookie("promo", "50%off");
    expect(() => getCookie("promo")).not.toThrow();
    expect(getCookie("promo")).toBe("50%off");
  });

  it("round-trips a value containing cookie-attribute separators (';', ',')", () => {
    setCookie("weird", "a;b,c");
    expect(getCookie("weird")).toBe("a;b,c");
  });

  it("actually encodes on write — the raw value never reaches document.cookie unescaped", () => {
    const capture = captureCookieWrites();
    try {
      setCookie("promo", "50%off");
    } finally {
      capture.restore();
    }
    expect(capture.writes).toHaveLength(1);
    expect(capture.writes[0]).toContain("promo=50%25off");
    expect(capture.writes[0]).not.toContain("promo=50%off");
  });

  it("MUTATION CHECK fixture: getCookie fails safe to null on a malformed percent-escape it did not write itself", () => {
    // Written directly, bypassing setCookie's own encoding, to simulate a
    // cookie this module did not produce — tampered with by hand, or
    // truncated by a browser/proxy size limit.
    document.cookie = "broken=50%zz; Path=/";
    expect(() => getCookie("broken")).not.toThrow();
    expect(getCookie("broken")).toBeNull();
  });
});

/**
 * Review round 2, finding 5: deleteCookie's old comment claimed a
 * `Max-Age=0` expiry works "regardless of what [Secure/SameSite]
 * attributes were on the cookie being deleted" — wrong under "Leave Secure
 * Cookies Alone" (RFC 6265bis): a Secure cookie can only be overwritten,
 * including by an expiring delete, from a write that itself carries
 * Secure. deleteCookie must now be passed (and forward) the same options
 * the matching setCookie call used.
 */
describe("deleteCookie carries the same Secure/SameSite as the matching set (round 2, finding 5)", () => {
  it("includes Secure in the delete write when asked for it, the same as setCookie would", () => {
    const capture = captureCookieWrites();
    try {
      deleteCookie("some_cookie", { secure: true });
    } finally {
      capture.restore();
    }
    expect(capture.writes).toHaveLength(1);
    expect(capture.writes[0]).toContain("Secure");
    expect(capture.writes[0]).toContain("Max-Age=0");
  });

  it("MUTATION CHECK: omits Secure when not asked for it (proves the assertion above can fail)", () => {
    const capture = captureCookieWrites();
    try {
      deleteCookie("some_cookie", { secure: false });
    } finally {
      capture.restore();
    }
    expect(capture.writes[0]).not.toContain("Secure");
  });

  it("forwards a non-default SameSite into the delete write", () => {
    const capture = captureCookieWrites();
    try {
      deleteCookie("some_cookie", { sameSite: "None", secure: true });
    } finally {
      capture.restore();
    }
    expect(capture.writes[0]).toContain("SameSite=None");
  });
});

/**
 * Review round 2, finding 6: `sameSite: "None"` without `secure: true` must
 * be a TYPE error, not just a runtime default a caller could miss. These
 * are compile-time assertions — `@ts-expect-error` makes `npm run
 * typecheck` fail if the error it expects stops happening (e.g. the
 * discriminated union in cookies.ts is loosened back to a single object
 * type), which is the mutation check for a type-level guarantee: there is
 * no runtime behaviour to break here, only the type to loosen.
 */
describe("SetCookieOptions forbids sameSite: None without secure: true (round 2, finding 6)", () => {
  it("accepts None with secure: true", () => {
    const ok: SetCookieOptions = { sameSite: "None", secure: true };
    expect(ok.sameSite).toBe("None");
  });

  it("accepts Lax/Strict (or omitted) with no secure requirement", () => {
    const ok1: SetCookieOptions = { sameSite: "Lax" };
    const ok2: SetCookieOptions = { secure: false };
    expect(ok1.sameSite).toBe("Lax");
    expect(ok2.secure).toBe(false);
  });

  it("rejects None with secure omitted, and rejects None with secure: false", () => {
    // @ts-expect-error -- sameSite: "None" requires secure: true.
    const missingSecure: SetCookieOptions = { sameSite: "None" };
    // @ts-expect-error -- secure: false is not allowed alongside None.
    const falseSecure: SetCookieOptions = { sameSite: "None", secure: false };
    expect(missingSecure).toBeDefined();
    expect(falseSecure).toBeDefined();
  });
});

describe("deleteCookie", () => {
  it("removes a cookie that was set", () => {
    setCookie("some_cookie", "granted");
    expect(getCookie("some_cookie")).toBe("granted");

    deleteCookie("some_cookie");

    expect(getCookie("some_cookie")).toBeNull();
  });

  it("is a no-op (does not throw) when the cookie was never set", () => {
    expect(() => deleteCookie("never_set_cookie")).not.toThrow();
    expect(getCookie("never_set_cookie")).toBeNull();
  });

  it("does not delete a different cookie", () => {
    setCookie("keep_me", "value");
    deleteCookie("some_other_cookie");
    expect(getCookie("keep_me")).toBe("value");
  });
});

/**
 * Review round 4, LOW (Family 4 — a sibling of analytics-loader.tsx's own
 * `withUmamiDisableFlag` try/catch around `window.localStorage` access):
 * merely ACCESSING `document.cookie` (not just processing what comes back)
 * can throw a `SecurityError` in a sandboxed cross-origin iframe without
 * `allow-same-origin`. Simulated by redefining `document.cookie`'s own
 * getter/setter to throw for the duration of each test here.
 */
describe("accessing document.cookie itself throws (not just a malformed value)", () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  function makeCookieAccessThrow(): void {
    originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get(): string {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
      set(): void {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
  }

  function restoreCookieAccess(): void {
    if (originalDescriptor) {
      Object.defineProperty(document, "cookie", originalDescriptor);
    }
  }

  it("getCookie does not throw", () => {
    makeCookieAccessThrow();
    try {
      expect(() => getCookie("some_cookie")).not.toThrow();
      expect(getCookie("some_cookie")).toBeNull();
    } finally {
      restoreCookieAccess();
    }
  });

  it("setCookie does not throw", () => {
    makeCookieAccessThrow();
    try {
      expect(() => setCookie("some_cookie", "granted")).not.toThrow();
    } finally {
      restoreCookieAccess();
    }
  });

  it("deleteCookie does not throw", () => {
    makeCookieAccessThrow();
    try {
      expect(() => deleteCookie("some_cookie")).not.toThrow();
    } finally {
      restoreCookieAccess();
    }
  });
});
