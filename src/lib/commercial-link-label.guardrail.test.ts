import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { toGalleryItem } from "@/lib/gallery-items";
import { completeAttestationRow } from "@/lib/test-support/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-jain's guardrail (K3): this site must never serve a commercial
 * link on an item whose advertising label has been taken away from it.
 * Forbrukertilsynet requires the page labelled at the top as well as at each
 * link (docs/ugc-research.md §3.2), and the top label is rendered from
 * `MediaAdvertisingDisclosure.label` and from nothing else.
 *
 * WHAT THIS FILE IS A REGRESSION OF, precisely. Two reviews drove this
 * sequence by hand against the real routes and recorded what it answered:
 * attach 201, publish 200, withdraw 200 — the link surviving, because the
 * disclosure route touched no `CommercialLink` row at all — and re-publish
 * 200, entirely ungated, because `commercialPublishRefusal` answered null the
 * moment `benefitReceived` stopped being `true`. Four requests from a
 * compliant state to a public row carrying a live advertising link with
 * nothing labelling it.
 *
 * HOW IT IS BUILT. The sequence below is driven through the REAL routes, the
 * way an operator would, for the reason the § 9-2 guardrail next door
 * (src/lib/alcohol-commerce.guardrail.test.ts) gives for doing the same: a
 * test that seeded the offending row and then asserted it was hidden would be
 * asserting something about its own fixtures. The one exception is the
 * out-of-band write in the last phase, which is deliberate and is labelled
 * where it happens — the whole point of that phase is a row the API can no
 * longer produce.
 *
 * THREE LAYERS, ASKED SEPARATELY, because they fail independently: the
 * disclosure write (K1), the publish gate (K2), and what the public surfaces
 * actually serve for a row that got past both anyway.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const { PUT: DISCLOSE } = await import("@/app/api/media/[id]/disclosure/route");
const { POST: PUBLISH } = await import("@/app/api/media/[id]/publish/route");
const { POST: ATTACH_LINK } = await import(
  "@/app/api/media/[id]/commercial-links/route"
);
// Dynamic, like every other import in this block, for the reason the § 9-2
// guardrail states: `media-access.ts` imports `@/lib/auth` at module scope,
// and a static import would evaluate it while `authMock` is still in its
// temporal dead zone.
const { MEDIA_ANONYMOUS_SELECT } = await import("@/lib/media-access");
const { listPublicMedia, publicMediaListingUrl, PUBLIC_MEDIA_SCOPE } =
  await import("@/lib/public-media");
const { PERMITTED_ADVERTISING_LABELS } = await import(
  "@/lib/advertising-disclosure"
);

const OPERATOR = "operator-jain";
const MEDIA_ID = "media-jain";
const LABEL = PERMITTED_ADVERTISING_LABELS[0];
const LINK_URL = "https://track.adtraction.com/t/t?a=1234&m=jain";

const context = (id: string) => ({ params: Promise.resolve({ id }) });

function disclosureRequest(body: unknown) {
  return new Request(`http://localhost/api/media/${MEDIA_ID}/disclosure`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function attachRequest() {
  return new Request(
    `http://localhost/api/media/${MEDIA_ID}/commercial-links`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: LINK_URL,
        network: "ADTRACTION",
        benefitSource: "Riedel",
      }),
    },
  );
}

function publishRequest() {
  return new Request(`http://localhost/api/media/${MEDIA_ID}/publish`, {
    method: "POST",
  });
}

/** The item exactly as an anonymous visitor's query would read it. */
function anonymousRow() {
  return prisma.media.findFirstOrThrow({
    where: { id: MEDIA_ID, ...PUBLIC_MEDIA_SCOPE },
    select: MEDIA_ANONYMOUS_SELECT,
  });
}

function storedLinkCount() {
  return prisma.commercialLink.count({ where: { mediaId: MEDIA_ID } });
}

function storedDisclosure() {
  return prisma.mediaAdvertisingDisclosure.findUniqueOrThrow({
    where: { mediaId: MEDIA_ID },
    select: { benefitReceived: true, label: true },
  });
}

/**
 * Everything the sequence answered, assigned ONCE at the end of `beforeAll`
 * rather than field by field as it goes. A partially-filled object would let
 * a case below read `undefined` for a step that never ran and compare it
 * against an expectation that happens to be `undefined` too; building it in
 * one expression means every field is present or the file does not compile.
 */
type Recorded = {
  disclose: number;
  attach: number;
  publish: number;
  withdraw: number;
  withdrawBody: { blocker?: string; field?: string; error?: string };
  linksAfterRefusedWithdraw: number;
  disclosureAfterRefusedWithdraw: {
    benefitReceived: boolean | null;
    label: string | null;
  };
  republish: number;
  republishBody: { field?: string; error?: string };
  publishedAtAtEnd: Date | null;
  galleryLinkCount: number;
  feedLinkCount: number;
  rawRelationCount: number;
};

let recorded: Recorded;

beforeAll(async () => {
  await applyMigrations(prisma);
  authMock.mockResolvedValue({ user: { id: OPERATOR, role: "ADMIN" } });

  await prisma.user.create({
    data: { id: OPERATOR, email: "operator-jain@example.com", role: "ADMIN" },
  });
  await prisma.media.create({
    data: {
      id: MEDIA_ID,
      userId: OPERATOR,
      kind: "IMAGE",
      key: `media/${OPERATOR}/glass.png`,
      previewKey: `previews/${OPERATOR}/glass.webp`,
      previewId: "preview-jain",
      mimeType: "image/png",
      sizeBytes: 2048,
      originalName: "IMG_0001.HEIC",
      altText: "An empty wine glass on a windowsill",
    },
  });
  // The uploader's rights declaration (ugcportal-3ae) and a completed triage,
  // so nothing in the sequence below is ever refused for a reason this file
  // is not about. `depictsPeople: false` is what keeps the PEOPLE clearance
  // out of it; `depictsAlcohol: false` keeps § 9-2 out of it.
  await prisma.mediaAttestation.create({
    data: completeAttestationRow(MEDIA_ID, OPERATOR),
  });
  await prisma.mediaListing.create({
    data: {
      mediaId: MEDIA_ID,
      depictsPeople: false,
      depictsMinors: false,
      containsMusic: false,
      thirdPartyCreator: false,
      sponsoredContent: false,
      depictsAlcohol: false,
      wineAccessory: true,
    },
  });

  // 1-3: the compliant state the two reviews started from.
  const disclose = (
    await DISCLOSE(
      disclosureRequest({
        benefitReceived: true,
        benefitKind: "FREE_PRODUCT",
        benefitSource: "Riedel",
        benefitSourceAlcoholLinked: false,
        marketValueOre: 49900,
        label: LABEL,
      }),
      context(MEDIA_ID),
    )
  ).status;
  const attach = (await ATTACH_LINK(attachRequest(), context(MEDIA_ID))).status;
  const publish = (await PUBLISH(publishRequest(), context(MEDIA_ID))).status;

  // 4: the request that used to answer 200 and strand the link.
  const withdrawResponse = await DISCLOSE(
    disclosureRequest({ benefitReceived: false }),
    context(MEDIA_ID),
  );
  const withdraw = withdrawResponse.status;
  const withdrawBody = await withdrawResponse.json();
  const linksAfterRefusedWithdraw = await storedLinkCount();
  const disclosureAfterRefusedWithdraw = await storedDisclosure();

  /*
   * 5: THE OUT-OF-BAND WRITE, and the one fixture in this file that does not
   * go through a route. It is here because the phases below are about the
   * BACKSTOPS, and after phase 4 the API can no longer produce the state they
   * exist to catch. That state is still reachable: a raw statement, a future
   * importer, a row that predates the gate, or — the one that is reachable
   * today — a link attached concurrently with a withdrawal, which neither
   * read excludes, because `@prisma/adapter-libsql` opens SQLite transactions
   * as `deferred` (see `recordTriageFacts`'s own note on the same limit).
   *
   * It writes exactly what a successful withdrawal would have written, which
   * is what makes the phases below a regression of the recorded sequence
   * rather than of some other row.
   */
  await prisma.mediaAdvertisingDisclosure.update({
    where: { mediaId: MEDIA_ID },
    data: { benefitReceived: false, label: null, benefitSourceId: null },
  });

  // 6: the re-publish that used to be entirely ungated.
  const republishResponse = await PUBLISH(publishRequest(), context(MEDIA_ID));
  const republish = republishResponse.status;
  const republishBody = await republishResponse.json();
  const { publishedAt: publishedAtAtEnd } =
    await prisma.media.findUniqueOrThrow({
      where: { id: MEDIA_ID },
      select: { publishedAt: true },
    });

  // 7-8: what the two public layers serve for that row, which is still
  // published — the publish refusal above does not unpublish, and nothing in
  // this product does (ugcportal-qnq9.5 / ugcportal-rh9q own that question).
  //
  // `-1` for "the surface did not return this item at all", which is NOT the
  // same answer as "it returned it with no links" and must not be allowed to
  // pass as one: a `0` from a feed that silently dropped the row would make
  // the two assertions below hold for a reason that is not the gate.
  const row = await anonymousRow();
  const feed = await listPublicMedia(publicMediaListingUrl());

  recorded = {
    disclose,
    attach,
    publish,
    withdraw,
    withdrawBody,
    linksAfterRefusedWithdraw,
    disclosureAfterRefusedWithdraw,
    republish,
    republishBody,
    publishedAtAtEnd,
    rawRelationCount: row.commercialLinks.length,
    galleryLinkCount: toGalleryItem(row)?.commercialLinks.length ?? -1,
    feedLinkCount: feed.ok
      ? (feed.page.items.find((item) => item.id === MEDIA_ID)?.commercialLinks
          .length ?? -1)
      : -1,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-jain: the compliant state the sequence starts from", () => {
  it("records the benefit, attaches the link and publishes", () => {
    // THE SUCCESS COMES FIRST, for the reason the § 9-2 guardrail gives for
    // its own: without it, every refusal asserted below would hold just as
    // well for a product that refused everything.
    expect({
      disclose: recorded.disclose,
      attach: recorded.attach,
      publish: recorded.publish,
    }).toEqual({ disclose: 200, attach: 201, publish: 200 });
  });
});

describe("ugcportal-jain K1: the withdrawal that used to answer 200", () => {
  it("is refused with a named blocker", () => {
    expect(recorded.withdraw).toBe(409);
    expect(recorded.withdrawBody.blocker).toBe("commercial_links_attached");
    // No `field`: there is no edit to `{"benefitReceived": false}` that would
    // make it succeed, and the message names the request that would.
    expect(recorded.withdrawBody.field).toBeUndefined();
    expect(recorded.withdrawBody.error).toContain(
      "DELETE /api/media/[id]/commercial-links",
    );
  });

  it("leaves the link attached AND the label standing", () => {
    // Both halves, because a refusal that answered 409 while still clearing
    // the label would pass a status-only assertion and leave exactly the row
    // this bead is about. The recorded measurement was "count stays 1" for
    // the opposite reason — the route touched no link row because it refused
    // nothing — so the count alone does not distinguish the fix from the bug.
    expect(recorded.linksAfterRefusedWithdraw).toBe(1);
    expect(recorded.disclosureAfterRefusedWithdraw).toEqual({
      benefitReceived: true,
      label: LABEL,
    });
  });
});

describe("ugcportal-jain K2: the re-publish that used to be ungated", () => {
  it("is refused, naming the links rather than the label", () => {
    expect(recorded.republish).toBe(400);
    // `commercialLinks`, not `advertisingLabel`: the sibling gate
    // (`advertisingLabelPublishRefusal`) answers null for this row, because
    // it asks only whether a DECLARED benefit is labelled and this row
    // declares none. Asserting the field is what proves the refusal came from
    // the gate this bead added rather than from one that was already there.
    expect(recorded.republishBody.field).toBe("commercialLinks");
    expect(recorded.republishBody.error).toContain(LABEL);
  });

  it("refuses it even though the item is already published", () => {
    // NOT GATED ON `publishedAt === null`, matching the two refusals beside
    // it: a published row in this state was written outside this API and IS
    // in breach, and answering 200 because it already happens to be public
    // would be this route reporting success for a row the site is refusing to
    // show the links of.
    expect(recorded.publishedAtAtEnd).not.toBeNull();
  });
});

describe("ugcportal-jain K3: what the public surfaces serve for that row", () => {
  it("has the link in the relation the anonymous query returns", () => {
    // The premise of the two assertions below, stated rather than assumed:
    // the gate is NOT in the select (it cannot be — see
    // MEDIA_ANONYMOUS_SELECT's own comment), so both of them are about a row
    // that really does carry the link.
    expect(recorded.rawRelationCount).toBe(1);
  });

  it("renders no link on any React surface", () => {
    expect(recorded.galleryLinkCount).toBe(0);
  });

  it("serves no link in the raw public feed JSON either", () => {
    // The second chokepoint, which is not the first: GET /api/public/media
    // serialises `listPublicMedia`'s own result and never calls
    // `toGalleryItem` at all, so neither of these two assertions stands in
    // for the other.
    expect(recorded.feedLinkCount).toBe(0);
  });
});
