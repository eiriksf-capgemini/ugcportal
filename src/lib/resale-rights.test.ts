import { describe, expect, it } from "vitest";

import { ResaleRightsStatus, RightsLayer } from "@/generated/prisma/enums";
import {
  ACCEPTED_CHECKLIST_VERSIONS,
  CURRENT_CHECKLIST_VERSION,
  type GateLayerClearance,
  type GatePost,
  type GateReview,
  accountClearanceBlocker,
  evaluateSellability,
  isResaleRightsRoute,
  isResaleRightsStatus,
  isSellable,
} from "@/lib/resale-rights";

const NOW = new Date("2026-09-24T12:00:00.000Z");

/** A review that passes every account-level check. */
function clearedReview(overrides: Partial<GateReview> = {}): GateReview {
  return {
    status: "CLEARED",
    checklistVersion: CURRENT_CHECKLIST_VERSION,
    reviewedByUserId: "admin-1",
    validUntil: null,
    reviewedBy: { role: "ADMIN" },
    clearedOwnerUserId: "owner-1",
    ...overrides,
  };
}

/**
 * A post that is sellable — the one input in this file that returns true.
 * Every other case is this minus one thing, so a test that fails tells you
 * exactly which requirement did the blocking.
 */
function sellablePost(overrides: Partial<GatePost> = {}): GatePost {
  return {
    mediaId: "media-1",
    // The Media row the listing points at, loaded by the caller. Owned by
    // the user the *clearance* names, which is the comparison that matters.
    media: { userId: "owner-1" },
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
    instagramAccount: { resaleRightsReview: clearedReview() },
    ...overrides,
  };
}

function withReview(review: GateReview | null): GatePost {
  return sellablePost({ instagramAccount: { resaleRightsReview: review } });
}

describe("the baseline fixture", () => {
  // Without this, every "returns false" assertion below would also pass with
  // the gate hard-wired to false.
  it("is sellable, so the negative cases below are meaningful", () => {
    expect(evaluateSellability(sellablePost(), NOW)).toEqual({ sellable: true });
    expect(isSellable(sellablePost(), NOW)).toBe(true);
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
      const post = withReview(clearedReview({ status }));
      const result = evaluateSellability(post, NOW);

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

  it("treats a post with no account at all as not sellable", () => {
    expect(
      evaluateSellability(sellablePost({ instagramAccount: null }), NOW),
    ).toEqual({ sellable: false, blocker: "no_review" });
  });
});

describe("ugcportal-0ss K2: a CLEARED review can still be insufficient", () => {
  it("refuses a clearance whose validUntil has passed", () => {
    const post = withReview(
      clearedReview({ validUntil: new Date(NOW.getTime() - 1) }),
    );
    expect(evaluateSellability(post, NOW)).toEqual({
      sellable: false,
      blocker: "clearance_expired",
    });
  });

  it("refuses a clearance that expires exactly now", () => {
    const post = withReview(clearedReview({ validUntil: new Date(NOW) }));
    expect(evaluateSellability(post, NOW).sellable).toBe(false);
  });

  it("accepts a clearance that is still inside its window", () => {
    const post = withReview(
      clearedReview({ validUntil: new Date(NOW.getTime() + 1000) }),
    );
    expect(evaluateSellability(post, NOW).sellable).toBe(true);
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
    const post = withReview(clearedReview({ validUntil: new Date("nonsense") }));
    expect(evaluateSellability(post, NOW)).toEqual({
      sellable: false,
      blocker: "clearance_expired",
    });
  });

  it("refuses everything when `now` itself is unreadable", () => {
    // A caller with a broken clock gets nothing sold, rather than
    // everything sold.
    const post = withReview(
      clearedReview({ validUntil: new Date("2099-01-01T00:00:00.000Z") }),
    );
    expect(evaluateSellability(post, new Date("nonsense")).sellable).toBe(
      false,
    );
  });

  it("refuses a validUntil that is not a Date at all", () => {
    // A hand-written query, or a future select that maps the column as a
    // string, must not read as "no expiry".
    const post = withReview(
      clearedReview({ validUntil: "2099-01-01" as unknown as Date }),
    );
    expect(evaluateSellability(post, NOW).sellable).toBe(false);
  });

  it("treats an undefined validUntil as no expiry, not as a crash", () => {
    // Absent is legitimately "no end date" — the column is nullable — and
    // the old `!== null` test would have thrown on undefined instead.
    const post = withReview(
      clearedReview({ validUntil: undefined as unknown as null }),
    );
    expect(evaluateSellability(post, NOW).sellable).toBe(true);
  });

  it("refuses a checklist version that is not in the accepted set", () => {
    expect(ACCEPTED_CHECKLIST_VERSIONS.has("2026-01-01.0")).toBe(false);
    const post = withReview(clearedReview({ checklistVersion: "2026-01-01.0" }));
    expect(evaluateSellability(post, NOW)).toEqual({
      sellable: false,
      blocker: "checklist_version_retired",
    });
  });

  it("refuses a reviewer who is no longer an ADMIN", () => {
    const post = withReview(clearedReview({ reviewedBy: { role: "USER" } }));
    expect(evaluateSellability(post, NOW)).toEqual({
      sellable: false,
      blocker: "reviewer_not_admin",
    });
  });

  it("refuses a clearance with no reviewer recorded", () => {
    const post = withReview(
      clearedReview({ reviewedByUserId: null, reviewedBy: null }),
    );
    expect(evaluateSellability(post, NOW)).toEqual({
      sellable: false,
      blocker: "reviewer_not_admin",
    });
  });

  it("refuses a reviewer whose user row is gone", () => {
    const post = withReview(clearedReview({ reviewedBy: null }));
    expect(evaluateSellability(post, NOW).sellable).toBe(false);
  });
});

describe("per-post triage (checklist Part C)", () => {
  it("refuses a post nobody has triaged", () => {
    expect(
      evaluateSellability(sellablePost({ depictsPeople: null }), NOW),
    ).toEqual({ sellable: false, blocker: "triage_incomplete" });
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
        sellablePost({ triagedByUserId: null, triagedBy: null }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "triage_not_signed_by_admin" });
  });

  it("refuses a triage signed by someone who is no longer an ADMIN", () => {
    // The scenario: a curator, or an admin since demoted, marks a
    // photograph of an identifiable person as depicting nobody.
    expect(
      evaluateSellability(
        sellablePost({ depictsPeople: false, triagedBy: { role: "USER" } }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "triage_not_signed_by_admin" });
  });

  it("refuses a triage whose signer's account is gone", () => {
    expect(
      evaluateSellability(sellablePost({ triagedBy: null }), NOW).sellable,
    ).toBe(false);
  });

  /**
   * `undefined === null` is false, so an undefined triage flag used to slip
   * past the "not triaged" check — and for depictsPeople that meant
   * skipping the model-release requirement entirely, because `undefined` is
   * also falsy. Every flag is now checked for being a real boolean.
   */
  it.each(["depictsPeople", "containsMusic", "thirdPartyCreator", "sponsoredContent"] as const)(
    "treats an undefined %s as untriaged rather than as false",
    (field) => {
      expect(
        evaluateSellability(
          sellablePost({ [field]: undefined as unknown as null }),
          NOW,
        ),
      ).toEqual({ sellable: false, blocker: "triage_incomplete" });
    },
  );

  it("treats a non-boolean triage answer as untriaged", () => {
    expect(
      evaluateSellability(
        sellablePost({ depictsPeople: "false" as unknown as boolean }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "triage_incomplete" });
  });

  it("survives a missing layerClearances relation", () => {
    // A caller that forgot the include should get "not cleared", not a
    // TypeError some outer catch might read as a transient failure.
    const post = sellablePost({
      containsMusic: true,
      layerClearances: undefined as unknown as [],
    });
    expect(evaluateSellability(post, NOW)).toEqual({
      sellable: false,
      blocker: "third_party_layer_uncleared",
    });
  });

  it("refuses a post showing people with no model release", () => {
    expect(
      evaluateSellability(sellablePost({ depictsPeople: true }), NOW),
    ).toEqual({ sellable: false, blocker: "model_release_missing" });
  });

  it("refuses a model release key that is only whitespace", () => {
    // Trimmed like the other string checks: a key of spaces is not a
    // release, and consent for a photograph of a person is not a field you
    // want passing on truthiness alone.
    expect(
      evaluateSellability(
        sellablePost({ depictsPeople: true, modelReleaseKey: "   " }),
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
    const post = sellablePost({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/acc-1/release.pdf",
    });
    expect(evaluateSellability(post, NOW)).toEqual({
      sellable: false,
      blocker: "model_release_unverified",
    });
  });

  it("refuses a release verified by someone since demoted", () => {
    const post = sellablePost({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/acc-1/release.pdf",
      layerClearances: [
        {
          layer: RightsLayer.PEOPLE,
          reason: "Release covers commercial resale.",
          clearedByUserId: "admin-1",
          clearedBy: { role: "USER" },
        },
      ],
    });
    expect(evaluateSellability(post, NOW).sellable).toBe(false);
  });

  it("accepts a post showing people with a release and an admin's confirmation", () => {
    const post = sellablePost({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/acc-1/release.pdf",
      layerClearances: [
        {
          layer: RightsLayer.PEOPLE,
          reason: "Release read; covers commercial resale, no time limit.",
          clearedByUserId: "admin-1",
          clearedBy: { role: "ADMIN" },
        },
      ],
    });
    expect(evaluateSellability(post, NOW)).toEqual({ sellable: true });
  });

  it("does not let a music clearance stand in for the people one", () => {
    const post = sellablePost({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/acc-1/release.pdf",
      layerClearances: [
        {
          layer: RightsLayer.MUSIC,
          reason: "Licence purchased.",
          clearedByUserId: "admin-1",
          clearedBy: { role: "ADMIN" },
        },
      ],
    });
    expect(evaluateSellability(post, NOW)).toEqual({
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
      expect(evaluateSellability(sellablePost({ [field]: null }), NOW)).toEqual({
        sellable: false,
        blocker: "triage_incomplete",
      });
    });

    it(`refuses ${field} = true with no clearance`, () => {
      expect(evaluateSellability(sellablePost({ [field]: true }), NOW)).toEqual({
        sellable: false,
        blocker: "third_party_layer_uncleared",
      });
    });

    it(`accepts ${field} = true once cleared with a reason`, () => {
      const post = sellablePost({
        [field]: true,
        layerClearances: [clearance(layer)],
      });
      expect(evaluateSellability(post, NOW).sellable).toBe(true);
    });

    it(`refuses ${field} = true when its clearance has no reason`, () => {
      const post = sellablePost({
        [field]: true,
        layerClearances: [clearance(layer, { reason: "   " })],
      });
      expect(evaluateSellability(post, NOW).sellable).toBe(false);
    });

    it(`refuses ${field} = true when nobody signed its clearance`, () => {
      const post = sellablePost({
        [field]: true,
        layerClearances: [
          clearance(layer, { clearedByUserId: null, clearedBy: null }),
        ],
      });
      expect(evaluateSellability(post, NOW).sellable).toBe(false);
    });

    // The same read-time role re-check the account reviewer gets. Without
    // it, a demoted admin's justifications keep working as long as some
    // other admin signed the account clearance.
    it(`refuses ${field} = true when its clearer is no longer an ADMIN`, () => {
      const post = sellablePost({
        [field]: true,
        layerClearances: [clearance(layer, { clearedBy: { role: "USER" } })],
      });
      expect(evaluateSellability(post, NOW)).toEqual({
        sellable: false,
        blocker: "third_party_layer_uncleared",
      });
    });

    it(`refuses ${field} = true when its clearer's account is gone`, () => {
      const post = sellablePost({
        [field]: true,
        layerClearances: [clearance(layer, { clearedBy: null })],
      });
      expect(evaluateSellability(post, NOW).sellable).toBe(false);
    });
  }

  /**
   * The bug this structure exists to prevent: one justification used to
   * settle all three layers, so "music licence purchased" made a post with
   * an untriaged collaborator and an undisclosed sponsorship sellable.
   */
  for (const [field, layer] of LAYERS) {
    it(`clearing ${field} leaves the other layers blocking`, () => {
      const others = LAYERS.filter(([other]) => other !== field);
      const post = sellablePost({
        [field]: true,
        [others[0][0]]: true,
        [others[1][0]]: true,
        layerClearances: [clearance(layer)],
      });

      expect(evaluateSellability(post, NOW)).toEqual({
        sellable: false,
        blocker: "third_party_layer_uncleared",
      });
    });

    it(`a clearance for a different layer does not settle ${field}`, () => {
      const other = LAYERS.find(([name]) => name !== field)![1];
      const post = sellablePost({
        [field]: true,
        layerClearances: [clearance(other)],
      });

      expect(evaluateSellability(post, NOW).sellable).toBe(false);
    });
  }

  it("accepts a post whose three layers are each cleared in their own right", () => {
    const post = sellablePost({
      containsMusic: true,
      thirdPartyCreator: true,
      sponsoredContent: true,
      layerClearances: LAYERS.map(([, layer]) => clearance(layer)),
    });

    expect(evaluateSellability(post, NOW)).toEqual({ sellable: true });
  });
});

describe("ugcportal-2eh Option A: the file sold is the owner's upload", () => {
  it("refuses a post with no linked owner-uploaded original", () => {
    expect(evaluateSellability(sellablePost({ mediaId: null }), NOW)).toEqual({
      sellable: false,
      blocker: "not_owner_supplied_original",
    });
  });

  it("refuses a blank mediaId", () => {
    expect(evaluateSellability(sellablePost({ mediaId: "  " }), NOW).sellable).toBe(
      false,
    );
  });

  // mediaId has no foreign key behind it — the Media model belongs to
  // another branch — so "there is a row with this id" is a question only the
  // loaded row can answer.
  it("refuses a mediaId that resolves to nothing", () => {
    expect(evaluateSellability(sellablePost({ media: null }), NOW)).toEqual({
      sellable: false,
      blocker: "not_owner_supplied_original",
    });
  });

  // The one that matters most: a clearance covers one party's rights, so a
  // listing under it must not be able to sell a different user's upload.
  //
  // Compared against the *review's* rights holder, not a second column on
  // the listing. An earlier revision checked CuratedPost.ownerUserId
  // against the Media row, but both were written by whoever created the
  // listing — it proved the row agreed with itself and nothing more.
  it("refuses a file belonging to someone other than the cleared rights holder", () => {
    expect(
      evaluateSellability(
        sellablePost({ media: { userId: "someone-else" } }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "media_not_owned" });
  });

  it("refuses a clearance that names no rights holder at all", () => {
    // Nothing to compare the file against, so nothing is sellable — caught
    // at the account level, before any per-post question is asked.
    expect(
      evaluateSellability(
        withReview(clearedReview({ clearedOwnerUserId: null })),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "rights_holder_not_recorded" });
  });

  it("follows the rights holder when the clearance names a different one", () => {
    // The listing is unchanged; only the clearance moved. Selling has to
    // follow the clearance.
    expect(
      evaluateSellability(
        withReview(clearedReview({ clearedOwnerUserId: "another-owner" })),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "media_not_owned" });
  });
});

describe("accountClearanceBlocker", () => {
  it("agrees with the full gate on the account-level checks", () => {
    expect(accountClearanceBlocker(clearedReview(), NOW)).toBeNull();
    expect(accountClearanceBlocker(null, NOW)).toBe("no_review");
    expect(accountClearanceBlocker(clearedReview({ status: "REVOKED" }), NOW)).toBe(
      "status_not_cleared",
    );
  });

  it("says nothing about per-post triage, which is the caller's job", () => {
    // The admin screen uses this to describe an *account*; a post-level
    // blocker here would be a category error.
    expect(accountClearanceBlocker(clearedReview(), NOW)).toBeNull();
    expect(
      evaluateSellability(
        sellablePost({ depictsPeople: null }),
        NOW,
      ).sellable,
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
