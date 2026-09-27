import { describe, expect, it } from "vitest";

import { ResaleRightsStatus, RightsLayer } from "@/generated/prisma/enums";
import {
  ACCEPTED_CHECKLIST_VERSIONS,
  CURRENT_CHECKLIST_VERSION,
  type GateLayerClearance,
  type GateListing,
  type GateReview,
  type GateUpload,
  MEDIA_GATE_SELECT,
  evaluateSellability,
  isResaleRightsRoute,
  isResaleRightsStatus,
  isSellable,
  uploaderClearanceBlocker,
} from "@/lib/resale-rights";

const NOW = new Date("2026-09-24T12:00:00.000Z");

/** A review that passes every uploader-level check. */
function clearedReview(overrides: Partial<GateReview> = {}): GateReview {
  return {
    status: "CLEARED",
    checklistVersion: CURRENT_CHECKLIST_VERSION,
    reviewedByUserId: "admin-1",
    validUntil: null,
    reviewedBy: { role: "ADMIN" },
    ...overrides,
  };
}

/** A sale record whose triage is complete, signed, and clean on every layer. */
function clearListing(overrides: Partial<GateListing> = {}): GateListing {
  return {
    layerClearances: [],
    depictsPeople: false,
    modelReleaseKey: null,
    containsMusic: false,
    thirdPartyCreator: false,
    sponsoredContent: false,
    // The triage is signed by a current admin: every flag above is an
    // assertion about a third party's rights, so the gate wants a name.
    triagedByUserId: "admin-1",
    triagedBy: { role: "ADMIN" },
    ...overrides,
  };
}

/**
 * An upload that is sellable — the one input in this file that returns true.
 * Every other case is this minus one thing, so a test that fails tells you
 * exactly which requirement did the blocking.
 *
 * Note the shape: the review hangs off `user`, i.e. off the file's own
 * uploader. There is no field here naming "whose rights were cleared",
 * because there is nothing for it to disagree with.
 */
function sellableUpload(overrides: Partial<GateUpload> = {}): GateUpload {
  return {
    userId: "owner-1",
    user: { resaleRightsReview: clearedReview() },
    listing: clearListing(),
    ...overrides,
  };
}

/** The same upload with a different listing. */
function withListing(overrides: Partial<GateListing>): GateUpload {
  return sellableUpload({ listing: clearListing(overrides) });
}

function withReview(review: GateReview | null): GateUpload {
  return sellableUpload({ user: { resaleRightsReview: review } });
}

describe("the baseline fixture", () => {
  // Without this, every "returns false" assertion below would also pass with
  // the gate hard-wired to false.
  it("is sellable, so the negative cases below are meaningful", () => {
    expect(evaluateSellability(sellableUpload(), NOW)).toEqual({
      sellable: true,
    });
    expect(isSellable(sellableUpload(), NOW)).toBe(true);
  });
});

describe("ugcportal-vsm: the clearance is the uploader's, reached through the file", () => {
  /**
   * The anchor, asserted structurally rather than described in a comment.
   *
   * ugcportal-0ss reached the review from the listing's own
   * `instagramAccountId` and then compared `media.userId` against the
   * review's `clearedOwnerUserId`. Both halves of that comparison were
   * reachable from the listing, which is why round 5 found it proved
   * nothing on its own. Here the only path to a review runs through the
   * file's `user`, so "which clearance applies" is not a question any
   * listing author gets to answer.
   */
  it("routes the review through the uploader and nowhere else", () => {
    expect(Object.keys(MEDIA_GATE_SELECT).sort()).toEqual([
      "listing",
      "user",
      "userId",
    ]);
    expect(MEDIA_GATE_SELECT.user.select.resaleRightsReview).toBeTruthy();
    // The listing half carries triage and layer clearances only — nothing
    // that could name a different review.
    expect(
      Object.keys(MEDIA_GATE_SELECT.listing.select).sort(),
    ).toEqual([
      "containsMusic",
      "depictsPeople",
      "layerClearances",
      "modelReleaseKey",
      "sponsoredContent",
      "thirdPartyCreator",
      "triagedBy",
      "triagedByUserId",
    ]);
  });

  it("refuses a file whose uploader has no review, however well triaged", () => {
    // Somebody else being cleared is not this file being cleared.
    expect(
      evaluateSellability(
        sellableUpload({ user: { resaleRightsReview: null } }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "no_review" });
  });

  it("refuses a file with no uploader row loaded at all", () => {
    expect(evaluateSellability(sellableUpload({ user: null }), NOW)).toEqual({
      sellable: false,
      blocker: "no_review",
    });
  });

  it("refuses a file that records no uploader", () => {
    // Unreachable through Prisma — Media.userId is a non-null foreign key —
    // but a fixture, a hand-written query or a mis-mapped select can produce
    // it, and the answer has to be no rather than a crash.
    expect(evaluateSellability(sellableUpload({ userId: null }), NOW)).toEqual({
      sellable: false,
      blocker: "upload_owner_unknown",
    });
    expect(
      evaluateSellability(sellableUpload({ userId: "   " }), NOW),
    ).toEqual({ sellable: false, blocker: "upload_owner_unknown" });
  });

  it("refuses an upload nobody has put forward for sale", () => {
    // A cleared uploader is a precondition, not a standing offer: an upload
    // with no listing has had no triage, so nobody has looked at what is in
    // it.
    expect(evaluateSellability(sellableUpload({ listing: null }), NOW)).toEqual(
      { sellable: false, blocker: "not_listed_for_sale" },
    );
  });
});

describe("ugcportal-0ss K1: only CLEARED is sellable", () => {
  // Iterating the generated enum rather than a hand-written list: a status
  // added to schema.prisma later is covered here the moment it exists.
  const allStatuses = Object.values(ResaleRightsStatus);

  it("covers every status the schema defines", () => {
    expect(allStatuses).toHaveLength(6);
    expect(allStatuses).toContain("CLEARED");
  });

  for (const status of allStatuses) {
    it(`status ${status} is ${status === "CLEARED" ? "sellable" : "not sellable"}`, () => {
      const upload = withReview(clearedReview({ status }));
      const result = evaluateSellability(upload, NOW);

      if (status === "CLEARED") {
        expect(result).toEqual({ sellable: true });
      } else {
        expect(result).toEqual({
          sellable: false,
          blocker: "status_not_cleared",
        });
      }
    });
  }

  it("treats a missing review row exactly like UNREVIEWED", () => {
    expect(evaluateSellability(withReview(null), NOW)).toEqual({
      sellable: false,
      blocker: "no_review",
    });
  });
});

describe("ugcportal-0ss K2: a CLEARED review can still be insufficient", () => {
  it("refuses a clearance whose validUntil has passed", () => {
    const upload = withReview(
      clearedReview({ validUntil: new Date(NOW.getTime() - 1) }),
    );
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "clearance_expired",
    });
  });

  it("refuses a clearance that expires exactly now", () => {
    const upload = withReview(clearedReview({ validUntil: new Date(NOW) }));
    expect(evaluateSellability(upload, NOW).sellable).toBe(false);
  });

  it("accepts a clearance that is still inside its window", () => {
    const upload = withReview(
      clearedReview({ validUntil: new Date(NOW.getTime() + 1000) }),
    );
    expect(evaluateSellability(upload, NOW).sellable).toBe(true);
  });

  /**
   * An Invalid Date's getTime() is NaN, and every comparison against NaN is
   * false — so `expiry <= now` answered "not expired" for a date nobody can
   * read, and the gate returned sellable. Reachable from any validUntil the
   * route handler didn't write: an import, a manual fix-up, a restored
   * backup. It compounded with the form, which renders an unreadable date
   * as blank, so the next unrelated edit made the clearance perpetual.
   *
   * The whole module is now written so NaN lands on the blocked side.
   */
  it("refuses a clearance whose validUntil cannot be read", () => {
    const upload = withReview(
      clearedReview({ validUntil: new Date("nonsense") }),
    );
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "clearance_expired",
    });
  });

  it("refuses everything when `now` itself is unreadable", () => {
    // A caller with a broken clock gets nothing sold, rather than
    // everything sold.
    const upload = withReview(
      clearedReview({ validUntil: new Date("2099-01-01T00:00:00.000Z") }),
    );
    expect(evaluateSellability(upload, new Date("nonsense")).sellable).toBe(
      false,
    );
  });

  it("refuses a validUntil that is not a Date at all", () => {
    // A hand-written query, or a future select that maps the column as a
    // string, must not read as "no expiry".
    const upload = withReview(
      clearedReview({ validUntil: "2099-01-01" as unknown as Date }),
    );
    expect(evaluateSellability(upload, NOW).sellable).toBe(false);
  });

  it("treats an undefined validUntil as no expiry, not as a crash", () => {
    // Absent is legitimately "no end date" — the column is nullable — and
    // the old `!== null` test would have thrown on undefined instead.
    const upload = withReview(
      clearedReview({ validUntil: undefined as unknown as null }),
    );
    expect(evaluateSellability(upload, NOW).sellable).toBe(true);
  });

  it("refuses a checklist version that is not in the accepted set", () => {
    expect(ACCEPTED_CHECKLIST_VERSIONS.has("2026-01-01.0")).toBe(false);
    const upload = withReview(
      clearedReview({ checklistVersion: "2026-01-01.0" }),
    );
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "checklist_version_retired",
    });
  });

  it("refuses a reviewer who is no longer an ADMIN", () => {
    const upload = withReview(clearedReview({ reviewedBy: { role: "USER" } }));
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "reviewer_not_admin",
    });
  });

  it("refuses a clearance with no reviewer recorded", () => {
    const upload = withReview(
      clearedReview({ reviewedByUserId: null, reviewedBy: null }),
    );
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "reviewer_not_admin",
    });
  });

  it("refuses a reviewer whose user row is gone", () => {
    const upload = withReview(clearedReview({ reviewedBy: null }));
    expect(evaluateSellability(upload, NOW).sellable).toBe(false);
  });
});

describe("per-upload triage (checklist Part C)", () => {
  it("refuses an upload nobody has triaged", () => {
    expect(evaluateSellability(withListing({ depictsPeople: null }), NOW)).toEqual(
      { sellable: false, blocker: "triage_incomplete" },
    );
  });

  /**
   * The triage answers are assertions about other people's rights, and the
   * dangerous direction is `false`: "this photograph contains no
   * identifiable person" is what sells the photograph. An unattributed
   * assertion, or one from someone since demoted, is not one the gate takes.
   */
  it("refuses a triage nobody signed", () => {
    expect(
      evaluateSellability(
        withListing({ triagedByUserId: null, triagedBy: null }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "triage_not_signed_by_admin" });
  });

  it("refuses a triage signed by someone who is no longer an ADMIN", () => {
    // The scenario: a curator, or an admin since demoted, marks a
    // photograph of an identifiable person as depicting nobody.
    expect(
      evaluateSellability(
        withListing({ depictsPeople: false, triagedBy: { role: "USER" } }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "triage_not_signed_by_admin" });
  });

  it("refuses a triage whose signer's account is gone", () => {
    expect(
      evaluateSellability(withListing({ triagedBy: null }), NOW).sellable,
    ).toBe(false);
  });

  /**
   * `undefined === null` is false, so an undefined triage flag used to slip
   * past the "not triaged" check — and for depictsPeople that meant
   * skipping the model-release requirement entirely, because `undefined` is
   * also falsy. Every flag is now checked for being a real boolean.
   */
  it.each([
    "depictsPeople",
    "containsMusic",
    "thirdPartyCreator",
    "sponsoredContent",
  ] as const)(
    "treats an undefined %s as untriaged rather than as false",
    (field) => {
      expect(
        evaluateSellability(
          withListing({ [field]: undefined as unknown as null }),
          NOW,
        ),
      ).toEqual({ sellable: false, blocker: "triage_incomplete" });
    },
  );

  it("treats a non-boolean triage answer as untriaged", () => {
    expect(
      evaluateSellability(
        withListing({ depictsPeople: "false" as unknown as boolean }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "triage_incomplete" });
  });

  it("survives a missing layerClearances relation", () => {
    // A caller that forgot the include should get "not cleared", not a
    // TypeError some outer catch might read as a transient failure.
    const upload = withListing({
      containsMusic: true,
      layerClearances: undefined as unknown as [],
    });
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "third_party_layer_uncleared",
    });
  });

  it("refuses an upload showing people with no model release", () => {
    expect(evaluateSellability(withListing({ depictsPeople: true }), NOW)).toEqual(
      { sellable: false, blocker: "model_release_missing" },
    );
  });

  it("refuses a model release key that is only whitespace", () => {
    // Trimmed like the other string checks: a key of spaces is not a
    // release, and consent for a photograph of a person is not a field you
    // want passing on truthiness alone.
    expect(
      evaluateSellability(
        withListing({ depictsPeople: true, modelReleaseKey: "   " }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "model_release_missing" });
  });

  /**
   * People is the strictest of the four layers, not the loosest. An earlier
   * revision settled it with a free-text key and a boolean — no author, no
   * role re-check — while the three commercial layers each required an
   * admin-signed clearance. That had it exactly backwards: this is the one
   * with a named individual behind it (åndsverkloven § 104, GDPR art 9).
   */
  it("refuses a release on file that no admin has verified", () => {
    const upload = withListing({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/owner-1/release.pdf",
    });
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "model_release_unverified",
    });
  });

  it("refuses a release verified by someone since demoted", () => {
    const upload = withListing({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/owner-1/release.pdf",
      layerClearances: [
        {
          layer: RightsLayer.PEOPLE,
          reason: "Release covers commercial resale.",
          clearedByUserId: "admin-1",
          clearedBy: { role: "USER" },
        },
      ],
    });
    expect(evaluateSellability(upload, NOW).sellable).toBe(false);
  });

  it("accepts an upload showing people with a release and an admin's confirmation", () => {
    const upload = withListing({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/owner-1/release.pdf",
      layerClearances: [
        {
          layer: RightsLayer.PEOPLE,
          reason: "Release read; covers commercial resale, no time limit.",
          clearedByUserId: "admin-1",
          clearedBy: { role: "ADMIN" },
        },
      ],
    });
    expect(evaluateSellability(upload, NOW)).toEqual({ sellable: true });
  });

  it("does not let a music clearance stand in for the people one", () => {
    const upload = withListing({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/owner-1/release.pdf",
      layerClearances: [
        {
          layer: RightsLayer.MUSIC,
          reason: "Licence purchased.",
          clearedByUserId: "admin-1",
          clearedBy: { role: "ADMIN" },
        },
      ],
    });
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "model_release_unverified",
    });
  });

  const LAYERS = [
    ["containsMusic", RightsLayer.MUSIC],
    ["thirdPartyCreator", RightsLayer.THIRD_PARTY_CREATOR],
    ["sponsoredContent", RightsLayer.SPONSORED_CONTENT],
  ] as const;

  /** A justification for one layer, signed by a current admin. */
  function clearance(
    layer: RightsLayer,
    overrides: Partial<GateLayerClearance> = {},
  ): GateLayerClearance {
    return {
      layer,
      reason: "Licence on file, see evidence.",
      clearedByUserId: "admin-1",
      clearedBy: { role: "ADMIN" },
      ...overrides,
    };
  }

  for (const [field, layer] of LAYERS) {
    it(`refuses an un-triaged ${field}`, () => {
      expect(evaluateSellability(withListing({ [field]: null }), NOW)).toEqual({
        sellable: false,
        blocker: "triage_incomplete",
      });
    });

    it(`refuses ${field} = true with no clearance`, () => {
      expect(evaluateSellability(withListing({ [field]: true }), NOW)).toEqual({
        sellable: false,
        blocker: "third_party_layer_uncleared",
      });
    });

    it(`accepts ${field} = true once cleared with a reason`, () => {
      const upload = withListing({
        [field]: true,
        layerClearances: [clearance(layer)],
      });
      expect(evaluateSellability(upload, NOW).sellable).toBe(true);
    });

    it(`refuses ${field} = true when its clearance has no reason`, () => {
      const upload = withListing({
        [field]: true,
        layerClearances: [clearance(layer, { reason: "   " })],
      });
      expect(evaluateSellability(upload, NOW).sellable).toBe(false);
    });

    it(`refuses ${field} = true when nobody signed its clearance`, () => {
      const upload = withListing({
        [field]: true,
        layerClearances: [
          clearance(layer, { clearedByUserId: null, clearedBy: null }),
        ],
      });
      expect(evaluateSellability(upload, NOW).sellable).toBe(false);
    });

    // The same read-time role re-check the uploader's reviewer gets. Without
    // it, a demoted admin's justifications keep working as long as some
    // other admin signed the uploader's clearance.
    it(`refuses ${field} = true when its clearer is no longer an ADMIN`, () => {
      const upload = withListing({
        [field]: true,
        layerClearances: [clearance(layer, { clearedBy: { role: "USER" } })],
      });
      expect(evaluateSellability(upload, NOW)).toEqual({
        sellable: false,
        blocker: "third_party_layer_uncleared",
      });
    });

    it(`refuses ${field} = true when its clearer's account is gone`, () => {
      const upload = withListing({
        [field]: true,
        layerClearances: [clearance(layer, { clearedBy: null })],
      });
      expect(evaluateSellability(upload, NOW).sellable).toBe(false);
    });
  }

  /**
   * The bug this structure exists to prevent: one justification used to
   * settle all three layers, so "music licence purchased" made an upload
   * with an untriaged collaborator and an undisclosed sponsorship sellable.
   */
  for (const [field, layer] of LAYERS) {
    it(`clearing ${field} leaves the other layers blocking`, () => {
      const others = LAYERS.filter(([other]) => other !== field);
      const upload = withListing({
        [field]: true,
        [others[0][0]]: true,
        [others[1][0]]: true,
        layerClearances: [clearance(layer)],
      });

      expect(evaluateSellability(upload, NOW)).toEqual({
        sellable: false,
        blocker: "third_party_layer_uncleared",
      });
    });

    it(`a clearance for a different layer does not settle ${field}`, () => {
      const other = LAYERS.find(([name]) => name !== field)![1];
      const upload = withListing({
        [field]: true,
        layerClearances: [clearance(other)],
      });

      expect(evaluateSellability(upload, NOW).sellable).toBe(false);
    });
  }

  it("accepts an upload whose three layers are each cleared in their own right", () => {
    const upload = withListing({
      containsMusic: true,
      thirdPartyCreator: true,
      sponsoredContent: true,
      layerClearances: LAYERS.map(([, layer]) => clearance(layer)),
    });

    expect(evaluateSellability(upload, NOW)).toEqual({ sellable: true });
  });
});

describe("uploaderClearanceBlocker", () => {
  it("agrees with the full gate on the uploader-level checks", () => {
    expect(uploaderClearanceBlocker(clearedReview(), NOW)).toBeNull();
    expect(uploaderClearanceBlocker(null, NOW)).toBe("no_review");
    expect(
      uploaderClearanceBlocker(clearedReview({ status: "REVOKED" }), NOW),
    ).toBe("status_not_cleared");
  });

  it("says nothing about per-upload triage, which is the caller's job", () => {
    // The admin screen uses this to describe an *uploader*; an upload-level
    // blocker here would be a category error.
    expect(uploaderClearanceBlocker(clearedReview(), NOW)).toBeNull();
    expect(
      evaluateSellability(withListing({ depictsPeople: null }), NOW).sellable,
    ).toBe(false);
  });
});

describe("enum guards", () => {
  it("accepts every schema value and rejects everything else", () => {
    for (const status of Object.values(ResaleRightsStatus)) {
      expect(isResaleRightsStatus(status)).toBe(true);
    }
    for (const value of ["cleared", "", null, undefined, 1, ["CLEARED"]]) {
      expect(isResaleRightsStatus(value)).toBe(false);
    }

    expect(isResaleRightsRoute("CONTRACT")).toBe(true);
    expect(isResaleRightsRoute("contract")).toBe(false);
    expect(isResaleRightsRoute("toString")).toBe(false);
  });
});
