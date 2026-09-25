import { GetObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();

const mediaFindFirstMock = vi.fn();
// Every write method the Prisma client exposes for Media, mirroring the
// publish route's test: a delivery route that reached for any of them would
// show up here rather than sliding past assertions about the read it was
// expected to make.
const mediaFindUniqueMock = vi.fn();
const mediaFindManyMock = vi.fn();
const mediaUpdateMock = vi.fn();
const mediaUpdateManyMock = vi.fn();
const mediaCreateMock = vi.fn();
const mediaCreateManyMock = vi.fn();
const mediaUpsertMock = vi.fn();
const mediaDeleteMock = vi.fn();
const mediaDeleteManyMock = vi.fn();
const executeRawMock = vi.fn();
const queryRawMock = vi.fn();
const transactionMock = vi.fn();

const WRITE_MOCKS = [
  mediaUpdateMock,
  mediaUpdateManyMock,
  mediaCreateMock,
  mediaCreateManyMock,
  mediaUpsertMock,
  mediaDeleteMock,
  mediaDeleteManyMock,
  executeRawMock,
  queryRawMock,
  transactionMock,
];

const s3SendMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      findFirst: mediaFindFirstMock,
      findUnique: mediaFindUniqueMock,
      findMany: mediaFindManyMock,
      update: mediaUpdateMock,
      updateMany: mediaUpdateManyMock,
      create: mediaCreateMock,
      createMany: mediaCreateManyMock,
      upsert: mediaUpsertMock,
      delete: mediaDeleteMock,
      deleteMany: mediaDeleteManyMock,
    },
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/s3", () => ({
  getS3Client: () => ({ send: s3SendMock }),
  getBucketName: () => "test-bucket",
}));

const { GET } = await import("@/app/api/media/preview/[previewId]/route");
const { PREVIEW_CONTENT_TYPE } = await import("@/lib/watermark");
const { PREVIEW_KEY_PREFIX } = await import("@/lib/media");

const OWNER_ID = "user-a";
const OTHER_ID = "user-b";

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
  createdAt: Date;
  publishedAt: Date | null;
};

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
  return {
    userId: OWNER_ID,
    kind: "IMAGE",
    key: `media/${OWNER_ID}/${overrides.id}-original.png`,
    previewKey: `${PREVIEW_KEY_PREFIX}${OWNER_ID}/${overrides.id}.webp`,
    previewId: `pid-${overrides.id}`,
    mimeType: "image/png",
    sizeBytes: 1024,
    originalName: "photo.png",
    createdAt: new Date("2026-03-01T09:00:00.000Z"),
    publishedAt: null,
    ...overrides,
  };
}

const PUBLISHED = row({
  id: "published",
  publishedAt: new Date("2026-03-02T10:00:00.000Z"),
});
const UNPUBLISHED = row({ id: "unpublished" });
const OTHERS_UNPUBLISHED = row({ id: "others", userId: OTHER_ID });
const OTHERS_PUBLISHED = row({
  id: "others-published",
  userId: OTHER_ID,
  publishedAt: new Date("2026-03-03T10:00:00.000Z"),
});
// A published row whose previewKey points at the ORIGINAL rather than at a
// watermarked copy. Nothing in the schema forbids it; K4 is the assertion that
// this route refuses to fetch it.
const ROGUE_KEY = row({
  id: "rogue",
  publishedAt: new Date("2026-03-04T10:00:00.000Z"),
  previewKey: `media/${OWNER_ID}/rogue-original.png`,
});
// Prefixed correctly and still pointing at the originals' shelf. Object
// storage treats the key literally, but this deployment addresses the bucket
// path-style, and intermediaries collapse `..` in a request path.
const TRAVERSAL_KEY = row({
  id: "traversal",
  publishedAt: new Date("2026-03-08T10:00:00.000Z"),
  previewKey: `${PREVIEW_KEY_PREFIX}../media/${OWNER_ID}/rogue-original.png`,
});
// Blank rather than null: `"" !== null`, so it satisfies every `not: null`
// filter in the codebase while pointing at nothing.
const BLANK_KEY = row({
  id: "blank",
  publishedAt: new Date("2026-03-05T10:00:00.000Z"),
  previewKey: "",
});
// Published, but not a v4 UUID handle — the shape a different id generator
// (or a hand-repaired row) would produce.
const ODD_SHAPED_ID = row({
  id: "odd",
  publishedAt: new Date("2026-03-06T10:00:00.000Z"),
  previewId: "not-a-uuid_0123456789",
});
// VIDEO: no preview at all yet (ugcportal-pmb owns poster frames).
const VIDEO = row({
  id: "video",
  kind: "VIDEO",
  previewKey: null,
  previewId: null,
  publishedAt: new Date("2026-03-07T10:00:00.000Z"),
});

const TABLE: Row[] = [
  PUBLISHED,
  UNPUBLISHED,
  OTHERS_UNPUBLISHED,
  OTHERS_PUBLISHED,
  ROGUE_KEY,
  TRAVERSAL_KEY,
  BLANK_KEY,
  ODD_SHAPED_ID,
  VIDEO,
];

/**
 * Evaluates the handler's real `where` clause against real rows rather than
 * asserting on the arguments it was called with. Same reasoning as the public
 * feed's test helper: an args-only assertion passes just as happily when the
 * predicate is wrong, because it proves the handler said something and not
 * that the something excludes the right rows.
 *
 * Supports exactly the operators this route emits: equality, `{ not: null }`,
 * and `OR`. Note that an `OR` branch of `{}` matches everything here — which
 * is deliberate, because that is precisely what Prisma does with a filter
 * whose value is `undefined`, and it is the failure this evaluator has to be
 * able to reveal.
 */
function matches(candidate: Row, where: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === "OR") {
      const branches = condition as Record<string, unknown>[];
      if (!branches.some((branch) => matches(candidate, branch))) return false;
      continue;
    }

    const actual = (candidate as unknown as Record<string, unknown>)[field];

    if (condition !== null && typeof condition === "object") {
      const op = condition as { not?: unknown };
      if ("not" in op) {
        if (op.not === null ? actual === null : actual === op.not) return false;
      }
      continue;
    }

    if (actual !== condition) return false;
  }
  return true;
}

const PREVIEW_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function call(
  previewId: string,
  init?: { headers?: Record<string, string> },
): Promise<Response> {
  return GET(
    new Request(
      `https://example.test/api/media/preview/${encodeURIComponent(previewId)}`,
      { headers: init?.headers },
    ),
    { params: Promise.resolve({ previewId }) },
  );
}

/** Status, every header, and the body — the whole observable response. */
async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()]
      .map(([name, value]) => `${name}: ${value}`)
      .sort()
      .join("\n"),
    body: await response.clone().text(),
  };
}

function getObjectKeys(): string[] {
  return s3SendMock.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof GetObjectCommand)
    .map((command) => (command as GetObjectCommand).input.Key as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(null);
  mediaFindFirstMock.mockImplementation(
    async ({
      where,
      select,
    }: {
      where: Record<string, unknown>;
      select: Record<string, true>;
    }) => {
      const found = TABLE.find((candidate) => matches(candidate, where));
      if (!found) return null;
      // Project exactly what was asked for, so a test can never read a column
      // the handler did not select.
      return Object.fromEntries(
        Object.keys(select).map((column) => [
          column,
          (found as unknown as Record<string, unknown>)[column],
        ]),
      );
    },
  );
  s3SendMock.mockResolvedValue({
    Body: { transformToWebStream: () => streamOf(PREVIEW_BYTES) },
  });
});

function signedInAs(userId: string) {
  authMock.mockResolvedValue({ user: { id: userId } });
}

describe("GET /api/media/preview/[previewId] — K1: the bytes come back", () => {
  it("serves a published preview to an anonymous caller", async () => {
    const response = await call(PUBLISHED.previewId as string);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(PREVIEW_CONTENT_TYPE);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PREVIEW_BYTES);
    expect(getObjectKeys()).toEqual([PUBLISHED.previewKey]);
  });

  it("serves a published preview to its owner", async () => {
    signedInAs(OWNER_ID);
    const response = await call(PUBLISHED.previewId as string);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PREVIEW_BYTES);
  });

  it("serves someone else's published preview to a signed-in stranger", async () => {
    signedInAs(OTHER_ID);
    const response = await call(PUBLISHED.previewId as string);
    expect(response.status).toBe(200);
  });

  it("asserts the content type rather than echoing storage metadata", async () => {
    // The mocked GetObject response carries no ContentType at all; the header
    // still has to be right, because it comes from the watermark service's
    // constant.
    s3SendMock.mockResolvedValue({
      Body: { transformToWebStream: () => streamOf(PREVIEW_BYTES) },
    });
    const response = await call(PUBLISHED.previewId as string);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not shape-validate the id, so non-UUID handles still resolve", async () => {
    // ugcportal-r1d's backfill matched randomUUID()'s format precisely so that
    // a UUID check here would not break pre-existing rows. This test exists so
    // that adding such a check is a failing test rather than a silent outage
    // the day the id generator changes.
    const response = await call(ODD_SHAPED_ID.previewId as string);
    expect(response.status).toBe(200);
  });
});

describe("K2: nothing in the response identifies the uploader", () => {
  it("leaks neither the storage path nor a userId, and never redirects", async () => {
    const response = await call(PUBLISHED.previewId as string);
    const observable = await snapshot(response);
    const wire = `${observable.headers}\n${observable.body}`;

    expect(response.status).toBe(200);
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("location")).toBeNull();
    expect(wire).not.toContain(PREVIEW_KEY_PREFIX);
    expect(wire).not.toContain(OWNER_ID);
    expect(wire).not.toContain(PUBLISHED.previewKey as string);
    expect(wire).not.toContain(PUBLISHED.key);
    // The bucket is not the caller's business either.
    expect(wire).not.toContain("test-bucket");
  });

  it("keeps the key out of a 500 even when the storage error contains it", async () => {
    // The key IS expected in the server-side log — that is where it belongs.
    // Silenced so the assertion below is about the response and not about
    // whether stderr happens to be quiet.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    s3SendMock.mockRejectedValue(
      new Error(
        `Access denied for bucket test-bucket key ${PUBLISHED.previewKey}`,
      ),
    );
    const response = await call(PUBLISHED.previewId as string);
    const observable = await snapshot(response);
    consoleError.mockRestore();
    const wire = `${observable.headers}\n${observable.body}`;

    expect(response.status).toBe(500);
    expect(observable.body).toBe(
      JSON.stringify({ error: "Failed to load preview" }),
    );
    expect(wire).not.toContain(PREVIEW_KEY_PREFIX);
    expect(wire).not.toContain(OWNER_ID);
    expect(wire).not.toContain("test-bucket");
  });

  it("reads neither `key` nor `userId` from the database", async () => {
    await call(PUBLISHED.previewId as string);
    const select = mediaFindFirstMock.mock.calls[0][0].select as Record<
      string,
      unknown
    >;
    expect(Object.keys(select)).toEqual(["previewKey"]);
    expect(select).not.toHaveProperty("key");
    expect(select).not.toHaveProperty("userId");
  });
});

describe("K3: unpublished is 404, and identical to nonexistent", () => {
  it("404s an unpublished preview for an anonymous caller, byte-identically to an unknown id", async () => {
    const unpublished = await snapshot(
      await call(UNPUBLISHED.previewId as string),
    );
    const unknown = await snapshot(await call("pid-does-not-exist"));

    expect(unpublished.status).toBe(404);
    expect(unpublished).toEqual(unknown);
    // And no bucket round trip on either, which would be the loud timing tell.
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("404s someone else's unpublished preview for a signed-in stranger, identically", async () => {
    signedInAs(OTHER_ID);
    const forbidden = await snapshot(
      await call(UNPUBLISHED.previewId as string),
    );
    const unknown = await snapshot(await call("pid-does-not-exist"));

    expect(forbidden.status).toBe(404);
    expect(forbidden).toEqual(unknown);
  });

  it("serves the owner their own unpublished preview", async () => {
    signedInAs(OWNER_ID);
    const response = await call(UNPUBLISHED.previewId as string);
    expect(response.status).toBe(200);
    expect(getObjectKeys()).toEqual([UNPUBLISHED.previewKey]);
  });

  it("does not let one owner see another owner's unpublished preview", async () => {
    signedInAs(OWNER_ID);
    const response = await call(OTHERS_UNPUBLISHED.previewId as string);
    expect(response.status).toBe(404);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("puts the publish filter in the query for an anonymous caller, with no owner branch", async () => {
    await call(UNPUBLISHED.previewId as string);
    const where = mediaFindFirstMock.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where).toEqual({
      previewId: UNPUBLISHED.previewId,
      previewKey: { not: null },
      publishedAt: { not: null },
    });
    expect("OR" in where).toBe(false);
    expect("userId" in where).toBe(false);
  });

  it.each([
    ["no session at all", null],
    ["a session with no user", {}],
    ["a user with no id", { user: {} }],
    ["a user whose id is undefined", { user: { id: undefined } }],
    ["a user whose id is empty", { user: { id: "" } }],
  ])(
    "treats %s as anonymous rather than as an unfiltered owner query",
    async (_label, session) => {
      // The failure this guards is Prisma dropping a filter whose value is
      // `undefined`: `{ OR: [{ publishedAt: { not: null } }, {}] }` matches
      // every row, so a malformed session would serve every unpublished
      // preview in the database. The in-memory evaluator above reproduces that
      // behaviour faithfully, so this test would fail if the handler ever let
      // an undefined id through.
      authMock.mockResolvedValue(session);
      const response = await call(UNPUBLISHED.previewId as string);
      expect(response.status).toBe(404);
      expect(s3SendMock).not.toHaveBeenCalled();
    },
  );

  it("404s with no-store, so a miss cannot outlive a later publish", async () => {
    const response = await call("pid-does-not-exist");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("404s a blank id without querying the database", async () => {
    const response = await call(" ");
    expect(response.status).toBe(404);
    expect(mediaFindFirstMock).not.toHaveBeenCalled();
  });
});

describe("K4: the original is never served", () => {
  it("refuses a row whose previewKey points outside the preview prefix", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const rogue = await snapshot(await call(ROGUE_KEY.previewId as string));
    consoleError.mockRestore();

    expect(rogue.status).toBe(404);
    // The point of the test: no GetObject at all, so the original's bytes are
    // never even read, let alone returned.
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("refuses a key that escapes the prefix with a `..` segment", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const response = await call(TRAVERSAL_KEY.previewId as string);
    consoleError.mockRestore();

    expect(response.status).toBe(404);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("refuses a blank previewKey without touching storage", async () => {
    const response = await call(BLANK_KEY.previewId as string);
    expect(response.status).toBe(404);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("404s a published VIDEO, which has no preview object", async () => {
    // previewId is null on such a row, so there is no handle to ask for; the
    // case is covered by asking for the id a caller might guess.
    const response = await call("pid-video");
    expect(response.status).toBe(404);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("only ever issues GetObject under the preview prefix", async () => {
    signedInAs(OWNER_ID);
    for (const target of [PUBLISHED, UNPUBLISHED, OTHERS_PUBLISHED]) {
      await call(target.previewId as string);
    }
    const keys = getObjectKeys();
    expect(keys.length).toBe(3);
    for (const key of keys) {
      expect(key.startsWith(PREVIEW_KEY_PREFIX)).toBe(true);
    }
    // Belt and braces: none of them is any row's original.
    for (const candidate of TABLE) {
      expect(keys).not.toContain(candidate.key);
    }
  });

  it("writes nothing", async () => {
    signedInAs(OWNER_ID);
    await call(PUBLISHED.previewId as string);
    await call(UNPUBLISHED.previewId as string);
    await call("pid-does-not-exist");
    for (const write of WRITE_MOCKS) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});

describe("caching", () => {
  it("is private and must-revalidate, and varies on the session", async () => {
    const response = await call(PUBLISHED.previewId as string);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]+"$/);
    // No shared-cache directive and no freshness window: either would let an
    // unpublish be outlived.
    const cacheControl = response.headers.get("cache-control") as string;
    expect(cacheControl).not.toContain("public");
    expect(cacheControl).not.toContain("max-age");
    expect(cacheControl).not.toContain("immutable");
  });

  it("answers 304 with no body and no bucket round trip on a matching If-None-Match", async () => {
    const first = await call(PUBLISHED.previewId as string);
    const etag = first.headers.get("etag") as string;
    await first.arrayBuffer();
    s3SendMock.mockClear();

    const second = await call(PUBLISHED.previewId as string, {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("private, no-cache");
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a weak validator", (etag: string) => `W/${etag}`],
    ["a list", (etag: string) => `"other", ${etag}`],
    ["a wildcard", () => "*"],
  ])("honours %s in If-None-Match", async (_label, build) => {
    const first = await call(PUBLISHED.previewId as string);
    const etag = first.headers.get("etag") as string;
    await first.arrayBuffer();

    const second = await call(PUBLISHED.previewId as string, {
      headers: { "if-none-match": build(etag) },
    });
    expect(second.status).toBe(304);
  });

  it("serves the bytes again when If-None-Match does not match", async () => {
    const response = await call(PUBLISHED.previewId as string, {
      headers: { "if-none-match": '"something-else"' },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PREVIEW_BYTES);
  });

  it("gives different ids different validators", async () => {
    const one = await call(PUBLISHED.previewId as string);
    await one.arrayBuffer();
    const two = await call(ODD_SHAPED_ID.previewId as string);
    await two.arrayBuffer();
    expect(one.headers.get("etag")).not.toBe(two.headers.get("etag"));
  });

  it("revalidation re-runs authorisation: an unpublished item 404s rather than 304s", async () => {
    // This is the whole justification for `no-cache` over a max-age. The
    // caller holds a valid validator for bytes they were legitimately served;
    // once the item is not theirs and not published, the conditional request
    // must not be answered 304.
    signedInAs(OWNER_ID);
    const first = await call(UNPUBLISHED.previewId as string);
    const etag = first.headers.get("etag") as string;
    await first.arrayBuffer();
    expect(first.status).toBe(200);

    authMock.mockResolvedValue(null);
    const second = await call(UNPUBLISHED.previewId as string, {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(404);
  });
});

describe("storage failures", () => {
  it.each([
    ["NoSuchKey", { name: "NoSuchKey" }],
    ["NotFound", { name: "NotFound" }],
    ["a 404 status", { name: "Whatever", $metadata: { httpStatusCode: 404 } }],
  ])("404s identically when the object is gone (%s)", async (_label, error) => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    s3SendMock.mockRejectedValue(Object.assign(new Error("gone"), error));
    const missing = await snapshot(await call(PUBLISHED.previewId as string));
    s3SendMock.mockResolvedValue({
      Body: { transformToWebStream: () => streamOf(PREVIEW_BYTES) },
    });
    const unknown = await snapshot(await call("pid-does-not-exist"));
    consoleError.mockRestore();

    expect(missing.status).toBe(404);
    expect(missing).toEqual(unknown);
  });

  it("500s when the fetch fails for any other reason", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    s3SendMock.mockRejectedValue(
      Object.assign(new Error("boom"), {
        name: "InternalError",
        $metadata: { httpStatusCode: 500 },
      }),
    );
    const response = await call(PUBLISHED.previewId as string);
    consoleError.mockRestore();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("500s rather than returning an empty 200 when the response carries no body", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    s3SendMock.mockResolvedValue({});
    const response = await call(PUBLISHED.previewId as string);
    consoleError.mockRestore();

    expect(response.status).toBe(500);
  });
});
