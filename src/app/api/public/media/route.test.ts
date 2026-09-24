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

type Row = {
  id: string;
  userId: string;
  kind: "IMAGE" | "VIDEO";
  key: string;
  previewKey: string | null;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
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

function row(overrides: Partial<Row> = {}): Row {
  sequence += 1;
  const id = overrides.id ?? `media-${sequence}`;
  return {
    id,
    userId: "user-1",
    kind: "IMAGE",
    key: `media/user-1/${id}-original.png`,
    previewKey: `previews/user-1/${id}.webp`,
    mimeType: "image/png",
    sizeBytes: 1234,
    originalName: `${id}.png`,
    createdAt: new Date(`2026-09-${String((sequence % 28) + 1).padStart(2, "0")}T10:00:00Z`),
    publishedAt: new Date("2026-09-24T12:00:00Z"),
    ...overrides,
  };
}

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

  it("serializes no 'key' field and no media/ path for any row", async () => {
    seed([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);

    const body = await (await GET(request())).json();
    const serialized = JSON.stringify(body);

    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item).not.toHaveProperty("key");
      expect(item.previewKey).toMatch(/^previews\//);
    }
    // The originals live under the media/ prefix; nothing in the payload
    // points at it, so the original is not reachable from this feed.
    expect(serialized).not.toContain("media/user-1");
    expect(serialized).not.toContain("-original.png");
  });

  it("exposes no userId, so the feed cannot be grouped by uploader", async () => {
    seed([row({ id: "a", userId: "user-9" })]);

    const body = await (await GET(request())).json();

    expect(body.items[0]).not.toHaveProperty("userId");
    expect(JSON.stringify(body)).not.toContain("user-9");
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "createdAt",
      "id",
      "kind",
      "mimeType",
      "originalName",
      "previewKey",
      "publishedAt",
      "sizeBytes",
    ]);
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
    expect(body.nextCursor).toBe("b");
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
    const anchorCreatedAt = new Date("2026-09-22T10:00:00Z");
    seed([row({ id: "anchor", createdAt: anchorCreatedAt })]);

    await GET(request("?cursor=anchor"));

    const args = mediaFindManyMock.mock.calls[0][0];
    expect(args).not.toHaveProperty("cursor");
    expect(args).not.toHaveProperty("skip");
    expect(args.where).toMatchObject({
      publishedAt: { not: null },
      previewKey: { not: null },
      OR: [
        { createdAt: { lt: anchorCreatedAt } },
        { createdAt: anchorCreatedAt, id: { lt: "anchor" } },
      ],
    });
  });

  it("rejects a cursor naming an unpublished row rather than using it as an oracle", async () => {
    // An owner knows the ids of their own drafts — POST hands them back. If
    // the anchor were resolved outside the feed's scope, passing a draft id
    // here would order the public feed relative to a private row.
    seed([row({ id: "draft", publishedAt: null }), row({ id: "a" })]);

    const response = await GET(request("?cursor=draft"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid or expired cursor" });
    // An empty page would read as end-of-list and the caller would stop,
    // believing it had seen everything.
    expect(mediaFindManyMock).not.toHaveBeenCalled();
  });

  it("rejects a cursor naming a preview-less row, or one that never existed", async () => {
    seed([
      row({ id: "clip", kind: "VIDEO", previewKey: null }),
      row({ id: "a" }),
    ]);

    expect((await GET(request("?cursor=clip"))).status).toBe(400);
    expect((await GET(request("?cursor=nope"))).status).toBe(400);
  });

  it("resolves the cursor only against rows this feed already shows", async () => {
    seed([row({ id: "a", createdAt: new Date("2026-09-22T10:00:00Z") })]);

    await GET(request("?cursor=a"));

    expect(mediaFindFirstMock.mock.calls[0][0].where).toEqual({
      publishedAt: { not: null },
      previewKey: { not: null },
      id: "a",
    });
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

  it("never reports hasMore without a usable cursor to go with it", async () => {
    // Pathological: the query hands back preview-less rows the where-clause
    // should have excluded. The defensive filter drops them, leaving no
    // cursor — so the handler must not still claim another page exists.
    mediaFindManyMock.mockResolvedValue([
      { id: "a", previewKey: null },
      { id: "b", previewKey: null },
    ]);

    const body = await (await GET(request("?limit=1"))).json();

    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it("takes nextCursor from an emitted row, not a filtered-out one", async () => {
    mediaFindManyMock.mockResolvedValue([
      { id: "a", previewKey: "previews/user-1/a.webp" },
      { id: "b", previewKey: null },
      { id: "c", previewKey: "previews/user-1/c.webp" },
    ]);

    const body = await (await GET(request("?limit=2"))).json();

    // `b` is dropped by the filter; pointing the next page at it would name a
    // row the next request's where-clause also excludes — the silent skip.
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["a"]);
    expect(body.nextCursor).toBe("a");
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
    expect(Object.keys(where).sort()).toEqual(["previewKey", "publishedAt"]);
  });
});
