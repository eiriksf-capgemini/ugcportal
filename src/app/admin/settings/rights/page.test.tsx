import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CURRENT_CHECKLIST_VERSION } from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The resale-rights screen, against a real database.
 *
 * This file exists because the code it covers arrived by DELETING a tested
 * module. ugcportal-0ss capped the rights-holder `<select>` at 200 and read
 * "truncated" off the final list length, which could not tell "exactly 200
 * users" from "cut off" — the defect recorded in ugcportal-gkj. The fix was
 * rights-holders.ts, a module whose stated reason for existing was that the
 * two rules pull against each other, with 91 lines of tests written for
 * exactly that bug class.
 *
 * ugcportal-vsm removed the rights-holder field entirely, which is the right
 * call — the gate reaches a clearance through Media.userId, so there is
 * nothing for a human to pick — and deleted the module and its tests with
 * it. But the SAME cap-and-notice problem reappeared one screen over, on the
 * uploader list, and arrived with no coverage at all. A behaviour that had a
 * regression test ended up with none while the bead that motivated the test
 * was still open.
 *
 * So the boundary is asserted here end to end, against real rows, including
 * the `take: cap + 1` that is the whole reason the notice can be trusted:
 * "there are more" is a fact the database answered, not a length compared
 * against the cap.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const notFoundMock = vi.fn(() => {
  // next/navigation's notFound() throws so the caller stops; a stand-in that
  // returns would let the page carry on rendering an admin screen to a
  // non-admin, which is the opposite of what the test should prove.
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { default: ResaleRightsSettingsPage, MAX_UPLOADERS } = await import(
  "@/app/admin/settings/rights/page"
);

const ADMIN = { user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" } };

/**
 * Renders the page the way Next would: it is an async server component, so
 * it is awaited for its element tree and then rendered.
 */
async function renderPage(
  searchParams: Record<string, string> = {},
): Promise<string> {
  const element = await ResaleRightsSettingsPage({
    searchParams: Promise.resolve(searchParams),
  } as Parameters<typeof ResaleRightsSettingsPage>[0]);
  return renderToStaticMarkup(element);
}

/**
 * One entry per uploader row, read out of the rendered markup.
 *
 * Counted per `<li>` rather than per email occurrence: each row prints its
 * uploader's address twice (as the display name when they have none, and
 * again in the detail line), so counting matches would report double the
 * rows and quietly turn every boundary assertion below into a different
 * test than the one intended.
 */
function listedEmails(markup: string): string[] {
  const list = /<ul\b[^>]*>([\s\S]*?)<\/ul>/.exec(markup)?.[1] ?? "";
  return [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(
    (row) => /([\w.+-]+@example\.com)/.exec(row[1])?.[1] ?? "",
  );
}

const TRUNCATION_NOTICE = `Showing the first ${MAX_UPLOADERS} uploaders`;

/** An uploader with one upload, so the page's `where` clause includes them. */
async function createUploaderWithMedia(id: string, email: string) {
  await prisma.user.create({ data: { id, email, role: "USER" } });
  await prisma.media.create({
    data: {
      id: `media-${id}`,
      userId: id,
      kind: "IMAGE",
      key: `uploads/${id}/a.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 10,
      originalName: "a.jpg",
    },
  });
}

/**
 * `count` uploaders whose emails sort in creation order, seeded in two bulk
 * inserts rather than `count` serial round trips.
 *
 * ugcportal-qudv: the per-row version awaited a `user.create` and a
 * `media.create` in a loop, so a page's worth of uploaders cost two
 * sequential round trips against the real SQLite connection per uploader.
 * That stayed under vitest's default timeout on an unloaded machine but not
 * on a loaded CI runner, because each round trip's overhead — not the row
 * count — is what scales with runner contention (see the bead for the CI
 * run and timings that motivated this). `createMany` issues one statement
 * per table regardless of `count`, so the cost no longer scales with
 * contention the same way.
 */
async function createUploaders(count: number, prefix = "u") {
  const ids = Array.from({ length: count }, (_, index) =>
    `${prefix}-${String(index).padStart(4, "0")}`,
  );
  await prisma.user.createMany({
    data: ids.map((id, index) => ({
      id,
      email: `${prefix}${String(index).padStart(4, "0")}@example.com`,
      role: "USER" as const,
    })),
  });
  await prisma.media.createMany({
    data: ids.map((id) => ({
      id: `media-${id}`,
      userId: id,
      kind: "IMAGE" as const,
      key: `uploads/${id}/a.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 10,
      originalName: "a.jpg",
    })),
  });
}

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  authMock.mockReset().mockResolvedValue(ADMIN);
  notFoundMock.mockClear();
  await prisma.resaleRightsEvent.deleteMany({});
  await prisma.media.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({
    data: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
  });
});

describe("who the screen lists", () => {
  it("lists uploaders and people already judged, and nobody else", async () => {
    await createUploaderWithMedia("has-media", "hasmedia@example.com");
    // A review but no uploads: still needs to be reachable, or a REVOKED
    // decision could never be revisited once their files were deleted.
    await prisma.user.create({
      data: { id: "has-review", email: "hasreview@example.com", role: "USER" },
    });
    await prisma.resaleRightsReview.create({
      data: {
        uploaderUserId: "has-review",
        checklistVersion: CURRENT_CHECKLIST_VERSION,
      },
    });
    // Neither: a signed-up account with nothing to decide about. Listing
    // them would make this screen a user directory.
    await prisma.user.create({
      data: { id: "has-neither", email: "hasneither@example.com", role: "USER" },
    });

    const listed = listedEmails(await renderPage());

    expect(listed).toContain("hasmedia@example.com");
    expect(listed).toContain("hasreview@example.com");
    expect(listed).not.toContain("hasneither@example.com");
    // The admin themselves has neither, so they are absent too — which is
    // what makes the assertion above about the rule, not about this fixture.
    expect(listed).not.toContain("admin@example.com");
  });

  it("says so plainly when nobody has uploaded anything", async () => {
    const markup = await renderPage();

    expect(markup).toContain("Nobody has uploaded anything yet");
    expect(markup).not.toContain(TRUNCATION_NOTICE);
  });
});

/**
 * The boundary ugcportal-gkj was filed about, at the new location.
 *
 * The query asks for `MAX_UPLOADERS + 1` and shows `MAX_UPLOADERS`, so the
 * notice reports something the database answered. Reading it off the
 * rendered length instead is what made the old notice vanish at exactly the
 * size it was written for.
 */
describe("the truncation notice", () => {
  it("does not appear at exactly the page size", async () => {
    await createUploaders(MAX_UPLOADERS);

    const markup = await renderPage();

    expect(listedEmails(markup)).toHaveLength(MAX_UPLOADERS);
    expect(markup).not.toContain(TRUNCATION_NOTICE);
  });

  it("appears at one more than the page size, showing exactly the cap", async () => {
    await createUploaders(MAX_UPLOADERS + 1);

    const markup = await renderPage();

    expect(markup).toContain(TRUNCATION_NOTICE);
    // Exactly the cap: the extra row is fetched to answer "are there more",
    // never rendered.
    expect(listedEmails(markup)).toHaveLength(MAX_UPLOADERS);
  });

  it("does not appear one below the page size", async () => {
    // The other side of the boundary, so the assertions above cannot pass
    // with the notice simply never rendering.
    await createUploaders(MAX_UPLOADERS - 1);

    const markup = await renderPage();

    expect(listedEmails(markup)).toHaveLength(MAX_UPLOADERS - 1);
    expect(markup).not.toContain(TRUNCATION_NOTICE);
  });
});

describe("what the screen says about a clearance", () => {
  it("shows an uploader with no review as not sellable, with a reason", async () => {
    await createUploaderWithMedia("u-1", "u1@example.com");

    const markup = await renderPage();

    expect(markup).toContain("UNREVIEWED");
    expect(markup).toContain("not sellable");
    expect(markup).toContain("Nothing this uploader has uploaded can be sold");
  });

  it("shows a cleared uploader as clear to sell, once uploads are triaged", async () => {
    await createUploaderWithMedia("u-1", "u1@example.com");
    await prisma.resaleRightsReview.create({
      data: {
        uploaderUserId: "u-1",
        status: "CLEARED",
        checklistVersion: CURRENT_CHECKLIST_VERSION,
        reviewedByUserId: "admin-1",
        reviewedAt: new Date(),
      },
    });

    const markup = await renderPage();

    expect(markup).toContain("clear to sell");
    expect(markup).not.toContain("not sellable");
  });

  it("warns when an admin cleared their own uploads", async () => {
    // Separation of duties, re-anchored: the conflict is now an admin
    // signing off their own work rather than the account they connected.
    await prisma.media.create({
      data: {
        id: "media-admin",
        userId: "admin-1",
        kind: "IMAGE",
        key: "uploads/admin-1/a.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        originalName: "a.jpg",
      },
    });
    await prisma.resaleRightsReview.create({
      data: {
        uploaderUserId: "admin-1",
        status: "CLEARED",
        checklistVersion: CURRENT_CHECKLIST_VERSION,
        reviewedByUserId: "admin-1",
        reviewedAt: new Date(),
      },
    });

    expect(await renderPage()).toContain("Reviewed by the uploader themselves");
  });
});

describe("the decision form is opened one at a time", () => {
  it("renders no form until ?edit= names an uploader", async () => {
    await createUploaders(2);

    const markup = await renderPage();

    expect(markup).not.toContain('name="uploaderUserId"');
    expect(markup).toContain("?edit=u-0000");
  });

  it("renders the form for the named uploader only", async () => {
    await createUploaders(2);

    const markup = await renderPage({ edit: "u-0001" });

    const hidden = [
      ...markup.matchAll(/<input[^>]*name="uploaderUserId"[^>]*>/g),
    ];
    expect(hidden).toHaveLength(1);
    expect(hidden[0][0]).toContain('value="u-0001"');
  });
});

/**
 * The cap is a display limit, not a limit on who can be decided about.
 *
 * This screen is the only path in the codebase that can write
 * `status = CLEARED`, so an uploader whose form cannot be opened is an
 * uploader whose work can never be sold. Before this, ranking past the cap
 * by email did exactly that and did it silently: a hand-typed `?edit=<id>`
 * rendered an ordinary page with no form and nothing to say why.
 */
describe("the admin area is navigable without the deferred feature", () => {
  it("links to users and roles", async () => {
    // There is no admin nav. Until ugcportal-vsm the only in-app route to
    // this screen sat on the Instagram settings page — a deferred feature —
    // so an operator who never connected an account had no discoverable way
    // to reach the one screen that gates all selling.
    expect(await renderPage()).toContain('href="/admin/settings/users"');
  });
});

describe("an uploader outside the listed slice can still be decided about", () => {
  it("renders the form for someone ranked past the cap", async () => {
    await createUploaders(MAX_UPLOADERS + 1);
    // Sorted last by email, so they fall outside the slice the page lists.
    const outside = `u${String(MAX_UPLOADERS).padStart(4, "0")}@example.com`;
    const outsideId = `u-${String(MAX_UPLOADERS).padStart(4, "0")}`;

    const closed = await renderPage();
    expect(listedEmails(closed)).not.toContain(outside);

    const markup = await renderPage({ edit: outsideId });

    const hidden = [
      ...markup.matchAll(/<input[^>]*name="uploaderUserId"[^>]*>/g),
    ];
    expect(hidden).toHaveLength(1);
    expect(hidden[0][0]).toContain(`value="${outsideId}"`);
    // And they are visible on the page, not just present in a hidden field.
    expect(listedEmails(markup)).toContain(outside);
  });

  it("says why that uploader appears at the top — beyond the cap case", async () => {
    await createUploaders(MAX_UPLOADERS + 1);
    const outsideId = `u-${String(MAX_UPLOADERS).padStart(4, "0")}`;

    const markup = await renderPage({ edit: outsideId });

    expect(markup).toContain("fall outside the first");
    // Pinned, not sorted into place: the admin came here to act on them.
    expect(listedEmails(markup)[0]).toBe(
      `u${String(MAX_UPLOADERS).padStart(4, "0")}@example.com`,
    );
  });

  it("distinguishes exclusion by query from exclusion by cap: query-excluded case (K1)", async () => {
    // Seed uploaders within the cap, so the truncation notice would not appear.
    await createUploaders(5);
    // Create a user with no uploads and no review — excluded by the page query.
    await prisma.user.create({
      data: {
        id: "excluded-by-query",
        email: "excluded@example.com",
        role: "USER",
      },
    });

    const markup = await renderPage({ edit: "excluded-by-query" });

    // Should show the query-exclusion reason, not the cap reason.
    expect(markup).toContain("no uploads and no prior review");
    expect(markup).not.toContain("fall outside the first");
    // Pin the exact wording too (review-standards family 3): the reason
    // category alone doesn't catch a regression back to the K3-violating
    // claim that this uploader "does not appear" when they are, in fact,
    // pinned and visible right here.
    expect(markup).toContain("would not normally appear in the listing below");
    expect(markup).not.toContain("do not appear in the list above");
    // The uploader should still be pinned and visible.
    expect(listedEmails(markup)[0]).toBe("excluded@example.com");
  });

  it("shows the truncation reason when beyond the cap (K2)", async () => {
    await createUploaders(MAX_UPLOADERS + 1);
    const outsideId = `u-${String(MAX_UPLOADERS).padStart(4, "0")}`;

    const markup = await renderPage({ edit: outsideId });

    expect(markup).toContain("fall outside the first");
    expect(markup).not.toContain("no uploads and no prior review");
    // Pinned, not sorted into place: the admin came here to act on them.
    expect(listedEmails(markup)[0]).toBe(
      `u${String(MAX_UPLOADERS).padStart(4, "0")}@example.com`,
    );
  });

  it("does not duplicate an uploader who is already listed", async () => {
    await createUploaders(3);

    const markup = await renderPage({ edit: "u-0001" });

    const listed = listedEmails(markup);
    expect(listed.filter((email) => email === "u0001@example.com")).toHaveLength(
      1,
    );
    expect(markup).not.toContain("fall outside the first");
  });

  it("explains a ?edit= that names nobody, rather than rendering nothing", async () => {
    // A stale tab, a deleted account, a typo. Silently rendering an ordinary
    // page leaves the admin unable to tell the difference between "no form"
    // and "no such person".
    await createUploaders(2);

    const markup = await renderPage({ edit: "ghost" });

    expect(markup).toContain("no longer has an account");
    expect(markup).not.toContain('name="uploaderUserId"');
  });
});

describe("authorization", () => {
  it("is not found for a signed-out caller, and reads nothing", async () => {
    authMock.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("is not found for a signed-in non-admin", async () => {
    // notFound rather than 403: an ordinary user should not learn that an
    // admin area exists at this path.
    authMock.mockResolvedValue({ user: { id: "u-1", role: "USER" } });

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
