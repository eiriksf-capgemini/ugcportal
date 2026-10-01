// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UploadForm } from "./upload-form";

/**
 * ugcportal-juo — a drop outside the drop zone must not navigate the page.
 *
 * upload-form.tsx's drop zone calls preventDefault on dragover/drop for the
 * zone element itself, but the zone is a few hundred pixels tall on a page
 * that is full height. A drop a few pixels outside it used to hit the
 * browser's default handling -- navigate to the dropped file, replacing the
 * page and destroying the queue, including anything mid-upload. The fix is a
 * document-level listener that does nothing but preventDefault, installed
 * for the lifetime of the page.
 *
 * `@vitest-environment jsdom` and the createRoot/act mounting pattern match
 * upload-form.clock.test.tsx -- the pattern that file's own header points to
 * as the one other test files in this repo needing a real DOM already use.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Same as upload-form.clock.test.tsx: React 19's `act` from "react" needs
  // this flag set, or every act() call below warns instead of flushing.
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

function mount(): void {
  act(() => {
    root.render(<UploadForm />);
  });
}

/**
 * Dispatches a real, bubbling, cancelable drop/dragover event on `target`.
 *
 * Always carries a `dataTransfer` with an empty `files` list: a bare `Event`
 * has none, and the zone's own onDrop (`event.dataTransfer.files`) throws
 * reading it from one, which would crash the "still lets the drop zone's own
 * handler run" case below rather than testing it.
 */
function dispatchDragEvent(target: EventTarget, type: "dragover" | "drop"): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files: [] as unknown as FileList },
  });
  target.dispatchEvent(event);
  return event;
}

describe("a drop outside the drop zone does not navigate away (K1)", () => {
  it("prevents the default action of a drop dispatched on the document root", () => {
    mount();

    const event = dispatchDragEvent(document, "drop");

    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents the default action of a dragover dispatched on the document root", () => {
    mount();

    const event = dispatchDragEvent(document, "dragover");

    expect(event.defaultPrevented).toBe(true);
  });

  it("still lets the drop zone's own handler run a drop that lands ON the zone", () => {
    mount();

    // The visually-hidden file input lives inside the zone; its closest
    // ancestor with the zone's drag handlers is what a real drop on the zone
    // would target. Dispatching there exercises the same bubbling path a
    // real drop takes -- through the zone's React handler, then up to the
    // document listener this bead adds -- rather than asserting against the
    // zone's internals.
    const input = container.querySelector('input[type="file"]');
    if (input === null) throw new Error("no file input in the markup");
    const zone = input.closest("div");
    if (zone === null) throw new Error("no drop zone ancestor in the markup");

    // `defaultPrevented` can't be the assertion here: the document listener
    // this bead adds now prevents the default action of EVERY drop,
    // including one that lands on the zone, so checking it would pass even
    // if the zone's own onDrop were deleted entirely -- it would prove
    // nothing bead-specific. Instead, drive the zone's own
    // dragenter-sets-"dragging over" / drop-clears-it state, which only the
    // zone's own handlers touch (the document listener has no component
    // state to reach): if the drop's effect on that state disappears, the
    // zone's onDrop stopped running, however "prevented" the event still is.
    // `classList.contains`, not a `className` substring check: the zone's
    // static classes already include `has-[:focus-visible]:border-ring`, so
    // a substring match on "border-ring" would be true even at rest and
    // never actually observe the dragging-over state changing.
    act(() => {
      zone.dispatchEvent(
        new Event("dragenter", { bubbles: true, cancelable: true }),
      );
    });
    expect(zone.classList.contains("border-ring")).toBe(true);

    act(() => {
      dispatchDragEvent(zone, "drop");
    });

    expect(zone.classList.contains("border-ring")).toBe(false);
    expect(zone.classList.contains("border-line-strong")).toBe(true);
  });
});

describe("the document listener does not outlive the page (K2)", () => {
  it("no longer prevents a drop on the document once the component unmounts", () => {
    mount();

    act(() => {
      root.unmount();
    });

    const event = dispatchDragEvent(document, "drop");

    expect(event.defaultPrevented).toBe(false);
  });

  it("removes exactly what it added, leaving no listener behind across repeated mounts", () => {
    // Mount and unmount twice. If cleanup ever added one more listener than
    // it removed (e.g. an effect with no cleanup, or a dependency array that
    // re-fires without tearing down the previous pair), this would still
    // pass on a single mount/unmount but starts failing once listeners
    // accumulate -- the shape of bug K2 actually guards against.
    mount();
    act(() => {
      root.unmount();
    });

    root = createRoot(container);
    mount();
    act(() => {
      root.unmount();
    });

    const event = dispatchDragEvent(document, "drop");

    expect(event.defaultPrevented).toBe(false);
  });
});
