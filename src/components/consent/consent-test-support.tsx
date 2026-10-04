import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";

/**
 * Shared jsdom mount/unmount scaffolding for the four consent-module jsdom
 * suites (consent-context.test.tsx, cookie-banner.test.tsx,
 * cookie-settings-link.test.tsx, analytics-loader.test.tsx — review round
 * 3, finding 8 — reuse): each independently hand-rolled the identical
 * createRoot/act container setup and teardown. Modeled directly on
 * src/components/gallery/gallery.test-support.tsx's `setupGalleryTestRoot`,
 * the one other place in this repo with the same shape — same accessor-
 * function return (`ctx.container()`/`ctx.root()`, not plain mutable
 * properties, so a test can't accidentally read a stale pre-`beforeEach`
 * snapshot), same `IS_REACT_ACT_ENVIRONMENT` setup, same unmount-then-remove
 * teardown.
 *
 * Deliberately NOT itself a `*.test.*` file, for the same reason
 * gallery.test-support.tsx isn't: vitest's default test-file glob would
 * otherwise collect it as an (empty) suite of its own.
 */

export interface ConsentTestRoot {
  container(): HTMLDivElement;
  root(): Root;
}

/**
 * Registers the `beforeEach`/`afterEach` pair every consent-module jsdom
 * suite needs — a fresh container appended to `document.body`, a fresh
 * client root, and `IS_REACT_ACT_ENVIRONMENT` set so `act()` does not warn
 * — and returns accessors for the state those hooks fill in.
 *
 * Must be called from the top level of a test file while vitest is still
 * collecting it, exactly like calling `beforeEach`/`afterEach` directly
 * would require — this does nothing more than wrap that same call.
 */
export function setupConsentTestRoot(): ConsentTestRoot {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

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
      root?.unmount();
    });
    container?.remove();
  });

  return {
    container() {
      if (!container) {
        throw new Error("setupConsentTestRoot: container accessed before beforeEach ran");
      }
      return container;
    },
    root() {
      if (!root) {
        throw new Error("setupConsentTestRoot: root accessed before beforeEach ran");
      }
      return root;
    },
  };
}
