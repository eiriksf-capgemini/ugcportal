// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONSENT_COOKIE_NAME, readStoredConsent } from "@/lib/consent";

import { ConsentProvider, useConsent } from "./consent-context";

/**
 * createRoot/act mounting, same pattern as src/app/upload/upload-form.clock
 * .test.tsx and its siblings — the one other place in this repo that needs a
 * real DOM and real state transitions rather than a single static render.
 */

let container: HTMLDivElement;
let root: Root;

function clearCookie(): void {
  document.cookie = `${CONSENT_COOKIE_NAME}=; Max-Age=0; Path=/`;
}

beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  clearCookie();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

type Snapshot = {
  consent: string | null;
  bannerOpen: boolean;
};

let latest: Snapshot | null = null;

function Probe({
  onAction,
}: {
  onAction?: (actions: ReturnType<typeof useConsent>) => void;
}) {
  const value = useConsent();
  // Capturing into module-level state for the test to read is a side
  // effect, so it belongs in an effect, not directly in render.
  useEffect(() => {
    latest = { consent: value.consent, bannerOpen: value.bannerOpen };
    onAction?.(value);
  });
  return null;
}

function mount(
  initialConsent: "granted" | "denied" | null,
  onAction?: (actions: ReturnType<typeof useConsent>) => void,
): void {
  act(() => {
    root.render(
      <ConsentProvider initialConsent={initialConsent}>
        <Probe onAction={onAction} />
      </ConsentProvider>,
    );
  });
}

describe("ConsentProvider initial state", () => {
  it("opens the banner when there is no stored choice", () => {
    mount(null);
    expect(latest?.consent).toBeNull();
    expect(latest?.bannerOpen).toBe(true);
  });

  it("does not open the banner when consent was already granted", () => {
    mount("granted");
    expect(latest?.consent).toBe("granted");
    expect(latest?.bannerOpen).toBe(false);
  });

  it("does not open the banner when consent was already denied", () => {
    mount("denied");
    expect(latest?.consent).toBe("denied");
    expect(latest?.bannerOpen).toBe(false);
  });
});

describe("ConsentProvider actions", () => {
  it("acceptOptional: sets consent to granted, closes the banner, and persists the cookie", () => {
    let actions: ReturnType<typeof useConsent> | undefined;
    mount(null, (value) => {
      actions = value;
    });

    act(() => {
      actions?.acceptOptional();
    });

    expect(latest?.consent).toBe("granted");
    expect(latest?.bannerOpen).toBe(false);
    expect(readStoredConsent()).toBe("granted");
  });

  it("onlyNecessary: sets consent to denied, closes the banner, and persists the cookie", () => {
    let actions: ReturnType<typeof useConsent> | undefined;
    mount(null, (value) => {
      actions = value;
    });

    act(() => {
      actions?.onlyNecessary();
    });

    expect(latest?.consent).toBe("denied");
    expect(latest?.bannerOpen).toBe(false);
    expect(readStoredConsent()).toBe("denied");
  });

  it("reopen: reopens the banner without touching the stored consent (K4)", () => {
    let actions: ReturnType<typeof useConsent> | undefined;
    mount("granted", (value) => {
      actions = value;
    });

    act(() => {
      actions?.reopen();
    });

    expect(latest?.bannerOpen).toBe(true);
    // The whole point of K4: reopening is not an implicit withdrawal.
    // AnalyticsLoader must keep reading "granted" while the banner is
    // merely reopened, until a NEW choice is actually made.
    expect(latest?.consent).toBe("granted");
  });

  it("switching the choice after reopening overwrites the earlier one (K4 withdrawal)", () => {
    let actions: ReturnType<typeof useConsent> | undefined;
    mount("granted", (value) => {
      actions = value;
    });

    act(() => {
      actions?.reopen();
    });
    act(() => {
      actions?.onlyNecessary();
    });

    expect(latest?.consent).toBe("denied");
    expect(latest?.bannerOpen).toBe(false);
    expect(readStoredConsent()).toBe("denied");
  });
});

describe("useConsent outside a provider", () => {
  it("throws rather than silently reporting no choice", () => {
    expect(() => {
      act(() => {
        root.render(<Probe />);
      });
    }).toThrow(/useConsent must be used within a ConsentProvider/);
  });
});
