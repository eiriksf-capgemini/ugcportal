// @vitest-environment jsdom
import { act, useEffect } from "react";
import { describe, expect, it } from "vitest";

import { ConsentProvider, useConsent } from "./consent-context";
import { setupConsentTestRoot } from "./consent-test-support";
import { COOKIE_BANNER_DECLINE_LABEL, CookieBanner } from "./cookie-banner";
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
 * ugcportal-ysub item 7 (LOW, Safari). The banner used to work out which
 * control to return focus to by reading `document.activeElement` at the
 * moment it opened. WebKit does not move focus to a clicked `<button>` at
 * all, so on Safari that read `<body>` — and `<body>` is focusable enough
 * that `.focus()` on it succeeds, so the banner's "that didn't take, use
 * the fallback" branch never fired either. The invoker is now passed
 * explicitly from the click event's `currentTarget`, which does not depend
 * on the browser having focused anything.
 *
 * jsdom reproduces the Safari shape exactly: `dispatchEvent(new
 * MouseEvent("click"))` fires the handler without focusing the target, so
 * this test runs the real wiring through the real failure condition.
 */
describe("hands the clicked control to the banner as the focus-restore target (ugcportal-ysub item 7)", () => {
  function buttonLabelled(label: string): HTMLButtonElement {
    const match = [...ctx.container().querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (!match) throw new Error(`no button labelled "${label}"`);
    return match;
  }

  it("returns focus to the 'Cookies' button after the banner it opened is dismissed", () => {
    act(() => {
      ctx.root().render(
        <ConsentProvider initialConsent="granted">
          <CookieSettingsLink />
          <CookieBanner />
        </ConsentProvider>,
      );
    });

    const cookiesButton = buttonLabelled("Cookies");
    // The precondition this whole fix is about, asserted BEFORE the click
    // and about `document.activeElement` — which is the thing the old
    // implementation read (review round 2, LOW: the previous version of
    // this line compared the BUTTON to `document.body`, two values that
    // can never be equal, so it had no failing case and did not read
    // activeElement at all). Nothing has focused this button, and jsdom's
    // `dispatchEvent` will not either: exactly WebKit's behaviour.
    expect(document.activeElement).not.toBe(cookiesButton);
    act(() => {
      cookiesButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    act(() => {
      buttonLabelled(COOKIE_BANNER_DECLINE_LABEL).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(document.activeElement).toBe(cookiesButton);
  });

  it("MUTATION CHECK: a banner that was never opened by this control does not steal focus to it on dismiss", () => {
    // Fixture mutation: same components, but the banner is already open at
    // mount (a first visit, no stored choice), so nothing invoked it and
    // there is nothing to restore to. If the assertion above were passing
    // because the banner focuses this button on every close, this would
    // fail.
    act(() => {
      ctx.root().render(
        <ConsentProvider initialConsent={null}>
          <CookieSettingsLink />
          <CookieBanner />
        </ConsentProvider>,
      );
    });

    const cookiesButton = buttonLabelled("Cookies");
    act(() => {
      buttonLabelled(COOKIE_BANNER_DECLINE_LABEL).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(document.activeElement).not.toBe(cookiesButton);
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
