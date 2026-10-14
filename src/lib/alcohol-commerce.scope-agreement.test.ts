import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MediaAuthorship } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-pgpq: THE TWO EXPRESSIONS OF THE § 9-2 PAIR, CHECKED AGAINST EACH
 * OTHER ON A REAL DATABASE.
 *
 * `isAlcoholUnclearedAdvertisement` (TypeScript, one row at a time, read by
 * `commercialPublishRefusal`) decides a PUBLISH REQUEST, and is one of the two
 * reasons `isWithheldFromPublicRead` withholds a row (the other is a recorded
 * `true`, ugcportal-qnq9.11). `PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE` (a Prisma
 * `where`, spread into `PUBLIC_MEDIA_RIGHTS_SCOPE` and so into
 * `PUBLIC_MEDIA_SCOPE`) decides what every anonymous surface SERVES, and is
 * the complement of `isWithheldFromPublicRead`, not of the narrower predicate.
 * The where and `isWithheldFromPublicRead` have to agree, and
 * nothing in either file makes them: they are written in different languages
 * against different engines, and the way they come apart is silent in exactly
 * the dangerous direction — a row the publish gate refuses, sitting on the
 * public site because the where-clause was written one condition short.
 *
 * THIS FILE IS HERE BECAUSE ugcportal-0epl SAYS IT HAS TO BE. That bead
 * records that the publishability rule is already expressed twice, that two
 * of its checks are not expressible as a Prisma filter at all, and that the
 * SQL side is therefore looser in exactly those two ways. Adding a third
 * silently-divergent expression of a legal-consequence rule is the failure
 * mode it is about. So the § 9-2 pair is expressed in both places and PINNED
 * HERE, in the same shape src/lib/publishability.scope-agreement.test.ts
 * already uses for the rule next door: one row per state, both sides asked,
 * compared row by row, with the deliberate disagreements enumerated rather
 * than excluded.
 *
 * EVERY ROW SATISFIES THE REST OF THE SCOPE — the three not-null columns, a
 * current attestation by the uploader, nobody identifiable in the frame — so
 * the only thing that can decide a row's visibility below is the § 9-2 arm.
 */

vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the anonymous scope must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { PUBLIC_MEDIA_SCOPE } = await import("@/lib/public-media");
const { commercialPublishRefusal, isWithheldFromPublicRead } = await import(
  "@/lib/alcohol-commerce"
);

const OWNER = "owner-scope-pgpq";

/** The brand a case names, or none. `null` is a brand nobody has looked up. */
type Brand = "clean" | "alcohol-linked" | "unchecked";

const BRANDS: Record<Brand, { slug: string; alcoholLinked: boolean | null }> = {
  clean: { slug: "riedel", alcoholLinked: false },
  "alcohol-linked": { slug: "vinmonopolet", alcoholLinked: true },
  unchecked: { slug: "brand-nobody-checked", alcoholLinked: null },
};

/**
 * Each brand's generated id, filled in by `beforeAll`.
 *
 * Needed because every create in this file names `mediaId` as a scalar,
 * which puts Prisma in its unchecked-create form — a nested
 * `benefitSource: { connect: … }` is not accepted alongside it, so the
 * foreign key is written directly.
 */
const brandIds: Record<Brand, string> = {
  clean: "",
  "alcohol-linked": "",
  unchecked: "",
};

type Case = {
  /** The Media row's id, and the case's name in every message below. */
  id: string;
  /** What the case is, in one line — printed when the comparison fails. */
  what: string;
  /**
   * The disclosure row, or `"none"` for an item nobody has declared anything
   * about. `benefitReceived: null` is a row that exists with the question
   * unanswered; `false` is a withdrawn declaration, which is the state
   * ugcportal-jain found still carrying live links.
   */
  disclosure: "none" | { benefitReceived: boolean | null; brand?: Brand };
  /** How many commercial links are attached. */
  links: number;
  /** `undefined` writes no MediaListing at all: every untriaged upload. */
  depictsAlcohol?: boolean | null;
};

/**
 * The states where the PREDICATE refuses and the FILTER serves, with the
 * reason and the compensating control. Keyed by case id; the value is the
 * `field` the predicate's refusal names.
 *
 * BOTH ARE THE BRAND HALF, and both are a recorded decision rather than a
 * limit of SQL — which makes this list different in kind from
 * `SQL_CANNOT_EXPRESS` in publishability.scope-agreement.test.ts.
 * `commercialPublishRefusal` refuses a benefit from an alcohol-linked or
 * unchecked brand; the read-side filter deliberately does not, because
 * ugcportal-mqh8 decided that an item ALREADY published under a brand later
 * recorded as alcohol-linked is listed for the admin and NOT auto-unpublished
 * (src/app/admin/settings/rights/brands/page.tsx, and that screen's whole
 * reason for existing). A filter that caught these two would overturn that
 * decision silently, from the other side, and would empty the public site of
 * every labelled item whose brand nobody had got round to checking.
 *
 * Expressible as a `where`, for the record — `advertisingDisclosure: { is: {
 * benefitSource: { is: { alcoholLinked: false } } } }` — so this is a choice,
 * not an incapacity. See docs/legal/alcohol-commerce-public-visibility.md.
 */
const DECIDED_NOT_TO_FILTER: Record<string, string> = {
  "benefit-from-alcohol-brand": "benefitSource",
  "benefit-from-unchecked-brand": "benefitSource",
};

const CASES: Case[] = [
  {
    id: "nothing-commercial-untriaged",
    what: "the ordinary upload: nothing declared, nothing attached, never triaged",
    disclosure: "none",
    links: 0,
  },
  {
    id: "nothing-commercial-answered-no",
    what: "triaged, free of alcohol, and carrying nothing commercial",
    disclosure: "none",
    links: 0,
    depictsAlcohol: false,
  },
  {
    id: "nothing-commercial-shows-alcohol",
    what: "a glass of wine as personal content, nothing commercial: withheld since ugcportal-qnq9.11 (option (a)), by both sides",
    disclosure: "none",
    links: 0,
    depictsAlcohol: true,
  },
  {
    id: "nothing-commercial-unanswered",
    what: "a listing exists with the alcohol question unanswered, nothing commercial",
    disclosure: "none",
    links: 0,
    depictsAlcohol: null,
  },
  {
    id: "withdrawn-disclosure-untriaged",
    what: "a disclosure row that declares no benefit, on an untriaged item",
    disclosure: { benefitReceived: false },
    links: 0,
  },
  {
    id: "unanswered-disclosure-untriaged",
    what: "a disclosure row whose benefit question is itself unanswered",
    disclosure: { benefitReceived: null },
    links: 0,
  },
  {
    id: "benefit-untriaged",
    what: "THE BEAD: a declared benefit on an item nobody has triaged",
    disclosure: { benefitReceived: true, brand: "clean" },
    links: 0,
  },
  {
    id: "benefit-unanswered",
    what: "a declared benefit beside a listing whose alcohol answer is null",
    disclosure: { benefitReceived: true, brand: "clean" },
    links: 0,
    depictsAlcohol: null,
  },
  {
    id: "benefit-shows-alcohol",
    what: "a declared benefit on a picture recorded as showing the drink",
    disclosure: { benefitReceived: true, brand: "clean" },
    links: 0,
    depictsAlcohol: true,
  },
  {
    id: "benefit-answered-no",
    what: "the lawful advertisement: a benefit, a clean brand, alcohol answered no",
    disclosure: { benefitReceived: true, brand: "clean" },
    links: 0,
    depictsAlcohol: false,
  },
  {
    id: "link-untriaged",
    what: "ugcportal-jain's row: the benefit withdrawn, the link still live, untriaged",
    disclosure: { benefitReceived: false },
    links: 1,
  },
  {
    id: "link-unanswered",
    what: "the same, beside a listing whose alcohol answer is null",
    disclosure: { benefitReceived: null },
    links: 1,
    depictsAlcohol: null,
  },
  {
    id: "link-shows-alcohol",
    what: "a live affiliate link under a photograph of a drink",
    disclosure: { benefitReceived: false },
    links: 1,
    depictsAlcohol: true,
  },
  {
    id: "link-answered-no",
    what: "a live affiliate link on a picture recorded as free of alcohol",
    disclosure: { benefitReceived: false },
    links: 1,
    depictsAlcohol: false,
  },
  {
    id: "benefit-and-link-untriaged",
    what: "both halves at once, on the untriaged item — the reproduced defect",
    disclosure: { benefitReceived: true, brand: "clean" },
    links: 1,
  },
  {
    id: "benefit-and-link-answered-no",
    what: "both halves at once, answered no: the fully lawful advertisement",
    disclosure: { benefitReceived: true, brand: "clean" },
    links: 1,
    depictsAlcohol: false,
  },
  {
    id: "two-links-untriaged",
    what: "more than one link, so the count is not read as a boolean by accident",
    disclosure: { benefitReceived: true, brand: "clean" },
    links: 2,
  },
  {
    id: "benefit-from-alcohol-brand",
    what: "a clean picture paid for by a wine importer (the mqh8 case)",
    disclosure: { benefitReceived: true, brand: "alcohol-linked" },
    links: 0,
    depictsAlcohol: false,
  },
  {
    id: "benefit-from-unchecked-brand",
    what: "a clean picture from a brand nobody looked up",
    disclosure: { benefitReceived: true, brand: "unchecked" },
    links: 0,
    depictsAlcohol: false,
  },
];

async function seed(testCase: Case): Promise<void> {
  const { id } = testCase;

  await prisma.media.create({
    data: {
      id,
      userId: OWNER,
      kind: "IMAGE",
      key: `media/${OWNER}/${id}.jpg`,
      previewKey: `previews/${OWNER}/${id}.webp`,
      previewId: `pv-${id}`,
      mimeType: "image/jpeg",
      sizeBytes: 4096,
      originalName: `${id}.jpg`,
      altText: `Alt text for ${id}`,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      publishedAt: new Date("2026-03-02T00:00:00.000Z"),
    },
  });

  await prisma.mediaAttestation.create({
    data: {
      mediaId: id,
      attestedByUserId: OWNER,
      attestationVersion: CURRENT_ATTESTATION_VERSION,
      authorship: MediaAuthorship.AUTHOR,
      ownOriginalNotFromWeb: true,
      showsIdentifiablePeople: false,
      showsMinors: false,
      containsMusicNotOwned: false,
      otherCreativeContributor: false,
      brandOrSponsorship: true,
      aiGenerated: false,
      uploaderIsAdult: true,
    },
  });

  if (testCase.depictsAlcohol !== undefined) {
    await prisma.mediaListing.create({
      data: {
        mediaId: id,
        depictsPeople: false,
        depictsMinors: false,
        containsMusic: false,
        thirdPartyCreator: false,
        sponsoredContent: false,
        depictsAlcohol: testCase.depictsAlcohol,
        wineAccessory: true,
        triagedByUserId: OWNER,
        triagedAt: new Date("2026-03-01T12:00:00.000Z"),
      },
    });
  }

  if (testCase.disclosure !== "none") {
    const brand = testCase.disclosure.brand;
    await prisma.mediaAdvertisingDisclosure.create({
      data: {
        mediaId: id,
        benefitReceived: testCase.disclosure.benefitReceived,
        ...(brand
          ? {
              benefitKind: "FREE_PRODUCT",
              marketValueOre: 49900,
              label: "Advertisement / Reklame",
              benefitSourceId: brandIds[brand],
            }
          : {}),
      },
    });
  }

  for (let index = 0; index < testCase.links; index += 1) {
    await prisma.commercialLink.create({
      data: {
        mediaId: id,
        // The item's own id in the destination, so a row this file finds is
        // traceable back to the case that made it rather than being one of
        // twenty identical URLs.
        url: `https://track.adtraction.com/t/t?a=1234&m=${id}-${index}`,
        network: "ADTRACTION",
        // The LINK's brand, which the schema keeps separate from the
        // disclosure's because the two can differ. Always clean here: the
        // link brand is checked at the attach (`benefitAttachmentRefusal`)
        // and is not part of either expression being compared.
        benefitSourceId: brandIds.clean,
      },
    });
  }
}

/**
 * What the TypeScript predicate says about one seeded row.
 *
 * READ THROUGH `commercialPublishRefusal`, the function the publish route
 * actually calls, rather than through `isAlcoholUnclearedAdvertisement`
 * directly — otherwise the brand half would be absent from this comparison
 * and the two enumerated disagreements below could not be stated at all. The
 * projection mirrors what that route selects.
 */
async function predicateRow(id: string) {
  return prisma.media.findUniqueOrThrow({
    where: { id },
    select: {
      advertisingDisclosure: {
        select: {
          benefitReceived: true,
          benefitSource: { select: { alcoholLinked: true } },
        },
      },
      listing: { select: { depictsAlcohol: true } },
      _count: { select: { commercialLinks: true } },
    },
  });
}

async function predicateRefusalField(id: string): Promise<string | null> {
  const row = await predicateRow(id);
  const refusal = commercialPublishRefusal({
    disclosure: row.advertisingDisclosure,
    listing: row.listing,
    commercialLinks: { commercialLinkCount: row._count.commercialLinks },
  });
  return refusal?.field ?? null;
}

/**
 * What the READ arm's predicate twin says (ugcportal-qnq9.11): withheld when
 * the publish gate refuses, OR when the item is recorded as showing alcohol
 * whatever is attached. `commercialPublishRefusal` alone cannot say the second
 * half - it returns null for an item with nothing commercial on it - so the
 * comparison below asks both and ORs them.
 */
async function predicateWithholds(id: string): Promise<boolean> {
  const row = await predicateRow(id);
  return (
    (await predicateRefusalField(id)) !== null ||
    isWithheldFromPublicRead({
      disclosure: row.advertisingDisclosure,
      listing: row.listing,
      commercialLinks: { commercialLinkCount: row._count.commercialLinks },
    })
  );
}

let visibleIds: Set<string>;

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: OWNER, email: "owner-scope-pgpq@example.com", role: "USER" },
  });
  for (const [name, brand] of Object.entries(BRANDS) as [
    Brand,
    (typeof BRANDS)[Brand],
  ][]) {
    const row = await prisma.benefitSource.create({
      data: {
        slug: brand.slug,
        name,
        alcoholLinked: brand.alcoholLinked,
        alcoholAnsweredAt: brand.alcoholLinked === null ? null : new Date(),
      },
    });
    brandIds[name] = row.id;
  }

  for (const testCase of CASES) {
    await seed(testCase);
  }

  const rows = await prisma.media.findMany({
    where: PUBLIC_MEDIA_SCOPE,
    select: { id: true },
  });
  visibleIds = new Set(rows.map((row) => row.id));
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("the § 9-2 predicate and PUBLIC_MEDIA_SCOPE agree, row by row (ugcportal-pgpq, ugcportal-0epl)", () => {
  it("exercises both outcomes, so the comparison below cannot pass vacuously", async () => {
    // A seed that produced all-visible or all-hidden rows would make every
    // `expect` in this file agree with a scope that filtered on nothing, or
    // on everything.
    const withheld = await Promise.all(
      CASES.map((testCase) => predicateWithholds(testCase.id)),
    );
    expect(withheld.filter((w) => !w).length).toBeGreaterThan(3);
    expect(withheld.filter((w) => w).length).toBeGreaterThan(3);
    expect(visibleIds.size).toBeGreaterThan(3);
    expect(visibleIds.size).toBeLessThan(CASES.length);
  });

  for (const testCase of CASES) {
    if (DECIDED_NOT_TO_FILTER[testCase.id]) continue;

    it(`${testCase.id}: ${testCase.what}`, async () => {
      const withheld = await predicateWithholds(testCase.id);
      expect(visibleIds.has(testCase.id), `${testCase.id}`).toBe(!withheld);
    });
  }
});

describe("the one half deliberately left out of the filter (ugcportal-mqh8)", () => {
  it("names exactly two cases, and the comparison above covers everything else", () => {
    // The exception list is itself the thing most likely to rot: a third
    // entry added to quiet a failing comparison is how a gap gets
    // normalised. Changing this list is a deliberate act.
    expect(Object.keys(DECIDED_NOT_TO_FILTER).sort()).toEqual([
      "benefit-from-alcohol-brand",
      "benefit-from-unchecked-brand",
    ]);
    for (const id of Object.keys(DECIDED_NOT_TO_FILTER)) {
      expect(CASES.map((testCase) => testCase.id)).toContain(id);
    }
  });

  for (const [id, field] of Object.entries(DECIDED_NOT_TO_FILTER)) {
    it(`${id}: the publish gate refuses it (${field}); the read filter serves it`, async () => {
      // Both halves asserted, so a change in EITHER direction fails: the
      // gate quietly stopping refusing it, or the filter quietly starting to
      // catch it — which would be ugcportal-mqh8's decision being reversed,
      // and should be noticed rather than absorbed.
      expect(await predicateRefusalField(id)).toBe(field);
      expect(visibleIds.has(id)).toBe(true);
    });
  }
});

describe("the filter is a conjunction: not recorded true, AND (answered no OR nothing commercial) (ugcportal-qnq9.11)", () => {
  it("withholds an alcohol-recorded row with nothing commercial, and serves the same row once the answer is `no` or `null`", async () => {
    /*
     * REWRITTEN, NOT DELETED. This case used to assert that the same row was
     * SERVED with nothing commercial and hidden once a link arrived: the proof
     * that the "nothing commercial" arm was alive. Under option (a) a recorded
     * `true` is withheld with or without a link, so that proof moves to
     * `null` and `false`, which are the states the arm still carries, and the
     * recorded `true` is asserted withheld on both sides of the link.
     *
     * THE ARM THAT IS STILL EASY TO LOSE: a filter written as the single
     * condition `depictsAlcohol: false` would pass every refusing case in this
     * file and empty the site of every untriaged photograph.
     */
    const id = "nothing-commercial-shows-alcohol";
    expect(visibleIds.has(id)).toBe(false);
    const served = async () =>
      (await prisma.media.count({ where: { id, ...PUBLIC_MEDIA_SCOPE } })) === 1;
    expect(await served()).toBe(false);
    expect(await predicateWithholds(id)).toBe(true);

    const link = await prisma.commercialLink.create({
      data: {
        mediaId: id,
        url: `https://track.adtraction.com/t/t?a=1234&m=${id}-arm`,
        network: "ADTRACTION",
        benefitSourceId: brandIds.clean,
      },
    });
    expect(await served()).toBe(false);
    await prisma.commercialLink.delete({ where: { id: link.id } });

    for (const depictsAlcohol of [null, false]) {
      await prisma.mediaListing.update({
        where: { mediaId: id },
        data: { depictsAlcohol },
      });
      expect(await served(), `depictsAlcohol ${depictsAlcohol}`).toBe(true);
      expect(await predicateWithholds(id)).toBe(false);
    }

    // Put it back, so `visibleIds` (taken once in `beforeAll`) still
    // describes the database the cases above were compared against.
    await prisma.mediaListing.update({
      where: { mediaId: id },
      data: { depictsAlcohol: true },
    });
    expect(await served()).toBe(false);
  });
});
