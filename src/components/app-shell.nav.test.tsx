import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_PATH } from "@/lib/routes";

/**
 * ugcportal-t0y: the app shell is the only place besides typing the URL that
 * reaches /upload, and it must offer that link to exactly the population the
 * page itself would let through - never more, never less.
 *
 * `auth` is mocked the same way src/app/upload/page.test.tsx mocks it for the
 * page this nav link points at, so both tests are asserting the same "signed
 * in" shape stays in agreement. `signIn`/`signOut` are mocked alongside it
 * because AuthStatus's inline server actions reference them at module scope
 * even though a static render never invokes the actions themselves.
 */
const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: authMock,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const { AppShell } = await import("./app-shell");

// A real anchor tag whose href is exactly UPLOAD_PATH, not merely a string
// that happens to appear somewhere in the markup (the wordmark, the skip
// link, and page content could all mention "/upload" in prose without this
// being the nav entry point K1/K2 are about).
const UPLOAD_ANCHOR = new RegExp(`<a[^>]*\\shref="${UPLOAD_PATH}"[^>]*>`);

function extractNavLandmark(markup: string): string | null {
  const match = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(markup);
  return match ? match[1] : null;
}

async function renderShell(): Promise<string> {
  return renderToStaticMarkup(
    await AppShell({ children: <div data-testid="page-content" /> }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the upload nav link (ugcportal-t0y)", () => {
  it("K1: shows a link to /upload for a signed-in user", async () => {
    authMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });

    const markup = await renderShell();

    expect(markup).toMatch(UPLOAD_ANCHOR);
  });

  it("K2: shows no such link to a signed-out visitor", async () => {
    authMock.mockResolvedValue(null);

    const markup = await renderShell();

    expect(markup).not.toMatch(UPLOAD_ANCHOR);
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
    authMock.mockResolvedValue({ user: { email: "someone@example.com" } });

    const markup = await renderShell();

    expect(markup).not.toMatch(UPLOAD_ANCHOR);
  });

  it("puts the link inside a real <nav> landmark, not a bare anchor in the header", async () => {
    authMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });

    const markup = await renderShell();
    const nav = extractNavLandmark(markup);

    expect(nav, "no <nav> landmark found in the rendered header").not.toBeNull();
    expect(nav).toMatch(UPLOAD_ANCHOR);
  });

  it("still renders no second <main> and keeps the skip link's target", async () => {
    // Guards against the nav slot regressing the landmark structure the rest
    // of the app depends on (src/app/upload/page.test.tsx and
    // src/app/page.test.tsx each assert their page adds no second <main>;
    // this is the shell's own half of that contract).
    authMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });

    const markup = await renderShell();

    expect([...markup.matchAll(/<main\b/g)]).toHaveLength(1);
    expect(markup).toContain('href="#main-content"');
  });
});
