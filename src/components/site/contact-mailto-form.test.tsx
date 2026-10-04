// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContactMailtoForm } from "@/components/site/contact-mailto-form";

/**
 * ugcportal-qnq9.7 round-1 review, the blocking medium finding: a
 * GET-method `<form action="mailto:...">` encodes a space as `+`
 * (application/x-www-form-urlencoded), which a real mail client does not
 * decode back to a space in a `mailto:` URI. This file proves the fix —
 * the href is built client-side with `encodeURIComponent`, which encodes a
 * space as `%20` — including the live-typing case, not just a static
 * default.
 *
 * `@vitest-environment jsdom` and the `createRoot`/`act` mounting pattern
 * match src/components/upload-link.test.tsx and
 * src/app/upload/upload-form.alt-text-error.test.tsx — this repo's
 * established way to mount a real Client Component against a real DOM
 * rather than reach for `renderToStaticMarkup` (which cannot observe a
 * value changing after a simulated keystroke).
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mount(email: string, defaultSubject: string): void {
  act(() => {
    root.render(<ContactMailtoForm email={email} defaultSubject={defaultSubject} />);
  });
}

function submitLink(): HTMLAnchorElement {
  const link = container.querySelector<HTMLAnchorElement>("a[data-contact-submit]");
  if (link === null) throw new Error("no contact-submit link in the markup");
  return link;
}

function setFieldValue(selector: string, value: string): void {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  if (field === null) throw new Error(`no field matching ${selector}`);
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(field, value);
  act(() => {
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ContactMailtoForm", () => {
  it("builds the initial href from the default subject, encoded with %20 and never +", () => {
    mount("hello@example.com", "Hello from your portfolio page");

    const href = submitLink().getAttribute("href");
    expect(href).toBe(
      "mailto:hello%40example.com?subject=Hello%20from%20your%20portfolio%20page",
    );
    expect(href).not.toContain("+");
  });

  it("recomputes the href with %20 (not +) as the subject is typed", () => {
    mount("hello@example.com", "Hi");

    setFieldValue("#contact-subject", "A longer subject with several spaces");

    const href = submitLink().getAttribute("href");
    expect(href).toBe(
      "mailto:hello%40example.com?subject=A%20longer%20subject%20with%20several%20spaces",
    );
    expect(href).not.toContain("+");
  });

  it("includes the message as the body, %20-encoded, once typed", () => {
    mount("hello@example.com", "Hi");

    setFieldValue("#contact-message", "Great wine cooler write-up");

    const href = submitLink().getAttribute("href");
    expect(href).toContain("body=Great%20wine%20cooler%20write-up");
    expect(href).not.toContain("+");
  });

  it("omits the body parameter until a message is typed", () => {
    mount("hello@example.com", "Hi");
    expect(submitLink().getAttribute("href")).not.toContain("body=");
  });
});
