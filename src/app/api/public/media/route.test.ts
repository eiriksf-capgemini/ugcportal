import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const mediaFindManyMock = vi.fn();
const mediaFindFirstMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      findMany: mediaFindManyMock,
      findFirst: mediaFindFirstMock,
    },
  },
}));

const { GET } = await import("@/app/api/public/media/route");
const { encodeMediaCursor } = await import("@/lib/media-listing");

type Row = {
  id: string;
  userId: string;
  kind: "IMAGE" | "VIDEO";
  key: string;
  previewKey: string | null;
  previewId: string | null;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  altText: string | null;
  caption: string | null;
  createdAt: Date;
  publishedAt: Date | null;
};

/**
 * A tiny in-memory stand-in for the Media table.
 *
 * Deliberately evaluates the handler's real `where` clause against real rows
 * rather than asserting on the arguments it was called with. An args-only test
 * passes just as happily when the predicate is wrong — it only proves the
 * handler said something, not that the something excludes the right rows. K1
 * and K3 are claims about which rows come back, so they are tested that way.
 *
 * Supports exactly the operators src/lib/media-listing.ts emits: equality
 * (including Date equality), `{ not: null }`, `{ lt: ... }`, and `OR`.
 */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === "OR") {
      const branches = condition as Record<string, unknown>[];
      if (!branches.some((branch) => matches(row, branch))) return false;
      continue;
    }

    const actual = (row as unknown as Record<string, unknown>)[field];

    if (condition === null) {
      if (actual !== null) return false;
      continue;
    }

    if (
      typeof condition === "object" &&
      condition !== null &&
      !(condition instanceof Date)
    ) {
      const op = condition as { not?: unknown; lt?: unknown };
      if ("not" in op) {
        if (op.not === null ? actual === null : actual === op.not) return false;
      }
      if ("lt" in op) {
        if (
          actual === null ||
          !((actual as Date | string | number) < (op.lt as Date | string))
        ) {
          return false;
        }
      }
      continue;
    }

    if (actual instanceof Date && condition instanceof Date) {
      if (actual.getTime() !== condition.getTime()) return false;
      continue;
    }

    if (actual !== condition) return false;
  }

  return true;
}

function project(row: Row, select: Record<string, boolean>) {
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(select)) {
    out[field] = (row as unknown as Record<string, unknown>)[field];
  }
  return out;
}

/** Installs `rows` as the whole table behind findMany/findFirst. */
function seed(rows: Row[]) {
  mediaFindManyMock.mockImplementation(
    async (args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
      take: number;
    }) =>
      rows
        .filter((row) => matches(row, args.where))
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .slice(0, args.take)
        .map((row) => project(row, args.select)),
  );

  mediaFindFirstMock.mockImplementation(
    async (args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }) => {
      const hit = rows.find((row) => matches(row, args.where));
      return hit ? project(hit, args.select) : null;
    },
  );
}

let sequence = 0;

/**
 * Both storage paths are derived from the row's own `userId`, exactly as
 * POST /api/media builds them (`media/${userId}/…`, `previews/${userId}/…`).
 *
 * This is load-bearing, not incidental. An earlier version of this fixture
 * hard-coded `previews/user-1/…` regardless of the `userId` override, which
 * made the "exposes no userId" assertion below unfalsifiable: a row created as
 * `row({ userId: "user-9" })` put the string `user-9` nowhere in the payload,
 * so the test passed while the handler was in fact publishing every uploader's
 * account id inside `previewKey`. A fixture that cannot reproduce the leak
 * cannot detect it.
 */
function row(overrides: Partial<Row> = {}): Row {
  sequence += 1;
  const id = overrides.id ?? `media-${sequence}`;
  const userId = overrides.userId ?? "user-1";
  return {
    id,
    userId,
    kind: "IMAGE",
    key: `media/${userId}/${id}-original.png`,
    previewKey: `previews/${userId}/${id}.webp`,
    previewId: `preview-${id}`,
    mimeType: "image/png",
    sizeBytes: 1234,
    originalName: `${id}.png`,
    // ugcportal-gwr: present by default so this fixture can produce a row
    // the anonymous feed is actually allowed to publish (K1 requires it),
    // and distinct from `originalName` so a test can tell the two apart.
    altText: `A photograph, ${id}`,
    caption: null,
    createdAt: new Date(
      `2026-09-${String((sequence % 28) + 1).padStart(2, "0")}T10:00:00Z`,
    ),
    publishedAt: new Date("2026-09-24T12:00:00Z"),
    ...overrides,
  };
}

/**
 * Exactly the fields an anonymous caller may see.
 *
 * NOT exhaustive against `MEDIA_ANONYMOUS_SELECT` — `tags` is a relation, and
 * this file's `Row`/`project` fixture pre-dates it (ugcportal-jsc) without
 * being extended to model one; that gap is pre-existing and out of this
 * bead's scope. `altText` and `caption` (ugcportal-gwr) are plain columns,
 * same shape as everything else this list already names, so they are added
 * here rather than left to silently vanish the way an `undefined` fixture
 * value does through `NextResponse.json`'s serialisation.
 */
const ANONYMOUS_FIELDS = [
  "altText",
  "caption",
  "createdAt",
  "id",
  "kind",
  "previewId",
  "publishedAt",
];

function request(query = "") {
  return new Request(`http://localhost/api/public/media${query}`);
}

async function listIds(query = ""): Promise<string[]> {
  const body = await (await GET(request(query))).json();
  return body.items.map((item: { id: string }) => item.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  sequence = 0;
  authMock.mockResolvedValue(null);
  seed([]);
  // listPublicMedia now logs a malformed cursor's `ok: false` through to
  // console.error, throttled (ugcportal-0dh) — real behaviour this suite
  // should not have to opt out of case by case. Several tests below
  // (caching, the malformed-cursor loop) deliberately exercise that exact
  // path; without this, their otherwise-green runs print real
  // "[gallery] public media listing failed" lines to test stderr, which is
  // noise this file never asked for and that can mask a genuinely
  // unexpected error in CI output.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/public/media — visibility (K1)", () => {
  it("omits an unpublished row and includes it once published", async () => {
    const draft = row({ id: "draft", publishedAt: null });
    seed([draft]);

    // Anonymous request, no session at all.
    expect(await listIds()).toEqual([]);

    // The owner publishes it: same row, publishedAt now set.
    seed([{ ...draft, publishedAt: new Date("2026-09-24T12:00:00Z") }]);

    expect(await listIds()).toEqual(["draft"]);
  });

  it("answers anonymously and never consults the session", async () => {
    seed([row({ id: "a" })]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    // The public feed must not vary by who is asking. A handler that called
    // auth() could grow a "…and also my own drafts" branch; this one can't.
    expect(authMock).not.toHaveBeenCalled();
  });

  it("shows published rows from every user, not just one", async () => {
    seed([
      row({ id: "a", userId: "user-1" }),
      row({ id: "b", userId: "user-2" }),
      row({ id: "c", userId: "user-3", publishedAt: null }),
    ]);

    expect((await listIds()).sort()).toEqual(["a", "b"]);
  });

  it("drops a row again as soon as it is unpublished", async () => {
    const published = row({ id: "a" });
    seed([published]);
    expect(await listIds()).toEqual(["a"]);

    seed([{ ...published, publishedAt: null }]);
    expect(await listIds()).toEqual([]);
  });
});

describe("GET /api/public/media — no original key, no preview-less row (K3)", () => {
  it("excludes a published VIDEO row, which has no watermarked preview", async () => {
    // A VIDEO gets no preview yet (ugcportal-pmb owns poster frames). Its
    // owner published it, so the visibility gate says yes — but the only
    // representation of it would be `key`, the paid original, so it must not
    // appear. Both conditions have to hold, not either.
    seed([
      row({
        id: "clip",
        kind: "VIDEO",
        previewKey: null,
        mimeType: "video/mp4",
        originalName: "clip.mp4",
        key: "media/user-1/clip-original.mp4",
      }),
      row({ id: "photo" }),
    ]);

    const response = await GET(request());
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["photo"]);
    expect(serialized).not.toContain("clip");
    expect(serialized).not.toContain("clip.mp4");
  });

  it("serializes no storage path of any kind, original or preview", async () => {
    seed([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);

    const body = await (await GET(request())).json();
    const serialized = JSON.stringify(body);

    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item).not.toHaveProperty("key");
      // Not the preview's path either: it embeds the uploader's id. The feed
      // hands out an opaque handle instead.
      expect(item).not.toHaveProperty("previewKey");
      expect(item.previewId).toBe(`preview-${item.id}`);
    }
    // Neither prefix appears anywhere in the payload, so neither object is
    // nameable from this feed.
    expect(serialized).not.toContain("media/");
    expect(serialized).not.toContain("previews/");
    expect(serialized).not.toContain("-original.png");
  });

  it("exposes no userId, in a field or embedded in one", async () => {
    // `row()` derives both storage paths from this userId, exactly as
    // POST /api/media does. That is what makes this assertion able to fail:
    // with a fixture that hard-coded `previews/user-1/…` it could not, and
    // for one round it did not — the feed was returning `previewKey`, which
    // is built as `previews/{userId}/{uuid}.webp`, so every uploader's
    // account id was in the payload in plain text.
    seed([row({ id: "a", userId: "user-9" })]);

    const body = await (await GET(request())).json();
    const serialized = JSON.stringify(body);

    expect(body.items[0]).not.toHaveProperty("userId");
    expect(serialized).not.toContain("user-9");
    expect(Object.keys(body.items[0]).sort()).toEqual(ANONYMOUS_FIELDS);
  });

  it("gives two uploaders' rows nothing an anonymous caller could group by", async () => {
    // The capability being denied, stated directly: page the feed and try to
    // partition it by uploader. Every value in the payload must be either
    // per-row-unique or shared across uploaders — never per-uploader.
    seed([
      row({ id: "a", userId: "user-1" }),
      row({ id: "b", userId: "user-1" }),
      row({ id: "c", userId: "user-2" }),
    ]);

    const body = await (await GET(request())).json();
    const serialized = JSON.stringify(body);

    expect(body.items).toHaveLength(3);
    for (const uploader of ["user-1", "user-2"]) {
      expect(serialized).not.toContain(uploader);
    }
    // The two rows from the same uploader share no value that the row from
    // the other uploader does not also share. `previewId` is the only
    // per-row identifier, and it is opaque and unique.
    const [a, b, c] = body.items.slice().sort(
      (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1),
    );
    expect(new Set([a.previewId, b.previewId, c.previewId]).size).toBe(3);
    // `kind` is the only non-unique field left, and it is identical across
    // uploaders rather than varying with them — so it partitions nothing.
    // Asserted against the cross-uploader pair specifically: a field that
    // happened to correlate with the uploader would differ here.
    expect(a.kind).toEqual(c.kind);
    expect(b.kind).toEqual(c.kind);
    // Every remaining field is either shared by all three or unique to one.
    // Nothing sits in between, which is what "cannot be grouped" means.
    for (const field of Object.keys(a)) {
      const values = [a[field], b[field], c[field]];
      const distinct = new Set(values.map((v) => JSON.stringify(v))).size;
      expect([1, 3]).toContain(distinct);
    }
  });

  it("withholds the uploader-supplied filename from anonymous callers", async () => {
    seed([
      row({
        id: "a",
        originalName: "anna-berg-passport-scan.jpg",
      }),
    ]);

    const response = await GET(request());
    const body = await response.json();

    // `originalName` is volunteered, not chosen for publication, and was
    // owner-only before this endpoint existed. Publishing an item must not
    // also publish whatever the uploader happened to call the file on their
    // own disk (ugcportal-r1d review round 1, finding 2).
    expect(body.items[0]).not.toHaveProperty("originalName");
    expect(JSON.stringify(body)).not.toContain("anna-berg-passport-scan");
    expect(Object.keys(body.items[0]).sort()).toEqual(ANONYMOUS_FIELDS);
  });

  it("never selects the filename at the database layer either", async () => {
    seed([row({ id: "a" })]);

    await GET(request());

    // Not selected, not merely dropped afterwards — so a future change that
    // starts echoing the selected row cannot leak it by accident.
    const select = mediaFindManyMock.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("originalName");
    expect(select).not.toHaveProperty("key");
    expect(select).not.toHaveProperty("userId");
    // Nor the preview's path, which embeds the uploader's id.
    expect(select).not.toHaveProperty("previewKey");
    expect(select.previewId).toBe(true);
    // Nor the original's type and size: this feed can only ever serve the
    // watermarked preview, which is a different format at a different size.
    expect(select).not.toHaveProperty("mimeType");
    expect(select).not.toHaveProperty("sizeBytes");
  });

  it("reports no metadata describing the original file", async () => {
    seed([
      row({
        id: "a",
        mimeType: "image/png",
        sizeBytes: 1_400_000,
      }),
    ]);

    const body = await (await GET(request())).json();
    const serialized = JSON.stringify(body);

    // The only asset this feed can hand over is the webp preview, so the
    // original's content type and byte count are not merely private — they
    // are the wrong answer about the wrong file. A consumer using `mimeType`
    // for a <source type> would be wrong on every row, and `sizeBytes` is an
    // exact fingerprint of a file the caller cannot fetch.
    expect(body.items[0]).not.toHaveProperty("mimeType");
    expect(body.items[0]).not.toHaveProperty("sizeBytes");
    expect(serialized).not.toContain("image/png");
    expect(serialized).not.toContain("1400000");
    expect(Object.keys(body.items[0]).sort()).toEqual(ANONYMOUS_FIELDS);
  });

  it("keeps the original's type and size on the owner-scoped projection", async () => {
    // The split is per audience, not a global removal: an owner's own library
    // (and ugcportal-n3c's upload UI) legitimately wants "photo.png,
    // image/png, 1.4 MB" about the file they actually uploaded.
    const { MEDIA_OWNER_SELECT, MEDIA_ANONYMOUS_SELECT } = await import(
      "@/lib/media-access"
    );

    expect(MEDIA_OWNER_SELECT).toHaveProperty("mimeType", true);
    expect(MEDIA_OWNER_SELECT).toHaveProperty("sizeBytes", true);
    expect(MEDIA_ANONYMOUS_SELECT).not.toHaveProperty("mimeType");
    expect(MEDIA_ANONYMOUS_SELECT).not.toHaveProperty("sizeBytes");
  });

  it("still shows the owner their own filenames on the owner-scoped feed", async () => {
    // The two projections diverged deliberately; this pins that the narrowing
    // applies to the anonymous feed only, and is not a global removal.
    const { MEDIA_OWNER_SELECT, MEDIA_ANONYMOUS_SELECT } = await import(
      "@/lib/media-access"
    );

    expect(MEDIA_OWNER_SELECT).toHaveProperty("originalName", true);
    expect(MEDIA_OWNER_SELECT).toHaveProperty("previewKey", true);
    expect(MEDIA_ANONYMOUS_SELECT).not.toHaveProperty("originalName");
    expect(MEDIA_ANONYMOUS_SELECT).not.toHaveProperty("previewKey");
    // Both audiences get the opaque handle; only the owner gets the path.
    expect(MEDIA_ANONYMOUS_SELECT).toHaveProperty("previewId", true);
    /*
     * Anonymous must stay a strict subset of owner — and a subset in VALUE,
     * not just in key. This compared against the literal `true` until
     * ugcportal-jsc added `tags`, whose projection is a nested
     * `{ select, orderBy }` object rather than a boolean. Comparing each
     * field against the anonymous select's own value keeps the assertion
     * honest for both shapes: it now also catches the case a `true`
     * comparison never could, an audience being given a WIDER nested
     * projection of the same relation than the other.
     */
    for (const [field, projection] of Object.entries(MEDIA_ANONYMOUS_SELECT)) {
      expect(MEDIA_OWNER_SELECT).toHaveProperty(field, projection);
    }
  });

  it("never selects the original key at the database layer either", async () => {
    seed([row({ id: "a" })]);

    await GET(request());

    const args = mediaFindManyMock.mock.calls[0][0];
    expect(args.select).not.toHaveProperty("key");
    expect(args.where).toMatchObject({
      publishedAt: { not: null },
      previewKey: { not: null },
    });
    // No userId scoping: this is everyone's published media.
    expect(args.where).not.toHaveProperty("userId");
  });
});

describe("GET /api/public/media — caching", () => {
  it("forbids storing the response, on success and on error alike", async () => {
    seed([row({ id: "a" })]);

    const ok = await GET(request());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");

    // The 400 path too: a cached "Invalid cursor" is its own small trap, and
    // a header that is only set on the happy path is one refactor from not
    // being set at all.
    const bad = await GET(request("?cursor=not-a-cursor"));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("cache-control")).toBe("no-store");
  });

  it("does not let an unpublished row be served from a cached page", async () => {
    // The requirement behind the header, stated as behaviour rather than as a
    // string: this endpoint is session-independent, so a shared cache would
    // key on the URL alone and keep answering with the published version long
    // after the owner withdrew the item. `no-store` is what stops that, and
    // ugcportal-r1d's whole purpose is that the withdrawal is real.
    const published = row({ id: "a" });
    seed([published]);

    const before = await GET(request());
    expect((await before.json()).items).toHaveLength(1);
    expect(before.headers.get("cache-control")).toBe("no-store");

    seed([{ ...published, publishedAt: null }]);

    const after = await GET(request());
    expect((await after.json()).items).toEqual([]);
    expect(after.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/public/media — pagination contract", () => {
  it("orders by createdAt desc with id as the tiebreak", async () => {
    const sameInstant = new Date("2026-09-20T10:00:00Z");
    seed([
      row({ id: "b", createdAt: sameInstant }),
      row({ id: "c", createdAt: sameInstant }),
      row({ id: "a", createdAt: new Date("2026-09-21T10:00:00Z") }),
    ]);

    expect(await listIds()).toEqual(["a", "c", "b"]);
    expect(mediaFindManyMock.mock.calls[0][0].orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("requests one row beyond the page size and reports hasMore with a cursor", async () => {
    seed([
      row({ id: "a", createdAt: new Date("2026-09-23T10:00:00Z") }),
      row({ id: "b", createdAt: new Date("2026-09-22T10:00:00Z") }),
      row({ id: "c", createdAt: new Date("2026-09-21T10:00:00Z") }),
    ]);

    const body = await (await GET(request("?limit=2"))).json();

    expect(mediaFindManyMock.mock.calls[0][0].take).toBe(3);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["a", "b"]);
    expect(body.hasMore).toBe(true);
    // A position, not a row reference. Decoded without the library's own
    // decoder so the encoding is pinned rather than assumed.
    expect(Buffer.from(body.nextCursor, "base64url").toString("utf8")).toBe(
      "2026-09-22T10:00:00.000Z|b",
    );
  });

  it("walks the whole feed exactly once across pages", async () => {
    const shared = new Date("2026-09-20T10:00:00Z");
    seed([
      row({ id: "a", createdAt: new Date("2026-09-23T10:00:00Z") }),
      // Two rows sharing a timestamp: the case Prisma's inclusive `cursor`
      // plus `skip: 1` silently swallows.
      row({ id: "b", createdAt: shared }),
      row({ id: "c", createdAt: shared }),
      row({ id: "d", createdAt: new Date("2026-09-19T10:00:00Z") }),
      row({ id: "draft", publishedAt: null }),
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: string = `?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
      const body = await (await GET(request(query))).json();
      seen.push(...body.items.map((i: { id: string }) => i.id));
      if (!body.hasMore) break;
      cursor = body.nextCursor;
    }

    expect(seen).toEqual(["a", "c", "b", "d"]);
  });

  it("pages with an explicit keyset predicate, not Prisma's cursor", async () => {
    const position = {
      id: "anchor",
      createdAt: new Date("2026-09-22T10:00:00Z"),
    };
    seed([row({ id: "anchor", createdAt: position.createdAt })]);

    await GET(request(`?cursor=${encodeMediaCursor(position)}`));

    const args = mediaFindManyMock.mock.calls[0][0];
    expect(args).not.toHaveProperty("cursor");
    expect(args).not.toHaveProperty("skip");
    expect(args.where).toMatchObject({
      publishedAt: { not: null },
      previewKey: { not: null },
      OR: [
        { createdAt: { lt: position.createdAt } },
        { createdAt: position.createdAt, id: { lt: "anchor" } },
      ],
    });
  });

  it("does not strand a visitor when an unrelated owner unpublishes mid-scroll", async () => {
    // The row this visitor's cursor came from has just been unpublished by
    // someone else — a person the visitor has never heard of, acting on their
    // own media. Resolving the cursor back to a row would turn that into a
    // hard 400 and a restart from the top of the feed, for something the
    // visitor neither did nor can see (ugcportal-r1d review finding 3).
    const gone = {
      id: "was-published",
      createdAt: new Date("2026-09-22T10:00:00Z"),
    };
    seed([
      row({ ...gone, publishedAt: null }),
      row({ id: "older", createdAt: new Date("2026-09-21T10:00:00Z") }),
    ]);

    const response = await GET(request(`?cursor=${encodeMediaCursor(gone)}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["older"]);
    // No anchor lookup happens at all any more.
    expect(mediaFindFirstMock).not.toHaveBeenCalled();
  });

  it("does not strand a visitor when the cursor's row was deleted outright", async () => {
    seed([row({ id: "older", createdAt: new Date("2026-09-21T10:00:00Z") })]);

    const response = await GET(
      request(
        `?cursor=${encodeMediaCursor({
          id: "since-deleted",
          createdAt: new Date("2026-09-22T10:00:00Z"),
        })}`,
      ),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).items.map((i: { id: string }) => i.id)).toEqual(
      ["older"],
    );
  });

  it("cannot be widened by a forged cursor naming a private row", async () => {
    // An owner knows the (createdAt, id) of their own drafts — the owner feed
    // hands both back — so a forged cursor is trivially constructible. It can
    // move the window; it must not widen it, because the keyset predicate
    // lives inside the same `where` as the publish/preview scoping.
    const draft = {
      id: "draft",
      createdAt: new Date("2026-09-23T10:00:00Z"),
    };
    seed([
      row({ ...draft, publishedAt: null }),
      row({ id: "public-older", createdAt: new Date("2026-09-22T10:00:00Z") }),
    ]);

    const response = await GET(request(`?cursor=${encodeMediaCursor(draft)}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    // The draft is still absent; all the cursor did was choose a position.
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["public-older"]);
    expect(JSON.stringify(body)).not.toContain("draft");
    expect(mediaFindManyMock.mock.calls[0][0].where).toMatchObject({
      publishedAt: { not: null },
      previewKey: { not: null },
    });
  });

  it("rejects a malformed cursor rather than faking an empty page", async () => {
    seed([row({ id: "a" })]);

    for (const bad of [
      "draft",
      "not-base64!!",
      Buffer.from("no-separator").toString("base64url"),
      Buffer.from("2026-09-22T10:00:00.000Z|").toString("base64url"),
      Buffer.from("2026|a").toString("base64url"),
      Buffer.from("not-a-date|a").toString("base64url"),
    ]) {
      mediaFindManyMock.mockClear();

      const response = await GET(request(`?cursor=${bad}`));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid cursor" });
      expect(mediaFindManyMock).not.toHaveBeenCalled();
    }
  });

  it("treats an empty ?cursor= as an ordinary first-page request", async () => {
    seed([row({ id: "a" })]);

    for (const query of ["", "?cursor=", "?cursor=%20"]) {
      mediaFindFirstMock.mockClear();
      mediaFindManyMock.mockClear();

      const response = await GET(request(query));

      expect(response.status).toBe(200);
      expect(mediaFindFirstMock).not.toHaveBeenCalled();
      expect(mediaFindManyMock.mock.calls[0][0].where).not.toHaveProperty("OR");
    }
  });

  it("clamps the page size and ignores nonsense limits", async () => {
    seed([row({ id: "a" })]);

    const takeFor = async (query: string) => {
      mediaFindManyMock.mockClear();
      await GET(request(query));
      return mediaFindManyMock.mock.calls[0][0].take;
    };

    expect(await takeFor("")).toBe(51);
    expect(await takeFor("?limit=")).toBe(51);
    expect(await takeFor("?limit=abc")).toBe(51);
    expect(await takeFor("?limit=0")).toBe(2);
    expect(await takeFor("?limit=-5")).toBe(2);
    expect(await takeFor("?limit=10000")).toBe(101);
    expect(await takeFor("?limit=7.9")).toBe(8);
  });

  it("reports the end of the list", async () => {
    seed([row({ id: "a" })]);

    const body = await (await GET(request("?limit=2"))).json();

    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("steps past an entirely withheld page instead of stranding the caller", async () => {
    // The query handed back preview-less rows its own where-clause should have
    // excluded, so the defensive filter empties this page. The advance past
    // them happens server-side: the caller gets the next real row and never
    // sees the withheld rows' identifiers.
    mediaFindManyMock
      .mockResolvedValueOnce([
        {
          id: "withheld-1",
          previewId: null,
          createdAt: new Date("2026-09-24T10:00:00Z"),
        },
        {
          id: "withheld-2",
          previewId: null,
          createdAt: new Date("2026-09-23T10:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "real",
          previewId: "preview-real",
          createdAt: new Date("2026-09-22T10:00:00Z"),
        },
      ]);

    const response = await GET(request("?limit=1"));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["real"]);
    // Neither withheld row is disclosed, in any form.
    expect(serialized).not.toContain("withheld-1");
    expect(serialized).not.toContain("withheld-2");
    expect(serialized).not.toContain("2026-09-24T10:00:00.000Z");

    // Two windows, the second starting strictly after the last row read.
    expect(mediaFindManyMock).toHaveBeenCalledTimes(2);
    expect(mediaFindManyMock.mock.calls[1][0].where.OR).toEqual([
      { createdAt: { lt: new Date("2026-09-24T10:00:00Z") } },
      {
        createdAt: new Date("2026-09-24T10:00:00Z"),
        id: { lt: "withheld-1" },
      },
    ]);
  });

  it("reports the end of the list rather than disclosing a withheld row", async () => {
    // Pathological: every window is entirely withheld, i.e. the where-clause
    // and the filter disagree across the whole feed. The scan is bounded, and
    // when it gives up it says end-of-list — the only alternative would be
    // handing an anonymous caller the cuid and creation time of rows
    // deliberately dropped (ugcportal-r1d review round 5, finding 3).
    mediaFindManyMock.mockResolvedValue([
      {
        id: "withheld-1",
        previewId: null,
        createdAt: new Date("2026-09-24T10:00:00Z"),
      },
      {
        id: "withheld-2",
        previewId: null,
        createdAt: new Date("2026-09-23T10:00:00Z"),
      },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = await (await GET(request("?limit=1"))).json();

    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain("withheld");
    // Bounded, not open-ended: this runs on an unauthenticated endpoint.
    expect(mediaFindManyMock).toHaveBeenCalledTimes(5);
    // A broken invariant should be noticed, not smoothed over.
    expect(errorSpy).toHaveBeenCalledWith(
      "[media] listing filter withheld every scanned row",
      expect.objectContaining({ scans: 5 }),
    );
    // The log itself must not carry row identifiers either — it is about a
    // broken invariant, not about the rows, and it is reachable anonymously.
    const logged = JSON.stringify(errorSpy.mock.calls[0]?.[1]);
    expect(logged).not.toContain("withheld-1");
    expect(logged).not.toContain("withheld-2");
    expect(logged).not.toContain("2026-09-24T10:00:00.000Z");
    errorSpy.mockRestore();
  });

  it("reports no cursor when there genuinely is no further page", async () => {
    mediaFindManyMock.mockResolvedValue([
      {
        id: "a",
        previewId: null,
        createdAt: new Date("2026-09-24T10:00:00Z"),
      },
    ]);

    const body = await (await GET(request("?limit=1"))).json();

    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("does not mistake an absent previewKey for a null one", async () => {
    // The anonymous projection never selects previewKey, so it is absent
    // rather than null on every row here. A guard that read `undefined` as
    // "no preview" would empty the entire public feed; one that read it as
    // "has a preview" was the no-op this listing already shipped once. Both
    // failure modes are one `in` check apart, so both are pinned.
    seed([row({ id: "a" }), row({ id: "b" })]);

    const body = await (await GET(request())).json();

    expect(body.items.map((i: { id: string }) => i.id).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(body.items[0]).not.toHaveProperty("previewKey");
  });

  it("never builds nextCursor from a withheld row", async () => {
    mediaFindManyMock.mockResolvedValueOnce([
      {
        id: "a",
        previewId: "preview-a",
        createdAt: new Date("2026-09-24T10:00:00Z"),
      },
      {
        id: "b",
        previewId: null,
        createdAt: new Date("2026-09-23T10:00:00Z"),
      },
      {
        id: "c",
        previewId: "preview-c",
        createdAt: new Date("2026-09-22T10:00:00Z"),
      },
    ]);

    const body = await (await GET(request("?limit=2"))).json();

    // The page read is [a, b]; `b` is withheld. The cursor names `a`, the last
    // row the caller actually received. Naming `b` would disclose a row
    // deliberately dropped, contradicting the whole reason the cursor is safe
    // to hand out. Resuming after `a` re-reads `b` — which is dropped again —
    // so nothing is skipped and nothing is served twice.
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["a"]);
    expect(body.hasMore).toBe(true);
    expect(Buffer.from(body.nextCursor, "base64url").toString("utf8")).toBe(
      "2026-09-24T10:00:00.000Z|a",
    );
    expect(JSON.stringify(body)).not.toContain("2026-09-23T10:00:00.000Z");
  });
});

describe("GET /api/public/media — visibility is not sellability (K4)", () => {
  it("advertises no price, licence or purchasability for a published row", async () => {
    seed([row({ id: "a" })]);

    const body = await (await GET(request())).json();
    const serialized = JSON.stringify(body);

    // Being in this feed means "visible". Whether it may be SOLD is decided
    // by the per-account resale-rights gate (ugcportal-0ss) plus the sale
    // catalogue (ugcportal-74w), which read their own records and do not
    // consult publishedAt. Once ugcportal-0ss exists, extend this to assert
    // that a published row with no CLEARED ResaleRightsReview is still
    // refused by the sellability predicate — that model does not exist yet,
    // so what is checkable now is that nothing here implies buyability.
    for (const forbidden of [
      "price",
      "priceCents",
      "licence",
      "license",
      "forSale",
      "sellable",
      "purchasable",
      "resaleRights",
    ]) {
      expect(body.items[0]).not.toHaveProperty(forbidden);
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    // And the query that produced it asked about visibility only.
    const where = mediaFindManyMock.mock.calls[0][0].where;
    expect(Object.keys(where).sort()).toEqual([
      "previewId",
      "previewKey",
      "publishedAt",
    ]);
  });
});
