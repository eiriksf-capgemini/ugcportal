import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_PATH } from "@/lib/routes";

/**
 * ugcportal-t0y K1/K2: the app shell is the only place besides typing the
 * URL that reaches /upload, and it must offer that link to exactly the
 * population src/app/upload/page.tsx itself would let through.
 *
 * Mocks `getSession` (the cache()-memoized `auth()` UploadNavLink actually
 * calls, per src/lib/auth.ts and the round 1 medium finding), not `auth`
 * itself — the module under test never touches `auth` directly.
 */
const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: getSessionMock }));

const { UploadNavLink } = await import("./upload-nav-link");

// A real anchor tag whose href is exactly UPLOAD_PATH, not merely a string
// that happens to appear somewhere in the markup.
const UPLOAD_ANCHOR = new RegExp(`<a[^>]*\\shref="${UPLOAD_PATH}"[^>]*>`);

async function renderLink(): Promise<string> {
  const element = await UploadNavLink();
  return element === null ? "" : renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UploadNavLink (ugcportal-t0y)", () => {
  it("K1: shows a link to /upload for a signed-in user", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });

    expect(await renderLink()).toMatch(UPLOAD_ANCHOR);
  });

  it("K2: renders nothing for a signed-out visitor", async () => {
    getSessionMock.mockResolvedValue(null);

    expect(await UploadNavLink()).toBeNull();
  });

  it("also hides the link from a session with a user but no id", async () => {
    /*
      THE FIXTURE MUTATION, and the case a weaker gate lets through. The
      /upload page itself is gated on `session?.user?.id`
      (src/app/upload/page.tsx), not on `session?.user` - a session shaped
      like this is exactly one the page would redirect to sign-in. If this
      nav link were gated on the weaker `session?.user`, this is the fixture
      that would expose the disagreement: K2 above never would, because it
      uses `null`, which both expressions treat identically.
    */
    getSessionMock.mockResolvedValue({ user: { email: "someone@example.com" } });

    expect(await UploadNavLink()).toBeNull();
  });

  it("puts the link inside a real <nav aria-label=\"Primary\"> landmark", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });

    const markup = await renderLink();
    const match = /<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/.exec(
      markup,
    );

    expect(match, 'no <nav aria-label="Primary"> landmark found').not.toBeNull();
    expect(match?.[1]).toMatch(UPLOAD_ANCHOR);
  });
});
