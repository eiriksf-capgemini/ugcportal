import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { toGalleryItem } from "@/lib/gallery-items";
import { completeAttestationRow } from "@/lib/test-support/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { FIXTURE_CLEARANCE_SCOPE } from "@/lib/test-support/resale-rights";

/**
 * ugcportal-qnq9.3 K6, the guardrail: this site must never serve a price, a
 * buy affordance, an affiliate link, a discount code, a sponsorship label or
 * a recorded gift on an image in which alcohol is visible or clearly evoked,
 * or from a brand that also sells alcohol. alkoholloven § 9-2,
 * administratively finable since 13 September 2024.
 *
 * HOW THIS IS BUILT, AND WHY IT MATTERS. The criterion asks for a test
 * enumerating every published row in a seeded database. A test that SEEDS the
 * offending rows directly and then asserts they are absent would be asserting
 * something about its own fixtures — the enumeration would pass because the
 * test chose not to insert anything bad.
 *
 * So the database here is built by DRIVING THE REAL WRITE PATHS: the
 * disclosure route, the commercial-links attach route, the curation price
 * route and the publish route, each called the way an operator would call it,
 * once per item. Every item in the
 * plan below has something attached that the law cares about, and the
 * enumeration in the second describe reads whatever the product actually let
 * through. If a refusal is ever weakened, the offending row appears in the
 * real table and the sweep fails — which is the only arrangement under which
 * it is evidence of anything.
 *
 * WHAT "COMMERCIAL AFFORDANCE" MEANS HERE, concretely, because the bead names
 * six and the schema can now express four: a price
 * (`MediaListing.priceCents`), an offered listing (the sellability gate,
 * which the price route evaluates), a recorded benefit with its advertising
 * label (`MediaAdvertisingDisclosure`), and — since ugcportal-qnq9.2.1 — a
 * commercial outbound link (`CommercialLink`). The sweep is written as "any
 * affordance implies a clean record" rather than as a list of forbidden rows
 * precisely so that a new affordance has to satisfy it, and the fourth is
 * what tested whether that worked: adding it meant one more request per item
 * in the loop below and two more reads in the sweep, and no rewrite of either
 * assertion. What is NOT here is the per-link marker and the all-surfaces
 * render sweep — that is ugcportal-qnq9.2.2, which owns what a page looks
 * like rather than what the table holds.
 *
 * TWO ORDERS, NOT ONE, SINCE ugcportal-pgpq. The loop below publishes each
 * item LAST, which is the order the publish gate can see. The other order —
 * publish an untriaged item first, then declare a benefit and attach a link
 * to a row that is already public — reaches the forbidden pair through three
 * requests none of which runs that gate, and is driven by
 * `drivePublishFirst` after the loop. That is also why the depiction half of
 * the sweep enumerates `PUBLIC_MEDIA_SCOPE` rather than `publishedAt`: under
 * that bead's decision the row stays published and stops being served, so
 * "published" and "the public can see it" are no longer the same set. See
 * docs/legal/alcohol-commerce-public-visibility.md.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const { PUT: DISCLOSE } = await import(
  "@/app/api/media/[id]/disclosure/route"
);
const { POST: PUBLISH } = await import("@/app/api/media/[id]/publish/route");
const { POST: SET_PRICE } = await import(
  "@/app/api/admin/curation/[id]/price/route"
);
const { POST: ATTACH_LINK } = await import(
  "@/app/api/media/[id]/commercial-links/route"
);
const { CURRENT_CHECKLIST_VERSION } = await import("@/lib/resale-rights");
// Dynamic, like every other import in this block: `media-access.ts` imports
// `@/lib/auth` at module scope, and a STATIC import of it above (before
// `authMock` is assigned) throws "Cannot access 'authMock' before
// initialization" — vitest hoists `vi.mock` above the imports, so the
// static import's own module evaluation would call the mock factory while
// `authMock` is still in its temporal dead zone.
const { MEDIA_ANONYMOUS_SELECT } = await import("@/lib/media-access");
// The anonymous read scope (ugcportal-pgpq). Dynamic for the same reason as
// every other import in this block.
const { PUBLIC_MEDIA_SCOPE } = await import("@/lib/public-media");

/**
 * The operator, who is both the owner of every item and the admin who prices
 * them — which is what this product actually is (docs/ugc-research.md
 * Decisions table: a two-person hobby, only the operators' own content). Using
 * one account means no case here passes because a second account happened to
 * lack a permission.
 */
const OPERATOR = "operator-k6";

type ItemPlan = {
  id: string;
  /** What the picture is, for the failure message. */
  what: string;
  /** The alcohol triage answer, or "none" for an item with no listing row. */
  depictsAlcohol: boolean | null | "none";
  wineAccessory: boolean | null;
  /** The brand's recorded answer before the request, or "none" for a brand
   * this test never records — the first-contact case. */
  brand: { name: string; alcoholLinked: boolean | null } | "none";
  /** The answer the disclosure request submits, if any. */
  submitAnswer?: boolean;
};

/**
 * Six items, covering every refusing state of both inputs plus the one
 * passing combination.
 *
 * Only `accessory` should end up published with anything commercial on it.
 * That single success is what keeps the enumeration from passing against a
 * product that refuses everything.
 */
const PLAN: ItemPlan[] = [
  {
    id: "accessory",
    what: "an empty wine glass from a glassmaker (K1)",
    depictsAlcohol: false,
    wineAccessory: true,
    brand: { name: "Riedel", alcoholLinked: null },
    submitAnswer: false,
  },
  {
    id: "full-glass",
    what: "a glass of wine, shot as wine",
    depictsAlcohol: true,
    wineAccessory: false,
    brand: { name: "Riedel", alcoholLinked: null },
    submitAnswer: false,
  },
  {
    id: "cooler-with-bottles",
    what: "a cooler with labelled bottles on the shelf: accessory AND alcohol",
    depictsAlcohol: true,
    wineAccessory: true,
    brand: { name: "Riedel", alcoholLinked: null },
    submitAnswer: false,
  },
  {
    id: "untriaged",
    what: "a photograph nobody has triaged at all",
    depictsAlcohol: "none",
    wineAccessory: null,
    brand: { name: "Riedel", alcoholLinked: null },
    submitAnswer: false,
  },
  {
    id: "alcohol-brand",
    what: "a clean picture, paid for by a wine importer",
    depictsAlcohol: false,
    wineAccessory: false,
    brand: { name: "Vinmonopolet", alcoholLinked: true },
    submitAnswer: false,
  },
  {
    id: "unchecked-brand",
    what: "a clean picture from a brand nobody looked up",
    depictsAlcohol: false,
    wineAccessory: false,
    brand: "none",
  },
];

function disclosureRequest(id: string, body: unknown) {
  return new Request(`http://localhost/api/media/${id}/disclosure`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function publishRequest(id: string) {
  return new Request(`http://localhost/api/media/${id}/publish`, {
    method: "POST",
  });
}

function priceRequest(listingId: string) {
  return new Request(
    `http://localhost/api/admin/curation/${listingId}/price`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ priceCents: 24900, currency: "NOK" }),
    },
  );
}

/**
 * The attach request for one item (ugcportal-qnq9.2.1), which is the fourth
 * commercial affordance this sweep has to cover.
 *
 * ONE DESTINATION PER ITEM, carrying the item's id in the `m=` parameter, so
 * that a row the sweep below finds can be traced back to the request that
 * made it instead of being one of six identical URLs. The brand is the SAME
 * brand the item's disclosure names, so a refusal here is about the item's own
 * facts rather than about a brand this test invented separately.
 */
function commercialLinkRequest(id: string, brand: string) {
  return new Request(`http://localhost/api/media/${id}/commercial-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `https://track.adtraction.com/t/t?a=1234&m=${id}`,
      network: "ADTRACTION",
      benefitSource: brand,
    }),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

/** What each item's four requests answered, so the cases below can assert on
 * the refusals as well as on the rows. */
const outcomes = new Map<
  string,
  { disclosure: number; price: number; link: number; publish: number }
>();

beforeAll(async () => {
  await applyMigrations(prisma);
  authMock.mockResolvedValue({ user: { id: OPERATOR, role: "ADMIN" } });

  await prisma.user.create({
    data: { id: OPERATOR, email: "operator@example.com", role: "ADMIN" },
  });
  // The uploader-level clearance the price route needs, so a refusal there is
  // never about the person.
  await prisma.resaleRightsReview.create({
    data: {
      uploaderUserId: OPERATOR,
      status: "CLEARED",
      route: "CONTRACT",
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      // ugcportal-aqw: wide enough to cover every upload this fixture seeds.
      // See FIXTURE_CLEARANCE_SCOPE for why that is a far cut-off rather
      // than the framework-licence flag, which would be a claim about a
      // document this fixture does not have.
      ...FIXTURE_CLEARANCE_SCOPE,
      reviewedByUserId: OPERATOR,
      reviewedAt: new Date(),
      productDecisionRef: "ugcportal-2eh",
    },
  });

  for (const item of PLAN) {
    await prisma.media.create({
      data: {
        id: item.id,
        userId: OPERATOR,
        kind: "IMAGE",
        key: `media/${OPERATOR}/${item.id}.png`,
        previewKey: `previews/${OPERATOR}/${item.id}.webp`,
        previewId: `preview-${item.id}`,
        mimeType: "image/png",
        sizeBytes: 1024,
        originalName: `${item.id}.png`,
        altText: item.what,
      },
    });

    // The uploader's own rights attestation (ugcportal-15r), so a refusal at
    // the price route below is never about a missing declaration. Written on
    // every item including the ones with no listing, which keeps the one
    // reason an item is refused the one this file is about.
    await prisma.mediaAttestation.create({
      data: completeAttestationRow(item.id, OPERATOR),
    });

    if (item.depictsAlcohol !== "none") {
      await prisma.mediaListing.create({
        data: {
          id: `listing-${item.id}`,
          mediaId: item.id,
          depictsPeople: false,
          depictsMinors: false,
          containsMusic: false,
          thirdPartyCreator: false,
          sponsoredContent: false,
          depictsAlcohol: item.depictsAlcohol,
          wineAccessory: item.wineAccessory,
          triagedByUserId: OPERATOR,
          triagedAt: new Date(),
        },
      });
    }

    // A brand already on record, where the plan says so. Written straight to
    // the table for the `true` case because no surface in the product records
    // a `yes` — that is deliberate, see the disclosure route's own comment.
    if (item.brand !== "none") {
      await prisma.benefitSource.upsert({
        where: { slug: item.brand.name.toLowerCase() },
        create: {
          slug: item.brand.name.toLowerCase(),
          name: item.brand.name,
          alcoholLinked: item.brand.alcoholLinked,
          alcoholAnsweredAt:
            item.brand.alcoholLinked === null ? null : new Date(),
        },
        update: {},
      });
    }

    const disclosure = await DISCLOSE(
      disclosureRequest(item.id, {
        benefitReceived: true,
        benefitKind: "FREE_PRODUCT",
        benefitSource:
          item.brand === "none" ? "Brand Nobody Checked" : item.brand.name,
        ...(item.submitAnswer === undefined
          ? {}
          : { benefitSourceAlcoholLinked: item.submitAnswer }),
        marketValueOre: 49900,
        label: "Advertisement / Reklame",
      }),
      context(item.id),
    );

    const price =
      item.depictsAlcohol === "none"
        ? // No listing, so there is no price endpoint to call: the id would
          // 404. Recorded as a 404 rather than skipped, so the table below
          // has a value for every item.
          404
        : (await SET_PRICE(priceRequest(`listing-${item.id}`), context(`listing-${item.id}`)))
            .status;

    // AFTER the disclosure and BEFORE the publish, which is the only order
    // that says anything: the attach route requires a declared benefit under
    // a permitted label, so running it first would refuse every item for that
    // reason and tell us nothing about alcohol. Run here, it refuses for the
    // reason each item is in the plan for.
    const link = await ATTACH_LINK(
      commercialLinkRequest(
        item.id,
        item.brand === "none" ? "Brand Nobody Checked" : item.brand.name,
      ),
      context(item.id),
    );

    const publish = await PUBLISH(publishRequest(item.id), context(item.id));

    outcomes.set(item.id, {
      disclosure: disclosure.status,
      price,
      link: link.status,
      publish: publish.status,
    });
  }

  await drivePublishFirst();
});

/**
 * THE SAME THREE ROUTES, IN THE OTHER ORDER (ugcportal-pgpq K3).
 *
 * Every item in `PLAN` above is published LAST, so the publish gate is the
 * last thing that runs and `commercialPublishRefusal` gets to see the
 * finished row. That is one of two orders an owner can use, and it is the
 * only one this file drove before — which is why the forbidden state this
 * file is built to detect was, until ugcportal-pgpq, reachable only by the
 * labelled out-of-band write the enumeration below also covers.
 *
 * Here the publish comes FIRST, on an untriaged item with nothing attached:
 * § 9-2 has nothing to say about it yet, so it is accepted, and the item is
 * public. The benefit and the link then arrive on a row that is already
 * public, through two routes that write no `publishedAt` and read none.
 * Both are accepted too, deliberately — see `benefitAttachmentRefusal`. So
 * the forbidden PAIR is created, in the real table, by three ordinary
 * requests that were each individually correct, and the enumeration below
 * has something real to find.
 *
 * NO LISTING AT ALL on this item, which is the common case: `depictsAlcohol`
 * is not merely unanswered, there is no row for the answer to live in.
 */
const PUBLISH_FIRST_ID = "publish-first";

async function drivePublishFirst(): Promise<void> {
  await prisma.media.create({
    data: {
      id: PUBLISH_FIRST_ID,
      userId: OPERATOR,
      kind: "IMAGE",
      key: `media/${OPERATOR}/${PUBLISH_FIRST_ID}.png`,
      previewKey: `previews/${OPERATOR}/${PUBLISH_FIRST_ID}.webp`,
      previewId: `preview-${PUBLISH_FIRST_ID}`,
      mimeType: "image/png",
      sizeBytes: 1024,
      originalName: `${PUBLISH_FIRST_ID}.png`,
      altText: "a decanter nobody has triaged, published before anything was attached",
    },
  });
  await prisma.mediaAttestation.create({
    data: completeAttestationRow(PUBLISH_FIRST_ID, OPERATOR),
  });

  const publish = await PUBLISH(
    publishRequest(PUBLISH_FIRST_ID),
    context(PUBLISH_FIRST_ID),
  );
  const disclosure = await DISCLOSE(
    disclosureRequest(PUBLISH_FIRST_ID, {
      benefitReceived: true,
      benefitKind: "FREE_PRODUCT",
      // Riedel, already recorded as not alcohol-linked by the loop above, so
      // this item is refused for the DEPICTION half of §9-2 or not at all.
      benefitSource: "Riedel",
      marketValueOre: 49900,
      label: "Advertisement / Reklame",
    }),
    context(PUBLISH_FIRST_ID),
  );
  const link = await ATTACH_LINK(
    commercialLinkRequest(PUBLISH_FIRST_ID, "Riedel"),
    context(PUBLISH_FIRST_ID),
  );

  outcomes.set(PUBLISH_FIRST_ID, {
    disclosure: disclosure.status,
    // No listing, so there is no price endpoint to call — recorded as a 404
    // for the same reason the `untriaged` item in the plan above is.
    price: 404,
    link: link.status,
    publish: publish.status,
  });
}

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("ugcportal-qnq9.3 K6: what the real write paths let through", () => {
  it("publishes the accessory with its price and its label (K1)", () => {
    // THE ONE SUCCESS, and it has to come first: without it every absence
    // asserted below would also hold for a product that refused everything,
    // which is precisely the product the bead was rewritten to stop building.
    expect(outcomes.get("accessory")).toEqual({
      disclosure: 200,
      price: 200,
      link: 201,
      publish: 200,
    });
  });

  it.each([
    ["full-glass", "the picture shows the drink"],
    ["cooler-with-bottles", "an accessory answer does not rescue it"],
  ])("refuses every affordance on %s, because %s", (id) => {
    const outcome = outcomes.get(id);
    expect(outcome?.disclosure).toBe(400);
    // 422 from the price route: well-formed, authorized, refused by the row's
    // own state — the shape that endpoint already uses for a blocked gate.
    expect(outcome?.price).toBe(422);
    // And the commercial link. A STATUS ONLY, so this does not distinguish
    // which of the attach route's two gates produced it — § 9-2 refuses this
    // item, and so does the missing disclosure the refusal above left behind.
    // That discrimination is commercial-links/route.test.ts's job, where each
    // refusal is asserted by `field` against a seeded disclosure; what this
    // file adds is that the refusal held in a database built by real requests.
    expect(outcome?.link).toBe(400);
  });

  it.each([
    ["alcohol-brand", 400],
    ["unchecked-brand", 400],
  ])("refuses the benefit on %s", (id, status) => {
    // K4 through the real route, in both its refusing states. The price is
    // NOT refused for these two, and that is correct: the picture is clean,
    // so the item is sellable — what it may not carry is a benefit from that
    // brand, or a published advertising label.
    expect(outcomes.get(id)?.disclosure).toBe(status);
    expect(outcomes.get(id)?.price).toBe(200);
    // The link is refused too. Again a status only, for the reason given in
    // the case above: both of the attach route's gates refuse these two
    // items, and the per-gate discrimination lives in that route's own test.
    expect(outcomes.get(id)?.link).toBe(400);
  });

  it("records the untriaged item's benefit but will not publish it", () => {
    // The deliberate asymmetry, end to end: the honest declaration is stored
    // because the label is itself a legal requirement, and the public page is
    // refused because nobody has answered the alcohol question.
    expect(outcomes.get("untriaged")).toEqual({
      disclosure: 200,
      price: 404,
      // The link is attached, and by the same asymmetry: the attach gate
      // reads the alcohol question permissively, and the publish gate is what
      // refuses. An untriaged item can therefore hold a commercial link and
      // cannot show it to anybody — which is what the `publish: 400` on the
      // next line is, and what keeps this row out of the published sweep
      // below.
      link: 201,
      publish: 400,
    });
  });
});

describe("ugcportal-qnq9.3 K6: every published row, and every row the public can reach (ugcportal-pgpq)", () => {
  /**
   * Every published item, with everything about it the law cares about.
   *
   * Read back through Prisma rather than tracked as the requests went out, so
   * this is the database's own account of what happened.
   */
  async function publishedRows() {
    return prisma.media.findMany({
      where: { publishedAt: { not: null } },
      select: {
        id: true,
        listing: {
          select: { priceCents: true, depictsAlcohol: true, wineAccessory: true },
        },
        advertisingDisclosure: {
          select: {
            benefitReceived: true,
            label: true,
            benefitSource: { select: { name: true, alcoholLinked: true } },
          },
        },
        // The fourth affordance (ugcportal-qnq9.2.1). Each link's own brand is
        // read rather than the disclosure's: CommercialLink carries its own
        // `benefitSourceId` precisely because the two can differ — the glass
        // was gifted by its maker and the link may point at a retailer — so
        // checking the disclosure's brand twice would leave the link's
        // unchecked.
        commercialLinks: {
          select: {
            url: true,
            benefitSource: { select: { name: true, alcoholLinked: true } },
          },
        },
      },
    });
  }

  /**
   * Every row the PUBLIC can actually reach, which since ugcportal-pgpq is
   * not the same set as every row with a `publishedAt`.
   *
   * THE SUBJECT OF THE DEPICTION HALF OF THE SWEEP MOVED HERE, and that is
   * this bead's decision rather than a weakening. `publishedAt` stopped
   * being a proxy for "the public can see it" the moment the § 9-2 pair
   * became a read-side filter: option C leaves the row published and stops
   * serving it. This file's own header states the criterion as what the
   * site may never SERVE, so enumerating `PUBLIC_MEDIA_SCOPE` — the exact
   * `where` every anonymous reader spreads — is closer to that criterion
   * than `publishedAt: { not: null }` ever was. What keeps the move honest
   * is "leaves a published row in the table that the public cannot reach"
   * below, which names the row this changes the answer for and asserts both
   * halves of its state.
   */
  async function servedRows() {
    return prisma.media.findMany({
      where: PUBLIC_MEDIA_SCOPE,
      select: {
        id: true,
        listing: {
          select: { priceCents: true, depictsAlcohol: true, wineAccessory: true },
        },
        advertisingDisclosure: {
          select: {
            benefitReceived: true,
            label: true,
            benefitSource: { select: { name: true, alcoholLinked: true } },
          },
        },
        commercialLinks: {
          select: {
            url: true,
            benefitSource: { select: { name: true, alcoholLinked: true } },
          },
        },
      },
    });
  }

  it("published something, so the sweep below is not vacuous", async () => {
    const rows = await publishedRows();
    expect(rows.map((row) => row.id)).toContain("accessory");
    // And the public can actually reach it, which is what the depiction
    // half of the sweep enumerates.
    expect((await servedRows()).map((row) => row.id)).toContain("accessory");
  });

  it("serves no commercial affordance on alcohol, or on an alcohol brand", async () => {
    // THE GUARDRAIL. For every row the public can reach, if it carries ANY
    // of the commercial affordances this schema can express, then its
    // alcohol answer must be a recorded `no` AND its benefit source must be
    // a recorded not-alcohol-linked brand. Written in that direction —
    // affordance implies clean — rather than as a list of forbidden rows,
    // because that is the direction a new affordance has to satisfy too.
    for (const row of await servedRows()) {
      const disclosure = row.advertisingDisclosure;
      const affordances = [
        row.listing?.priceCents != null && "a price",
        disclosure?.benefitReceived === true && "a recorded benefit",
        disclosure?.label != null && "an advertising label",
        row.commercialLinks.length > 0 && "a commercial link",
      ].filter((value): value is string => typeof value === "string");

      if (affordances.length === 0) continue;

      expect(
        row.listing?.depictsAlcohol,
        `served ${row.id} carries ${affordances.join(" and ")} with the alcohol question answered ${JSON.stringify(row.listing?.depictsAlcohol ?? null)}`,
      ).toBe(false);

      if (disclosure?.benefitReceived === true) {
        expect(
          disclosure.benefitSource?.alcoholLinked,
          `served ${row.id} carries a benefit from ${disclosure.benefitSource?.name ?? "an unnamed brand"}, whose alcohol answer is ${JSON.stringify(disclosure.benefitSource?.alcoholLinked ?? null)}`,
        ).toBe(false);
      }

      for (const link of row.commercialLinks) {
        expect(
          link.benefitSource.alcoholLinked,
          `served ${row.id} links ${link.url}, whose brand ${link.benefitSource.name} has the alcohol answer ${JSON.stringify(link.benefitSource.alcoholLinked)}`,
        ).toBe(false);
      }
    }
  });

  it("carries no commercial affordance from an alcohol-linked or unchecked brand ANYWHERE in the published table", async () => {
    /*
     * The BRAND half, kept over every published row rather than over the
     * served ones, because the read-side filter ugcportal-pgpq added does
     * not judge brands and must not: ugcportal-mqh8 decided that an item
     * already published under a brand later recorded as alcohol-linked is
     * listed for the admin, NOT auto-unpublished. So for this half the
     * write paths are still the whole of the enforcement, and asserting it
     * over the published table is asserting exactly that.
     *
     * Its enumerated counterpart is in
     * src/lib/alcohol-commerce.scope-agreement.test.ts, which seeds the two
     * states this one proves the product never writes and asserts the
     * publish gate refuses each while the read filter serves it.
     */
    for (const row of await publishedRows()) {
      const disclosure = row.advertisingDisclosure;
      if (disclosure?.benefitReceived === true) {
        expect(
          disclosure.benefitSource?.alcoholLinked,
          `published ${row.id} carries a benefit from ${disclosure.benefitSource?.name ?? "an unnamed brand"}, whose alcohol answer is ${JSON.stringify(disclosure.benefitSource?.alcoholLinked ?? null)}`,
        ).toBe(false);
      }
      for (const link of row.commercialLinks) {
        expect(
          link.benefitSource.alcoholLinked,
          `published ${row.id} links ${link.url}, whose brand ${link.benefitSource.name} has the alcohol answer ${JSON.stringify(link.benefitSource.alcoholLinked)}`,
        ).toBe(false);
      }
    }
  });

  it("accepts all three publish-first requests and leaves the row published but unreachable (ugcportal-pgpq K3)", async () => {
    /*
     * The case the sweep above would otherwise pass vacuously for. Three
     * ordinary owner requests, in the order the publish gate cannot see,
     * each answering success — and the resulting row IS the forbidden pair:
     * public, labelled, link-carrying, with § 9-2 unanswered.
     *
     * Both halves are asserted. The table still holds it, untouched, which
     * is option C's promise to the owner and what separates it from
     * depublishing in the transaction. And `PUBLIC_MEDIA_SCOPE` does not
     * return it, which is what makes the sweep above a measurement rather
     * than an artefact of a fixture that never produced the state.
     */
    expect(outcomes.get(PUBLISH_FIRST_ID)).toEqual({
      publish: 200,
      disclosure: 200,
      link: 201,
      price: 404,
    });

    const row = await prisma.media.findUniqueOrThrow({
      where: { id: PUBLISH_FIRST_ID },
      select: {
        publishedAt: true,
        listing: { select: { depictsAlcohol: true } },
        advertisingDisclosure: { select: { label: true } },
        _count: { select: { commercialLinks: true } },
      },
    });
    expect(row.publishedAt).not.toBeNull();
    expect(row.listing).toBeNull();
    expect(row.advertisingDisclosure?.label).toBe("Advertisement / Reklame");
    expect(row._count.commercialLinks).toBe(1);

    expect((await publishedRows()).map((item) => item.id)).toContain(
      PUBLISH_FIRST_ID,
    );
    expect((await servedRows()).map((item) => item.id)).not.toContain(
      PUBLISH_FIRST_ID,
    );
  });

  it("leaves no price, benefit or link anywhere on an item recorded as showing alcohol", async () => {
    // The same claim asked the other way round, and over EVERY row rather
    // than only the published ones — "it is only a draft" is not a reason for
    // a price to sit beside a glass of wine, and a draft is one request away
    // from being public.
    //
    // SCOPED TO A RECORDED `true`, not to "anything other than false", and
    // the difference is this bead's one deliberate asymmetry rather than a
    // gap. An UNTRIAGED item may carry a recorded benefit: the advertising
    // label is itself a legal requirement, so an operator who received a gift
    // has to be able to write it down before anyone has looked at the
    // photograph. `untriaged` in the plan above is exactly that row, and it
    // is why this query reads `depictsAlcohol: true` instead. What the
    // untriaged state may not do is reach the public, which the sweep above
    // covers over published rows and "will not publish it" covers as a
    // refusal.
    const offenders = await prisma.media.findMany({
      where: {
        OR: [
          { listing: { priceCents: { not: null } } },
          { advertisingDisclosure: { benefitReceived: true } },
          { commercialLinks: { some: {} } },
        ],
        listing: { depictsAlcohol: true },
      },
      select: { id: true },
    });

    expect(offenders.map((row) => row.id)).toEqual([]);
  });

  it("has a row that would fail the sweep above if a refusal were weakened", async () => {
    // The mutation, committed as a case. `full-glass` and
    // `cooler-with-bottles` are items the write paths refused, so the query
    // above returns nothing — which it would also do against a database
    // containing no alcohol items at all. These two assertions are what make
    // the empty result a measurement: the rows exist, they are recorded as
    // showing alcohol, and they are empty of every affordance because they
    // were refused rather than because nothing was attempted. The attempts
    // themselves are the 400/422 pairs asserted in the describe above.
    const rows = await prisma.media.findMany({
      where: { listing: { depictsAlcohol: true } },
      select: {
        id: true,
        publishedAt: true,
        listing: { select: { priceCents: true } },
        advertisingDisclosure: { select: { benefitReceived: true } },
        commercialLinks: { select: { url: true } },
      },
    });

    expect(rows.map((row) => row.id).sort()).toEqual([
      "cooler-with-bottles",
      "full-glass",
    ]);
    for (const row of rows) {
      expect(row.listing?.priceCents, `${row.id} has a price`).toBeNull();
      expect(
        row.advertisingDisclosure,
        `${row.id} has a disclosure row`,
      ).toBeNull();
      expect(
        row.commercialLinks,
        `${row.id} has a commercial link`,
      ).toEqual([]);
    }
  });
});

describe("ugcportal-qnq9.2.2 K5: the RENDERER agrees with the table above", () => {
  /**
   * The same enumeration as "every published row in the database" above, one
   * layer further downstream: through `MEDIA_ANONYMOUS_SELECT` and
   * `toGalleryItem` — the exact projection and the exact chokepoint every
   * React-rendered surface (the gallery tile, the lightbox, the portfolio
   * tile, /media/[previewId]) reads through — rather than a direct Prisma
   * query of every column. (The raw `GET /api/public/media` JSON has its own
   * separate chokepoint, `listPublicMedia`, src/lib/public-media.ts, not
   * exercised here.) The K6 guardrail above proves the TABLE never holds a
   * commercial link against an alcohol fact; this proves the RENDERED
   * item agrees, which is a different claim: a bug in `toGalleryItem`'s own
   * gate (K1's "gate on the label", not on alcohol at all) could in
   * principle let a row through unchanged while every assertion above still
   * passes, because those assertions never call it.
   *
   * REUSES THIS FILE'S OWN REGISTRY (the `PLAN` driven in `beforeAll` via
   * the real write paths), not a second fixture — the same "driving the real
   * write paths, not seeding the offending rows directly" discipline this
   * file's own header states, extended to the render layer rather than
   * re-stated for a hand-built database.
   */
  async function renderedPublishedItems() {
    const rows = await prisma.media.findMany({
      where: { publishedAt: { not: null } },
      select: MEDIA_ANONYMOUS_SELECT,
    });
    return rows
      .map((row) => toGalleryItem(row))
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  /** Brand facts per link id, read independently of the renderer (which
   * carries no brand information at all — see GalleryCommercialLink's own
   * comment) so this test can tell whether a rendered link's brand was
   * actually clean rather than merely trusting the renderer withheld it. */
  async function brandAlcoholAnswerByLinkId() {
    const links = await prisma.commercialLink.findMany({
      select: { id: true, benefitSource: { select: { alcoholLinked: true } } },
    });
    return new Map(links.map((link) => [link.id, link.benefitSource.alcoholLinked]));
  }

  it("rendered something, so the sweep below is not vacuous", async () => {
    const items = await renderedPublishedItems();
    expect(items.some((item) => item.id === "accessory")).toBe(true);
    expect(
      items.find((item) => item.id === "accessory")?.commercialLinks,
    ).toHaveLength(1);
  });

  it("never renders a commercial link whose brand is alcohol-linked or unchecked", async () => {
    const items = await renderedPublishedItems();
    const brandAnswers = await brandAlcoholAnswerByLinkId();

    for (const item of items) {
      for (const link of item.commercialLinks) {
        expect(
          brandAnswers.get(link.id),
          `${item.id} renders a commercial link (${link.id}) whose brand's alcohol answer is ${JSON.stringify(brandAnswers.get(link.id) ?? null)}`,
        ).toBe(false);
      }
    }
  });

  it("renders no commercial link at all on an item recorded as showing alcohol", async () => {
    const items = await renderedPublishedItems();
    const alcoholRows = await prisma.media.findMany({
      where: { publishedAt: { not: null }, listing: { depictsAlcohol: true } },
      select: { id: true },
    });
    const alcoholIds = new Set(alcoholRows.map((row) => row.id));

    for (const item of items) {
      if (!alcoholIds.has(item.id)) continue;
      expect(
        item.commercialLinks,
        `${item.id} depicts alcohol and still renders a commercial link`,
      ).toEqual([]);
    }
  });
});
