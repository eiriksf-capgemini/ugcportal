// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UploadForm } from "./upload-form";

/**
 * Keyboard focus through the upload queue's "Try again" control
 * (ugcportal-ff2a, the same shape ugcportal-jx4 fixed for the gallery's
 * "Load more" — see gallery.focus.test.tsx's own file header for the fuller
 * account of why jsdom can and cannot distinguish the fixed and broken
 * versions here).
 *
 * `{failure.retryable ? <Button/> : null}` inside Failure
 * (upload-queue-list.tsx) unmounts the very button a retry click just
 * activated — `uploadQueueReducer`'s "retried" case sets `failure: null`,
 * which is what makes `Failure` return null for that row until it settles
 * again. jsdom DOES reproduce a real browser's behaviour here: removing the
 * focused element from the DOM moves focus to `<body>` with no help from
 * this file, confirmed directly the same way gallery.focus.test.tsx confirms
 * it for "Load more".
 *
 * `@vitest-environment jsdom` and the `createRoot`/`act` mounting pattern,
 * and the fake `XMLHttpRequest`, match upload-form.clock.test.tsx — this
 * file's closest sibling, which mounts the same `UploadForm` for the same
 * reason: the repo's node-environment vitest has no DOM, and the focus
 * behaviour under test can only be observed against a real one.
 */

// --- a stand-in XMLHttpRequest, replayed the way a real one fires events ---

type FakeListener = (event: unknown) => void;

class FakeEventTarget {
  private listeners = new Map<string, FakeListener[]>();

  addEventListener(type: string, listener: FakeListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((each) => each !== listener),
    );
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

class FakeXhr extends FakeEventTarget {
  static instances: FakeXhr[] = [];

  readonly upload = new FakeEventTarget();
  status = 0;
  responseText = "";
  responseType = "";
  private readonly headers = new Map<string, string>();

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(): void {}

  send(): void {}

  abort(): void {
    this.emit("abort");
  }

  getResponseHeader(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  respond(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    this.status = status;
    this.responseText =
      body === undefined || body === null ? "" : JSON.stringify(body);
    for (const [name, value] of Object.entries(headers)) {
      this.headers.set(name.toLowerCase(), value);
    }
    this.emit("load");
  }
}

function imageFile(name = "photo.png", size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

const CREATED_BODY = {
  id: "media-1",
  kind: "IMAGE",
  previewId: "preview-abc",
  originalName: "photo.png",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Same as upload-form.clock.test.tsx, gallery.unmount.test.tsx and
  // upload-link.test.tsx: React 19's `act` from "react" needs this flag set,
  // or every `act()` call below warns instead of flushing.
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

function mount(): void {
  act(() => {
    root.render(<UploadForm />);
  });
}

/** See upload-form.clock.test.tsx: the same required-field setter. */
function setAltText(value: string): void {
  const input = container.querySelector<HTMLInputElement>(
    'input[required][type="text"]',
  );
  if (input === null) throw new Error("no alt text field in the markup");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function addFile(file: File): void {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input in the markup");
  Object.defineProperty(input, "files", {
    value: [file] as unknown as FileList,
    configurable: true,
  });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/**
 * Dispatches a real `"click"` event, wrapped in `act` — the way a visitor's
 * click reaches a React handler, as opposed to calling the handler directly.
 * Matches gallery.test-support.tsx's `click` helper.
 */
function click(button: HTMLButtonElement): Promise<void> {
  return act(async () => {
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

async function waitUntil(
  condition: () => boolean,
  what: string,
  tries = 50,
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (condition()) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  if (!condition()) {
    throw new Error(`timed out waiting for ${what}`);
  }
}

/**
 * The retry control, distinguished from "Sign in", "Cancel", "Remove" and
 * "Clear" — all of which are also `<button>`/`<a>` elements somewhere in the
 * queue — by its exact accessible text. Deliberately exact, not
 * `.includes("Try again")`: a throttled row renders "Try again in Ns" (see
 * upload-flow.test.tsx's own throttle suite), which this must NOT match, or
 * a test could pass against a button that is held shut rather than enabled.
 */
function tryAgainButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Try again",
  );
  expect(button, "expected an enabled 'Try again' button").not.toBeUndefined();
  return button as HTMLButtonElement;
}

function tryAgainButtonOrNull(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Try again",
    ) ?? null
  );
}

describe("K1 — focus survives a retry that unmounts 'Try again' (ugcportal-ff2a)", () => {
  it("moves focus to the row's status line, never to <body>, once the click retries and the button unmounts", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile());

    await waitUntil(() => FakeXhr.instances.length > 0, "the request to start");
    const first = FakeXhr.instances[0];
    // A plain server_error: retryable, with no Retry-After window, so "Try
    // again" renders enabled and focusable immediately rather than as
    // "Try again in Ns" — the throttled case is a different row entirely,
    // owned by upload-form.clock.test.tsx (ugcportal-ggw).
    act(() => {
      first.respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => tryAgainButtonOrNull() !== null,
      "the failed row's 'Try again' button to render",
    );

    const button = tryAgainButton();
    button.focus();
    expect(document.activeElement).toBe(button);

    await click(button);

    // The retry is sent as a second request immediately (drain() runs the
    // re-queued file straight away) — this is the row leaving "failed",
    // which is what unmounts Failure and the button inside it.
    await waitUntil(
      () => tryAgainButtonOrNull() === null,
      "'Try again' to unmount once the row leaves the failed state",
    );

    // The load-bearing claim: not <body>, and specifically the row's own
    // status line — the element `onStatusLineRef` registers in
    // upload-queue-list.tsx, found here the same way the gallery suite finds
    // its paging status: a `tabIndex="-1"` landing spot that is never
    // conditionally rendered.
    const statusLine = container.querySelector('p[tabindex="-1"]');
    expect(statusLine).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(statusLine);

    await waitUntil(
      () => FakeXhr.instances.length > 1,
      "the retried request to start",
    );
    act(() => {
      FakeXhr.instances[1].respond(201, CREATED_BODY);
    });
    await waitUntil(
      () => container.textContent?.includes("Uploaded") === true,
      "the retried upload to succeed",
    );
  });
});

describe("K2 guard — a retry the visitor did not have keyboard focus on (ugcportal-ff2a)", () => {
  it("leaves focus exactly where it was, through the whole retry, when the click did not come from the button itself", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile());

    await waitUntil(() => FakeXhr.instances.length > 0, "the request to start");
    act(() => {
      FakeXhr.instances[0].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => tryAgainButtonOrNull() !== null,
      "the failed row's 'Try again' button to render",
    );
    const button = tryAgainButton();

    // Stands in for a mouse activation: the synthetic click below is
    // deliberately NOT preceded by `button.focus()`, unlike the K1 test
    // above — matching gallery.focus.test.tsx's own "a mouse click that
    // never focused the button" guard. Focus is parked on an unrelated
    // element instead, the way a visitor tabbing through the page, not this
    // button, would leave it.
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    try {
      // The premise, asserted rather than assumed: the click must not be the
      // thing that focused the button, or the rest of this test passes over
      // a scenario it never actually reached.
      expect(document.activeElement).not.toBe(button);

      await click(button);
      await waitUntil(
        () => tryAgainButtonOrNull() === null,
        "'Try again' to unmount once the row leaves the failed state",
      );

      // Left exactly where the visitor put it — not pulled to the status
      // line, which is what the K1 handoff firing unconditionally would
      // look like.
      expect(document.activeElement).toBe(elsewhere);

      await waitUntil(
        () => FakeXhr.instances.length > 1,
        "the retried request to start",
      );
      act(() => {
        FakeXhr.instances[1].respond(201, CREATED_BODY);
      });
      await waitUntil(
        () => container.textContent?.includes("Uploaded") === true,
        "the retried upload to succeed",
      );

      // Still left alone once the retried upload actually settles — the
      // handoff must not fire late, on resolution, for a row the visitor was
      // never focused on in the first place.
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });
});
