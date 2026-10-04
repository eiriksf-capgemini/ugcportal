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
