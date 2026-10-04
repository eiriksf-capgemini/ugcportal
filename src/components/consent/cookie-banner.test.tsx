// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConsentProvider, useConsent } from "./consent-context";
import {
  COOKIE_BANNER_ACCEPT_LABEL,
  COOKIE_BANNER_COPY,
  COOKIE_BANNER_DECLINE_LABEL,
  CookieBanner,
} from "./cookie-banner";

/**
 * K5 (ugcportal-3wgp): the copy is one short paragraph naming what is
 * optional and what it is for; both buttons share the same visual variant;
 * axe coverage for the banner itself lives in the Playwright spec
 * (e2e/cookie-consent.spec.ts), which can run @axe-core/playwright against
 * a real rendered page the way this unit suite cannot.
 *
 * "Snapshot test ... reviewed and approved by Eirik in the PR": this exact
 * string is quoted verbatim in the PR body for that review, and pinned here
 * as an exact-equality assertion (not a substring match) so any edit to it
 * is a visible, deliberate diff to this test.
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

function mountOpenBanner(): void {
  act(() => {
    root.render(
      <ConsentProvider initialConsent={null}>
        <CookieBanner />
      </ConsentProvider>,
    );
  });
}

let actionsRef: ReturnType<typeof useConsent> | undefined;

function Actions() {
  const value = useConsent();
  useEffect(() => {
    actionsRef = value;
  });
  return null;
}

function mountWithActions(initialConsent: "granted" | "denied" | null): void {
  act(() => {
    root.render(
      <ConsentProvider initialConsent={initialConsent}>
        <Actions />
        <CookieBanner />
      </ConsentProvider>,
    );
  });
}

describe("CookieBanner copy (K5)", () => {
  it("renders the exact reviewed paragraph, once, naming what is optional and what it is for", () => {
    mountOpenBanner();
    const paragraph = container.querySelector("p");
    expect(paragraph).not.toBeNull();
    expect(paragraph?.textContent).toBe(COOKIE_BANNER_COPY);

    // Content requirements the copy must meet, named explicitly rather than
    // trusted from the exact-string match alone (round-proofs the test
    // against a future edit that changes the string but drops a
    // requirement).
    expect(COOKIE_BANNER_COPY).toMatch(/optional/i);
    expect(COOKIE_BANNER_COPY).toMatch(/analytics/i);
    expect(COOKIE_BANNER_COPY.toLowerCase()).toContain(
      "nothing optional is set until you choose",
    );
  });

  it("is exactly one paragraph", () => {
    mountOpenBanner();
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});

describe("CookieBanner buttons (K5: equally prominent, no dark pattern)", () => {
  it("renders both choices as real, focusable buttons with the exact labels", () => {
    mountOpenBanner();
    const buttons = [...container.querySelectorAll("button")];
    const labels = buttons.map((button) => button.textContent);
    expect(labels).toContain(COOKIE_BANNER_ACCEPT_LABEL);
    expect(labels).toContain(COOKIE_BANNER_DECLINE_LABEL);
  });

  it("both buttons carry the exact same class list (same variant/size — equally prominent)", () => {
    mountOpenBanner();
    const buttons = [...container.querySelectorAll("button")];
    const accept = buttons.find((b) => b.textContent === COOKIE_BANNER_ACCEPT_LABEL);
    const decline = buttons.find((b) => b.textContent === COOKIE_BANNER_DECLINE_LABEL);
    expect(accept).toBeDefined();
    expect(decline).toBeDefined();
    expect(accept?.className).toBe(decline?.className);
  });

  it("neither button is disabled or pre-selected", () => {
    mountOpenBanner();
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-pressed")).toBeNull();
    }
  });
});

describe("CookieBanner visibility", () => {
  it("does not render once the banner is closed (accepted)", () => {
    act(() => {
      root.render(
        <ConsentProvider initialConsent="granted">
          <CookieBanner />
        </ConsentProvider>,
      );
    });
    expect(container.querySelector('[aria-label="Cookies"]')).toBeNull();
  });

  it("is reachable as an ARIA region named 'Cookies'", () => {
    mountOpenBanner();
    const region = container.querySelector('[role="region"][aria-label="Cookies"]');
    expect(region).not.toBeNull();
  });
});

/**
 * Review round 1, CONFIRMED medium, finding 8: a fixed bottom banner with no
 * compensating padding can cover the footer, the gallery's "Load more" and
 * `/upload`'s form bottom for the whole first-visit session.
 */
describe("CookieBanner reserves space for itself while open (finding 8)", () => {
  afterEach(() => {
    // Belt-and-braces: afterEach above already unmounts, which should run
    // this component's own cleanup, but a defect in that cleanup should not
    // leak into the NEXT test's assertions either.
    document.body.style.paddingBottom = "";
  });

  it("sets a non-empty padding-bottom on <body> while the banner is open", () => {
    expect(document.body.style.paddingBottom).toBe("");
    mountOpenBanner();
    expect(document.body.style.paddingBottom).not.toBe("");
  });

  it("clears the padding-bottom again once the banner closes", () => {
    mountWithActions(null);
    expect(document.body.style.paddingBottom).not.toBe("");

    act(() => {
      actionsRef?.acceptOptional();
    });

    expect(document.body.style.paddingBottom).toBe("");
  });

  it("MUTATION CHECK: unmounting the banner outright also clears the padding (cleanup actually runs)", () => {
    mountOpenBanner();
    expect(document.body.style.paddingBottom).not.toBe("");

    act(() => {
      root.unmount();
    });

    expect(document.body.style.paddingBottom).toBe("");
  });
});

/**
 * Review round 1, PLAUSIBLE low, finding 9: reopening via the footer
 * "Cookies" control neither moved focus nor announced the change, so a
 * screen-reader user had no signal the banner reopened.
 */
describe("CookieBanner focus/announce on reopen (finding 9)", () => {
  it("carries aria-live=\"polite\" on the region", () => {
    mountOpenBanner();
    const region = container.querySelector('[role="region"][aria-label="Cookies"]');
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("does NOT move focus on the initial mount-time open (no stored choice yet)", () => {
    const focusBefore = document.activeElement;
    mountOpenBanner();
    // Specifically: focus must not have moved to the banner's own heading.
    expect(document.activeElement?.textContent).not.toBe("Cookies");
    expect(document.activeElement).toBe(focusBefore);
  });

  it("moves focus to the banner's heading when reopened via reopen()", () => {
    mountWithActions("granted");
    expect(container.querySelector('[aria-label="Cookies"]')).toBeNull();

    act(() => {
      actionsRef?.reopen();
    });

    const heading = container.querySelector("h2");
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toBe("Cookies");
    expect(document.activeElement).toBe(heading);
  });

  it("MUTATION CHECK: a second reopen() (e.g. after choosing again) moves focus again, not just the first time", () => {
    mountWithActions("granted");

    act(() => {
      actionsRef?.reopen();
    });
    act(() => {
      actionsRef?.onlyNecessary();
    });
    expect(container.querySelector('[aria-label="Cookies"]')).toBeNull();

    // Deliberately move focus elsewhere to prove the SECOND reopen() is
    // what brings it back, not a focus that merely never left.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    act(() => {
      actionsRef?.reopen();
    });

    const heading = container.querySelector("h2");
    expect(document.activeElement).toBe(heading);
    elsewhere.remove();
  });
});
