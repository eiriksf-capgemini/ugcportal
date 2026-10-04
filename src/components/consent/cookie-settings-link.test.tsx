// @vitest-environment jsdom
import { act, useEffect } from "react";
import { describe, expect, it } from "vitest";

import { ConsentProvider, useConsent } from "./consent-context";
import { setupConsentTestRoot } from "./consent-test-support";
import { CookieSettingsLink } from "./cookie-settings-link";

/**
 * K4: "a way to change or withdraw the choice later that is as easy as
 * giving it". This asserts the control is a real, labelled, focusable
 * button that reopens the banner — the full round-trip (reopen -> choose
 * again -> script stops/cookies clear) is covered end-to-end in
 * analytics-loader.test.tsx; this file is just the control itself.
 */

const ctx = setupConsentTestRoot();

let bannerOpenRef: boolean | undefined;

function Probe() {
  const { bannerOpen } = useConsent();
  useEffect(() => {
    bannerOpenRef = bannerOpen;
  });
  return null;
}

it("is labelled 'Cookies' and is a real button, not a link", () => {
  act(() => {
    ctx.root().render(
      <ConsentProvider initialConsent="granted">
        <CookieSettingsLink />
      </ConsentProvider>,
    );
  });
  const button = ctx.container().querySelector("button");
  expect(button).not.toBeNull();
  expect(button?.textContent).toBe("Cookies");
  expect(button?.tagName).toBe("BUTTON");
});

describe("clicking it", () => {
  it("reopens the banner even though a choice was already made", () => {
    act(() => {
      ctx.root().render(
        <ConsentProvider initialConsent="granted">
          <Probe />
          <CookieSettingsLink />
        </ConsentProvider>,
      );
    });
    expect(bannerOpenRef).toBe(false);

    const button = ctx.container().querySelector("button");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(bannerOpenRef).toBe(true);
  });
});

/**
 * Review round 5, LOW finding 7: without a ConsentProvider above it,
 * CookieSettingsLink previously called the throwing `useConsent()` and
 * crashed whatever rendered it (app-shell.tsx's own doc comment used to
 * document this as a HARD dependency for exactly that reason). It now uses
 * `useOptionalConsent()` and renders nothing instead.
 */
describe("without a ConsentProvider (round 5, finding 7)", () => {
  it("does not throw when mounted with no ConsentProvider above it", () => {
    expect(() => {
      act(() => {
        ctx.root().render(<CookieSettingsLink />);
      });
    }).not.toThrow();
  });

  it("renders nothing (no button at all) with no ConsentProvider above it", () => {
    act(() => {
      ctx.root().render(<CookieSettingsLink />);
    });
    expect(ctx.container().querySelector("button")).toBeNull();
    expect(ctx.container().textContent).toBe("");
  });

  it("MUTATION CHECK: still renders the real button once a ConsentProvider IS present (proves the test above isn't vacuously true)", () => {
    act(() => {
      ctx.root().render(
        <ConsentProvider initialConsent="granted">
          <CookieSettingsLink />
        </ConsentProvider>,
      );
    });
    const button = ctx.container().querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Cookies");
  });
});
