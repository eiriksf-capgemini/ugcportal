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

const { AnalyticsLoader, ANALYTICS_COOKIE_NAMES, clearAnalyticsCookies } =
  await import("./analytics-loader");
const { ConsentProvider, useConsent } = await import("./consent-context");

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
  for (const name of ANALYTICS_COOKIE_NAMES) {
    document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
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

  it("removes the analytics cookies the client can see", () => {
    setAnalyticsEnv();
    // Simulate the script having set its cache cookie while consent was
    // granted.
    for (const name of ANALYTICS_COOKIE_NAMES) {
      document.cookie = `${name}=some-value; Path=/`;
    }
    expect(document.cookie).toContain(ANALYTICS_COOKIE_NAMES[0]);

    mount("granted");

    act(() => {
      actionsRef?.reopen();
      actionsRef?.onlyNecessary();
    });

    for (const name of ANALYTICS_COOKIE_NAMES) {
      expect(document.cookie).not.toContain(`${name}=some-value`);
    }
  });

  it("MUTATION CHECK: clearAnalyticsCookies actually removes a cookie it names, not a no-op", () => {
    document.cookie = `${ANALYTICS_COOKIE_NAMES[0]}=present; Path=/`;
    expect(document.cookie).toContain(`${ANALYTICS_COOKIE_NAMES[0]}=present`);

    clearAnalyticsCookies();

    expect(document.cookie).not.toContain(`${ANALYTICS_COOKIE_NAMES[0]}=present`);
  });
});

describe("env vars unset (today's real deployment state)", () => {
  it("renders nothing even when consent is granted", () => {
    clearAnalyticsEnv();
    mount("granted");
    expect(scriptMock).not.toHaveBeenCalled();
  });
});
