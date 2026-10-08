// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerAttestation } from "./attestation.test-support";
import { UploadForm } from "./upload-form";

/**
 * ugcportal-ggw — round-4 finding on PR #42 (ugcportal-n3c).
 *
 * `now` used to refresh only from the interval in upload-form.tsx, which
 * itself only runs while `throttled` is true — and `throttled` was computed
 * from that same stale `now`. So the very first render after a 503 with a
 * `Retry-After` landed long after mount read a mount-time clock and showed a
 * wildly inflated countdown ("Try again in 312s" for a real 12s window) until
 * the interval's first tick, up to 500ms later.
 *
 * outcomes.test.ts and upload-flow.test.tsx cover `secondsUntilRetry` and
 * `UploadQueueList` exhaustively, but both do it by PASSING `now` IN as a
 * prop — which is exactly what makes them blind to this: they never let the
 * component read its own clock. This file is the one place that mounts
 * `UploadForm` itself (a real DOM, a real client root, `vi.useFakeTimers()`
 * driving both `Date.now()` and every interval) specifically so the
 * component's own clock is the thing under test.
 *
 * `@vitest-environment jsdom` and the `createRoot`/`act` mounting pattern
 * match src/components/upload-link.test.tsx and
 * src/components/gallery/gallery.unmount.test.tsx — this repo's other files
 * that need a real DOM rather than `renderToStaticMarkup`'s node environment.
 * jsdom is pinned at ^26 for the same reason those note: 30 breaks on CI's
 * Node 20 and silently drops every file with this pragma.
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

/**
 * A REAL CLASS, not a `vi.fn()` wrapping one — `uploadFile`'s default factory
 * is `() => new XMLHttpRequest()`, and only a real class works with `new`
 * once stubbed onto the global. Instances register themselves so the test
 * can reach the one the component's own drain loop created, without the
 * component exposing any way to inject one.
 */
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

/** A fixed mount moment, well before any response this file drives in. */
const MOUNT_TIME = Date.parse("2026-09-30T12:00:00.000Z");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Same as gallery.unmount.test.tsx and upload-link.test.tsx: React 19's
  // `act` from "react" (rather than a testing-library wrapper) needs this
  // flag set, or every `act()` call below warns instead of flushing.
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  vi.useFakeTimers();
  vi.setSystemTime(MOUNT_TIME);

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
  vi.useRealTimers();
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

/**
 * Fills in the required alt text field (ugcportal-gwr) the way a real visitor
 * would, before any file is added. Not this file's own concern — it is
 * testing the retry clock, not the alt-text gate — but `addFiles` now refuses
 * to queue anything at all while the field is blank, so every test that
 * drives a real upload through the DOM needs this once, up front.
 */
function setAltText(value: string): void {
  // `input[required]` alone, not `[maxlength]` too (review round 3 finding
  // 2 removed that attribute — it counted UTF-16 code units while the real
  // validator counts code points, so the native limit silently disagreed
  // with the server's). The only other required input on this page is the
  // file picker, which this selector does not match because it carries its
  // own `type="file"`.
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

/** Drives the hidden file input the way a real picker/drop would. */
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
 * Waits for a condition, repeatedly draining the microtask queue inside
 * `act()` so a dispatch made from an `await` inside the component's own
 * upload path is flushed and committed before the next check. Deliberately
 * NOT built on `setTimeout`: this file runs under fake timers for the whole
 * suite (K1 needs `vi.setSystemTime`, K3 needs `vi.advanceTimersByTimeAsync`),
 * and a real timer would need those same fake timers advanced to ever fire.
 */
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

function markup(): string {
  return container.textContent ?? "";
}

describe("the retry countdown reads the clock at the moment a 503 lands (ugcportal-ggw)", () => {
  it("renders from the current time, not mount time, on the very first render", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile());

    await waitUntil(() => FakeXhr.instances.length > 0, "the request to start");
    const xhr = FakeXhr.instances[0];

    /*
      Time passes with nothing throttled yet — the user picked tags, read the
      page, walked away — so no interval is running to keep `now` fresh. Under
      the bug, `now` stays at MOUNT_TIME through everything below.
    */
    vi.setSystemTime(MOUNT_TIME + 300_000);

    // The server's 12-second window, arriving five minutes after mount.
    xhr.respond(
      503,
      { error: "Too many uploads are being processed right now" },
      { "Retry-After": "12" },
    );

    await waitUntil(
      () => markup().includes("Try again in"),
      "the failed row to render",
    );

    /*
      The bug's own illustration: reading a mount-time `now` against a
      retryNotBefore stamped from the CURRENT time turns a real 12s window
      into "300s of clock drift" + "12s" = 312s. If this ever regresses, this
      is the number that will come back.
    */
    expect(markup()).not.toContain("312s");
    // Rounds to 12s exactly: the response landed and was rendered before any
    // fake-timer tick moved the clock any further.
    expect(markup()).toContain("Try again in 12s");
  });
});

describe("the retry interval exists only inside a retry window (K3)", () => {
  it("runs no interval before there is anything to count down", () => {
    mount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts an interval once a row is throttled, and clears it once the window passes", async () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile());

    await waitUntil(() => FakeXhr.instances.length > 0, "the request to start");
    const xhr = FakeXhr.instances[0];

    xhr.respond(
      503,
      { error: "Too many uploads are being processed right now" },
      { "Retry-After": "12" },
    );
    await waitUntil(
      () => markup().includes("Try again in"),
      "the failed row to render",
    );

    // Throttled: the countdown interval is the only timer left running (the
    // in-flight watchdog from the settled request has already been disarmed).
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Past the window — advancing (not just setting) the clock so the
    // interval's own ticks run and flip `throttled` back to false.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    await waitUntil(
      () => !markup().includes("Try again in"),
      "the button to re-enable once the window passes",
    );

    // Idle again: this is what tells K3 apart from turning `now` into a
    // plain always-on clock — the interval is gone once nothing needs it.
    expect(vi.getTimerCount()).toBe(0);
    expect(markup()).toContain("Try again");
  });
});
