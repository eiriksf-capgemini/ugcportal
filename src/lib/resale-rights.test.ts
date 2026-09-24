import { describe, expect, it } from "vitest";

import { ResaleRightsStatus } from "@/generated/prisma/enums";
import {
  ACCEPTED_CHECKLIST_VERSIONS,
  CURRENT_CHECKLIST_VERSION,
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
    depictsPeople: false,
    modelReleaseKey: null,
    containsMusic: false,
    thirdPartyCreator: false,
    sponsoredContent: false,
    postClearedByUserId: null,
    postClearedAt: null,
    postClearanceReason: null,
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

  it("refuses a post showing people with no model release", () => {
    expect(
      evaluateSellability(sellablePost({ depictsPeople: true }), NOW),
    ).toEqual({ sellable: false, blocker: "model_release_missing" });
  });

  it("accepts a post showing people once a release is on file", () => {
    const post = sellablePost({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/acc-1/release.pdf",
    });
    expect(evaluateSellability(post, NOW).sellable).toBe(true);
  });

  for (const layer of [
    "containsMusic",
    "thirdPartyCreator",
    "sponsoredContent",
  ] as const) {
    it(`refuses an un-triaged ${layer}`, () => {
      expect(
        evaluateSellability(sellablePost({ [layer]: null }), NOW),
      ).toEqual({ sellable: false, blocker: "triage_incomplete" });
    });

    it(`refuses ${layer} = true with no post-level clearance`, () => {
      expect(evaluateSellability(sellablePost({ [layer]: true }), NOW)).toEqual({
        sellable: false,
        blocker: "third_party_layer_uncleared",
      });
    });

    it(`accepts ${layer} = true once explicitly cleared with a reason`, () => {
      const post = sellablePost({
        [layer]: true,
        postClearedByUserId: "admin-1",
        postClearedAt: NOW,
        postClearanceReason: "Licence on file, see evidence.",
      });
      expect(evaluateSellability(post, NOW).sellable).toBe(true);
    });

    it(`refuses ${layer} = true when the clearance has no reason`, () => {
      const post = sellablePost({
        [layer]: true,
        postClearedByUserId: "admin-1",
        postClearedAt: NOW,
        postClearanceReason: "   ",
      });
      expect(evaluateSellability(post, NOW).sellable).toBe(false);
    });

    it(`refuses ${layer} = true when nobody signed the clearance`, () => {
      const post = sellablePost({
        [layer]: true,
        postClearedByUserId: null,
        postClearedAt: NOW,
        postClearanceReason: "Someone said it was fine.",
      });
      expect(evaluateSellability(post, NOW).sellable).toBe(false);
    });
  }
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
