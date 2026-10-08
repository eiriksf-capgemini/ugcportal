import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_PATH } from "@/lib/routes";

/**
 * ugcportal-t0y K1/K2: the app shell is the only place besides typing the
 * URL that reaches /upload, and it must offer that link to exactly the
 * population src/app/upload/page.tsx itself would let through.
 *
 * Mocks `getSession` (the cache()-memoized `auth()` UploadNavLink actually
 * calls, per src/lib/auth.ts and the round 1 medium finding), not `auth`
 * itself — the module under test never touches `auth` directly.
 *
 * Does NOT mock `next/navigation`: the link's `aria-current` determination
 * lives in the Client Component UploadLink renders
 * (src/components/upload-link.tsx, tested on its own in
 * upload-link.test.tsx), and `usePathname()` outside any router context
 * gracefully returns `null` rather than throwing, so the real
 * implementation runs fine here with `aria-current` simply absent — this
 * file has nothing to say about that attribute either way.
 */
const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: getSessionMock }));

const { UploadNavLink } = await import("./upload-nav-link");

// A real anchor tag whose href is exactly UPLOAD_PATH, not merely a string
// that happens to appear somewhere in the markup.
const UPLOAD_ANCHOR = new RegExp(`<a[^>]*\\shref="${UPLOAD_PATH}"[^>]*>`);

const SIGNED_IN_USER = {
  user: { id: "user-1", email: "someone@example.com", role: "USER" },
};

async function renderLink(): Promise<string> {
  const element = await UploadNavLink();
  return element === null ? "" : renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * ugcportal-8df3 round-1 review, finding 3: the rejection test below
 * (`vi.spyOn(console, "error")`, `getSessionMock.mockRejectedValue(...)`)
 * is never otherwise undone. `vi.clearAllMocks()` in `beforeEach` above only
 * clears call history — not a spy's restored implementation, nor a mock's
 * configured resolved/rejected value — so without this, a leftover
 * console.error spy or a still-rejecting `getSessionMock` could silently
 * leak into whichever test runs after it. Harmless today only because that
 * test happens to be last in this file; the same anti-pattern src/app/
 * page.error.test.tsx's own top comment warns about by name for a different
 * mock. `vi.restoreAllMocks()` undoes the spy; `getSessionMock.mockReset()`
 * is explicit (not left to restoreAllMocks' documented but easy-to-miss
 * fallback behaviour for a plain `vi.fn()`) so a reader does not have to
 * know that nuance to see this mock is clean between tests.
 */
afterEach(() => {
  vi.restoreAllMocks();
  getSessionMock.mockReset();
});

describe("UploadNavLink (ugcportal-t0y)", () => {
  it("K1: shows a link to /upload for a signed-in user", async () => {
    getSessionMock.mockResolvedValue(SIGNED_IN_USER);

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

  /**
   * ugcportal-i7lr: this used to assert a `<nav aria-label="Primary">`
   * landmark of its own — a SECOND nav landmark sitting next to the header's
   * own "Main navigation" (site-header.tsx), holding only this one link. It
   * now returns a bare `<li>` instead, so the caller (site-header.tsx) can
   * splice it into the END of the shared `<ul>` that landmark already
   * renders, rather than wrapping it in a landmark of its own.
   *
   * THE FIXTURE MUTATION: re-wrapping the returned `<li>` in its own
   * `<nav aria-label="Primary">` here (reverting this file's own change) is
   * exactly the regression this guards — `markup).not.toMatch(/<nav\b/)`
   * would fail against that markup, since it would contain one. Performed by
   * hand against a copy of the real output, confirmed to fail, not left in
   * the tree.
   */
  it("puts the link inside a bare <li>, not a nav landmark of its own", async () => {
    getSessionMock.mockResolvedValue(SIGNED_IN_USER);

    const markup = await renderLink();
    const match = /<li[^>]*>([\s\S]*?)<\/li>/.exec(markup);

    expect(match, "no <li> wrapper found").not.toBeNull();
    expect(match?.[1]).toMatch(UPLOAD_ANCHOR);
    expect(markup).not.toMatch(/<nav\b/);
  });

  /**
   * ugcportal-8df3: UploadNavLink reads the session through the shared
   * fail-safe (src/lib/session-or-anonymous.ts), not `getSession()`
   * directly — so a rejected read degrades to "render nothing", the same
   * all-or-nothing signed-out shape K2 above already covers, instead of
   * crashing this component (and, with it, every page it is rendered on).
   * This file mocks `@/lib/auth`, not the fail-safe module itself, so the
   * real `resolveSessionOrAnonymous` runs here.
   *
   * THE FIXTURE MUTATION: remove the `try`/`catch` from
   * src/lib/session-or-anonymous.ts (or swap this component back to a bare
   * `await getSession()`) and this test fails — `UploadNavLink()` rejects
   * instead of resolving to `null`.
   */
  it("renders nothing, not a crash, when the session read fails (fails closed to signed-out)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    getSessionMock.mockRejectedValue(new Error("getSession() failed (simulated)"));

    await expect(UploadNavLink()).resolves.toBeNull();
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
