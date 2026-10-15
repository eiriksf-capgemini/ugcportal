import { describe, expect, it, vi } from "vitest";

import { MediaAuthorship } from "@/generated/prisma/enums";
import { advertisingLabelPublishRefusal } from "@/lib/advertising-disclosure";
import { commercialPublishRefusal } from "@/lib/alcohol-commerce";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import { commercialLinkPublishRefusal } from "@/lib/commercial-link";
import {
  PUBLISH_GATE_DISCLOSURE_SELECT,
  PUBLISH_GATE_LISTING_SELECT,
  isConfiguredUser,
  publishGateRefusal,
  publishGateSources,
  type PublishGateClient,
  type PublishGateDisclosure,
  type PublishGateListing,
  type PublishGateMedia,
  type PublishGateSources,
} from "@/lib/publish-gates";
import {
  PUBLISH_ATTESTATION_SELECT,
  PUBLISH_BLOCKER_MESSAGES,
} from "@/lib/publishability";
import type { GateAttestation } from "@/lib/resale-rights";

/**
 * ugcportal-ho7j K4, at the shared function: each refusal, in the order the
 * manual publish route has always asked them, with that route's status and
 * body — and each source read only once every gate before it has passed.
 *
 * The route-level oracle for the same claim is
 * src/app/api/media/[id]/publish/route.test.ts, whose assertions this bead
 * did not change; this file pins the function both routes now call.
 */

const UPLOADER = "uploader-ho7j";

const PUBLISHABLE_MEDIA: PublishGateMedia = {
  publishedAt: null,
  altText: "A fox crossing a snowy field at dawn",
  previewKey: "previews/uploader-ho7j/preview.webp",
};

const CLEAN_ATTESTATION: GateAttestation = {
  attestedByUserId: UPLOADER,
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

/** A declared benefit whose label is not on the permitted list. */
const UNLABELLED_BENEFIT: PublishGateDisclosure = {
  benefitReceived: true,
  label: "sponsored",
  benefitSource: { alcoholLinked: false },
};

/** A labelled benefit from a brand that sells alcohol (§ 9-2). */
const ALCOHOL_BRAND_BENEFIT: PublishGateDisclosure = {
  benefitReceived: true,
  label: "Advertisement / Reklame",
  benefitSource: { alcoholLinked: true },
};

type Facts = {
  disclosure: PublishGateDisclosure | null;
  commercialLinkCount: number;
  listing: PublishGateListing | null;
  attestation: GateAttestation | null;
  uploaderConfigured: boolean;
};

const CLEAN_FACTS: Facts = {
  disclosure: null,
  commercialLinkCount: 0,
  listing: null,
  attestation: CLEAN_ATTESTATION,
  uploaderConfigured: false,
};

/** Sources over fixed facts, each a spy so the read pattern is assertable. */
function sources(overrides: Partial<Facts> = {}) {
  const facts = { ...CLEAN_FACTS, ...overrides };
  return {
    disclosure: vi.fn(async () => facts.disclosure),
    commercialLinkCount: vi.fn(async () => facts.commercialLinkCount),
    listing: vi.fn(async () => facts.listing),
    attestation: vi.fn(async () => facts.attestation),
    uploaderConfigured: vi.fn(async () => facts.uploaderConfigured),
  } satisfies PublishGateSources;
}

describe("publishGateRefusal: each refusal, with the manual route's status and body", () => {
  it("passes a clean, unpublished row with a preview", async () => {
    expect(
      await publishGateRefusal(PUBLISHABLE_MEDIA, UPLOADER, sources()),
    ).toBeNull();
  });

  it("1. missing alt text on an unpublished row: 400 naming the field", async () => {
    for (const altText of [null, "   "]) {
      expect(
        await publishGateRefusal(
          { ...PUBLISHABLE_MEDIA, altText },
          UPLOADER,
          sources(),
        ),
      ).toEqual({
        status: 400,
        body: { error: "Add alt text before publishing this item.", field: "altText" },
      });
    }
  });

  it("1. ...but not on a row that is already published (transition-only)", async () => {
    expect(
      await publishGateRefusal(
        { ...PUBLISHABLE_MEDIA, altText: null, publishedAt: new Date() },
        UPLOADER,
        sources(),
      ),
    ).toBeNull();
  });

  it("2. an unlabelled advertisement: 400 with the label gate's own body", async () => {
    expect(
      await publishGateRefusal(
        PUBLISHABLE_MEDIA,
        UPLOADER,
        sources({ disclosure: UNLABELLED_BENEFIT }),
      ),
    ).toEqual({
      status: 400,
      body: advertisingLabelPublishRefusal(UNLABELLED_BENEFIT),
    });
  });

  it("3. a commercial link with no label above it: 400 with the link gate's own body", async () => {
    const expected = commercialLinkPublishRefusal(null, { commercialLinkCount: 1 });
    expect(expected).not.toBeNull();
    expect(
      await publishGateRefusal(
        PUBLISHABLE_MEDIA,
        UPLOADER,
        sources({ commercialLinkCount: 1 }),
      ),
    ).toEqual({ status: 400, body: expected });
  });

  it("4. an advertisement from an alcohol brand: 400 with the alcohol gate's own body", async () => {
    const expected = commercialPublishRefusal({
      disclosure: ALCOHOL_BRAND_BENEFIT,
      listing: null,
      commercialLinks: { commercialLinkCount: 0 },
    });
    expect(expected).not.toBeNull();
    expect(
      await publishGateRefusal(
        PUBLISHABLE_MEDIA,
        UPLOADER,
        sources({ disclosure: ALCOHOL_BRAND_BENEFIT }),
      ),
    ).toEqual({ status: 400, body: expected });
  });

  it("5. no declaration from an ordinary uploader: 422 `attestation_missing`", async () => {
    expect(
      await publishGateRefusal(
        PUBLISHABLE_MEDIA,
        UPLOADER,
        sources({ attestation: null, uploaderConfigured: false }),
      ),
    ).toEqual({
      status: 422,
      body: {
        blocker: "attestation_missing",
        error: PUBLISH_BLOCKER_MESSAGES.attestation_missing,
      },
    });
  });

  it("5. a declaration disclaiming the rights: 422, configured uploader or not", async () => {
    for (const uploaderConfigured of [false, true]) {
      expect(
        await publishGateRefusal(
          PUBLISHABLE_MEDIA,
          UPLOADER,
          sources({
            attestation: { ...CLEAN_ATTESTATION, authorship: MediaAuthorship.NEITHER },
            uploaderConfigured,
          }),
        ),
      ).toEqual({
        status: 422,
        body: {
          blocker: "attestation_rights_disclaimed",
          error: PUBLISH_BLOCKER_MESSAGES.attestation_rights_disclaimed,
        },
      });
    }
  });

  it("6. no watermarked preview: 409", async () => {
    for (const previewKey of [null, "  "]) {
      expect(
        await publishGateRefusal(
          { ...PUBLISHABLE_MEDIA, previewKey },
          UPLOADER,
          sources(),
        ),
      ).toEqual({
        status: 409,
        body: {
          error:
            "This item has no watermarked preview yet, so it cannot be published.",
        },
      });
    }
  });
});

describe("publishGateRefusal: the order, and the reads it costs", () => {
  /*
   * One row that fails EVERY gate, then each failure fixed in turn: the
   * answer must move down the list one gate at a time. Reordering any two
   * gates in the function fails one of these steps.
   */
  it("answers the first failing gate, in the manual route's order", async () => {
    const media = { ...PUBLISHABLE_MEDIA, altText: null, previewKey: null };
    const failing: Partial<Facts> = {
      disclosure: UNLABELLED_BENEFIT,
      commercialLinkCount: 1,
      attestation: null,
      uploaderConfigured: false,
    };

    const steps: [string, () => Promise<unknown>][] = [
      ["alt text", () => publishGateRefusal(media, UPLOADER, sources(failing))],
      [
        "label",
        () =>
          publishGateRefusal(
            { ...media, altText: "described" },
            UPLOADER,
            sources(failing),
          ),
      ],
      [
        "link",
        () =>
          publishGateRefusal(
            { ...media, altText: "described" },
            UPLOADER,
            sources({ ...failing, disclosure: null }),
          ),
      ],
      [
        "alcohol",
        () =>
          publishGateRefusal(
            { ...media, altText: "described" },
            UPLOADER,
            sources({ ...failing, disclosure: ALCOHOL_BRAND_BENEFIT, commercialLinkCount: 0 }),
          ),
      ],
      [
        "rights",
        () =>
          publishGateRefusal(
            { ...media, altText: "described" },
            UPLOADER,
            sources({ ...failing, disclosure: null, commercialLinkCount: 0 }),
          ),
      ],
      [
        "preview",
        () =>
          publishGateRefusal(
            { ...media, altText: "described" },
            UPLOADER,
            sources({ ...CLEAN_FACTS }),
          ),
      ],
    ];

    const answers = [];
    for (const [, run] of steps) answers.push(await run());

    expect(answers.map((answer) => (answer as { status: number }).status)).toEqual([
      400, 400, 400, 400, 422, 409,
    ]);
    const bodies = answers.map((answer) => (answer as { body: object }).body);
    expect(bodies[0]).toMatchObject({ field: "altText" });
    expect(bodies[1]).toEqual(advertisingLabelPublishRefusal(UNLABELLED_BENEFIT));
    expect(bodies[2]).toEqual(
      commercialLinkPublishRefusal(null, { commercialLinkCount: 1 }),
    );
    expect(bodies[3]).toEqual(
      commercialPublishRefusal({
        disclosure: ALCOHOL_BRAND_BENEFIT,
        listing: null,
        commercialLinks: { commercialLinkCount: 0 },
      }),
    );
    expect(bodies[4]).toMatchObject({ blocker: "attestation_missing" });
  });

  it("reads nothing when alt text refuses", async () => {
    const spies = sources();
    await publishGateRefusal({ ...PUBLISHABLE_MEDIA, altText: null }, UPLOADER, spies);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("reads only the disclosure when the label refuses", async () => {
    const spies = sources({ disclosure: UNLABELLED_BENEFIT });
    await publishGateRefusal(PUBLISHABLE_MEDIA, UPLOADER, spies);
    expect(spies.disclosure).toHaveBeenCalledTimes(1);
    expect(spies.commercialLinkCount).not.toHaveBeenCalled();
    expect(spies.listing).not.toHaveBeenCalled();
    expect(spies.attestation).not.toHaveBeenCalled();
    expect(spies.uploaderConfigured).not.toHaveBeenCalled();
  });

  it("reads each source at most once on a full pass", async () => {
    const spies = sources({ attestation: null, uploaderConfigured: true });
    expect(await publishGateRefusal(PUBLISHABLE_MEDIA, UPLOADER, spies)).toBeNull();
    for (const spy of Object.values(spies)) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("asks whether the uploader is configured only when the declaration is missing", async () => {
    const spies = sources();
    await publishGateRefusal(PUBLISHABLE_MEDIA, UPLOADER, spies);
    expect(spies.uploaderConfigured).not.toHaveBeenCalled();
  });
});

describe("publishGateRefusal: the configured-uploader exemption (ugcportal-ho7j)", () => {
  it("passes a configured uploader's undeclared upload", async () => {
    // Fails if the exemption is lost: the same facts with
    // `uploaderConfigured: false` are the 422 above.
    expect(
      await publishGateRefusal(
        PUBLISHABLE_MEDIA,
        UPLOADER,
        sources({ attestation: null, uploaderConfigured: true }),
      ),
    ).toBeNull();
  });

  it("still refuses a configured uploader's undeclared upload with no preview", async () => {
    expect(
      await publishGateRefusal(
        { ...PUBLISHABLE_MEDIA, previewKey: null },
        UPLOADER,
        sources({ attestation: null, uploaderConfigured: true }),
      ),
    ).toMatchObject({ status: 409 });
  });

  it("still refuses a configured uploader's undeclared upload the admin says shows a person", async () => {
    expect(
      await publishGateRefusal(
        PUBLISHABLE_MEDIA,
        UPLOADER,
        sources({
          attestation: null,
          uploaderConfigured: true,
          listing: { depictsAlcohol: null, depictsPeople: true, layerClearances: [] },
        }),
      ),
    ).toMatchObject({ status: 422, body: { blocker: "people_uncleared" } });
  });
});

describe("publishGateSources: what it reads, through which client", () => {
  function fakeClient(configuredHandle: string | null) {
    return {
      mediaAdvertisingDisclosure: { findUnique: vi.fn(async () => null) },
      commercialLink: { count: vi.fn(async () => 0) },
      mediaListing: { findUnique: vi.fn(async () => null) },
      mediaAttestation: { findUnique: vi.fn(async () => null) },
      user: { findUnique: vi.fn(async () => ({ configuredHandle })) },
    };
  }

  it("reads each table by the media id, with the shared selects", async () => {
    const client = fakeClient(null);
    const read = publishGateSources(client as unknown as PublishGateClient, {
      mediaId: "media-1",
      userId: UPLOADER,
    });
    await read.disclosure();
    await read.commercialLinkCount();
    await read.listing();
    await read.attestation();

    expect(client.mediaAdvertisingDisclosure.findUnique).toHaveBeenCalledWith({
      where: { mediaId: "media-1" },
      select: PUBLISH_GATE_DISCLOSURE_SELECT,
    });
    expect(client.commercialLink.count).toHaveBeenCalledWith({
      where: { mediaId: "media-1" },
    });
    expect(client.mediaListing.findUnique).toHaveBeenCalledWith({
      where: { mediaId: "media-1" },
      select: PUBLISH_GATE_LISTING_SELECT,
    });
    expect(client.mediaAttestation.findUnique).toHaveBeenCalledWith({
      where: { mediaId: "media-1" },
      select: PUBLISH_ATTESTATION_SELECT,
    });
  });

  it("reads configured-ness from the uploader's User row when not told it", async () => {
    for (const [handle, expected] of [
      ["fixture-handle", true],
      [null, false],
    ] as const) {
      const client = fakeClient(handle);
      const read = publishGateSources(client as unknown as PublishGateClient, {
        mediaId: "media-1",
        userId: UPLOADER,
      });
      expect(await read.uploaderConfigured()).toBe(expected);
      expect(client.user.findUnique).toHaveBeenCalledWith({
        where: { id: UPLOADER },
        select: { configuredHandle: true },
      });
    }
  });

  it("uses a value the caller already decided, without a second read", async () => {
    const client = fakeClient(null);
    const read = publishGateSources(client as unknown as PublishGateClient, {
      mediaId: "media-1",
      userId: UPLOADER,
      uploaderConfigured: true,
    });
    expect(await read.uploaderConfigured()).toBe(true);
    expect(client.user.findUnique).not.toHaveBeenCalled();
  });

  it("isConfiguredUser answers false for a user row that does not exist", async () => {
    const client = { user: { findUnique: vi.fn(async () => null) } };
    expect(
      await isConfiguredUser(
        client as unknown as Parameters<typeof isConfiguredUser>[0],
        "nobody",
      ),
    ).toBe(false);
  });
});
