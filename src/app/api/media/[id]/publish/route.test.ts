import { beforeEach, describe, expect, it, vi } from "vitest";

import { PERMITTED_ADVERTISING_LABELS } from "@/lib/advertising-disclosure";
import type { OwnedMediaRow } from "@/lib/media-access";

const authMock = vi.fn();

// Every write method the Prisma client exposes for Media, not just the one
// the handlers use. K4 below asserts that a publish touches nothing else —
// a publish path that reached for `update`, `upsert` or a raw statement to
// set price or licence state would show up here rather than sliding past a
// test that only inspects the call the handler was expected to make.
const mediaFindUniqueMock = vi.fn();
const mediaFindFirstMock = vi.fn();
const mediaFindManyMock = vi.fn();
const mediaUpdateManyMock = vi.fn();
const mediaUpdateMock = vi.fn();
const mediaCreateMock = vi.fn();
const mediaCreateManyMock = vi.fn();
const mediaUpsertMock = vi.fn();
const mediaDeleteMock = vi.fn();
const mediaDeleteManyMock = vi.fn();
// The advertising-disclosure table (ugcportal-qnq9.1). Its reader is the
// publish gate; every WRITE method is mocked and listed in WRITE_MOCKS below
// for the same reason Media's are — a publish that reached for one would show
// up rather than sliding past a test that only inspects the call it expected.
const disclosureFindUniqueMock = vi.fn();
const disclosureUpdateManyMock = vi.fn();
const disclosureUpdateMock = vi.fn();
const disclosureCreateMock = vi.fn();
const disclosureUpsertMock = vi.fn();
const disclosureDeleteMock = vi.fn();
const disclosureDeleteManyMock = vi.fn();
const executeRawMock = vi.fn();
const queryRawMock = vi.fn();
const transactionMock = vi.fn();

const WRITE_MOCKS = [
  disclosureUpdateManyMock,
  disclosureUpdateMock,
  disclosureCreateMock,
  disclosureUpsertMock,
  disclosureDeleteMock,
  disclosureDeleteManyMock,
  mediaUpdateMock,
  mediaCreateMock,
  mediaCreateManyMock,
  mediaUpsertMock,
  mediaDeleteMock,
  mediaDeleteManyMock,
  executeRawMock,
  queryRawMock,
  transactionMock,
];

vi.mock("@/lib/auth", () => ({
  auth: authMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    media: {
      findUnique: mediaFindUniqueMock,
      findFirst: mediaFindFirstMock,
      findMany: mediaFindManyMock,
      updateMany: mediaUpdateManyMock,
      update: mediaUpdateMock,
      create: mediaCreateMock,
      createMany: mediaCreateManyMock,
      upsert: mediaUpsertMock,
      delete: mediaDeleteMock,
      deleteMany: mediaDeleteManyMock,
    },
    mediaAdvertisingDisclosure: {
      findUnique: disclosureFindUniqueMock,
      updateMany: disclosureUpdateManyMock,
      update: disclosureUpdateMock,
      create: disclosureCreateMock,
      upsert: disclosureUpsertMock,
      delete: disclosureDeleteMock,
      deleteMany: disclosureDeleteManyMock,
    },
    $executeRaw: executeRawMock,
    $queryRaw: queryRawMock,
    $transaction: transactionMock,
  },
}));

const { DELETE, POST } = await import("@/app/api/media/[id]/publish/route");

const OWNER_ID = "user-a";
const OTHER_ID = "user-b";
const MEDIA_ID = "media-1";

const PUBLISHED_AT = new Date("2026-03-01T09:00:00.000Z");

const unpublishedMedia: OwnedMediaRow = {
  id: MEDIA_ID,
  userId: OWNER_ID,
  kind: "IMAGE",
  key: "media/user-a/abc-photo.png",
  previewKey: "previews/user-a/def-photo.webp",
  // The opaque public handle for that preview (ugcportal-r1d). Set and
  // nulled together with previewKey; the anonymous feed exposes this,
  // never the key, because the key embeds the uploader's id.
  previewId: "preview-abc",
  mimeType: "image/png",
  sizeBytes: 1024,
  originalName: "photo.png",
  // Present by default so every existing publish test keeps exercising the
  // thing IT is about, rather than tripping the new K1 gate. The tests that
  // ARE about K1 override this to null explicitly.
  altText: "A fox crossing a snowy field at dawn",
  caption: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  // The default for every row: private until its owner says otherwise.
  publishedAt: null,
  // The ownership gate loads the subject tags alongside the columns
  // (ugcportal-jsc), because this handler echoes the row it hands back.
  // Deliberately non-empty, so a handler that dropped the field entirely
  // could not still produce a matching response body.
  tags: [{ slug: "food", name: "Food" }],
};

const publishedMedia: OwnedMediaRow = {
  ...unpublishedMedia,
  publishedAt: PUBLISHED_AT,
};

// No watermarked preview yet — every VIDEO, until ugcportal-pmb lands.
const previewLessMedia: OwnedMediaRow = {
  ...unpublishedMedia,
  id: "media-2",
  kind: "VIDEO",
  key: "media/user-a/ghi-clip.mp4",
  previewKey: null,
  previewId: null,
  mimeType: "video/mp4",
  originalName: "clip.mp4",
};

/**
 * Exactly the fields a publish response may carry — no `key`, no `userId`.
 * This is the OWNER projection: publish is an owner-only endpoint, so
 * `originalName` belongs here. The anonymous feed drops it; see
 * src/app/api/public/media/route.test.ts.
 */
const OWNER_FIELDS = [
  "altText",
  "caption",
  "createdAt",
  "id",
  "kind",
  "mimeType",
  "originalName",
  "previewId",
  "previewKey",
  "publishedAt",
  "sizeBytes",
  // Subject tags (ugcportal-jsc). In the owner projection as well as the
  // anonymous one, because a tag is a label chosen to be published.
  "tags",
];

/**
 * The shape prisma returns for `select: MEDIA_OWNER_SELECT` — i.e. `key` is
 * already absent at the DB layer, so the re-read path is fed exactly what that
 * select would actually yield.
 */
function toOwnerShape(media: OwnedMediaRow) {
  return {
    id: media.id,
    kind: media.kind,
    previewKey: media.previewKey,
    previewId: media.previewId,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    originalName: media.originalName,
    altText: media.altText,
    caption: media.caption,
    createdAt: media.createdAt,
    publishedAt: media.publishedAt,
    tags: media.tags,
  };
}

function context(id: string = MEDIA_ID) {
  return { params: Promise.resolve({ id }) };
}

function publishRequest(method: "POST" | "DELETE") {
  return new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
    method,
  });
}

function signedInAs(userId: string, role: "USER" | "ADMIN" = "USER") {
  authMock.mockResolvedValue({ user: { id: userId, role } });
}

/** Every prisma write the handlers performed, as `data` payloads. */
function writtenPayloads() {
  return mediaUpdateManyMock.mock.calls.map((call) => call[0].data);
}

function expectNoOtherWrites() {
  for (const mock of WRITE_MOCKS) {
    expect(mock).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(null);
  mediaFindUniqueMock.mockResolvedValue(null);
  mediaFindFirstMock.mockResolvedValue(null);
  mediaUpdateManyMock.mockResolvedValue({ count: 1 });
  // No disclosure row is the state every item that existed before
  // ugcportal-qnq9.1 is in, and the state every existing test in this file
  // means to exercise. The tests that are ABOUT the gate override it.
  disclosureFindUniqueMock.mockResolvedValue(null);
});

describe("ownership gate on publish/unpublish (K2)", () => {
  it("returns 401 from POST for an anonymous caller, and writes nothing", async () => {
    authMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(401);
    // Not even a read: the gate bails before it looks the row up.
    expect(mediaFindUniqueMock).not.toHaveBeenCalled();
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("returns 401 from DELETE for an anonymous caller, and writes nothing", async () => {
    authMock.mockResolvedValue(null);

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(401);
    expect(mediaFindUniqueMock).not.toHaveBeenCalled();
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("returns 401 when a session exists but carries no user id", async () => {
    authMock.mockResolvedValue({ user: {} });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(401);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 403 when user B publishes user A's media, and writes nothing", async () => {
    signedInAs(OTHER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("returns 403 when user B unpublishes user A's media, and writes nothing", async () => {
    signedInAs(OTHER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(403);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("stays 403 for an admin, since publish state has no admin override", async () => {
    // Admin curation of someone else's visibility is explicitly out of scope
    // for ugcportal-r1d; requireOwnedMedia has no role branch at all.
    signedInAs(OTHER_ID, "ADMIN");
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    expect((await POST(publishRequest("POST"), context())).status).toBe(403);
    expect((await DELETE(publishRequest("DELETE"), context())).status).toBe(403);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a row that does not exist", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context("missing"));

    expect(response.status).toBe(404);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/media/[id]/publish", () => {
  it("sets publishedAt and scopes the write by owner as well as id", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(200);

    const args = mediaUpdateManyMock.mock.calls[0][0];
    // The gate's read and this write are separate statements, so the userId
    // has to be on the write too — otherwise a row re-owned in between would
    // be published by the previous owner's request.
    expect(args.where).toEqual({
      id: MEDIA_ID,
      userId: OWNER_ID,
      publishedAt: null,
    });
    expect(typeof body.publishedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.publishedAt))).toBe(false);
  });

  it("is idempotent and never moves an existing 'public since' timestamp", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    mediaFindFirstMock.mockResolvedValue(toOwnerShape(publishedMedia));

    const body = await (await POST(publishRequest("POST"), context())).json();

    // No write is issued at all. Publish is a transition from null, and the
    // gate saw the row already published, so there is nothing to transition.
    // Issuing the write anyway is what let an interleaved unpublish be undone.
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    // And the answer comes from the re-read, not from the gate's stale copy.
    expect(mediaFindFirstMock).toHaveBeenCalledTimes(1);
    expect(body.publishedAt).toBe(PUBLISHED_AT.toISOString());
  });

  it("does not resurrect an item whose owner unpublished it mid-request", async () => {
    signedInAs(OWNER_ID);
    // The interleaving: the gate read the row while it was published, then the
    // owner's DELETE /publish committed. The previous version always ran the
    // write with `publishedAt: null` in the predicate — which now MATCHED — so
    // this older request republished the item and answered 200, silently
    // undoing an explicit withdrawal and putting it back on the public feed
    // while the owner's UI believed it private.
    //
    // This test is the deliberate inverse of an earlier one that asserted the
    // republish. That earlier test was written against a real bug — answering
    // 200 with a stale timestamp — but its fix overshot: the answer is neither
    // "report the stale value" nor "write anyway", it is "do not write, and
    // report what is actually there".
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    mediaFindFirstMock.mockResolvedValue(
      toOwnerShape({ ...publishedMedia, publishedAt: null }),
    );

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    // The withdrawal stands.
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expect(response.status).toBe(409);
    expect(body.error).toMatch(/unpublished/i);
    // And no success body claiming a publish that did not happen.
    expect(body).not.toHaveProperty("publishedAt");
  });

  it("reports the winner's timestamp when a concurrent publish got there first", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    // `publishedAt: null` in the predicate means the loser updates 0 rows.
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });
    mediaFindFirstMock.mockResolvedValue(toOwnerShape(publishedMedia));

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    // A 404 here would report a publish that actually succeeded as a failure.
    expect(response.status).toBe(200);
    expect(body.publishedAt).toBe(PUBLISHED_AT.toISOString());
  });

  it("refuses when the transition is lost and the row then ends up unpublished", async () => {
    signedInAs(OWNER_ID);
    // A different route to the same answer, reached from the other starting
    // state: the gate saw the row unpublished, so the write IS attempted —
    // but a concurrent publish got in first (count 0), and by the time of the
    // re-read an unpublish had landed too. The row exists, the caller owns it,
    // and it is not published.
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });
    mediaFindFirstMock.mockResolvedValue(
      toOwnerShape({ ...publishedMedia, publishedAt: null }),
    );

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    // Here the write is attempted — the gate saw a transition available — and
    // simply matches nothing.
    expect(mediaUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(409);
    expect(body.error).toMatch(/unpublished/i);
    // Not retried: the unpublish is the more recent instruction, and retrying
    // would let this older request overturn it.
    expect(mediaUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it("still answers 200 when a concurrent publish, not an unpublish, won", async () => {
    // The neighbouring branch: same count === 0, different cause, different
    // answer. Both are reached by reading what is actually there.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });
    mediaFindFirstMock.mockResolvedValue(toOwnerShape(publishedMedia));

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
    expect((await response.json()).publishedAt).toBe(
      PUBLISHED_AT.toISOString(),
    );
  });

  it("returns 404 when the row was deleted between the gate and the write", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });
    mediaFindFirstMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(404);
  });

  it("never echoes the original object key back", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    // requireOwnedMedia hands back the whole row, `key` included. Spreading
    // that into the response would leak the paid original (ugcportal-5d6).
    expect(body).not.toHaveProperty("key");
    expect(body).not.toHaveProperty("userId");
    expect(JSON.stringify(body)).not.toContain("media/");
    expect(Object.keys(body).sort()).toEqual(OWNER_FIELDS);

    // The re-read path must honour the same projection.
    expect(
      mediaFindFirstMock.mock.calls.every(
        (call) => call[0].select?.key === undefined,
      ),
    ).toBe(true);
  });
});

describe("publishing without alt text (ugcportal-gwr K1)", () => {
  it("refuses with 400 naming the field, and writes nothing", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      altText: null,
    });

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.field).toBe("altText");
    expect(body.error).toMatch(/alt text/i);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("refuses whitespace-only alt text the same way", async () => {
    // Defence in depth: `validateAltText` refuses this going forward, but the
    // publish route must not trust that every row was written after that
    // check existed.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      altText: "   ",
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(400);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("still publishes normally when alt text is present", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
    expect(mediaUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it("checks ownership before alt text, not after", async () => {
    // The 400 must not become a way to probe someone else's library.
    signedInAs(OTHER_ID);
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      altText: null,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(403);
  });

  it("does not block unpublishing a row with no alt text", async () => {
    // DELETE /publish cannot fail — an owner must always be able to retract
    // an item, whatever state its other fields are in.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue({
      ...publishedMedia,
      altText: null,
    });

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(200);
    expect((await response.json()).publishedAt).toBeNull();
  });

  // Review round 4, finding 4: a row that is ALREADY published but has no
  // alt text (a deploy-window straggler the backfill migration could not
  // reach, since it did not exist when the migration ran) must still get
  // the idempotent 200 this route's own docstring promises, not a fresh
  // 400 — K1 governs the TRANSITION, not an already-published row's state.
  it("idempotently re-confirms an already-published row even if it has no alt text", async () => {
    signedInAs(OWNER_ID);
    const straggler = { ...publishedMedia, altText: null };
    mediaFindUniqueMock.mockResolvedValue(straggler);
    mediaFindFirstMock.mockResolvedValue(toOwnerShape(straggler));

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.publishedAt).toBe(PUBLISHED_AT.toISOString());
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("still refuses a genuinely UNPUBLISHED row with no alt text (K1 itself, unchanged)", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      altText: null,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(400);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("publishing an item with a benefit but no advertising label (ugcportal-qnq9.1 K2)", () => {
  /**
   * K2: an item whose benefit flag is true and whose disclosure label is null
   * or blank must be refused with 4xx, and publishedAt must stay null.
   * Mirrors the blank-altText refusal above, which is what the bead asks for.
   *
   * The label values here are the REAL ones from
   * src/lib/advertising-disclosure.ts rather than literals typed again: the
   * list is a compliance decision (ugcportal-qnq9.14) and a test carrying its
   * own copy would keep passing after that decision changed.
   */

  it.each([null, "", "   "])(
    "refuses with 400 naming the field when the stored label is %j",
    async (label) => {
      signedInAs(OWNER_ID);
      mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
      disclosureFindUniqueMock.mockResolvedValue({
        benefitReceived: true,
        label,
      });

      const response = await POST(publishRequest("POST"), context());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.field).toBe("advertisingLabel");
      expect(body.error).toMatch(/advertising label/i);
      // publishedAt stays null because nothing was written at all.
      expect(mediaUpdateManyMock).not.toHaveBeenCalled();
      expectNoOtherWrites();
    },
  );

  it("refuses a stored label that is not on the permitted list", async () => {
    // Defence in depth, the same shape the whitespace-only alt-text case
    // takes: PUT /api/media/[id]/disclosure will not write this, but the
    // publish gate must not assume every row went through that route.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    disclosureFindUniqueMock.mockResolvedValue({
      benefitReceived: true,
      label: "Sponsored",
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(400);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it.each(PERMITTED_ADVERTISING_LABELS)(
    "publishes normally when the label is %j",
    async (label) => {
      signedInAs(OWNER_ID);
      mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
      disclosureFindUniqueMock.mockResolvedValue({
        benefitReceived: true,
        label,
      });

      const response = await POST(publishRequest("POST"), context());

      expect(response.status).toBe(200);
      expect(writtenPayloads()).toEqual([{ publishedAt: expect.any(Date) }]);
    },
  );

  it.each([null, false])(
    "publishes an item whose benefit answer is %j, with no label",
    async (benefitReceived) => {
      // K4's storage side, and the no-row case's twin: a label is required
      // only of an item that declares a benefit. An honest item carries none,
      // and must not be blocked for not carrying one.
      signedInAs(OWNER_ID);
      mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
      disclosureFindUniqueMock.mockResolvedValue({
        benefitReceived,
        label: null,
      });

      const response = await POST(publishRequest("POST"), context());

      expect(response.status).toBe(200);
    },
  );

  it("publishes an item that has no disclosure row at all", async () => {
    // Every item that existed when this bead's migration ran. If this ever
    // starts refusing, every pre-existing draft becomes unpublishable with
    // nothing in the product able to clear it.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    disclosureFindUniqueMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
    expect(disclosureFindUniqueMock).toHaveBeenCalledWith({
      where: { mediaId: MEDIA_ID },
      select: { benefitReceived: true, label: true },
    });
  });

  it("checks ownership before the disclosure, not after", async () => {
    // The 400 must not become a way to probe someone else's library — and
    // the gate must not even read the disclosure for a caller it will refuse.
    signedInAs(OTHER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    disclosureFindUniqueMock.mockResolvedValue({
      benefitReceived: true,
      label: null,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(403);
    expect(disclosureFindUniqueMock).not.toHaveBeenCalled();
  });

  it("does not block unpublishing an unlabelled item", async () => {
    // DELETE /publish cannot fail: retracting an undisclosed advertisement is
    // the remedy, so the gate must never stand in its way. The disclosure is
    // not even read.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    disclosureFindUniqueMock.mockResolvedValue({
      benefitReceived: true,
      label: null,
    });

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(200);
    expect((await response.json()).publishedAt).toBeNull();
    expect(disclosureFindUniqueMock).not.toHaveBeenCalled();
  });

  it("refuses even an ALREADY-published row, unlike the alt-text gate", async () => {
    /*
     * The one place this gate deliberately differs from the alt-text one a
     * few describes up, which exempts an already-published row because a
     * rolling deploy can mint a blank-altText row that is not in breach of
     * anything. There is no equivalent here: no backfill creates this state,
     * and PUT /api/media/[id]/disclosure refuses to write it. A published row
     * in this state was written outside the API and IS an undisclosed
     * advertisement, so answering 200 to "publish it" is the wrong answer.
     */
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    mediaFindFirstMock.mockResolvedValue(toOwnerShape(publishedMedia));
    disclosureFindUniqueMock.mockResolvedValue({
      benefitReceived: true,
      label: null,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("advertisingLabel");
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("refuses before reading the disclosure when alt text is missing too", async () => {
    // Ordering, so the cheaper in-memory check short-circuits the round trip.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      altText: null,
    });
    disclosureFindUniqueMock.mockResolvedValue({
      benefitReceived: true,
      label: null,
    });

    const response = await POST(publishRequest("POST"), context());

    expect((await response.json()).field).toBe("altText");
    expect(disclosureFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("publishing a row with no watermarked preview", () => {
  it("refuses with 409 rather than setting a timestamp that changes nothing", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(previewLessMedia);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    // The public feed requires both a publish timestamp AND a previewKey, so
    // publishing this row would have answered 200 and still left it invisible
    // forever, with nothing to tell the owner apart from a working publish.
    expect(response.status).toBe(409);
    expect(body.error).toMatch(/preview/i);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("still lets the owner unpublish it, since that cannot fail", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue({
      ...previewLessMedia,
      publishedAt: PUBLISHED_AT,
    });

    // A row published before this refusal existed must still be retractable.
    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(200);
    expect((await response.json()).publishedAt).toBeNull();
  });

  it("repairs a row with a preview key but no public handle, then publishes it", async () => {
    signedInAs(OWNER_ID);
    // The watermarked object exists; only the handle the anonymous feed hands
    // out is missing. This row used to get "no watermarked preview yet" — a
    // false statement — and a 409 with no way out, because the migration
    // backfilled only rows existing when it ran and nothing anywhere writes
    // previewId on an existing row. An ordinary migrate-then-swap deploy mints
    // exactly this shape (ugcportal-r1d round 10, finding 2).
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      previewKey: "previews/user-a/def-photo.webp",
      previewId: null,
    });

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(200);

    // Two statements, in order, each writing only its own column.
    expect(mediaUpdateManyMock).toHaveBeenCalledTimes(2);
    const [repair, publish] = mediaUpdateManyMock.mock.calls.map((c) => c[0]);

    expect(Object.keys(repair.data)).toEqual(["previewId"]);
    expect(typeof repair.data.previewId).toBe("string");
    // Scoped so a concurrent repair is not clobbered.
    expect(repair.where).toMatchObject({
      id: MEDIA_ID,
      userId: OWNER_ID,
      previewKey: { not: null },
      previewId: null,
    });

    // Publishing still writes nothing but publishedAt — the repair is a
    // separate statement precisely so neither can smuggle the other's columns.
    expect(Object.keys(publish.data)).toEqual(["publishedAt"]);

    // The response carries the id that was actually written, not a second one.
    expect(body.previewId).toBe(repair.data.previewId);
    expect(typeof body.publishedAt).toBe("string");
  });

  it("does not repair a row that already has a public handle", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    await POST(publishRequest("POST"), context());

    // One statement only: the publish. A repair here would be a pointless
    // write, and would churn an id that other things may already reference.
    expect(mediaUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(mediaUpdateManyMock.mock.calls[0][0].data)).toEqual([
      "publishedAt",
    ]);
  });

  it("falls back to the surviving id when a concurrent repair wins", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      previewId: null,
    });
    // The repair matches nothing — another request got there first.
    mediaUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    // The publish itself succeeds.
    mediaUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    mediaFindFirstMock.mockResolvedValue(
      toOwnerShape({
        ...publishedMedia,
        previewId: "preview-from-the-other-request",
      }),
    );

    const body = await (await POST(publishRequest("POST"), context())).json();

    // This request does not know the surviving id, so it re-reads rather than
    // reporting the one it minted and failed to write.
    expect(body.previewId).toBe("preview-from-the-other-request");
  });

  it("refuses a row with a public handle but no preview key", async () => {
    signedInAs(OWNER_ID);
    // The mirror case: the guard has to be the same condition the feeds use,
    // not a subset of it in either direction.
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      previewKey: null,
      previewId: "preview-abc",
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(409);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("still publishes normally when both preview columns are set", async () => {
    // The guard must not have become so broad it refuses ordinary rows.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
    expect(mediaUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it("refuses before the ownership gate would be bypassed, not after", async () => {
    // The 409 must not become a way to probe someone else's library: the
    // ownership gate still runs first.
    signedInAs(OTHER_ID);
    mediaFindUniqueMock.mockResolvedValue(previewLessMedia);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(403);
  });
});

describe("DELETE /api/media/[id]/publish", () => {
  it("writes publishedAt back to null, scoped by owner", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);

    const response = await DELETE(publishRequest("DELETE"), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mediaUpdateManyMock.mock.calls[0][0].where).toEqual({
      id: MEDIA_ID,
      userId: OWNER_ID,
    });
    expect(body.publishedAt).toBeNull();
    expect(body).not.toHaveProperty("key");
  });

  it("is idempotent on an already-private row", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(200);
    expect((await response.json()).publishedAt).toBeNull();
  });

  it("returns 404 when the row was deleted between the gate and the write", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    mediaUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(404);
  });
});

describe("publishing is visibility only, never sellability (K4)", () => {
  // Publishing decides whether something is publicly VISIBLE. Whether it may
  // be SOLD is decided independently by the per-account resale-rights gate
  // (ugcportal-0ss) and the sale catalogue (ugcportal-74w). Both must hold on
  // their own; neither reads publishedAt.
  //
  // The full criterion — "a published row with no CLEARED ResaleRightsReview
  // is still refused by the sellability predicate" — cannot be written yet:
  // ugcportal-0ss has not been built, so there is no ResaleRightsReview model
  // and no sellability predicate to call. When 0ss lands, add that assertion
  // here. What is checkable today is the other half, and it is the half that
  // would actually break the separation from this side: that no publish code
  // path writes anything except publishedAt.

  it("writes publishedAt and nothing else when publishing", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    await POST(publishRequest("POST"), context());

    const payloads = writtenPayloads();
    expect(payloads).toHaveLength(1);
    for (const data of payloads) {
      // Exact key set, not a subset check: a `forSale`, `priceCents` or
      // `licence` written alongside publishedAt would pass `toMatchObject`.
      expect(Object.keys(data)).toEqual(["publishedAt"]);
      expect(data.publishedAt).toBeInstanceOf(Date);
    }
    expectNoOtherWrites();
  });

  it("writes publishedAt and nothing else when unpublishing", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);

    await DELETE(publishRequest("DELETE"), context());

    const payloads = writtenPayloads();
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0])).toEqual(["publishedAt"]);
    expect(payloads[0].publishedAt).toBeNull();
    expectNoOtherWrites();
  });

  it("leaves every other column of the row untouched", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const body = await (await POST(publishRequest("POST"), context())).json();

    // Everything the response reports about the item other than its
    // visibility is byte-for-byte what it was before the publish.
    expect(body.id).toBe(unpublishedMedia.id);
    expect(body.kind).toBe(unpublishedMedia.kind);
    expect(body.previewKey).toBe(unpublishedMedia.previewKey);
    expect(body.mimeType).toBe(unpublishedMedia.mimeType);
    expect(body.sizeBytes).toBe(unpublishedMedia.sizeBytes);
    expect(body.originalName).toBe(unpublishedMedia.originalName);
    expect(body.createdAt).toBe(unpublishedMedia.createdAt.toISOString());
  });

  it("carries no price, licence or purchasability field in the response", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const body = await (await POST(publishRequest("POST"), context())).json();

    // A client cannot infer "this is now buyable" from a publish response,
    // because the response says nothing about buying at all.
    expect(Object.keys(body).sort()).toEqual(OWNER_FIELDS);
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
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});
