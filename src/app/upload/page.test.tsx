import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACCEPTED_MIME_TYPES } from "@/lib/media";

/**
 * ugcportal-n3c K5: a signed-out visitor is sent to sign in, not handed a
 * form that will 401 the moment they drop a file on it.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const redirectMock = vi.fn((url: string): never => {
  /*
    next/navigation's redirect() throws, and that is load-bearing here: a
    stand-in that merely recorded the call and returned would let the page
    carry straight on and render the upload form to a signed-out visitor,
    which is precisely the state K5 says must not exist. The test would pass
    while the page it describes was broken.
  */
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const { default: UploadPage } = await import("./page");

const SIGN_IN_URL = "/api/auth/signin?callbackUrl=%2Fupload";

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await UploadPage());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the upload page is gated (K5)", () => {
  it("sends a signed-out visitor to sign in", async () => {
    authMock.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow(`NEXT_REDIRECT:${SIGN_IN_URL}`);
    expect(redirectMock).toHaveBeenCalledWith(SIGN_IN_URL);
  });

  it("comes back to /upload afterwards rather than dropping the visitor home", async () => {
    authMock.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow();
    expect(redirectMock.mock.calls[0][0]).toContain(
      `callbackUrl=${encodeURIComponent("/upload")}`,
    );
  });

  it("sends away a session that has no user id either", async () => {
    /*
      THE FIXTURE MUTATION, and the case a weaker gate lets through. POST
      /api/media answers 401 on `!session?.user?.id`, so a session object with
      a user but no id is exactly a visitor who would be shown a working-looking
      form and get a 401 on submit. Gating on `session` alone passes every
      other test in this file.
    */
    authMock.mockResolvedValue({ user: { email: "someone@example.com" } });

    await expect(renderPage()).rejects.toThrow(`NEXT_REDIRECT:${SIGN_IN_URL}`);
  });

  it("also sends away a session whose user is missing", async () => {
    authMock.mockResolvedValue({ expires: "2026-12-01T00:00:00.000Z" });
    await expect(renderPage()).rejects.toThrow(`NEXT_REDIRECT:${SIGN_IN_URL}`);
  });
});

describe("the upload page, for someone signed in", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });
  });

  it("renders the upload form instead of redirecting", async () => {
    const markup = await renderPage();

    expect(redirectMock).not.toHaveBeenCalled();
    expect(markup).toContain('type="file"');
    expect(markup).toContain("multiple");
    expect(markup).toContain("Choose files");
    expect(markup).toContain("drag them here");
  });

  it("offers every type the API accepts, and no others", async () => {
    const markup = await renderPage();
    expect(markup).toContain(`accept="${ACCEPTED_MIME_TYPES.join(",")}"`);
  });

  it("adds no second <main>, because the app shell owns the only one", async () => {
    // src/components/app-shell.tsx renders the page's single main landmark
    // and the skip link that targets it; a second one breaks both.
    const markup = await renderPage();
    expect(markup).not.toContain("<main");
  });

  it("gives the page one heading", async () => {
    const markup = await renderPage();
    expect([...markup.matchAll(/<h1\b/g)]).toHaveLength(1);
  });

  it("starts with an empty queue and says so", async () => {
    const markup = await renderPage();
    expect(markup).toContain("Nothing queued yet.");
    // An empty list renders nothing at all rather than an empty <ul>.
    expect(markup).not.toContain("<ul");
  });
});
