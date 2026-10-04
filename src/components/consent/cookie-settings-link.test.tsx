// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConsentProvider, useConsent } from "./consent-context";
import { CookieSettingsLink } from "./cookie-settings-link";

/**
 * K4: "a way to change or withdraw the choice later that is as easy as
 * giving it". This asserts the control is a real, labelled, focusable
 * button that reopens the banner — the full round-trip (reopen -> choose
 * again -> script stops/cookies clear) is covered end-to-end in
 * analytics-loader.test.tsx; this file is just the control itself.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
    root.render(
      <ConsentProvider initialConsent="granted">
        <CookieSettingsLink />
      </ConsentProvider>,
    );
  });
  const button = container.querySelector("button");
  expect(button).not.toBeNull();
  expect(button?.textContent).toBe("Cookies");
  expect(button?.tagName).toBe("BUTTON");
});

describe("clicking it", () => {
  it("reopens the banner even though a choice was already made", () => {
    act(() => {
      root.render(
        <ConsentProvider initialConsent="granted">
          <Probe />
          <CookieSettingsLink />
        </ConsentProvider>,
      );
    });
    expect(bannerOpenRef).toBe(false);

    const button = container.querySelector("button");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(bannerOpenRef).toBe(true);
  });
});
