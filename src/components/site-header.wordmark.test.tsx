// @vitest-environment jsdom
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ugcportal-ry6w: at 390px, signed in, with a long display name, the header
 * wordmark must not be squeezed to one letter - the display name gives way
 * first.
 *
 * WHAT THIS PINS: the class strings and markup that decide the squeeze order
 * - the wordmark Link does not shrink (`shrink-0`, no `shrink-[999]`), its
 * text is the full site name, and the signed-in name span is the element
 * that carries `min-w-0 truncate` and the full name on `title`.
 *
 * WHAT IT CANNOT: jsdom does no layout, so no pixel width is measured and
 * nothing here proves the rendered wordmark is N pixels wide at 390px. The
 * e2e assertion at 390px is blocked on ugcportal-0wh6 (no signed-in e2e
 * fixture). This is the RTL-style fallback the bead names.
 */
const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/components/upload-nav-link", () => ({
  UploadNavLink: () => (
    <li>
      <a href="/upload">Upload</a>
    </li>
  ),
}));
// The real AuthStatus is an async Server Component renderToStaticMarkup cannot
// resolve nested in SiteHeader (same constraint as site-header.test.tsx); the
// header gets a stub and the real one is rendered beside it below.
vi.mock("@/components/auth-status", () => ({ AuthStatus: () => null }));
const realAuth =
  await vi.importActual<typeof import("./auth-status")>("./auth-status");

const { SiteHeader } = await import("./site-header");

const LONG_NAME = "Bartholomew Featherstonehaugh"; // 29 chars, over the bead's 24

afterEach(() => {
  getSessionMock.mockReset();
});

async function renderSignedIn(): Promise<{ wordmark: Element; name: Element }> {
  getSessionMock.mockResolvedValue({
    user: { id: "u1", name: LONG_NAME, email: "a@example.com", role: "USER" },
  });
  const header = document.createElement("div");
  // SiteHeader nests AuthStatus (async); render the two halves and join them
  // in one container so the assertions read one signed-in header.
  header.innerHTML =
    renderToStaticMarkup(SiteHeader() as ReactElement).replace(
      /<\/header>$/,
      "",
    ) + renderToStaticMarkup(await realAuth.AuthStatus());
  const wordmark = header.querySelector('a[href="/"]');
  const name = header.querySelector("form span[title]");
  if (!wordmark || !name) throw new Error("wordmark or name span missing");
  return { wordmark, name };
}

describe("header wordmark under width pressure (ugcportal-ry6w)", () => {
  it("K1: the wordmark keeps its full text and does not shrink", async () => {
    const { wordmark } = await renderSignedIn();
    const classes = wordmark.className.split(/\s+/);

    expect(wordmark.textContent).toBe("UGC Portal");
    expect(classes).toContain("shrink-0");
    expect(classes).not.toContain("shrink-[999]");
    expect(classes).not.toContain("min-w-12");
  });

  it("K2: the display name truncates with an ellipsis, with the full name on title", async () => {
    const { name } = await renderSignedIn();
    const classes = name.className.split(/\s+/);

    expect(classes).toContain("min-w-0");
    expect(classes).toContain("truncate");
    expect(name.getAttribute("title")).toBe(LONG_NAME);
    expect(name.textContent).toBe(LONG_NAME);
  });
});
