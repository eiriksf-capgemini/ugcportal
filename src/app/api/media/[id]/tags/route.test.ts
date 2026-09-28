import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * PUT /api/media/[id]/tags — ugcportal-jsc K2: an owner edits the subjects on
 * their own media; anybody else is refused.
 *
 * AGAINST A REAL DATABASE, with only the session stubbed. The claim K2 makes
 * is "the change is saved", and a mocked Prisma client proves a function was
 * called with plausible arguments, not that a row now has different tags —
 * still less that a second write replaced the first rather than adding to it,
 * which is the whole difference between `set` and `connect`.
 *
 * The ownership answers deliberately mirror ugcportal-bdh's, because they come
 * from the same gate: `requireOwnedMedia` decides 401/403/404 once and every
 * handler on this resource reports what it says. This file re-checks them here
 * rather than assuming, since "reuses the gate" is the acceptance criterion
 * rather than an implementation note.
 */

const sessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => sessionMock() }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { PUT } = await import("@/app/api/media/[id]/tags/route");
const { MAX_TAGS_PER_ITEM } = await import("@/lib/tags");

const OWNER = "owner-jsc";
const STRANGER = "stranger-jsc";
const MEDIA_ID = "media-jsc";

/** The right-to-left override, by code point — see src/lib/tags.test.ts. */
const RTL_OVERRIDE = String.fromCodePoint(0x202e);

function context(id: string = MEDIA_ID) {
  return { params: Promise.resolve({ id }) };
}

function request(body: unknown, id: string = MEDIA_ID) {
  return new Request(`http://localhost/api/media/${id}/tags`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function seedMedia(id: string, userId: string = OWNER) {
  await prisma.media.create({
    data: {
      id,
      userId,
      kind: "IMAGE",
      key: `media/${userId}/${id}-original.jpg`,
      previewKey: `previews/${userId}/${id}-preview.webp`,
      previewId: `pv-${id}`,
      mimeType: "image/jpeg",
      sizeBytes: 4096,
      originalName: `${id}.jpg`,
      publishedAt: new Date("2026-03-04T10:00:00.000Z"),
    },
  });
}

/** The tag slugs actually stored against a row, read back from the database. */
async function storedSlugs(id: string = MEDIA_ID): Promise<string[]> {
  const row = await prisma.media.findUnique({
    where: { id },
    select: { tags: { select: { slug: true }, orderBy: { slug: "asc" } } },
  });
  return (row?.tags ?? []).map((tag) => tag.slug);
}

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  sessionMock.mockReset();
  await prisma.media.deleteMany({});
  await prisma.tag.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.createMany({
    data: [
      { id: OWNER, email: "owner@example.com", role: "USER" },
      { id: STRANGER, email: "stranger@example.com", role: "USER" },
    ],
  });
  await seedMedia(MEDIA_ID);
});

describe("K2 — the owner may set the tags on their own media", () => {
  beforeEach(() => {
    sessionMock.mockResolvedValue({ user: { id: OWNER } });
  });

  it("saves the tags and reports them back", async () => {
    const response = await PUT(
      request({ tags: ["Food", "Wine & drink"] }),
      context(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tags: { slug: string; name: string }[];
    };
    expect(body.tags).toEqual([
      { slug: "food", name: "Food" },
      { slug: "wine-drink", name: "Wine & drink" },
    ]);
    // The response is the claim; the database is whether it was true.
    expect(await storedSlugs()).toEqual(["food", "wine-drink"]);
  });

  it("REPLACES the set rather than adding to it", async () => {
    /*
     * The difference between `set` and `connect`, and the reason this test
     * exists as its own case: with `connect` the first assertion below still
     * passes and the second reads ["books", "food"] — a tag the owner
     * explicitly removed, still on their photograph, with a 200 saying it
     * worked.
     */
    await PUT(request({ tags: ["Food"] }), context());
    expect(await storedSlugs()).toEqual(["food"]);

    await PUT(request({ tags: ["Books"] }), context());
    expect(await storedSlugs()).toEqual(["books"]);
  });

  it("removes every tag when sent an empty list", async () => {
    await PUT(request({ tags: ["Food", "Books"] }), context());
    expect(await storedSlugs()).toHaveLength(2);

    const response = await PUT(request({ tags: [] }), context());

    expect(response.status).toBe(200);
    expect(await storedSlugs()).toEqual([]);
  });

  it("creates a tag that does not exist yet", async () => {
    await PUT(request({ tags: ["Ceramics"] }), context());

    const created = await prisma.tag.findUnique({ where: { slug: "ceramics" } });
    expect(created?.name).toBe("Ceramics");
  });

  it("reuses the existing row for a differently-cased spelling, and does not rename it", async () => {
    await PUT(request({ tags: ["Ceramics"] }), context());

    await seedMedia("media-2");
    await PUT(request({ tags: ["CERAMICS"] }, "media-2"), context("media-2"));

    // One row, not two: the slug is the identity key, and SQLite's unique
    // index on `name` would not have given this.
    expect(await prisma.tag.count({ where: { slug: "ceramics" } })).toBe(1);
    // And the first writer's spelling survives. `update: {}` on the upsert is
    // what makes that true; writing `name` there would have renamed the chip
    // under the first owner's photograph from under them.
    const tag = await prisma.tag.findUnique({ where: { slug: "ceramics" } });
    expect(tag?.name).toBe("Ceramics");
  });

  it("never returns the original's storage key or the uploader's id", async () => {
    const response = await PUT(request({ tags: ["Food"] }), context());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("key");
    expect(body).not.toHaveProperty("userId");
    expect(JSON.stringify(body)).not.toContain(`media/${OWNER}/`);
    // Guards the guard: the row really does hold that string, so the absence
    // above is a fact about the projection rather than about the fixture.
    const row = await prisma.media.findUnique({ where: { id: MEDIA_ID } });
    expect(row?.key).toContain(`media/${OWNER}/`);
  });

  it("changes no other column — not the name, not the publish state", async () => {
    const before = await prisma.media.findUnique({ where: { id: MEDIA_ID } });

    await PUT(request({ tags: ["Food"] }), context());

    const after = await prisma.media.findUnique({ where: { id: MEDIA_ID } });
    expect(after).toEqual(before);
  });
});

describe("K2 — everybody else is refused", () => {
  it("answers 401 with no session, and writes nothing", async () => {
    sessionMock.mockResolvedValue(null);

    const response = await PUT(request({ tags: ["Food"] }), context());

    expect(response.status).toBe(401);
    expect(await storedSlugs()).toEqual([]);
    // Nor is a tag row minted on the way to being refused.
    expect(await prisma.tag.count()).toBe(0);
  });

  it("answers 401 for a session with no user id", async () => {
    // The same shape the upload page's gate refuses: authenticated by some
    // reading, and not someone POST /api/media would serve.
    sessionMock.mockResolvedValue({ user: { email: "someone@example.com" } });

    const response = await PUT(request({ tags: ["Food"] }), context());

    expect(response.status).toBe(401);
    expect(await storedSlugs()).toEqual([]);
  });

  it("answers 403 for an authenticated non-owner, and writes nothing", async () => {
    sessionMock.mockResolvedValue({ user: { id: STRANGER } });

    const response = await PUT(request({ tags: ["Food"] }), context());

    expect(response.status).toBe(403);
    expect(await storedSlugs()).toEqual([]);
    expect(await prisma.tag.count()).toBe(0);
  });

  it("does not let a non-owner clear tags the owner set", async () => {
    // The stronger form of the case above: not "a stranger cannot add", but
    // "a stranger cannot destroy". An empty list is the destructive request.
    sessionMock.mockResolvedValue({ user: { id: OWNER } });
    await PUT(request({ tags: ["Food", "Books"] }), context());

    sessionMock.mockResolvedValue({ user: { id: STRANGER } });
    const response = await PUT(request({ tags: [] }), context());

    expect(response.status).toBe(403);
    expect(await storedSlugs()).toEqual(["books", "food"]);
  });

  it("answers 404 for a media id that does not exist", async () => {
    sessionMock.mockResolvedValue({ user: { id: OWNER } });

    const response = await PUT(
      request({ tags: ["Food"] }, "no-such-media"),
      context("no-such-media"),
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 when the row is deleted between the gate and the write", async () => {
    /*
     * THE CATCH BRANCH, driven rather than reasoned about.
     *
     * The gate reads the row in one statement and the write happens in
     * another, so a delete can land in between — and `update` answers that by
     * THROWING P2025 rather than reporting `count: 0`, which is why this
     * handler catches where its `updateMany` siblings check a number. Without
     * a test the branch is a guess about a Prisma error code, and the failure
     * if the guess is wrong is a 500 on an ordinary race.
     *
     * The interleaving is made deterministic by deleting the row from inside
     * the request body's own stream: `readJsonBody` runs after the gate and
     * before the write, so a delete performed while the body is being read
     * is committed at exactly the point the race describes.
     *
     * `highWaterMark: 0` IS THE TEST. Without it this fixture proves nothing:
     * a ReadableStream calls `pull` eagerly at CONSTRUCTION to fill its
     * queue, so the delete ran before `PUT` was even called, the gate itself
     * answered 404, and the catch below was never entered — the assertions
     * all passed while the case they describe had not happened. Caught by
     * mutating the handler (replacing the P2025 check with `if (false)`) and
     * watching this test stay green. A zero high-water mark defers `pull`
     * until the first `read()`, which is inside `readJsonBody`, which is
     * after the gate.
     */
    sessionMock.mockResolvedValue({ user: { id: OWNER } });

    let deleted = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (!deleted) {
            await prisma.media.delete({ where: { id: MEDIA_ID } });
            deleted = true;
          }
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ tags: ["Food"] })),
          );
          controller.close();
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );

    const response = await PUT(
      {
        headers: new Headers({ "content-type": "application/json" }),
        body,
      } as unknown as Request,
      context(),
    );

    /*
     * Guards the guard, in the one way that distinguishes this from the
     * plain missing-row case: the row must have existed when the GATE read
     * it and been gone by the time of the WRITE. `deleted` alone does not
     * say that — it was true in the broken version too — so the tag row
     * `resolveTagRows` creates is what pins the ordering. It is only written
     * after the body has been parsed, which is only reached if the gate
     * allowed the request through.
     */
    expect(deleted).toBe(true);
    expect(await prisma.tag.findUnique({ where: { slug: "food" } })).not.toBeNull();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });
});

describe("the request body", () => {
  beforeEach(() => {
    sessionMock.mockResolvedValue({ user: { id: OWNER } });
  });

  it("refuses a body with no 'tags' field rather than clearing the tags", async () => {
    /*
     * The case a one-line shortcut gets wrong. `const { tags = [] } = body`
     * reads as tidy and turns a typo — or a client sending the wrong body —
     * into a silent deletion of everything the owner had labelled, answered
     * with a 200.
     */
    await PUT(request({ tags: ["Food", "Books"] }), context());

    const response = await PUT(request({ subjects: ["Food"] }), context());

    expect(response.status).toBe(400);
    expect(await storedSlugs()).toEqual(["books", "food"]);
  });

  it("refuses a JSON array as the body", async () => {
    const response = await PUT(request(["Food"]), context());
    expect(response.status).toBe(400);
  });

  it("refuses a malformed JSON body", async () => {
    const response = await PUT(request("{not json"), context());
    expect(response.status).toBe(400);
  });

  it("refuses a name carrying a bidi override, and mints no tag row (K5)", async () => {
    const response = await PUT(
      request({ tags: ["Food", `Books${RTL_OVERRIDE}x`] }),
      context(),
    );

    expect(response.status).toBe(400);
    // Nothing partial: not even the valid "Food" from the same request is
    // applied, and no Tag row is created for either name.
    expect(await storedSlugs()).toEqual([]);
    expect(await prisma.tag.count()).toBe(0);
  });

  it("refuses more than the per-item cap", async () => {
    const tooMany = Array.from(
      { length: MAX_TAGS_PER_ITEM + 1 },
      (_, index) => `subject-${index}`,
    );

    const overCap = await PUT(request({ tags: tooMany }), context());
    expect(overCap.status).toBe(400);
    expect(await storedSlugs()).toEqual([]);

    // At the cap is accepted, so the refusal above is about the boundary and
    // not about the endpoint refusing long lists in general.
    const atCap = await PUT(
      request({ tags: tooMany.slice(0, MAX_TAGS_PER_ITEM) }),
      context(),
    );
    expect(atCap.status).toBe(200);
    expect(await storedSlugs()).toHaveLength(MAX_TAGS_PER_ITEM);
  });

  it("refuses a body past the size cap without applying any of it", async () => {
    const huge = { tags: ["Food"], filler: "x".repeat(8192) };

    const response = await PUT(request(huge), context());

    expect(response.status).toBe(413);
    expect(await storedSlugs()).toEqual([]);
  });
});
