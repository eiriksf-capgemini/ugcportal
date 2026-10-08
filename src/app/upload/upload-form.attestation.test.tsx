// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTESTATION_AUTHORSHIP_QUESTION,
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
  MEDIA_ATTESTATION_VERSION_FIELD,
  attestationFieldName,
} from "@/lib/attestation";

import { answerAttestation } from "./attestation.test-support";
import { UploadForm } from "./upload-form";

/**
 * ugcportal-15r K1 at the form: every question in §3.1 is actually asked, an
 * unanswered one refuses the upload rather than being defaulted, and what
 * goes on the wire carries an explicit answer for each.
 *
 * A REAL DOM AND A REAL CLIENT ROOT rather than `renderToStaticMarkup`,
 * following upload-form.clock.test.tsx: the claim is not only "the questions
 * render" but "answering them is what lets a file be queued, and the answers
 * reach the request" — which needs the component to actually run `addFiles`
 * across a re-render. A static render cannot do that, and a test that only
 * checked the markup would pass against a form whose answers went nowhere.
 */

class FakeEventTarget {
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
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
  /** The body the form actually handed to `send`. */
  sent: FormData | null = null;

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(): void {}
  send(body?: unknown): void {
    this.sent = body instanceof FormData ? body : null;
  }
  abort(): void {
    this.emit("abort");
  }
  getResponseHeader(): string | null {
    return null;
  }
  setRequestHeader(): void {}

  /** A plain retryable failure: no Retry-After, so "Try again" is enabled. */
  respond(status: number, body: unknown): void {
    this.status = status;
    this.responseText = body === undefined ? "" : JSON.stringify(body);
    this.emit("load");
  }
}

/**
 * The queue drains through promises, so a dispatch lands a microtask or
 * several after the click that caused it. Copied from
 * upload-queue-list.focus.test.tsx, which needs it for the same reason.
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
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

function imageFile(name = "photo.png", size = 2048): File {
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

function radios(field: string): HTMLInputElement[] {
  return [
    ...container.querySelectorAll<HTMLInputElement>(
      `[data-attestation-question="${field}"] input[type="radio"]`,
    ),
  ];
}

function text(): string {
  return container.textContent ?? "";
}

/**
 * The retry control, by exact text. Deliberately not `.includes("Try
 * again")`: a throttled row renders "Try again in Ns", which is a button
 * held shut, and matching it would let the case below pass against a click
 * that did nothing.
 */
function tryAgainOrNull(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    ) ?? null
  );
}

describe("K1: every question in §3.1 is asked", () => {
  it("renders each yes/no question, with its wording and its reason", () => {
    mount();

    // Derived from the registry rather than listed here, so a tenth
    // question is covered the moment it exists — and a question removed
    // from the registry stops being required here, which is the only
    // direction that should be easy.
    for (const { field, question, why } of ATTESTATION_QUESTIONS) {
      expect(
        container.querySelector(`[data-attestation-question="${field}"]`),
        `${field} is not rendered`,
      ).not.toBeNull();
      expect(text(), field).toContain(question);
      expect(text(), `${field} has no reason given`).toContain(why);
    }
  });

  it("renders the authorship question with all three options", () => {
    mount();

    expect(text()).toContain(ATTESTATION_AUTHORSHIP_QUESTION.question);
    for (const option of ATTESTATION_AUTHORSHIP_QUESTION.options) {
      expect(text(), option.value).toContain(option.label);
    }
    expect(radios(ATTESTATION_AUTHORSHIP_QUESTION.field)).toHaveLength(
      ATTESTATION_AUTHORSHIP_QUESTION.options.length,
    );
  });

  it("asks exactly the registry's questions and no others", () => {
    mount();

    const rendered = [
      ...container.querySelectorAll("[data-attestation-question]"),
    ].map((node) => node.getAttribute("data-attestation-question"));

    expect(rendered).toEqual([
      ATTESTATION_AUTHORSHIP_QUESTION.field,
      ...ATTESTATION_QUESTIONS.map(({ field }) => field),
    ]);
  });

  it("gives each question a named group, not a bare pair of inputs", () => {
    // A `<legend>` is what associates a name with a SET of form controls.
    // Without one, a screen reader reads "Yes" and "No" nine times over
    // with nothing saying what is being answered — on a form whose whole
    // content is what the answers mean.
    mount();

    for (const { field, question } of ATTESTATION_QUESTIONS) {
      const group = container.querySelector(
        `fieldset[data-attestation-question="${field}"]`,
      );
      expect(group, `${field} is not a fieldset`).not.toBeNull();
      expect(group!.querySelector("legend")?.textContent, field).toContain(
        question,
      );
    }
  });

  it("starts with NOTHING selected — the resting state is not an answer", () => {
    /*
     * K4 on screen. A checkbox has two states and rests on "no"; a pair of
     * radios with neither selected has three, and this is the assertion
     * that would fail the day somebody "simplifies" them into checkboxes.
     */
    mount();

    const all = [
      ...container.querySelectorAll<HTMLInputElement>(
        "[data-attestation-question] input",
      ),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const input of all) {
      expect(input.type, input.name).toBe("radio");
      expect(input.checked, `${input.name}=${input.value} starts checked`).toBe(
        false,
      );
    }
    expect(
      container.querySelector('[data-upload-attestation=""] input[type="checkbox"]'),
    ).toBeNull();
  });

  it("gives each question's pair its own radio group name", () => {
    // Two questions sharing a `name` would make answering the second one
    // silently un-answer the first — in the browser, below React, where the
    // state module's tests cannot see it.
    mount();

    const names = new Map<string, Set<string>>();
    for (const { field } of ATTESTATION_QUESTIONS) {
      const group = new Set(radios(field).map((input) => input.name));
      expect(group.size, field).toBe(1);
      names.set(field, group);
    }
    const allNames = [...names.values()].map((set) => [...set][0]);
    expect(new Set(allNames).size).toBe(allNames.length);
  });
});

describe("K1 fixture mutation: one question unanswered refuses the upload", () => {
  it("queues nothing and sends nothing while a question is unanswered", () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");

    // Everything answered except the last one.
    const last = ATTESTATION_QUESTIONS[ATTESTATION_QUESTIONS.length - 1];
    act(() => {
      radios(ATTESTATION_AUTHORSHIP_QUESTION.field)[0].click();
    });
    for (const { field } of ATTESTATION_QUESTIONS) {
      if (field === last.field) continue;
      act(() => {
        radios(field)[1].click();
      });
    }

    addFile(imageFile());

    // No request, and no queue row either: an unanswered question is not
    // something wrong with the FILE.
    expect(FakeXhr.instances).toHaveLength(0);
    expect(text()).toContain("Nothing queued yet");
    expect(text()).toContain("rights question");
  });

  it("marks the question that is missing, not just the block", () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    act(() => {
      radios(ATTESTATION_AUTHORSHIP_QUESTION.field)[0].click();
    });

    addFile(imageFile());

    const unanswered = container.querySelector(
      `[data-attestation-question="${ATTESTATION_QUESTIONS[0].field}"]`,
    );
    expect(unanswered!.textContent).toContain("Not answered");
    // And the one that IS answered is not marked, or the mark means
    // nothing.
    const answered = container.querySelector(
      `[data-attestation-question="${ATTESTATION_AUTHORSHIP_QUESTION.field}"]`,
    );
    expect(answered!.textContent).not.toContain("Not answered");
  });

  it("says nothing before anyone has tried", () => {
    // The refusal is the parent's, not the field's: marking nine questions
    // red on first paint would be the alternative.
    mount();

    expect(text()).not.toContain("Not answered");
    expect(text()).not.toContain("rights question");
  });

  it("stops saying it once the last question is answered", () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    addFile(imageFile());
    expect(text()).toContain("rights question");

    answerAttestation(container, act);

    expect(text()).not.toContain("Not answered");
  });
});

describe("K1: the answers reach the request", () => {
  it("sends an explicit answer for every question, plus the version", () => {
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    answerAttestation(container, act, {
      showsIdentifiablePeople: true,
      aiGenerated: true,
    });

    addFile(imageFile());

    expect(FakeXhr.instances).toHaveLength(1);
    const sent = FakeXhr.instances[0].sent;
    expect(sent).not.toBeNull();

    expect(sent!.get(MEDIA_ATTESTATION_VERSION_FIELD)).toBe(
      CURRENT_ATTESTATION_VERSION,
    );
    expect(sent!.get(attestationFieldName("authorship"))).toBe("AUTHOR");
    for (const { field } of ATTESTATION_QUESTIONS) {
      // "yes" or "no", never absent and never empty — an absent part is
      // what the server reads as "not asked".
      expect([
        "yes",
        "no",
      ]).toContain(sent!.get(attestationFieldName(field)));
    }
    // The two that were answered differently really did travel, so this is
    // not passing on nine identical values.
    expect(sent!.get(attestationFieldName("showsIdentifiablePeople"))).toBe("yes");
    expect(sent!.get(attestationFieldName("aiGenerated"))).toBe("yes");
    expect(sent!.get(attestationFieldName("showsMinors"))).toBe("no");
  });

  it("puts the file part first, ahead of every attestation part", () => {
    /*
     * POST /api/media sizes its memory reservation from the declared
     * Content-Type of the `file` part, found by peeking at the first few
     * kilobytes. Nine extra fields ahead of it would push that declaration
     * out of the window and 413 an ordinary video. The existing fields all
     * follow this rule; this is the assertion that the new ones do too.
     */
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    answerAttestation(container, act);

    addFile(imageFile());

    const names = [...FakeXhr.instances[0].sent!.keys()];
    expect(names[0]).toBe("file");
    expect(names.filter((name) => name === "file")).toHaveLength(1);
  });

  it("re-sends the ORIGINAL answers on a retry, not whatever is on screen now", async () => {
    /*
     * The strongest case on this page for replaying rather than rebuilding:
     * a retry that re-read the form would send a WARRANTY about this file
     * that its uploader never gave about it.
     */
    mount();
    setAltText("A fox crossing a snowy field at dawn");
    answerAttestation(container, act, { showsMinors: true });

    addFile(imageFile());
    await waitUntil(() => FakeXhr.instances.length > 0, "the request to start");
    expect(
      FakeXhr.instances[0].sent!.get(attestationFieldName("showsMinors")),
    ).toBe("yes");

    // A plain server error: retryable, and with no Retry-After window, so
    // "Try again" renders enabled rather than as "Try again in Ns".
    act(() => {
      FakeXhr.instances[0].respond(500, { error: "Something broke" });
    });
    await waitUntil(
      () => tryAgainOrNull() !== null,
      "the failed row's retry control",
    );

    // The uploader now changes their mind on screen about the NEXT batch.
    act(() => {
      radios("showsMinors")[1].click();
    });
    expect(radios("showsMinors")[1].checked).toBe(true);

    act(() => {
      tryAgainOrNull()!.click();
    });
    await waitUntil(
      () => FakeXhr.instances.length > 1,
      "the retried request to start",
    );
    expect(
      FakeXhr.instances[1].sent!.get(attestationFieldName("showsMinors")),
      "the retry re-answered the question on the uploader's behalf",
    ).toBe("yes");
  });
});
