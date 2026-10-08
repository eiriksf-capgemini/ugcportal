// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerAttestation } from "./attestation.test-support";
import { UploadForm } from "./upload-form";

/**
 * Keyboard focus through the upload queue's self-unmounting controls
 * (ugcportal-ff2a, the same shape ugcportal-jx4 fixed for the gallery's
 * "Load more" — see gallery.focus.test.tsx's own file header for the fuller
 * account of why jsdom can and cannot distinguish the fixed and broken
 * versions here).
 *
 * Four controls share the defect: "Try again", "Cancel", "Remove" and
 * "Clear" each unmounts (or gets replaced) as a direct result of its own
 * activation — `{failure.retryable ? <Button/> : null}` inside Failure
 * (upload-queue-list.tsx) for "Try again", a status change away from
 * `pending`/`uploading` for "Cancel", and `uploadQueueReducer`'s "dismissed"
 * case filtering the whole row out of `items` for "Remove"/"Clear" — and
 * jsdom DOES reproduce a real browser's behaviour here: removing the focused
 * element from the DOM moves focus to `<body>` with no help from this file,
 * confirmed directly the same way gallery.focus.test.tsx confirms it for
 * "Load more".
 *
 * "Try again" and "Cancel" land on their own row's status line, since the
 * row survives either click. "Remove" and "Clear" remove the whole row, so
 * there is nothing on it left to land on; those land on a neighbouring
 * row's first control, or the file input when the dismissed row was the
 * only one in the queue — see `dismiss()` in upload-form.tsx.
 *
 * A separate describe block below also covers the per-row `Map` keying
 * itself: with a single row in the queue, a lookup that ignored `id` and
 * always took the first entry of each map would be indistinguishable from
 * the real, id-keyed lookup, since with one row they are the same entry.
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
  // The rights attestation (ugcportal-15r) is required before `addFiles`
  // will queue anything, and it is not what any case in this file is about.
  // Answered through the real radios, so these tests still go through the
  // same gate a visitor does rather than around it.
  answerAttestation(container, act);
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

/**
 * The row for one file, found by its (unique, per test) filename — needed
 * once more than one row is on screen, where `container.querySelector(...)`
 * alone would silently match whichever row comes first in document order.
 */
function rowContaining(filename: string): HTMLLIElement {
  const row = [...container.querySelectorAll("li")].find((candidate) =>
    candidate.textContent?.includes(filename),
  );
  expect(row, `expected a queue row for ${filename}`).not.toBeUndefined();
  return row as HTMLLIElement;
}

function buttonWithTextOrNull(
  root: ParentNode,
  text: string,
): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === text,
    ) ?? null
  );
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement {
  const button = buttonWithTextOrNull(root, text);
  expect(button, `expected a "${text}" button`).not.toBeNull();
  return button as HTMLButtonElement;
}

/** The row's own focus landing spot — see `onStatusLineRef` in upload-queue-list.tsx. */
function statusLineWithin(row: ParentNode): HTMLParagraphElement {
  const line = row.querySelector('p[tabindex="-1"]');
  expect(line, "expected a status line in this row").not.toBeNull();
  return line as HTMLParagraphElement;
}

/**
 * The queue's always-present fallback landing spot — see `fileInputRef` in
 * upload-form.tsx.
 */
function fileInputOrNull(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[type="file"]');
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
    // its paging status: a `tabIndex="-1"` landing spot. It renders for any
    // row that exists, whatever that row's status — true here, since retry
    // leaves the row in place (see upload-queue-list.tsx's own prop doc).
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

describe("K2 guard — focus parked elsewhere is left alone through a retry (ugcportal-ff2a)", () => {
  it("leaves focus exactly where it was, through the whole retry, when the visitor's focus was never on the button", async () => {
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

    // What this tests: focus parked elsewhere when the control is
    // activated — not "a mouse click", which in most browsers DOES focus a
    // button on click (gallery.tsx's own pre-dispatch comment has the
    // fuller account; Safari is the exception). The synthetic click below
    // is deliberately NOT preceded by `button.focus()`, unlike the K1 test
    // above, so this is simply the jsdom shape for "this visitor's focus is
    // somewhere else" — the way tabbing to a different control would also
    // leave it.
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

describe("Cancel — focus survives unmounting itself (ugcportal-ff2a)", () => {
  it("moves focus to the row's own status line once Cancel turns a pending row into a cancelled failure", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile("a.png"));
    addFile(imageFile("b.png"));

    // a.png starts uploading immediately (the drain loop claims it); b.png
    // stays "pending" behind it — drainQueue is strictly sequential (see
    // upload-queue.ts) — which is the row this test cancels, so it reaches
    // the SYNCHRONOUS still-queued branch of cancel(), not the in-flight
    // abort branch.
    await waitUntil(
      () => FakeXhr.instances.length > 0,
      "a.png's request to start",
    );

    const rowB = rowContaining("b.png");
    const cancelButton = buttonWithText(rowB, "Cancel");
    cancelButton.focus();
    expect(document.activeElement).toBe(cancelButton);

    await click(cancelButton);
    await waitUntil(
      () => buttonWithTextOrNull(rowB, "Cancel") === null,
      "Cancel to unmount once the row becomes a cancelled failure",
    );

    // Cancel's own row survives as "failed" (cancelledFailure()) — the same
    // shape "Try again"/retry already relies on — so its status line is
    // still there to land on.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(statusLineWithin(rowB));
  });

  it("moves focus to the row's own status line once Cancel aborts an in-flight (uploading) row", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile());

    // The only file queued, so drain() claims it immediately — Cancel here
    // reaches the OTHER branch of cancel(), the in-flight abort, not the
    // still-queued one the test above exercises.
    await waitUntil(() => FakeXhr.instances.length > 0, "the request to start");

    const row = rowContaining("photo.png");
    const cancelButton = buttonWithText(row, "Cancel");
    cancelButton.focus();
    expect(document.activeElement).toBe(cancelButton);

    await click(cancelButton);
    await waitUntil(
      () => buttonWithTextOrNull(row, "Cancel") === null,
      "Cancel to unmount once the in-flight upload is aborted",
    );

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(statusLineWithin(row));
  });
});

describe("Cancel guard — focus parked elsewhere is left alone (ugcportal-ff2a)", () => {
  it("leaves focus exactly where it was when Cancel is activated with focus elsewhere", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile("a.png"));
    addFile(imageFile("b.png"));

    await waitUntil(
      () => FakeXhr.instances.length > 0,
      "a.png's request to start",
    );

    const rowB = rowContaining("b.png");
    const cancelButton = buttonWithText(rowB, "Cancel");

    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    try {
      expect(document.activeElement).toBe(elsewhere);
      expect(document.activeElement).not.toBe(cancelButton);

      await click(cancelButton);
      await waitUntil(
        () => buttonWithTextOrNull(rowB, "Cancel") === null,
        "Cancel to unmount once the row becomes a cancelled failure",
      );

      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });
});

describe("Remove — focus survives dismissing the whole row (ugcportal-ff2a)", () => {
  it("moves focus to the next row's first control once Remove dismisses a failed row entirely", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile("a.png"));
    addFile(imageFile("b.png"));

    await waitUntil(
      () => FakeXhr.instances.length > 0,
      "a.png's request to start",
    );
    act(() => {
      FakeXhr.instances[0].respond(500, { error: "Something broke" });
    });
    // a.png now failed; drain() moves straight on to b.png.
    await waitUntil(
      () => FakeXhr.instances.length > 1,
      "b.png's request to start",
    );
    act(() => {
      FakeXhr.instances[1].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => buttonWithTextOrNull(rowContaining("b.png"), "Try again") !== null,
      "b.png's row to fail too",
    );

    const rowA = rowContaining("a.png");
    const removeButton = buttonWithText(rowA, "Remove");
    removeButton.focus();
    expect(document.activeElement).toBe(removeButton);

    await click(removeButton);
    await waitUntil(
      () => container.textContent?.includes("a.png") === false,
      "a.png's row to be dismissed entirely",
    );

    // a.png's whole row is gone — there is no "a.png's own status line" to
    // land on (uploadQueueReducer's "dismissed" case filters the row out of
    // `items`) — so focus goes to the next row's first control: b.png's own
    // "Try again".
    const rowB = rowContaining("b.png");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(buttonWithText(rowB, "Try again"));
  });

  it("moves focus to the previous row's first control once Remove dismisses the last row in the queue", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile("a.png"));
    addFile(imageFile("b.png"));

    await waitUntil(
      () => FakeXhr.instances.length > 0,
      "a.png's request to start",
    );
    act(() => {
      FakeXhr.instances[0].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => FakeXhr.instances.length > 1,
      "b.png's request to start",
    );
    act(() => {
      FakeXhr.instances[1].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => buttonWithTextOrNull(rowContaining("b.png"), "Try again") !== null,
      "b.png's row to fail too",
    );

    // b.png is the LAST row this time — the opposite case from the test
    // above, where the dismissed row had a NEXT sibling but no previous one.
    const rowB = rowContaining("b.png");
    const removeButton = buttonWithText(rowB, "Remove");
    removeButton.focus();
    expect(document.activeElement).toBe(removeButton);

    await click(removeButton);
    await waitUntil(
      () => container.textContent?.includes("b.png") === false,
      "b.png's row to be dismissed entirely",
    );

    const rowA = rowContaining("a.png");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(buttonWithText(rowA, "Try again"));
  });
});

describe("Remove/Clear guard — focus parked elsewhere is left alone (ugcportal-ff2a)", () => {
  it("leaves focus exactly where it was when Remove is activated with focus elsewhere", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile("a.png"));
    addFile(imageFile("b.png"));

    await waitUntil(
      () => FakeXhr.instances.length > 0,
      "a.png's request to start",
    );
    act(() => {
      FakeXhr.instances[0].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => FakeXhr.instances.length > 1,
      "b.png's request to start",
    );
    act(() => {
      FakeXhr.instances[1].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => buttonWithTextOrNull(rowContaining("b.png"), "Try again") !== null,
      "b.png's row to fail too",
    );

    const rowA = rowContaining("a.png");
    const removeButton = buttonWithText(rowA, "Remove");

    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    try {
      expect(document.activeElement).toBe(elsewhere);
      expect(document.activeElement).not.toBe(removeButton);

      await click(removeButton);
      await waitUntil(
        () => container.textContent?.includes("a.png") === false,
        "a.png's row to be dismissed entirely",
      );

      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });
});

describe("Clear — focus survives dismissing the only row in the queue (ugcportal-ff2a)", () => {
  it("falls back to the file input once Clear dismisses the only row left", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile());

    await waitUntil(() => FakeXhr.instances.length > 0, "the request to start");
    act(() => {
      FakeXhr.instances[0].respond(201, CREATED_BODY);
    });
    await waitUntil(
      () => buttonWithTextOrNull(container, "Clear") !== null,
      "the succeeded row's Clear button to render",
    );

    const clearButton = buttonWithText(container, "Clear");
    clearButton.focus();
    expect(document.activeElement).toBe(clearButton);

    await click(clearButton);
    await waitUntil(
      () => container.textContent?.includes("photo.png") === false,
      "the row to be dismissed entirely",
    );

    // The only row in the queue, so there is no neighbouring row's control
    // to land on either — the file input is the one control this page
    // always has (see `dismiss()` in upload-form.tsx), named explicitly here
    // rather than inferred from wherever the DOM happens to place it.
    const fileInput = fileInputOrNull();
    expect(fileInput).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(fileInput);
  });
});

describe("per-row keying — focuses the right row's status line, not just the first one (ugcportal-ff2a)", () => {
  it("focuses the second row's own status line when its 'Try again' is retried, with a first failed row also present", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile("first.png"));
    addFile(imageFile("second.png"));

    await waitUntil(
      () => FakeXhr.instances.length > 0,
      "first.png's request to start",
    );
    act(() => {
      FakeXhr.instances[0].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => FakeXhr.instances.length > 1,
      "second.png's request to start",
    );
    act(() => {
      FakeXhr.instances[1].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () =>
        buttonWithTextOrNull(rowContaining("second.png"), "Try again") !==
        null,
      "second.png's row to fail too",
    );

    const rowFirst = rowContaining("first.png");
    const rowSecond = rowContaining("second.png");
    const secondButton = buttonWithText(rowSecond, "Try again");

    secondButton.focus();
    expect(document.activeElement).toBe(secondButton);

    await click(secondButton);
    await waitUntil(
      () => buttonWithTextOrNull(rowSecond, "Try again") === null,
      "second.png's 'Try again' to unmount",
    );

    // The load-bearing claim: the SECOND row's own status line, not the
    // first row's. A lookup that ignored `id` and always took the first
    // registered element of each map would land here too when only one row
    // exists — which is exactly why the K1/K2 tests above, each with a
    // single row, cannot tell the two implementations apart.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(statusLineWithin(rowSecond));
    expect(document.activeElement).not.toBe(statusLineWithin(rowFirst));

    await waitUntil(
      () => FakeXhr.instances.length > 2,
      "second.png's retried request to start",
    );
    act(() => {
      FakeXhr.instances[2].respond(201, CREATED_BODY);
    });
    await waitUntil(
      () => rowSecond.textContent?.includes("Uploaded") === true,
      "second.png's retried upload to succeed",
    );
  });
});
