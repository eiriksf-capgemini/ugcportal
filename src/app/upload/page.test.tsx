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
const { MAX_PICKER_TAGS, TAG_PUBLIC_FIELDS } = await import("@/lib/tags");

/*
  Returned OLDEST-FIRST, the order `listPickerTags` actually produces — which
  is deliberately NOT the order they should be read in. The page sorts for
  display, and a fixture that arrived pre-sorted would make that sort
  unfalsifiable.
*/
const SEEDED_TAGS = [
  { slug: "wine-drink", name: "Wine & drink" },
  { slug: "food", name: "Food" },
  { slug: "books", name: "Books" },
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

  it("asks for a BOUNDED page of the vocabulary, oldest first", async () => {
    /*
     * The round-1 medium. The tag table has no ceiling — any authenticated
     * account can add to it and nothing deletes — so an unbounded SELECT
     * rendered one-checkbox-per-row made this page a denial of service on
     * itself.
     *
     * This asserts the query that is ISSUED. That the bound and the ordering
     * actually bite is a claim about SQLite, and is covered against a real
     * database in src/lib/tags.vocabulary.test.ts.
     */
    await renderPage();

    expect(tagFindManyMock).toHaveBeenCalledWith({
      select: TAG_PUBLIC_FIELDS,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_PICKER_TAGS,
    });
  });

  it("reads only the two fields every audience gets, never Tag.id", async () => {
    await renderPage();

    // Guards the guard: the assertion above is only worth anything while the
    // shared projection really is the narrow one. If `id` is ever added to
    // it, this fails here rather than quietly widening the picker, the owner
    // feed and the public gallery at once.
    expect(TAG_PUBLIC_FIELDS).toEqual({ slug: true, name: true });
  });

  it("puts the subjects in a readable order, not the order they were created", async () => {
    /*
     * `listPickerTags` returns oldest-first because that is what makes the
     * cap unspoofable — a later writer cannot choose to be older. Nobody
     * wants to READ a list of subjects in insertion order, so the page sorts
     * by name. The fixture is deliberately unsorted, or this could not fail.
     */
    const markup = await renderPage();

    const rendered = [...markup.matchAll(/value="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(rendered).toEqual(["books", "food", "wine-drink"]);
  });

  it("says so, rather than rendering an empty group, when there are none", async () => {
    tagFindManyMock.mockResolvedValue([]);

    const markup = await renderPage();

    expect(markup).toContain("No subjects have been set up yet");
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).not.toContain("<fieldset");
  });

  it("renders the picker BEFORE the drop zone", async () => {
    /*
     * The round-1 low, and the reason it is a correctness question rather
     * than a layout preference: there is no staging step on this page, so
     * dropping a file starts its upload. A picker the user meets AFTER the
     * drop zone is one they meet after it can no longer affect anything they
     * have done — and there is no owner-facing retag screen yet
     * (ugcportal-1wz), so those uploads stay untagged with no remedy in the
     * product.
     *
     * The picker's own copy says "Applies to files you add from now on",
     * which is only an honest sentence if it is read before anything is
     * added. Asserted on DOCUMENT ORDER, since that is both the visual order
     * and the order a screen reader takes them in.
     */
    const markup = await renderPage();

    const picker = markup.indexOf("Tag what you add next");
    const dropZone = markup.indexOf("drag them here");

    // Both present, so the comparison is between two real positions rather
    // than two -1s, which would compare equal and prove nothing.
    expect(picker).toBeGreaterThan(-1);
    expect(dropZone).toBeGreaterThan(-1);
    expect(picker).toBeLessThan(dropZone);
  });

  it("starts with no cap message, because nothing is selected", async () => {
    // The live region is rendered unconditionally and empty — one inserted
    // at the same moment as its text is frequently not announced at all.
    const markup = await renderPage();

    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("Untick one to choose another");
  });

  it("disables nothing on first render", async () => {
    // Three subjects in the fixture and a cap of six: the picker must not
    // arrive with boxes already greyed out.
    const markup = await renderPage();

    const checkboxes = [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)];
    expect(checkboxes).toHaveLength(SEEDED_TAGS.length);
    for (const [input] of checkboxes) {
      expect(input).not.toContain("disabled");
    }
  });
});
