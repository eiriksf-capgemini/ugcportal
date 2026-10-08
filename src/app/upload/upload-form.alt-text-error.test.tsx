// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerAttestation } from "./attestation.test-support";
import { UploadForm } from "./upload-form";

/**
 * Round 5 finding on PR #78 (ugcportal-gwr).
 *
 * `attemptedFilenames` (the state the live alt-text error reads) is only
 * ever WRITTEN by `addFiles`'s refusal branch — nothing on the SUCCESS path
 * used to touch it. So a visitor who tripped the K2 filename-equality
 * refusal once, then fixed it not by editing the alt text field but by
 * swapping in a different file whose name no longer collides, reached a
 * successful add with the OLD failing filenames still sitting in state —
 * and the live error display, which recomputes from whatever
 * `attemptedFilenames` holds, kept showing "must describe the photo, not
 * repeat its filename" under a field whose file had just been queued fine.
 *
 * Reuses upload-form.clock.test.tsx's mounting pattern (a real DOM, a real
 * client root, a stand-in `XMLHttpRequest`) rather than `renderToStaticMarkup`
 * (client-rules.test.tsx), because this needs the component to actually run
 * `addFiles` twice across a real re-render, which a static markup render
 * cannot do.
 */

class FakeEventTarget {
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(
    type: string,
    listener: (event: unknown) => void,
  ): void {
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

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(): void {}
  send(): void {}
  abort(): void {
    this.emit("abort");
  }
  getResponseHeader(): string | null {
    return null;
  }
  setRequestHeader(): void {}
}

function imageFile(name: string, size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  const input = container.querySelector<HTMLInputElement>(
    'input[type="file"]',
  );
  if (input === null) throw new Error("no file input in the markup");
  Object.defineProperty(input, "files", {
    value: [file] as unknown as FileList,
    configurable: true,
  });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function markup(): string {
  return container.textContent ?? "";
}

describe("a stale filename-equality refusal clears once a different file succeeds (round 5)", () => {
  it("does not keep showing the old refusal after a later add succeeds", () => {
    mount();

    // First attempt: alt text repeats the file's own name — refused.
    setAltText("sunset.jpg");
    addFile(imageFile("sunset.jpg"));
    expect(markup()).toContain(
      "Alt text must describe the photo, not repeat its filename.",
    );

    // Second attempt, same alt text, a DIFFERENT file that no longer
    // collides with it — this must succeed, and the stale refusal from the
    // first attempt must not still be on screen afterwards.
    addFile(imageFile("mountain.jpg"));
    expect(markup()).not.toContain(
      "Alt text must describe the photo, not repeat its filename.",
    );
  });

  it("still shows a FRESH refusal for a second file that collides too", () => {
    mount();

    setAltText("sunset.jpg");
    addFile(imageFile("sunset.jpg"));
    expect(markup()).toContain(
      "Alt text must describe the photo, not repeat its filename.",
    );

    // A second file that ALSO collides should still refuse — clearing the
    // stale case must not clear a live one.
    addFile(imageFile("sunset.jpg"));
    expect(markup()).toContain(
      "Alt text must describe the photo, not repeat its filename.",
    );
  });
});
