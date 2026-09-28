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

/*
  The subject vocabulary the tag picker offers (ugcportal-jsc). Mocked at the
  Prisma client rather than at a helper, so the assertions below see the exact
  arguments the page passes — in particular the projection, which must stay
  the two public fields and not `Tag.id`.
*/
const tagFindManyMock = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { tag: { findMany: tagFindManyMock } },
}));

const { default: UploadPage } = await import("./page");
const { MEDIA_TAGS_SELECT } = await import("@/lib/media-access");

const SEEDED_TAGS = [
  { slug: "books", name: "Books" },
  { slug: "food", name: "Food" },
  { slug: "wine-drink", name: "Wine & drink" },
];

const SIGN_IN_URL = "/api/auth/signin?callbackUrl=%2Fupload";

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await UploadPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  tagFindManyMock.mockResolvedValue(SEEDED_TAGS);
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

/**
 * The tag picker (ugcportal-jsc): assigning subjects at upload time.
 *
 * What it does NOT cover is worth stating, because the limit is the test
 * environment rather than a choice. vitest runs these in node with no DOM, so
 * nothing here ticks a box — the wiring from a ticked box to the `tags` parts
 * on the wire is covered in upload-flow.test.tsx, against enqueueFiles and the
 * transport directly. This file covers what the SERVER sends down: which tags
 * are offered, and that offering them discloses nothing beyond their names.
 */
describe("the tag picker on the upload page", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({
      user: { id: "user-1", email: "someone@example.com", role: "USER" },
    });
  });

  it("offers one checkbox per subject, labelled with its name", async () => {
    const markup = await renderPage();

    for (const tag of SEEDED_TAGS) {
      expect(markup).toContain(`value="${tag.slug}"`);
    }
    // "Wine & drink" is deliberately in the fixture: the ampersand is escaped
    // in the markup, so a test looking for the raw name would fail for the
    // wrong reason — and one looking for an over-escaped name would pass for
    // the wrong reason.
    expect(markup).toContain("Wine &amp; drink");
    expect(markup).toContain("Tag what you add next");
    expect(
      [...markup.matchAll(/<input[^>]*type="checkbox"/g)],
    ).toHaveLength(SEEDED_TAGS.length);
  });

  it("starts with nothing ticked", async () => {
    // Uploading is not opting in to a subject by default. React renders
    // `checked` as the `checked` attribute, so its absence is the assertion.
    const markup = await renderPage();
    const checkboxes = [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)];
    expect(checkboxes).toHaveLength(SEEDED_TAGS.length);
    for (const [input] of checkboxes) {
      expect(input).not.toContain("checked");
    }
  });

  it("reads only the two fields every audience gets, never Tag.id", async () => {
    await renderPage();

    expect(tagFindManyMock).toHaveBeenCalledWith({
      select: MEDIA_TAGS_SELECT.select,
      orderBy: MEDIA_TAGS_SELECT.orderBy,
    });
    // Guards the guard: the assertion above is only worth anything while that
    // shared projection really is the narrow one. If `id` is ever added to
    // it, this fails here rather than quietly widening the picker, the owner
    // feed and the public gallery at once.
    expect(MEDIA_TAGS_SELECT.select).toEqual({ slug: true, name: true });
  });

  it("says so, rather than rendering an empty group, when there are none", async () => {
    tagFindManyMock.mockResolvedValue([]);

    const markup = await renderPage();

    expect(markup).toContain("No subjects have been set up yet");
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).not.toContain("<fieldset");
  });
});
