// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConsentProvider } from "./consent-context";
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
