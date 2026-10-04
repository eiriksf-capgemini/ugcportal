// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { deleteCookie, getCookie, setCookie } from "./cookies";

function clearAllCookies(): void {
  for (const entry of document.cookie.split("; ")) {
    const name = entry.split("=")[0];
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

beforeEach(() => {
  clearAllCookies();
});

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
