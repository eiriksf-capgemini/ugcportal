// @vitest-environment jsdom
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConsentProvider, useConsent } from "./consent-context";
import { setupConsentTestRoot } from "./consent-test-support";
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

const ctx = setupConsentTestRoot();

function mountOpenBanner(): void {
  act(() => {
    ctx.root().render(
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
    ctx.root().render(
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
    const paragraph = ctx.container().querySelector("p");
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
    expect(ctx.container().querySelectorAll("p")).toHaveLength(1);
  });
});

describe("CookieBanner buttons (K5: equally prominent, no dark pattern)", () => {
  it("renders both choices as real, focusable buttons with the exact labels", () => {
    mountOpenBanner();
    const buttons = [...ctx.container().querySelectorAll("button")];
    const labels = buttons.map((button) => button.textContent);
    expect(labels).toContain(COOKIE_BANNER_ACCEPT_LABEL);
    expect(labels).toContain(COOKIE_BANNER_DECLINE_LABEL);
  });

  it("both buttons carry the exact same class list (same variant/size — equally prominent)", () => {
    mountOpenBanner();
    const buttons = [...ctx.container().querySelectorAll("button")];
    const accept = buttons.find((b) => b.textContent === COOKIE_BANNER_ACCEPT_LABEL);
    const decline = buttons.find((b) => b.textContent === COOKIE_BANNER_DECLINE_LABEL);
    expect(accept).toBeDefined();
    expect(decline).toBeDefined();
    expect(accept?.className).toBe(decline?.className);
  });

  it("neither button is disabled or pre-selected", () => {
    mountOpenBanner();
    for (const button of ctx.container().querySelectorAll("button")) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-pressed")).toBeNull();
    }
  });
});

describe("CookieBanner visibility", () => {
  it("does not render once the banner is closed (accepted)", () => {
    act(() => {
      ctx.root().render(
        <ConsentProvider initialConsent="granted">
          <CookieBanner />
        </ConsentProvider>,
      );
    });
    expect(ctx.container().querySelector('[aria-label="Cookies"]')).toBeNull();
  });

  it("is reachable as an ARIA region named 'Cookies'", () => {
    mountOpenBanner();
    const region = ctx.container().querySelector('[role="region"][aria-label="Cookies"]');
    expect(region).not.toBeNull();
  });
});

/**
 * Round 1 finding 8: a fixed bottom banner with no compensating padding can
 * cover the footer, the gallery's "Load more" and `/upload`'s form bottom
 * for the whole first-visit session.
 *
 * Round 2 finding 4: the reservation now lives in a namespaced CSS custom
 * property (`--cookie-banner-reserved-height`, consumed by a `body` rule in
 * globals.css), not a direct write to `body.style.paddingBottom` — so these
 * tests read `getPropertyValue("--cookie-banner-reserved-height")`, not
 * `style.paddingBottom`.
 *
 * Round 2 finding 3 (CONFIRMED medium): jsdom 26.1.0 implements neither
 * `ResizeObserver` nor real layout (`offsetHeight` is always `0`), so the
 * PREVIOUS version of this block's `not.toBe("")` assertions passed on
 * `"0px"` just as readily as on a correct, non-zero measurement — a
 * regression reverting the real measurement to a fixed guess, or a typo
 * that always wrote `"0px"`, would not have turned any of them red. Fixed
 * by stubbing both: `offsetHeight` returns a controlled, non-zero value,
 * and a fake `ResizeObserver` captures its callback so a test can invoke it
 * with a NEW height and assert the reservation actually updates — a real
 * check against the mechanism, not jsdom's defaults happening to look like
 * one.
 */
describe("CookieBanner reserves space for itself while open (round 1 finding 8, round 2 findings 3 and 4)", () => {
  const RESERVED_HEIGHT_PROPERTY = "--cookie-banner-reserved-height";
  const STUBBED_HEIGHT_PX = 128;

  let offsetHeightDescriptor: PropertyDescriptor | undefined;
  let resizeObserverCallbacks: ResizeObserverCallback[];
  let originalResizeObserver: typeof ResizeObserver | undefined;

  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  /**
   * A minimal, real-enough ResizeObserverEntry — just the two shapes
   * production code reads (review round 3, finding 7: `borderBoxSize`
   * first, `contentRect` as fallback).
   */
  function fakeResizeEntry(blockSize: number): ResizeObserverEntry {
    return {
      borderBoxSize: [{ blockSize, inlineSize: 0 }],
      contentRect: { height: blockSize } as DOMRectReadOnly,
    } as unknown as ResizeObserverEntry;
  }

  beforeEach(() => {
    offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(): number {
        return STUBBED_HEIGHT_PX;
      },
    });

    resizeObserverCallbacks = [];
    originalResizeObserver = (globalThis as { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });

  afterEach(() => {
    if (offsetHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
    }
    (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
      originalResizeObserver;
    // Belt-and-braces: afterEach above already unmounts, which should run
    // this component's own cleanup, but a defect in that cleanup should not
    // leak into the NEXT test's assertions either.
    document.body.style.removeProperty(RESERVED_HEIGHT_PROPERTY);
  });

  function reservedHeight(): string {
    return document.body.style.getPropertyValue(RESERVED_HEIGHT_PROPERTY);
  }

  it("sets the reserved-height variable to the banner's real measured height while open", () => {
    expect(reservedHeight()).toBe("");
    mountOpenBanner();
    expect(reservedHeight()).toBe(`${STUBBED_HEIGHT_PX}px`);
  });

  it("registers a ResizeObserver on the banner and updates the variable using the ENTRY's own size when it fires", () => {
    mountOpenBanner();
    expect(reservedHeight()).toBe(`${STUBBED_HEIGHT_PX}px`);
    expect(resizeObserverCallbacks).toHaveLength(1);

    // Deliberately do NOT change the offsetHeight stub here (review round
    // 3, finding 7): if production code still re-read el.offsetHeight
    // inside the callback instead of using the entry's own reported size,
    // this would observe the OLD (unchanged) STUBBED_HEIGHT_PX instead of
    // the new value the entry claims — proving the callback actually
    // consumes `entries[0].borderBoxSize`, not a re-read.
    const newSize = STUBBED_HEIGHT_PX * 2;
    act(() => {
      resizeObserverCallbacks[0]?.([fakeResizeEntry(newSize)], {} as ResizeObserver);
    });

    expect(reservedHeight()).toBe(`${newSize}px`);
  });

  it("falls back to contentRect.height when borderBoxSize is unavailable", () => {
    mountOpenBanner();
    const entry = {
      contentRect: { height: 77 } as DOMRectReadOnly,
    } as unknown as ResizeObserverEntry;

    act(() => {
      resizeObserverCallbacks[0]?.([entry], {} as ResizeObserver);
    });

    expect(reservedHeight()).toBe("77px");
  });

  /**
   * Review round 4, LOW: `entry?.contentRect.height` was missing a `?.`
   * between `contentRect` and `.height` — an entry shape with NEITHER
   * `borderBoxSize` nor `contentRect` (exactly the "provides neither" case
   * the fallback chain's own comment names) threw reading `.height` off
   * `undefined`, instead of falling through to `el.offsetHeight`.
   */
  it("falls back to el.offsetHeight without throwing when the entry has neither borderBoxSize nor contentRect", () => {
    mountOpenBanner();
    const bareEntry = {} as unknown as ResizeObserverEntry;

    expect(() => {
      act(() => {
        resizeObserverCallbacks[0]?.([bareEntry], {} as ResizeObserver);
      });
    }).not.toThrow();

    expect(reservedHeight()).toBe(`${STUBBED_HEIGHT_PX}px`);
  });

  it("MUTATION CHECK: falls back to el.offsetHeight when the callback fires with no entries at all", () => {
    mountOpenBanner();
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(): number {
        return 42;
      },
    });

    act(() => {
      resizeObserverCallbacks[0]?.([], {} as ResizeObserver);
    });

    expect(reservedHeight()).toBe("42px");
  });

  it("clears the reserved-height variable again once the banner closes", () => {
    mountWithActions(null);
    expect(reservedHeight()).toBe(`${STUBBED_HEIGHT_PX}px`);

    act(() => {
      actionsRef?.acceptOptional();
    });

    expect(reservedHeight()).toBe("");
  });

  it("MUTATION CHECK: unmounting the banner outright also clears the variable (cleanup actually runs)", () => {
    mountOpenBanner();
    expect(reservedHeight()).toBe(`${STUBBED_HEIGHT_PX}px`);

    act(() => {
      ctx.root().unmount();
    });

    expect(reservedHeight()).toBe("");
  });

  it("MUTATION CHECK fixture: the written value tracks the real offsetHeight rather than a hardcoded constant", () => {
    // Fixture mutation: a DIFFERENT offsetHeight stub, applied after the
    // one in beforeEach. A production regression that hardcoded the
    // reserved height (instead of reading el.offsetHeight) would write the
    // SAME value regardless of this change, making this assertion fail —
    // proving the test above is actually reading the measurement, not a
    // constant that happens to match the stub.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(): number {
        return 0;
      },
    });
    mountOpenBanner();
    expect(reservedHeight()).toBe("0px");
    expect(reservedHeight()).not.toBe(`${STUBBED_HEIGHT_PX}px`);
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
    const region = ctx.container().querySelector('[role="region"][aria-label="Cookies"]');
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
    expect(ctx.container().querySelector('[aria-label="Cookies"]')).toBeNull();

    act(() => {
      actionsRef?.reopen();
    });

    const heading = ctx.container().querySelector("h2");
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
    expect(ctx.container().querySelector('[aria-label="Cookies"]')).toBeNull();

    // Deliberately move focus elsewhere to prove the SECOND reopen() is
    // what brings it back, not a focus that merely never left.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    act(() => {
      actionsRef?.reopen();
    });

    const heading = ctx.container().querySelector("h2");
    expect(document.activeElement).toBe(heading);
    elsewhere.remove();
  });

  /**
   * Review round 3, CONFIRMED low, finding 4: the previous guard tracked
   * whether `reopen()` had ever been called (via a `reopenCount` that
   * changed), not whether the banner was actually CLOSED beforehand. A
   * first-visit visitor with no stored choice already sees the banner
   * open; if they (or something else on the page) triggers `reopen()`
   * while it is still showing, the old guard still saw "reopenCount
   * changed" and yanked focus into a banner that never actually
   * disappeared and reappeared — exactly the surprising, unannounced
   * focus move K4/finding 9 exists to prevent, just reached a different
   * way.
   */
  it("does NOT move focus when 'Cookies' is activated while the first-visit banner is already open", () => {
    const focusTarget = document.createElement("button");
    document.body.append(focusTarget);
    focusTarget.focus();

    mountWithActions(null);
    expect(ctx.container().querySelector('[aria-label="Cookies"]')).not.toBeNull();
    // Mounting itself must not have moved focus either (the existing
    // "initial mount-time open" test above covers this; re-asserted here
    // as the starting condition this test's own action depends on).
    expect(document.activeElement).toBe(focusTarget);

    act(() => {
      actionsRef?.reopen();
    });

    expect(ctx.container().querySelector('[aria-label="Cookies"]')).not.toBeNull();
    expect(document.activeElement).toBe(focusTarget);
    focusTarget.remove();
  });

  /**
   * Review round 4, LOW finding 5: closing the banner (accept/decline)
   * used to leave focus wherever the browser defaults it once the clicked
   * button unmounts (typically <body>) — lost, not returned anywhere
   * meaningful. Fixed to restore focus to whatever invoked the reopen (the
   * footer "Cookies" control, in the one real path that reaches this).
   */
  it("restores focus to the invoking control (the 'Cookies' button) when the reopened banner is dismissed", () => {
    const cookiesButton = document.createElement("button");
    cookiesButton.textContent = "Cookies";
    document.body.append(cookiesButton);

    mountWithActions("granted");
    cookiesButton.focus();
    expect(document.activeElement).toBe(cookiesButton);

    act(() => {
      actionsRef?.reopen();
    });
    expect(document.activeElement).toBe(ctx.container().querySelector("h2"));

    act(() => {
      actionsRef?.onlyNecessary();
    });

    expect(ctx.container().querySelector('[aria-label="Cookies"]')).toBeNull();
    expect(document.activeElement).toBe(cookiesButton);
    cookiesButton.remove();
  });

  it("restores focus to the invoking control on 'Accept optional cookies' too, not just 'Only necessary'", () => {
    const cookiesButton = document.createElement("button");
    document.body.append(cookiesButton);

    mountWithActions("denied");
    cookiesButton.focus();

    act(() => {
      actionsRef?.reopen();
    });
    act(() => {
      actionsRef?.acceptOptional();
    });

    expect(document.activeElement).toBe(cookiesButton);
    cookiesButton.remove();
  });

  it("MUTATION CHECK: does not try to restore focus to an invoker that no longer exists in the DOM", () => {
    const cookiesButton = document.createElement("button");
    document.body.append(cookiesButton);

    mountWithActions("granted");
    cookiesButton.focus();

    act(() => {
      actionsRef?.reopen();
    });
    // The invoking control is removed from the DOM entirely before the
    // banner closes (e.g. the footer re-rendered without it) — restoring
    // focus to a detached element would be a no-op in real browsers, but
    // must not throw here either.
    cookiesButton.remove();

    expect(() => {
      act(() => {
        actionsRef?.onlyNecessary();
      });
    }).not.toThrow();
  });
});
