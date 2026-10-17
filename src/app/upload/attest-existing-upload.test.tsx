// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTESTATION_QUESTIONS,
  CURRENT_ATTESTATION_VERSION,
  MEDIA_ATTESTATION_VERSION_FIELD,
  attestationFieldName,
} from "@/lib/attestation";

import { attestationFailureMessage } from "./attest-existing-upload";
import { answerAttestation } from "./attestation.test-support";
import { cancelledFailure } from "./outcomes";
import type { QueueItem, QueueMedia } from "./upload-queue";
import { UploadQueueList } from "./upload-queue-list";

/**
 * ugcportal-gkax K1, at the page: the queue row of an upload stored WITHOUT
 * the rights questions offers them — and no other row does — and answering
 * them posts the same nine answers, at the version this page rendered, to
 * POST /api/media/[id]/attestation.
 *
 * Mounted for real in jsdom (the `createRoot`/`act` pattern of
 * upload-queue-list.focus.test.tsx), because the control has state of its
 * own and the focus handoff is only observable against a real document.
 * `fetch` is a stand-in: the route's own behaviour is
 * src/app/api/media/[id]/attestation/route.test.ts's subject, against a real
 * database.
 *
 * "AN OWNER'S" ROW: every row in this queue is the signed-in visitor's own
 * upload — the 201 of their own POST /api/media — so ownership is not a
 * condition this component can get wrong; the route decides it (403 for
 * anybody else's id, an admin's included). What this file pins is the other
 * half: un-attested, and only un-attested.
 */

const MEDIA: QueueMedia = {
  id: "media-gkax-1",
  kind: "IMAGE",
  previewId: "preview-gkax-1",
  originalName: "fox.png",
  publishedAt: "2026-10-15T10:00:00.000Z",
  publishRefusal: null,
  attested: false,
};

function row(overrides: Partial<QueueItem> = {}, media: Partial<QueueMedia> = {}): QueueItem {
  return {
    id: "row-1",
    name: "fox.png",
    sizeBytes: 2048,
    mimeType: "image/png",
    status: "succeeded",
    loadedBytes: 2048,
    failure: null,
    media: { ...MEDIA, ...media },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
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

function render(items: QueueItem[]): void {
  act(() => {
    root.render(
      <UploadQueueList
        items={items}
        now={0}
        onRetry={() => {}}
        onCancel={() => {}}
        onDismiss={() => {}}
      />,
    );
  });
}

function text(): string {
  return container.textContent ?? "";
}

function toggle(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").startsWith("Answer the rights questions"),
    ) ?? null
  );
}

function recordButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Record my answers",
  );
  if (!button) throw new Error("no 'Record my answers' button");
  return button;
}

function panel(): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-attest-existing-upload-panel]");
  if (element === null) throw new Error("the questions are not open");
  return element;
}

function open(): void {
  const button = toggle();
  if (button === null) throw new Error("no control to open");
  act(() => {
    button.click();
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function respondWith(status: number, body: unknown): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("K1: the control renders only for an un-attested upload's row", () => {
  it("renders on a stored row whose 201 said attested: false", () => {
    render([row()]);

    expect(toggle(), "no control on the un-attested row").not.toBeNull();
    // Closed until asked: nine questions per row would bury the queue.
    expect(container.querySelector("[data-attestation-question]")).toBeNull();
  });

  it("does not render when the 201 said attested: true, or did not say", () => {
    render([
      row({ id: "attested" }, { attested: true }),
      row({ id: "unsaid" }, { attested: null }),
    ]);

    expect(toggle()).toBeNull();
    expect(text()).not.toContain("rights answers");
  });

  it("does not render on a row that is not a stored upload", () => {
    render([
      row({ id: "uploading", status: "uploading", media: null }),
      row({ id: "pending", status: "pending", media: null }),
      row({
        id: "failed",
        status: "failed",
        media: null,
        failure: cancelledFailure(),
      }),
    ]);

    expect(toggle()).toBeNull();
  });

  it("renders once per un-attested row, beside that row's own file only", () => {
    render([
      row({ id: "a", name: "a.png" }, { id: "media-a" }),
      row({ id: "b", name: "b.png" }, { id: "media-b", attested: true }),
    ]);

    const toggles = [...container.querySelectorAll("button")].filter((button) =>
      (button.textContent ?? "").startsWith("Answer the rights questions"),
    );
    expect(toggles).toHaveLength(1);
    expect(toggles[0].textContent).toContain("for a.png");
  });
});

describe("answering them", () => {
  it("posts the nine answers at the rendered version to the item's route, then says so and takes focus", async () => {
    render([row()]);
    open();
    answerAttestation(panel(), act, { aiGenerated: true });
    respondWith(201, { mediaId: MEDIA.id });

    act(() => {
      recordButton().click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/media/${MEDIA.id}/attestation`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body)) as Record<string, string>;
    expect(sent[MEDIA_ATTESTATION_VERSION_FIELD]).toBe(CURRENT_ATTESTATION_VERSION);
    expect(sent[attestationFieldName("authorship")]).toBe("AUTHOR");
    for (const { field } of ATTESTATION_QUESTIONS) {
      const expected =
        field === "uploaderIsAdult" || field === "aiGenerated" ? "yes" : "no";
      expect(sent[attestationFieldName(field)], field).toBe(expected);
    }
    // Nothing that names an actor: the route takes it from the session.
    expect(Object.keys(sent).some((key) => /user/i.test(key))).toBe(false);

    const done = container.querySelector<HTMLElement>("[data-attest-existing-upload-done]");
    expect(done?.textContent).toBe("Your rights answers for this file are recorded.");
    expect(document.activeElement).toBe(done);
    expect(toggle()).toBeNull();
    expect(container.querySelector("[data-attestation-question]")).toBeNull();
  });

  it("refuses to send an incomplete set, and says how many are left", () => {
    render([row()]);
    open();

    act(() => {
      recordButton().click();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(panel().textContent).toContain(
      `Answer the remaining ${ATTESTATION_QUESTIONS.length + 1} rights questions before recording them.`,
    );
  });

  it("a 409 finishes the block with the server's sentence: there is nothing left to answer", async () => {
    render([row()]);
    open();
    answerAttestation(panel(), act);
    respondWith(409, { error: "This file already has rights answers on record. They cannot be changed here." });

    act(() => {
      recordButton().click();
    });
    await settle();

    expect(
      container.querySelector("[data-attest-existing-upload-done]")?.textContent,
    ).toBe("This file already has rights answers on record. They cannot be changed here.");
    expect(toggle()).toBeNull();
  });

  it("a 400 keeps the block open with the route's own sentence, so it can be fixed and re-sent", async () => {
    render([row()]);
    open();
    answerAttestation(panel(), act);
    respondWith(400, {
      error: "The rights questions have changed since this page was opened. Reload and answer them again.",
    });

    act(() => {
      recordButton().click();
    });
    await settle();

    expect(panel().textContent).toContain("The rights questions have changed");
    expect(recordButton().disabled).toBe(false);
    expect(container.querySelector("[data-attest-existing-upload-done]")).toBeNull();
  });
});

describe("attestationFailureMessage", () => {
  it("names each refusal in the visitor's terms", () => {
    expect(attestationFailureMessage(400, "Answer yes or no: X")).toBe("Answer yes or no: X");
    expect(attestationFailureMessage(401, "Unauthorized")).toContain("signed out");
    expect(attestationFailureMessage(403, "Forbidden")).toBe(
      "This file is not one you can answer for.",
    );
    expect(attestationFailureMessage(404, "Not found")).toBe(
      "This file is not one you can answer for.",
    );
    expect(attestationFailureMessage(500, null)).toContain("could not be recorded");
  });
});
