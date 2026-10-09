import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaAuthorship, RightsLayer } from "@/generated/prisma/enums";
import { PERMITTED_ADVERTISING_LABELS } from "@/lib/advertising-disclosure";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import type { OwnedMediaRow } from "@/lib/media-access";
import { PUBLISH_AUTHORITY_BLOCKER_MESSAGES } from "@/lib/publish-authority";
import {
  PUBLISH_BLOCKERS,
  PUBLISH_BLOCKER_MESSAGES,
} from "@/lib/publishability";
import {
  PERMITTED_EMAILS_VAR,
  decideSignIn,
  isBootstrapAdminSignIn,
} from "@/lib/sign-in-policy";
import { pinEnvironment } from "@/lib/test-support/env";

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
// The uploader's rights declaration (ugcportal-15r), read by the publish
// gate ugcportal-3ae added. Every write method is mocked and listed in
// WRITE_MOCKS below for the same reason Media's are: this route reads it and
// must never write it — an attestation written by a publish request would be
// the platform ticking the uploader's boxes for them.
const attestationFindUniqueMock = vi.fn();
const attestationUpdateManyMock = vi.fn();
const attestationUpdateMock = vi.fn();
const attestationCreateMock = vi.fn();
const attestationUpsertMock = vi.fn();
const attestationDeleteMock = vi.fn();
const attestationDeleteManyMock = vi.fn();
const listingFindUniqueMock = vi.fn();
const listingUpdateManyMock = vi.fn();
const listingUpdateMock = vi.fn();
const listingCreateMock = vi.fn();
const listingUpsertMock = vi.fn();
const listingDeleteMock = vi.fn();
const listingDeleteManyMock = vi.fn();
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
  attestationUpdateManyMock,
  attestationUpdateMock,
  attestationCreateMock,
  attestationUpsertMock,
  attestationDeleteMock,
  attestationDeleteManyMock,
  listingUpdateManyMock,
  listingUpdateMock,
  listingCreateMock,
  listingUpsertMock,
  listingDeleteMock,
  listingDeleteManyMock,
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
    // The listing is read for its alcohol triage answer (ugcportal-qnq9.3
    // K6) and never written by this route; every writer on it is mocked and
    // in WRITE_MOCKS above, so "publishing writes only publishedAt" keeps
    // covering the table this route now reads.
    mediaListing: {
      findUnique: listingFindUniqueMock,
      updateMany: listingUpdateManyMock,
      update: listingUpdateMock,
      create: listingCreateMock,
      upsert: listingUpsertMock,
      delete: listingDeleteMock,
      deleteMany: listingDeleteManyMock,
    },
    mediaAttestation: {
      findUnique: attestationFindUniqueMock,
      updateMany: attestationUpdateManyMock,
      update: attestationUpdateMock,
      create: attestationCreateMock,
      upsert: attestationUpsertMock,
      delete: attestationDeleteMock,
      deleteMany: attestationDeleteManyMock,
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
const ADMIN_ID = "user-admin";
const MEDIA_ID = "media-1";

/**
 * THE THIRD PERSON (ugcportal-9gt1 K3) — the account that does not exist
 * yet, and whose arrival is the event this bead's gate defends against.
 *
 * `ALLOWLIST_BEFORE` is the instance as Eirik described it on 2026-10-09:
 * two operators, him and Gry. `pinEnvironment` below applies the ONE EDIT
 * that admits a third person — their address appended to the same variable —
 * for every test in this file, and leaves `ADMIN_BOOTSTRAP_EMAILS` naming
 * only the original two, because that is what the edit actually looks like.
 * Nothing in this file reads either variable except the K3 case at the
 * bottom, which is the point: the publish route has no opinion about the
 * allowlist, and the refusal it gives that account is not derived from one.
 */
const NEWCOMER_ID = "user-newcomer";
const NEWCOMER_EMAIL = "newcomer@example.com";
const ALLOWLIST_BEFORE = "eirik@example.com,gry@example.com";

pinEnvironment({
  ALLOWED_SIGNIN_EMAILS: `${ALLOWLIST_BEFORE},${NEWCOMER_EMAIL}`,
  ADMIN_BOOTSTRAP_EMAILS: "google:eirik@example.com,google:gry@example.com",
});

const PUBLISHED_AT = new Date("2026-03-01T09:00:00.000Z");

/**
 * A brand somebody has checked and found clean (ugcportal-qnq9.3 K4).
 *
 * Spread into every disclosure fixture that declares a benefit, because
 * `commercialPublishRefusal` refuses an UNCHECKED brand exactly as it refuses
 * an alcohol-linked one — so a fixture that simply omitted the brand would
 * make each of the advertising-label cases above fail for this bead's reason
 * instead of their own. The alcohol describe at the bottom of this file is
 * where the other two answers are the subject.
 */
const CHECKED_BRAND = {
  benefitSource: { alcoholLinked: false as boolean | null },
} as const;

/**
 * A listing whose alcohol question has been answered `no` — the empty-glass
 * answer (ugcportal-qnq9.3 K1).
 *
 * Needed by the "publishes normally" cases for the same reason CHECKED_BRAND
 * is: from this bead on, an item that DECLARES A BENEFIT may not go public
 * until somebody has said there is no alcohol in it, so an unanswered listing
 * (the default in this file) refuses. That precondition is new, it only
 * applies to an item carrying a benefit, and it is the subject of the alcohol
 * describe below rather than of these cases.
 */
const TRIAGED_ALCOHOL_FREE = { depictsAlcohol: false as boolean | null };

/**
 * The uploader's own rights declaration, complete and in force
 * (ugcportal-3ae K1).
 *
 * Spread into the default for every case in this file for the same reason
 * `altText` is present on `unpublishedMedia` and CHECKED_BRAND on the
 * disclosure fixtures: from this bead on, an upload with no declaration
 * cannot be published at all, so a fixture without one would make every case
 * above fail for THIS bead's reason instead of its own. The cases that ARE
 * about the declaration override it explicitly.
 */
const VALID_ATTESTATION = {
  attestedByUserId: OWNER_ID,
  attestationVersion: CURRENT_ATTESTATION_VERSION,
  authorship: MediaAuthorship.AUTHOR,
  ownOriginalNotFromWeb: true,
  showsIdentifiablePeople: false,
  showsMinors: false,
  containsMusicNotOwned: false,
  otherCreativeContributor: false,
  brandOrSponsorship: false,
  aiGenerated: false,
  uploaderIsAdult: true,
};

/** A PEOPLE clearance an admin signed, as the gate reads it. */
const PEOPLE_CLEARANCE_BY_ADMIN = {
  layer: RightsLayer.PEOPLE,
  reason: "Model release on file, countersigned 2026-02-02; covers online commercial publication.",
  clearedByUserId: ADMIN_ID,
  clearedBy: { role: "ADMIN" as const },
};

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

/**
 * THE DEFAULT ROLE IS `ADMIN`, i.e. an OPERATOR (ugcportal-9gt1).
 *
 * Same reason `VALID_ATTESTATION` and `altText` are defaults above: from
 * that bead on, publishing requires the caller to be an operator, so a
 * fixture signed in as an ordinary user would make every case in this file
 * fail for THAT bead's reason instead of its own. Every case where the role
 * matters states it rather than relying on this default: each `OTHER_ID`
 * site below passes its own (`"USER"` where "not the owner" is the whole
 * subject, `"ADMIN"` for the case about an admin having no override), and
 * the operator describe at the bottom of this file passes `"USER"`.
 *
 * It does NOT make the new gate untested by making it easy to pass: the
 * operator describe signs in as a non-operator explicitly, so deleting the
 * check in the route fails those cases regardless of what this default is.
 */
function signedInAs(userId: string, role: "USER" | "ADMIN" = "ADMIN") {
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
  // No listing row: an item nobody has put forward for sale, which is every
  // item in this file except where a case says otherwise. With no benefit
  // declared the alcohol gate answers null whatever this holds, and with the
  // uploader declaring nobody identifiable is shown, the people gate asks
  // for no clearance.
  listingFindUniqueMock.mockResolvedValue(null);
  // A complete, in-force declaration by the owner (ugcportal-3ae). See
  // VALID_ATTESTATION for why this is the default rather than null.
  attestationFindUniqueMock.mockResolvedValue(VALID_ATTESTATION);
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
    signedInAs(OTHER_ID, "USER");
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("returns 403 when user B unpublishes user A's media, and writes nothing", async () => {
    signedInAs(OTHER_ID, "USER");
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
    signedInAs(OTHER_ID, "USER");
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
        ...CHECKED_BRAND,
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
      ...CHECKED_BRAND,
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
        ...CHECKED_BRAND,
      });
      listingFindUniqueMock.mockResolvedValue(TRIAGED_ALCOHOL_FREE);

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
        ...CHECKED_BRAND,
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
      select: {
        benefitReceived: true,
        label: true,
        benefitSource: { select: { alcoholLinked: true } },
      },
    });
  });

  it("checks ownership before the disclosure, not after", async () => {
    // The 400 must not become a way to probe someone else's library — and
    // the gate must not even read the disclosure for a caller it will refuse.
    signedInAs(OTHER_ID, "USER");
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    disclosureFindUniqueMock.mockResolvedValue({
      benefitReceived: true,
      label: null,
      ...CHECKED_BRAND,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(403);
    expect(disclosureFindUniqueMock).not.toHaveBeenCalled();
  });

  it("does not block unpublishing an unlabelled item", async () => {
    // Retracting an undisclosed advertisement is the remedy, so the
    // disclosure gate must never stand in DELETE's way. (DELETE can still
    // answer 401/403/404 — the claim is only that this gate does not block
    // it.) The disclosure is not even read.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    disclosureFindUniqueMock.mockResolvedValue({
      benefitReceived: true,
      label: null,
      ...CHECKED_BRAND,
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
      ...CHECKED_BRAND,
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
      ...CHECKED_BRAND,
    });

    const response = await POST(publishRequest("POST"), context());

    expect((await response.json()).field).toBe("altText");
    expect(disclosureFindUniqueMock).not.toHaveBeenCalled();
  });
});

/**
 * ugcportal-qnq9.3 K6: no commercial affordance is ever served on an image
 * that shows alcohol, or from a brand that also sells it.
 *
 * Publishing is where that is enforced, because every public surface — the
 * gallery tile, the lightbox, the item page, the public feed, and the
 * advertising label all four of them render (ugcportal-e0jv) — is downstream
 * of `publishedAt`. alkoholloven § 9-2, administratively finable since 13
 * September 2024.
 *
 * Every case here declares a benefit, which is the whole scope of the rule:
 * an honest photograph of a glass of wine is personal content and publishes
 * normally (the last two cases).
 */
describe("publishing an advertisement that shows alcohol (ugcportal-qnq9.3 K6)", () => {
  function declaresBenefit(brand: { alcoholLinked: boolean | null } | null) {
    disclosureFindUniqueMock.mockResolvedValue({
      benefitReceived: true,
      label: "Advertisement / Reklame",
      benefitSource: brand,
    });
  }

  it.each([
    ["recorded as showing alcohol", true],
    ["never triaged for alcohol at all", null],
  ])("refuses an advertisement %s", async (_name, depictsAlcohol) => {
    // BOTH refusing states, and the `null` one is the half a `=== true` gate
    // would miss: §3.1a's standard is what the picture looks like, and
    // "nobody asked" is not an answer to that.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    declaresBenefit({ alcoholLinked: false });
    listingFindUniqueMock.mockResolvedValue(
      depictsAlcohol === null ? null : { depictsAlcohol },
    );

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.field).toBe("depictsAlcohol");
    expect(body.error).toMatch(/alkoholloven/);
    // Nothing was written, so the item is still private.
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("refuses an advertisement from a brand that sells alcohol", async () => {
    // K4 at the publish gate: a refusal about the COMPANY, with the picture
    // itself answered clean, so this case cannot pass for the previous one's
    // reason.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    declaresBenefit({ alcoholLinked: true });
    listingFindUniqueMock.mockResolvedValue(TRIAGED_ALCOHOL_FREE);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.field).toBe("benefitSource");
    expect(body.error).toMatch(/produces, imports or sells alcohol/);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it.each([
    ["answered by nobody", { alcoholLinked: null }],
    ["absent from the row entirely", null],
  ])("refuses an advertisement from a brand %s", async (_name, brand) => {
    // "An unasked question never passes as a no" (K4), at the publish gate
    // and in both of the shapes "unasked" actually arrives in: a brand row
    // with a null answer, and a disclosure whose brand pointer is null.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    declaresBenefit(brand);
    listingFindUniqueMock.mockResolvedValue(TRIAGED_ALCOHOL_FREE);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.field).toBe("benefitSource");
    expect(body.error).toMatch(/Nobody has recorded/);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("refuses even an ALREADY-published advertisement", async () => {
    // The same choice the advertising-label gate makes and the alt-text gate
    // does not: a published row in this state was written outside this API
    // and IS the breach, so answering 200 because it already happens to be
    // public is the wrong answer.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    mediaFindFirstMock.mockResolvedValue(toOwnerShape(publishedMedia));
    declaresBenefit({ alcoholLinked: false });
    listingFindUniqueMock.mockResolvedValue({ depictsAlcohol: true });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(400);
    expect((await response.json()).field).toBe("depictsAlcohol");
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("does not block unpublishing one", async () => {
    // Taking an unlawful advertisement down is the remedy, so this gate must
    // never stand in DELETE's way — the same rule the label gate follows.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    declaresBenefit({ alcoholLinked: true });
    listingFindUniqueMock.mockResolvedValue({ depictsAlcohol: true });

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(200);
    expect((await response.json()).publishedAt).toBeNull();
    expect(listingFindUniqueMock).not.toHaveBeenCalled();
  });

  it("publishes the empty glass, which is K1", async () => {
    // The accessory: a wine accessory answered `yes`, the drink answered
    // `no`, a checked brand, a permitted label — and it goes public. This is
    // the case the bead was rewritten to make true, and without it every
    // refusal above would also hold for a gate wired to refuse everything.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    declaresBenefit({ alcoholLinked: false });
    listingFindUniqueMock.mockResolvedValue(TRIAGED_ALCOHOL_FREE);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
    expect(writtenPayloads()).toEqual([{ publishedAt: expect.any(Date) }]);
  });

  it("publishes an untriaged photograph that declares no benefit", async () => {
    // The scope limit, stated as its own case: § 9-2 is about ADVERTISING.
    // Personal content showing a glass of wine is publishable, and an item
    // nobody has triaged is publishable, as long as no benefit is recorded —
    // which is also every item that existed before this bead.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    disclosureFindUniqueMock.mockResolvedValue(null);
    listingFindUniqueMock.mockResolvedValue({ depictsAlcohol: true });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
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
    signedInAs(OTHER_ID, "USER");
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

/**
 * ugcportal-3ae K1 and K2, at the route.
 *
 * The gate's own unit cases live in src/lib/publishability.test.ts; these
 * are about the HTTP contract K1 states — the status code, the closed-set
 * blocker, and `publishedAt` unchanged — and about K2's requirement that the
 * two refusals be told apart from each other rather than both just reading
 * "refused".
 */
describe("publishing requires the uploader's declaration (ugcportal-3ae K1)", () => {
  it("refuses with 422 and `attestation_missing`, and writes nothing", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.blocker).toBe("attestation_missing");
    expect(body.error).toBe(PUBLISH_BLOCKER_MESSAGES.attestation_missing);
    // K1's "publishedAt is unchanged", as the only thing that can change it:
    // the route issued no write at all, so there is nothing to have changed
    // it with. route.integration.test.ts asserts the stored column itself.
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("refuses an already-published row too, rather than answering an idempotent 200", async () => {
    // The two refusals above this one in the handler are not gated on
    // `publishedAt === null` either, and for the reason stated there: a
    // published row that fails this IS the row K3 says must not be on a
    // public surface, and PUBLIC_MEDIA_SCOPE has already stopped serving it.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    attestationFindUniqueMock.mockResolvedValue(null);

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe("attestation_missing");
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("refuses a declaration made by somebody other than the uploader", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue({
      ...VALID_ATTESTATION,
      attestedByUserId: ADMIN_ID,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe("attestation_not_by_uploader");
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
  });

  it("refuses a declaration at a retired version", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue({
      ...VALID_ATTESTATION,
      attestationVersion: "1999-01-01.1",
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe(
      "attestation_version_retired",
    );
  });

  it("refuses a declaration that disclaims the rights outright", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue({
      ...VALID_ATTESTATION,
      authorship: MediaAuthorship.NEITHER,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe(
      "attestation_rights_disclaimed",
    );
  });

  it("publishes an upload whose uploader declared they are under 18", async () => {
    /*
     * The one attestation answer that blocks a SALE and not a publish
     * (PUBLISH_ATTESTATION_BLOCKERS in src/lib/publishability.ts): §3.2 is
     * about capacity to grant a licence, and publishing grants none. This
     * case is what stops that decision from being quietly reversed into
     * "a seventeen-year-old may not show their own photograph".
     */
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue({
      ...VALID_ATTESTATION,
      uploaderIsAdult: false,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
    expect(writtenPayloads()).toHaveLength(1);
  });
});

describe("publishing something showing a person requires a PEOPLE clearance (ugcportal-3ae K2)", () => {
  /**
   * The upload K2 is about: the declaration is complete and in force, and
   * the uploader has said an identifiable person is in the frame.
   */
  const attestationShowingPeople = {
    ...VALID_ATTESTATION,
    showsIdentifiablePeople: true,
  };

  it("refuses on `people_uncleared` — NOT on the attestation blocker", async () => {
    /*
     * K2's distinguishability requirement, stated as the thing that could
     * go wrong: a test asserting only "refused" would pass if the refusal
     * came from the attestation check firing, which is a completely
     * different failure with a completely different fix. So the declaration
     * here is valid in every respect, and the blocker is asserted by name.
     */
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue(attestationShowingPeople);

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.blocker).toBe("people_uncleared");
    // A redundant negative assertion about the attestation blocker used to
    // sit here; once the line above passes it had no failing case (review
    // round 1, finding 7). It is NOT "every message is distinct" in
    // src/lib/publishability.test.ts that would catch a routing regression
    // here (round 2, finding 2 — that test guards message collisions in the
    // static PUBLISH_BLOCKER_MESSAGES map, a different bug class, and does
    // not move if `publishabilityBlocker` picks the wrong code for this
    // input). The `toBe` above already is the specific-value assertion that
    // distinguishes `people_uncleared` from every other blocker; the
    // predicate-level case this HTTP test exercises is
    // src/lib/publishability.test.ts's own K2 test, which asserts the same
    // way for the same reason.
    expect(body.error).toBe(PUBLISH_BLOCKER_MESSAGES.people_uncleared);
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });

  it("publishes the SAME upload once the PEOPLE clearance exists", async () => {
    /*
     * The other half of the pair K2 asks for, and the half that connects the
     * assertion above to the clearance rather than to anything else: the
     * only thing that changes between these two cases is the clearance row.
     */
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue(attestationShowingPeople);
    listingFindUniqueMock.mockResolvedValue({
      depictsAlcohol: null,
      depictsPeople: true,
      layerClearances: [PEOPLE_CLEARANCE_BY_ADMIN],
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
    expect(writtenPayloads()).toHaveLength(1);
    expect(Object.keys(writtenPayloads()[0])).toEqual(["publishedAt"]);
  });

  it("refuses when the clearance was signed by somebody who is no longer an admin", async () => {
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue(attestationShowingPeople);
    listingFindUniqueMock.mockResolvedValue({
      depictsAlcohol: null,
      depictsPeople: true,
      layerClearances: [
        { ...PEOPLE_CLEARANCE_BY_ADMIN, clearedBy: { role: "USER" } },
      ],
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe("people_uncleared");
  });

  it("refuses when a DIFFERENT layer is cleared and PEOPLE is not", async () => {
    // Per-layer clearances settle their own layer and nothing else; a
    // MUSIC clearance saying "licence purchased" is not an answer about a
    // person in the frame.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue(attestationShowingPeople);
    listingFindUniqueMock.mockResolvedValue({
      depictsAlcohol: null,
      depictsPeople: true,
      layerClearances: [
        { ...PEOPLE_CLEARANCE_BY_ADMIN, layer: RightsLayer.MUSIC },
      ],
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe("people_uncleared");
  });

  it("refuses when the ADMIN triage says a person is shown and the uploader said otherwise", async () => {
    /*
     * The two answers can disagree, and the dangerous direction is the
     * `no`: an uploader who ticks "nobody identifiable" on a street
     * portrait must not thereby publish it over an admin's recorded `yes`.
     */
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue(VALID_ATTESTATION);
    listingFindUniqueMock.mockResolvedValue({
      depictsAlcohol: null,
      depictsPeople: true,
      layerClearances: [],
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(422);
    expect((await response.json()).blocker).toBe("people_uncleared");
  });

  it("does not demand a clearance when neither the uploader nor an admin says a person is shown", async () => {
    // An untriaged listing is the ordinary state of every upload on this
    // site. Requiring an admin to answer first would make publishing an
    // admin-gated act, which is ugcportal-55nt's open question rather than
    // this gate's to decide.
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    listingFindUniqueMock.mockResolvedValue({
      depictsAlcohol: null,
      depictsPeople: null,
      layerClearances: [],
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(200);
  });

  it("does not block unpublishing a row this gate refuses to publish", async () => {
    /*
     * The sibling each of the three neighbouring publish gates already has
     * ("does not block unpublishing an unlabelled item", "...a row with no
     * alt text", "...one"), and which this one was missing (review round 1,
     * finding 6). Taking a row down is the REMEDY for every refusal above,
     * so a gate that stood in DELETE's way would trap the uncleared
     * photograph of an identifiable person on the public site — the exact
     * failure the gate exists to prevent, arriving through the fix for it.
     *
     * BOTH halves of the gate are made to refuse at once, so this cannot
     * pass because only one of them happened not to be consulted: there is
     * no declaration at all (K1), and the admin's triage says a person is
     * shown with no clearance (K2).
     *
     * The two `not.toHaveBeenCalled()` assertions are what give this a
     * failing case the status code alone would not: DELETE has no other
     * reason to read either table, so a gate wrongly copied into it is
     * visible here even in a form that let the request through anyway.
     */
    signedInAs(OWNER_ID);
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);
    attestationFindUniqueMock.mockResolvedValue(null);
    listingFindUniqueMock.mockResolvedValue({
      depictsAlcohol: null,
      depictsPeople: true,
      layerClearances: [],
    });

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(200);
    expect((await response.json()).publishedAt).toBeNull();
    expect(writtenPayloads()).toEqual([{ publishedAt: null }]);
    expect(attestationFindUniqueMock).not.toHaveBeenCalled();
    expect(listingFindUniqueMock).not.toHaveBeenCalled();
  });
});

/**
 * ---------------------------------------------------------------------------
 * PUBLISHING REQUIRES AN OPERATOR, NOT MERELY OWNERSHIP (ugcportal-9gt1)
 * ---------------------------------------------------------------------------
 *
 * Every case above this point signs in as an operator, because since this
 * bead that is what it takes to publish anything at all. These are the cases
 * where NOT being one is the subject.
 *
 * What makes them worth more than "a non-admin gets 403": each one arranges
 * a row that satisfies every OTHER condition this route imposes — alt text,
 * no undisclosed benefit, no alcohol, a complete in-force declaration by the
 * uploader, nobody identifiable in the frame, a watermarked preview with a
 * public handle. There is nothing left for the ugcportal-3ae rights gate or
 * its two neighbours to refuse. So a refusal here can only be about the
 * account, and the mutation in the first case — the same request, the same
 * row, the same fixtures, with the role changed and nothing else — is what
 * connects it to the role rather than to a gate that was already refusing.
 */
describe("publishing requires an operator, not merely ownership (ugcportal-9gt1)", () => {
  /**
   * A row with nothing wrong with it: this is the fixture against which a
   * refusal means the caller, because it cannot mean the material.
   *
   * `TRIAGED_ALCOHOL_FREE` and a disclosure are deliberately NOT set — the
   * file's default is no disclosure row at all, which declares no benefit,
   * which is the state in which `advertisingLabelPublishRefusal` and
   * `commercialPublishRefusal` both answer null. See their own describes
   * above.
   */
  function arrangeFullyPublishableRow() {
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue(VALID_ATTESTATION);
    disclosureFindUniqueMock.mockResolvedValue(null);
    listingFindUniqueMock.mockResolvedValue(null);
  }

  it("refuses the owner, then publishes the identical request once that same account is an operator (K1)", async () => {
    arrangeFullyPublishableRow();
    signedInAs(OWNER_ID, "USER");

    const refused = await POST(publishRequest("POST"), context());

    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: PUBLISH_AUTHORITY_BLOCKER_MESSAGES.not_an_operator,
      blocker: "not_an_operator",
    });
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();

    // THE MUTATION, and the only thing that differs between the two halves:
    // the same account, the same row, the same request, now an operator.
    // Without this half the case above would be satisfied by a route that
    // refused every publish outright.
    signedInAs(OWNER_ID, "ADMIN");

    const permitted = await POST(publishRequest("POST"), context());

    expect(permitted.status).toBe(200);
    expect(writtenPayloads()).toEqual([{ publishedAt: expect.any(Date) }]);
  });

  it("refuses an owner whose ownership the gate has already accepted (K2)", async () => {
    arrangeFullyPublishableRow();
    signedInAs(OWNER_ID, "USER");

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(403);
    // NOT the ownership refusal. Both answer 403, so the status alone cannot
    // tell "this row is not yours" from "you may not publish"; the body is
    // what distinguishes them, and the ownership gate's is a bare
    // `{ error: "Forbidden" }` with no `blocker` at all.
    expect(body).not.toEqual({ error: "Forbidden" });
    expect(body.blocker).toBe("not_an_operator");
    // And the ownership gate really did pass first: it read the row, and it
    // is the caller's own.
    expect(mediaFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MEDIA_ID } }),
    );
    expect(unpublishedMedia.userId).toBe(OWNER_ID);
  });

  it("answers the operator question before any condition on the material", async () => {
    // A row the ugcportal-3ae gate WOULD refuse: no declaration at all. An
    // operator asking this gets 422 `attestation_missing` (see that
    // describe); a non-operator must not, because the answer they are owed
    // is about them and does not depend on how far along this row is.
    mediaFindUniqueMock.mockResolvedValue(unpublishedMedia);
    attestationFindUniqueMock.mockResolvedValue(null);
    signedInAs(OWNER_ID, "USER");

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.blocker).toBe("not_an_operator");
    // By name, not by "is not a rights code": a route that returned some
    // third thing would pass that weaker form.
    expect(PUBLISH_BLOCKERS).not.toContain(body.blocker);
    // The three reads the later gates need never happened — the cheapness
    // half of putting this check first.
    expect(disclosureFindUniqueMock).not.toHaveBeenCalled();
    expect(listingFindUniqueMock).not.toHaveBeenCalled();
    expect(attestationFindUniqueMock).not.toHaveBeenCalled();
  });

  it("refuses a non-operator even for a row whose alt text is missing too", async () => {
    // The mirror of the case above against the FIRST condition the route
    // checks rather than the last, so "before the material" is not just a
    // statement about the gate that happens to sit furthest down.
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      altText: null,
    });
    signedInAs(OWNER_ID, "USER");

    const response = await POST(publishRequest("POST"), context());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.blocker).toBe("not_an_operator");
    expect(body.field).toBeUndefined();
  });

  it("still lets a non-operator owner UNPUBLISH their own item", async () => {
    // The deliberate asymmetry (see the DELETE handler's docstring):
    // withdrawing something from the public gallery moves in the safe
    // direction, and an owner who is not an operator — or who has been
    // demoted since — must not be locked out of taking their own
    // photograph down.
    signedInAs(OWNER_ID, "USER");
    mediaFindUniqueMock.mockResolvedValue(publishedMedia);

    const response = await DELETE(publishRequest("DELETE"), context());

    expect(response.status).toBe(200);
    expect(writtenPayloads()).toEqual([{ publishedAt: null }]);
  });

  /**
   * K3 — THE REASON THIS BEAD EXISTS.
   *
   * `pinEnvironment` at the top of this file puts `newcomer@example.com` on
   * `ALLOWED_SIGNIN_EMAILS` for every test in it: the exact one-line edit an
   * operator makes to let a third person upload. The two halves below are
   * the whole claim — that edit really does admit them, and it confers no
   * publish.
   */
  it("does not confer publish on an address added to ALLOWED_SIGNIN_EMAILS (K3)", async () => {
    // Half one: the edit is real. Without it the same identity is refused at
    // the door, so what follows is not a test of an address nobody admitted.
    expect(
      decideSignIn(
        { user: { email: NEWCOMER_EMAIL }, account: { provider: "google" } },
        { [PERMITTED_EMAILS_VAR]: ALLOWLIST_BEFORE },
        [],
      ).permitted,
    ).toBe(false);
    expect(
      decideSignIn(
        { user: { email: NEWCOMER_EMAIL }, account: { provider: "google" } },
        // The live environment this file pinned, and an EMPTY configured-user
        // array, so the permission can only have come from the allowlist
        // variable rather than from src/config/users.ts.
        process.env,
        [],
      ),
    ).toEqual({ permitted: true, email: NEWCOMER_EMAIL });
    // And it is only a sign-in grant: the bootstrap list is a different
    // variable and does not name them, so the role this account signs in
    // with is USER. That is the link between the allowlist edit and the
    // session below, rather than an assumption about it.
    expect(
      isBootstrapAdminSignIn({
        email: NEWCOMER_EMAIL,
        provider: "google",
      }),
    ).toBe(false);

    // Half two: and the public gallery is still closed to them, on an upload
    // that is theirs and that nothing else about this route would refuse.
    signedInAs(NEWCOMER_ID, "USER");
    mediaFindUniqueMock.mockResolvedValue({
      ...unpublishedMedia,
      userId: NEWCOMER_ID,
    });
    attestationFindUniqueMock.mockResolvedValue({
      ...VALID_ATTESTATION,
      attestedByUserId: NEWCOMER_ID,
    });

    const response = await POST(publishRequest("POST"), context());

    expect(response.status).toBe(403);
    expect((await response.json()).blocker).toBe("not_an_operator");
    expect(mediaUpdateManyMock).not.toHaveBeenCalled();
    expectNoOtherWrites();
  });
});
