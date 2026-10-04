// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readStoredConsent } from "@/lib/consent";

/**
 * K1-K4 (ugcportal-3wgp): AnalyticsLoader is the ONLY place a tracking
 * script may mount, and it must mount strictly when consent === "granted"
 * and both env vars are present.
 *
 * next/script is mocked with a spy standing in for "the script loader" the
 * K2 acceptance criterion names ("a stubbed script loader asserting it is
 * invoked exactly once after acceptance"): the real next/script component
 * does framework-internal work (dedup, injecting into <head> at the right
 * point in the page lifecycle) that is neither this bead's concern nor
 * something jsdom can observe directly, so the spy is what actually stands
 * in for "a script element was asked to load".
 */
const scriptMock = vi.fn((props: Record<string, unknown>) => {
  void props;
  return null;
});
vi.mock("next/script", () => ({
  default: (props: Record<string, unknown>) => scriptMock(props),
}));

const {
  AnalyticsLoader,
  ANALYTICS_COOKIE_NAMES,
  clearAnalyticsCookies,
  disableUmamiTracking,
  enableUmamiTracking,
} = await import("./analytics-loader");
const { ConsentProvider, useConsent } = await import("./consent-context");

// The exact key Umami's real tracker checks on every track call (confirmed
// against upstream umami-software/umami src/tracker/index.ts,
// `trackingDisabled()`); spelled out directly here rather than imported, so
// this test fails if analytics-loader.tsx ever renames its own constant
// without this test noticing the drift.
const UMAMI_DISABLE_STORAGE_KEY = "umami.disabled";

const ANALYTICS_SRC_VAR = "NEXT_PUBLIC_UMAMI_SRC";
const ANALYTICS_WEBSITE_ID_VAR = "NEXT_PUBLIC_UMAMI_WEBSITE_ID";

let container: HTMLDivElement;
let root: Root;

function setAnalyticsEnv(): void {
  process.env[ANALYTICS_SRC_VAR] = "https://analytics.example.com/script.js";
  process.env[ANALYTICS_WEBSITE_ID_VAR] = "test-website-id";
}

function clearAnalyticsEnv(): void {
  delete process.env[ANALYTICS_SRC_VAR];
  delete process.env[ANALYTICS_WEBSITE_ID_VAR];
}

beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  scriptMock.mockClear();
  clearAnalyticsEnv();
  window.localStorage.removeItem(UMAMI_DISABLE_STORAGE_KEY);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  clearAnalyticsEnv();
});

let actionsRef: ReturnType<typeof useConsent> | undefined;

function Actions() {
  const value = useConsent();
  useEffect(() => {
    actionsRef = value;
  });
  return null;
}

function mount(initialConsent: "granted" | "denied" | null): void {
  act(() => {
    root.render(
      <ConsentProvider initialConsent={initialConsent}>
        <Actions />
        <AnalyticsLoader />
      </ConsentProvider>,
    );
  });
}

describe("K1: first visit, no stored choice", () => {
  it("never invokes the script loader, even with analytics fully configured", () => {
    setAnalyticsEnv();
    mount(null);
    expect(scriptMock).not.toHaveBeenCalled();
  });
});

describe("K2: accepting optional cookies", () => {
  it("invokes the script loader exactly once once consent is granted", () => {
    setAnalyticsEnv();
    mount(null);
    expect(scriptMock).not.toHaveBeenCalled();

    act(() => {
      actionsRef?.acceptOptional();
    });

    expect(scriptMock).toHaveBeenCalledTimes(1);
    expect(scriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "https://analytics.example.com/script.js",
        "data-website-id": "test-website-id",
      }),
    );
  });

  it("MUTATION CHECK: stays at zero invocations if the stored choice is 'denied' instead", () => {
    // Mirrors the required mutation: store "denied" (not "granted") and
    // confirm the loader is never invoked — the fixture this K2 check names
    // explicitly.
    setAnalyticsEnv();
    mount("denied");
    expect(scriptMock).not.toHaveBeenCalled();
  });
});

describe("K3: only-necessary", () => {
  it("never invokes the script loader", () => {
    setAnalyticsEnv();
    mount(null);

    act(() => {
      actionsRef?.onlyNecessary();
    });

    expect(scriptMock).not.toHaveBeenCalled();
  });

  it("the stored 'denied' choice means the banner (and the loader) stay off across a later visit", () => {
    setAnalyticsEnv();
    mount(null);
    act(() => {
      actionsRef?.onlyNecessary();
    });

    // Simulate a later visit: a fresh ConsentProvider, seeded the way
    // src/app/layout.tsx would seed it — from the cookie written just now.
    act(() => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    mount(readStoredConsent());

    expect(actionsRef?.bannerOpen).toBe(false);
    expect(scriptMock).not.toHaveBeenCalled();
  });
});

describe("K4: withdrawal via the 'Cookies' control", () => {
  it("stops the script on the next render after switching granted -> denied", () => {
    setAnalyticsEnv();
    mount("granted");
    expect(scriptMock).toHaveBeenCalledTimes(1);

    scriptMock.mockClear();
    act(() => {
      actionsRef?.reopen();
      actionsRef?.onlyNecessary();
    });

    expect(scriptMock).not.toHaveBeenCalled();
  });

  /**
   * Review round 1, MEDIUM finding 1: removing <Script> from React's tree
   * stops a FUTURE mount, not an already-running tracker — next/script has
   * no unmount cleanup. The real fix is Umami's own documented runtime
   * opt-out, which its tracker checks on every track call, not just at
   * load (confirmed against upstream src/tracker/index.ts). This stub
   * reproduces that exact shape (a gate reading the same localStorage key
   * before every tracked call) without vendoring the real bundle, so a
   * regression that stops setting the real flag — or renames it — fails
   * this test the same way it would fail against the real script.
   */
  it("a stub tracker that already loaded stops making track calls after withdrawal, and the disable signal is set", () => {
    setAnalyticsEnv();
    let trackCallCount = 0;
    function stubTrack(): void {
      // The exact gate Umami's real tracker runs before every track call.
      if (window.localStorage.getItem(UMAMI_DISABLE_STORAGE_KEY)) return;
      trackCallCount += 1;
    }

    mount("granted");
    expect(window.localStorage.getItem(UMAMI_DISABLE_STORAGE_KEY)).toBeNull();
    stubTrack();
    expect(trackCallCount).toBe(1);

    act(() => {
      actionsRef?.reopen();
      actionsRef?.onlyNecessary();
    });

    expect(window.localStorage.getItem(UMAMI_DISABLE_STORAGE_KEY)).toBe("1");
    stubTrack();
    stubTrack();
    expect(trackCallCount).toBe(1); // no further track calls after withdrawal
  });

  it("re-enables tracking if consent is granted again after a prior withdrawal", () => {
    setAnalyticsEnv();
    mount("granted");
    act(() => {
      actionsRef?.reopen();
      actionsRef?.onlyNecessary();
    });
    expect(window.localStorage.getItem(UMAMI_DISABLE_STORAGE_KEY)).toBe("1");

    act(() => {
      actionsRef?.reopen();
      actionsRef?.acceptOptional();
    });

    expect(window.localStorage.getItem(UMAMI_DISABLE_STORAGE_KEY)).toBeNull();
  });

  it("MUTATION CHECK: disableUmamiTracking actually sets the flag, not a no-op", () => {
    expect(window.localStorage.getItem(UMAMI_DISABLE_STORAGE_KEY)).toBeNull();
    disableUmamiTracking();
    expect(window.localStorage.getItem(UMAMI_DISABLE_STORAGE_KEY)).toBe("1");
  });

  it("MUTATION CHECK: enableUmamiTracking actually clears the flag, not a no-op", () => {
    window.localStorage.setItem(UMAMI_DISABLE_STORAGE_KEY, "1");
    enableUmamiTracking();
    expect(window.localStorage.getItem(UMAMI_DISABLE_STORAGE_KEY)).toBeNull();
  });

  it("ANALYTICS_COOKIE_NAMES is empty today — Umami is confirmed cookieless (review round 1, finding 4)", () => {
    expect(ANALYTICS_COOKIE_NAMES).toEqual([]);
  });

  it("MUTATION CHECK: clearAnalyticsCookies actually removes a cookie it is given, not a no-op", () => {
    // No real Umami cookie exists to simulate (see the empty-array test
    // above); this proves the generic clearing mechanism itself works,
    // independent of which vendor is configured, by passing an explicit
    // name the way a future vendor's entry would.
    document.cookie = "a_future_vendor_cookie=present; Path=/";
    expect(document.cookie).toContain("a_future_vendor_cookie=present");

    clearAnalyticsCookies(["a_future_vendor_cookie"]);

    expect(document.cookie).not.toContain("a_future_vendor_cookie=present");
  });
});

describe("env vars unset (today's real deployment state)", () => {
  it("renders nothing even when consent is granted", () => {
    clearAnalyticsEnv();
    mount("granted");
    expect(scriptMock).not.toHaveBeenCalled();
  });
});
