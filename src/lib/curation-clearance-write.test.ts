import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RightsLayer } from "@/generated/prisma/enums";
import {
  CLEARABLE_LAYERS,
  CURRENT_CHECKLIST_VERSION,
  MEDIA_GATE_SELECT,
  TRIAGE_FACTS,
  evaluateSellability,
  triageBlocker,
  unsettledLayers,
} from "@/lib/resale-rights";
import { completeAttestationRow } from "@/lib/test-support/attestation";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * Per-layer rights clearances (ugcportal-qfy9 K1–K3), against a real SQLite
 * database with the committed migrations applied, the real Prisma client and
 * the real libsql driver.
 *
 * NOT A MOCK, for a reason specific to this bead. Half of what K2 claims is
 * a claim about the SCHEMA — that `MediaRightsClearance` carries a unique
 * index on `(listingId, layer)` and that the index REJECTS rather than
 * quietly replacing. A mocked Prisma would agree with whatever this file
 * asserted, and the defect the bead names (an `upsert` where a `create` was
 * meant, turning the guardrail into a no-op that still looks green) is
 * invisible to one.
 *
 * THE FIXTURE IS THE INTERESTING PART. One upload with FIVE clearable rights
 * layers all present at once, everything else about it clean, so the only
 * thing standing between it and a sale is the five clearances. That is what
 * makes "clearing one layer settles only that layer" measurable: with one
 * layer present, "still blocked" and "clearing did nothing" are the same
 * observation.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { recordLayerClearance } = await import(
  "@/lib/curation-clearance-write"
);

const ADMIN = "admin-1";
const SECOND_ADMIN = "admin-2";
const PLAIN_USER = "user-1";
const OWNER = "owner-1";

/**
 * The fields of the one listing under test, derived from the registry so a
 * layer added later lands in this fixture rather than being silently left
 * out of it.
 *
 * EVERY CLEARABLE LAYER ANSWERED `true`; the two the registry says no
 * clearance settles answered `false`, because ALCOHOL blocks forever on
 * `true` and would make the upload unsellable whatever this test did.
 */
const ALL_LAYERS_PRESENT = Object.fromEntries(
  TRIAGE_FACTS.map((fact) => [
    fact.field,
    fact.settledBy === "clearance",
  ]),
) as Record<string, boolean>;

/** Every layer a clearance can settle, which is what the fixture presents. */
const PRESENT_LAYERS: readonly RightsLayer[] = CLEARABLE_LAYERS;

/** The listing as the gate sees it, re-read from the database every time. */
async function gateListing(mediaId = "media-1") {
  const upload = await prisma.media.findUniqueOrThrow({
    where: { id: mediaId },
    select: MEDIA_GATE_SELECT,
  });
  if (!upload.listing) throw new Error(`no listing for ${mediaId}`);
  return upload.listing;
}

/** The set of layers still in the way, as the gate computes it. */
async function blockingLayers(mediaId = "media-1"): Promise<RightsLayer[]> {
  return unsettledLayers(await gateListing(mediaId));
}

async function gateUpload(mediaId = "media-1") {
  return prisma.media.findUniqueOrThrow({
    where: { id: mediaId },
    select: MEDIA_GATE_SELECT,
  });
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.createMany({
    data: [
      { id: ADMIN, email: "admin@example.com", role: "ADMIN" },
      { id: SECOND_ADMIN, email: "admin2@example.com", role: "ADMIN" },
      { id: PLAIN_USER, email: "user@example.com", role: "USER" },
      { id: OWNER, email: "owner@example.com", role: "USER" },
    ],
  });
  await prisma.resaleRightsReview.create({
    data: {
      uploaderUserId: OWNER,
      status: "CLEARED",
      route: "CONTRACT",
      checklistVersion: CURRENT_CHECKLIST_VERSION,
      reviewedByUserId: ADMIN,
      reviewedAt: new Date("2026-10-01T00:00:00.000Z"),
      productDecisionRef: "ugcportal-2eh",
    },
  });
  await prisma.media.createMany({
    data: [
      {
        id: "media-1",
        userId: OWNER,
        kind: "IMAGE",
        key: "media/owner-1/original.jpg",
        previewKey: "previews/owner-1/media-1.webp",
        previewId: "preview-media-1",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
        originalName: "original.jpg",
        altText: "A band on a stage",
      },
      {
        // A second upload with its own listing. The fixture that tells
        // "unique on (listingId, layer)" apart from "unique on layer".
        id: "media-2",
        userId: OWNER,
        kind: "IMAGE",
        key: "media/owner-1/second.jpg",
        previewKey: "previews/owner-1/media-2.webp",
        previewId: "preview-media-2",
        mimeType: "image/jpeg",
        sizeBytes: 2345,
        originalName: "second.jpg",
        altText: "Another band on another stage",
      },
      {
        // Never triaged, so it has no MediaListing to hang a clearance off.
        id: "media-untriaged",
        userId: OWNER,
        kind: "IMAGE",
        key: "media/owner-1/third.jpg",
        previewKey: "previews/owner-1/media-3.webp",
        previewId: "preview-media-3",
        mimeType: "image/jpeg",
        sizeBytes: 3456,
        originalName: "third.jpg",
        altText: "A third photograph",
      },
    ],
  });
  for (const mediaId of ["media-1", "media-2", "media-untriaged"]) {
    await prisma.mediaAttestation.create({
      data: completeAttestationRow(mediaId, OWNER),
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  await prisma.mediaRightsClearance.deleteMany({});
  await prisma.mediaListing.deleteMany({});
  await prisma.user.update({
    where: { id: ADMIN },
    data: { role: "ADMIN" },
  });
  for (const mediaId of ["media-1", "media-2"]) {
    await prisma.mediaListing.create({
      data: {
        mediaId,
        ...ALL_LAYERS_PRESENT,
        // PEOPLE's `alsoRequires`, satisfied, so the only thing left for
        // that layer is the clearance itself. Without it the PEOPLE entry
        // would block on `model_release_missing` no matter what any
        // clearance said, and the sequence below would measure the release
        // file rather than the clearance.
        modelReleaseKey: `releases/${mediaId}/release.pdf`,
        triagedByUserId: ADMIN,
        triagedAt: new Date("2026-10-02T00:00:00.000Z"),
      },
    });
  }
});

describe("the fixture itself", () => {
  it("presents every clearable layer at once, and nothing else blocks", async () => {
    /*
      Guards every sequence below against the way a test like this most
      often stops meaning anything: a fixture that presents one layer, or
      none, so that "still blocked" is true for reasons the test is not
      measuring.
    */
    expect(PRESENT_LAYERS.length).toBeGreaterThan(1);
    expect(await blockingLayers()).toEqual([...PRESENT_LAYERS]);
    // Nothing OUTSIDE the clearable set is in the way, so a layer that
    // leaves the set below really did leave because it was cleared.
    expect(
      (await blockingLayers()).filter(
        (layer) => !CLEARABLE_LAYERS.includes(layer),
      ),
    ).toEqual([]);
  });
});

describe("K1: clearing one layer settles that layer and no other", () => {
  /**
   * DELIBERATELY NOT REGISTRY ORDER. `unsettledLayers` walks TRIAGE_FACTS,
   * so clearing in that order would let an implementation that removed "the
   * first remaining layer" rather than "the layer named on the row" pass
   * every assertion below.
   */
  const CLEARING_ORDER: readonly RightsLayer[] = [
    RightsLayer.MUSIC,
    RightsLayer.SPONSORED_CONTENT,
    RightsLayer.PEOPLE,
    RightsLayer.THIRD_PARTY_CREATOR,
    RightsLayer.MINORS,
  ];

  it("covers every present layer, in an order the registry does not use", () => {
    // Both halves asserted rather than trusted: a clearing order that
    // silently dropped a layer would leave the final "nothing blocks"
    // assertion unreachable, and one that matched registry order would
    // weaken the sequence test below without failing it.
    expect([...CLEARING_ORDER].sort()).toEqual([...PRESENT_LAYERS].sort());
    expect(CLEARING_ORDER).not.toEqual([...PRESENT_LAYERS]);
  });

  it("shrinks the blocker set by exactly one per clearance", async () => {
    /*
      THE ASSERTION THE BEAD NAMES. "Clear MUSIC, assert still blocked"
      passes even if clearing does nothing at all — three of these five
      layers report the same blocker code (`third_party_layer_uncleared`),
      so `triageBlocker` alone cannot tell "MUSIC was settled" from "MUSIC
      was not". The set can.
    */
    let remaining = await blockingLayers();
    expect(remaining).toHaveLength(PRESENT_LAYERS.length);

    for (const layer of CLEARING_ORDER) {
      const before = remaining;
      const outcome = await recordLayerClearance({
        mediaId: "media-1",
        layer,
        reason: `Justification for ${layer} and for nothing else`,
        actorUserId: ADMIN,
      });
      expect(outcome.kind, layer).toBe("recorded");

      remaining = await blockingLayers();

      // (a) exactly one fewer.
      expect(remaining.length, layer).toBe(before.length - 1);
      // (b) the one that went is the one just cleared — not merely "one
      // fewer", which a gate that dropped an arbitrary layer would satisfy.
      expect(remaining, layer).not.toContain(layer);
      // (c) every other layer that was blocking still is. This is the
      // legal invariant: a cleared MUSIC layer is not a cleared PEOPLE
      // layer.
      expect(remaining, layer).toEqual(
        before.filter((candidate) => candidate !== layer),
      );
    }

    expect(remaining).toEqual([]);
  });

  it("records the acting admin on the one layer cleared", async () => {
    await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased from the rights holder, ref 4412",
      actorUserId: ADMIN,
    });

    const rows = await prisma.mediaRightsClearance.findMany({
      where: { listing: { mediaId: "media-1" } },
    });
    // ONE row, naming ONE layer: a write that fanned out across the present
    // layers would leave five here and still make the upload sellable.
    expect(rows).toHaveLength(1);
    expect(rows[0].layer).toBe(RightsLayer.MUSIC);
    expect(rows[0].clearedByUserId).toBe(ADMIN);
    expect(rows[0].reason).toBe(
      "Licence purchased from the rights holder, ref 4412",
    );
  });

  it("records whichever admin acted, not a constant", async () => {
    // The fixture mutation for "the acting admin": a writer that hard-coded
    // an id, or read the actor from somewhere other than its argument,
    // passes the test above and fails this one.
    await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Signed by the first admin",
      actorUserId: ADMIN,
    });
    await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MINORS,
      reason: "Signed by the second admin",
      actorUserId: SECOND_ADMIN,
    });

    const byLayer = Object.fromEntries(
      (
        await prisma.mediaRightsClearance.findMany({
          where: { listing: { mediaId: "media-1" } },
        })
      ).map((row) => [row.layer, row.clearedByUserId]),
    );
    expect(byLayer[RightsLayer.MUSIC]).toBe(ADMIN);
    expect(byLayer[RightsLayer.MINORS]).toBe(SECOND_ADMIN);
  });

  it("stamps the clearance time, and lets a caller pin it", async () => {
    const pinned = new Date("2026-10-03T09:30:00.000Z");
    await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased",
      actorUserId: ADMIN,
      now: pinned,
    });
    const [row] = await prisma.mediaRightsClearance.findMany({
      where: { listing: { mediaId: "media-1" } },
    });
    expect(row.clearedAt.toISOString()).toBe(pinned.toISOString());
  });

  it("clears the last layer into a sellable upload", async () => {
    // The end of the sequence, read through the whole gate rather than
    // through `unsettledLayers`: an empty blocker set that did not actually
    // sell anything would mean the helper and the gate had drifted apart.
    for (const layer of PRESENT_LAYERS) {
      expect(evaluateSellability(await gateUpload()).sellable).toBe(false);
      await recordLayerClearance({
        mediaId: "media-1",
        layer,
        reason: `Justification for ${layer}`,
        actorUserId: ADMIN,
      });
    }
    expect(triageBlocker(await gateListing())).toBeNull();
    expect(evaluateSellability(await gateUpload())).toEqual({ sellable: true });
  });

  it("puts a layer BACK when its clearer stops being an admin", async () => {
    /*
      FIXTURE MUTATION, and the one that proves the blocker set is computed
      rather than remembered. The row stays exactly as written; only the
      signer's role changes. A set derived from "a clearance row exists"
      would not move, and a demoted admin's justifications would quietly go
      on selling.

      It also re-checks independence from the other direction: ONE layer
      comes back, not all of them, even though one person signed them all.
    */
    for (const layer of PRESENT_LAYERS) {
      await recordLayerClearance({
        mediaId: "media-1",
        layer,
        reason: `Justification for ${layer}`,
        actorUserId: layer === RightsLayer.MUSIC ? SECOND_ADMIN : ADMIN,
      });
    }
    expect(await blockingLayers()).toEqual([]);

    await prisma.user.update({
      where: { id: SECOND_ADMIN },
      data: { role: "USER" },
    });
    try {
      expect(await blockingLayers()).toEqual([RightsLayer.MUSIC]);
    } finally {
      await prisma.user.update({
        where: { id: SECOND_ADMIN },
        data: { role: "ADMIN" },
      });
    }
  });

  it("puts a layer BACK when its reason is emptied underneath it", async () => {
    // The other fixture mutation on a written row: the gate requires a
    // non-blank reason, so a row whose reason is whitespace settles
    // nothing. Written through Prisma directly because the write path
    // refuses to produce this state — which is the point of asserting the
    // gate does not accept it either.
    await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased",
      actorUserId: ADMIN,
    });
    expect(await blockingLayers()).not.toContain(RightsLayer.MUSIC);

    await prisma.mediaRightsClearance.updateMany({
      where: { layer: RightsLayer.MUSIC },
      data: { reason: "   " },
    });
    expect(await blockingLayers()).toContain(RightsLayer.MUSIC);
  });
});

describe("K2: one layer's clearance never settles another", () => {
  it("leaves every other layer blocking, layer by layer", async () => {
    /*
      The whole table rather than one example: for EVERY clearable layer,
      clearing it alone must leave exactly the others in the way. A
      `layerIsCleared` that matched on "any clearance exists" would pass a
      single-example test for whichever layer happened to be first.
    */
    for (const cleared of PRESENT_LAYERS) {
      await prisma.mediaRightsClearance.deleteMany({});
      await recordLayerClearance({
        mediaId: "media-1",
        layer: cleared,
        reason: `Justification for ${cleared}`,
        actorUserId: ADMIN,
      });

      expect(await blockingLayers(), cleared).toEqual(
        PRESENT_LAYERS.filter((layer) => layer !== cleared),
      );
    }
  });

  it("does not settle the same layer on a DIFFERENT upload", async () => {
    // Independence across listings as well as across layers: the clearance
    // is keyed on the listing, and `media-2` presents the same five layers.
    await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased for the first upload",
      actorUserId: ADMIN,
    });

    expect(await blockingLayers("media-1")).not.toContain(RightsLayer.MUSIC);
    expect(await blockingLayers("media-2")).toEqual([...PRESENT_LAYERS]);
  });

  it("refuses a second clearance for a layer that has one, keeping the first", async () => {
    /*
      THE UPSERT TRAP. Row count alone cannot tell a refusal from a silent
      replacement — an `upsert` also leaves exactly one row. So the
      assertions are on the OUTCOME and on the row's CONTENTS: a second
      call must be refused, and the first admin's reason and name must
      still be what the register says.
    */
    const first = await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased from the rights holder",
      actorUserId: ADMIN,
    });
    expect(first.kind).toBe("recorded");

    const second = await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Actually we decided it was fine",
      actorUserId: SECOND_ADMIN,
    });
    expect(second.kind).toBe("clearance_already_recorded");

    const rows = await prisma.mediaRightsClearance.findMany({
      where: { listing: { mediaId: "media-1" } },
    });
    expect(rows).toHaveLength(1);
    // An `upsert` would have written both of these from the second call.
    expect(rows[0].reason).toBe("Licence purchased from the rights holder");
    expect(rows[0].clearedByUserId).toBe(ADMIN);
  });

  it("the unique index itself rejects the duplicate, below the write path", async () => {
    /*
      K2's named FIXTURE MUTATION, run against the database rather than
      against the function: the second INSERT is attempted directly through
      Prisma, bypassing the write path's own check entirely. If the index
      were missing from the migration — present in schema.prisma and never
      applied — the write path's `findUnique` would still refuse a
      duplicate and the test above would pass with no constraint behind it.

      `rejects` rather than a row count, and `P2002` rather than any error,
      so a foreign-key failure or a typo cannot be mistaken for the
      constraint firing.
    */
    const listing = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: "media-1" },
      select: { id: true },
    });
    await prisma.mediaRightsClearance.create({
      data: {
        listingId: listing.id,
        layer: RightsLayer.MUSIC,
        reason: "First",
        clearedByUserId: ADMIN,
      },
    });

    await expect(
      prisma.mediaRightsClearance.create({
        data: {
          listingId: listing.id,
          layer: RightsLayer.MUSIC,
          reason: "Second",
          clearedByUserId: SECOND_ADMIN,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(
      await prisma.mediaRightsClearance.count({
        where: { listingId: listing.id },
      }),
    ).toBe(1);
  });

  it("the index is on the PAIR, so a different layer and a different listing both insert", async () => {
    /*
      The other half of the mutation, and the reason the one above means
      something. An index on `listingId` alone — or a table that simply
      refused every second insert — would satisfy the rejection test and
      make the whole feature impossible. These two must SUCCEED.
    */
    const [one, two] = await Promise.all([
      prisma.mediaListing.findUniqueOrThrow({
        where: { mediaId: "media-1" },
        select: { id: true },
      }),
      prisma.mediaListing.findUniqueOrThrow({
        where: { mediaId: "media-2" },
        select: { id: true },
      }),
    ]);

    await prisma.mediaRightsClearance.create({
      data: {
        listingId: one.id,
        layer: RightsLayer.MUSIC,
        reason: "Music on the first upload",
        clearedByUserId: ADMIN,
      },
    });
    // Same listing, different layer.
    await prisma.mediaRightsClearance.create({
      data: {
        listingId: one.id,
        layer: RightsLayer.PEOPLE,
        reason: "Release on file for the first upload",
        clearedByUserId: ADMIN,
      },
    });
    // Same layer, different listing.
    await prisma.mediaRightsClearance.create({
      data: {
        listingId: two.id,
        layer: RightsLayer.MUSIC,
        reason: "Music on the second upload",
        clearedByUserId: ADMIN,
      },
    });

    expect(await prisma.mediaRightsClearance.count()).toBe(3);
  });

  it("refuses a layer no clearance settles, so the register holds no inert rows", async () => {
    // ALCOHOL is a member of RightsLayer and the table would accept it;
    // `factBlocker` never consults a clearance for it. A row recorded there
    // would read like a settled layer and settle nothing.
    const outcome = await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.ALCOHOL,
      reason: "It was grape juice",
      actorUserId: ADMIN,
    });
    expect(outcome.kind).toBe("clearance_layer_not_clearable");
    expect(await prisma.mediaRightsClearance.count()).toBe(0);
  });

  it("refuses a blank reason rather than writing a clearance that settles nothing", async () => {
    const outcome = await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      // Whitespace, not empty: the gate trims, so a space-only reason is
      // the shape that would look recorded and settle nothing.
      reason: "   \n  ",
      actorUserId: ADMIN,
    });
    expect(outcome.kind).toBe("clearance_reason_blank");
    expect(await prisma.mediaRightsClearance.count()).toBe(0);
  });

  it("stores the reason trimmed", async () => {
    await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "  Licence purchased  ",
      actorUserId: ADMIN,
    });
    const [row] = await prisma.mediaRightsClearance.findMany();
    expect(row.reason).toBe("Licence purchased");
  });

  it("refuses an upload that has never been triaged", async () => {
    const outcome = await recordLayerClearance({
      mediaId: "media-untriaged",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased",
      actorUserId: ADMIN,
    });
    expect(outcome.kind).toBe("clearance_listing_not_found");
    expect(await prisma.mediaRightsClearance.count()).toBe(0);
  });

  it("refuses an upload that does not exist at all", async () => {
    const outcome = await recordLayerClearance({
      mediaId: "media-does-not-exist",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased",
      actorUserId: ADMIN,
    });
    expect(outcome.kind).toBe("clearance_listing_not_found");
    expect(await prisma.mediaRightsClearance.count()).toBe(0);
  });
});

describe("K3: no clearance without a current ADMIN behind it", () => {
  it("refuses a plain user and writes nothing", async () => {
    const outcome = await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "I had a look and it seems fine",
      actorUserId: PLAIN_USER,
    });
    expect(outcome.kind).toBe("clearance_actor_not_admin");
    expect(await prisma.mediaRightsClearance.count()).toBe(0);
    // And the layer is exactly as blocked as before.
    expect(await blockingLayers()).toEqual([...PRESENT_LAYERS]);
  });

  it("refuses an actor who is not a user at all", async () => {
    const outcome = await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased",
      actorUserId: "nobody-at-all",
    });
    expect(outcome.kind).toBe("clearance_actor_not_admin");
    expect(await prisma.mediaRightsClearance.count()).toBe(0);
  });

  it("refuses an admin demoted since the session was minted", async () => {
    /*
      FIXTURE MUTATION for K3, and the reason the role is read from the
      database rather than taken from the caller: `actorUserId` is the same
      value in both halves of this test, and only the row changes. A write
      that trusted a role passed in — or that checked only at the server
      action, where the session still says ADMIN — would record the
      clearance here.
    */
    await prisma.user.update({ where: { id: ADMIN }, data: { role: "USER" } });
    const refused = await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased",
      actorUserId: ADMIN,
    });
    expect(refused.kind).toBe("clearance_actor_not_admin");
    expect(await prisma.mediaRightsClearance.count()).toBe(0);

    await prisma.user.update({ where: { id: ADMIN }, data: { role: "ADMIN" } });
    const recorded = await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased",
      actorUserId: ADMIN,
    });
    expect(recorded.kind).toBe("recorded");
    const [row] = await prisma.mediaRightsClearance.findMany();
    expect(row.clearedByUserId).toBe(ADMIN);
  });

  it("names the admin who acted on the row the gate then reads", async () => {
    // The second half of K3's Verified-by: with an admin, the RECORDED
    // ACTOR MATCHES — checked through the gate's own projection, not just
    // the raw row, so a clearance attributed to someone the gate cannot see
    // would fail here.
    await recordLayerClearance({
      mediaId: "media-1",
      layer: RightsLayer.MUSIC,
      reason: "Licence purchased",
      actorUserId: SECOND_ADMIN,
    });
    const listing = await gateListing();
    const clearance = listing.layerClearances.find(
      (row) => row.layer === RightsLayer.MUSIC,
    );
    expect(clearance?.clearedByUserId).toBe(SECOND_ADMIN);
    expect(clearance?.clearedBy?.role).toBe("ADMIN");
  });
});
