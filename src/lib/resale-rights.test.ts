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
  TRIAGE_FACTS,
  type TriageFact,
  type TriageFactField,
  evaluateSellability,
  isResaleRightsRoute,
  isResaleRightsStatus,
  isSellable,
  triageBlocker,
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
    depictsMinors: false,
    modelReleaseKey: null,
    containsMusic: false,
    thirdPartyCreator: false,
    sponsoredContent: false,
    depictsAlcohol: false,
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
    //
    // The triage columns come from TRIAGE_FACTS rather than a hand-list, so
    // a fact registered later is covered here the moment it exists; the
    // four non-fact keys stay written out, which is what keeps this an
    // assertion that nothing ELSE has crept in (ugcportal-qn3).
    expect(
      Object.keys(MEDIA_GATE_SELECT.listing.select).sort(),
    ).toEqual(
      [
        ...TRIAGE_FACTS.map((fact) => fact.field),
        "layerClearances",
        "modelReleaseKey",
        "triagedBy",
        "triagedByUserId",
      ].sort(),
    );
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

  it("blocks rather than throws when the owner column is not a string", () => {
    // `!value` is false for a number, and `.trim()` on one is a TypeError —
    // the same shape as the `undefined === null` fail-open, one type over.
    // A caller catching that TypeError and treating it as transient is how
    // a crash becomes a retry becomes a sale.
    for (const userId of [7, {}, [], true]) {
      expect(
        evaluateSellability(
          sellableUpload({ userId: userId as unknown as string }),
          NOW,
        ),
      ).toEqual({ sellable: false, blocker: "upload_owner_unknown" });
    }
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
  it.each(TRIAGE_FACTS.map((fact) => fact.field))(
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
   * People is the strictest of the layers, not the loosest. An earlier
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

  /**
   * What a fact needs on the listing BESIDES its own `true`, before a
   * clearance can settle it — today only the PEOPLE release file.
   *
   * A `Record` over every triage-fact field, not a partial map: adding a
   * nullable Boolean to GateListing stops this file compiling until
   * someone says what the new fact needs, which is what keeps the
   * generated cases below from covering a subset (ugcportal-qn3 K5).
   */
  const FACT_EXTRAS: Record<TriageFactField, Partial<GateListing>> = {
    depictsPeople: { modelReleaseKey: "rights-evidence/owner-1/release.pdf" },
    depictsMinors: {},
    containsMusic: {},
    thirdPartyCreator: {},
    sponsoredContent: {},
    depictsAlcohol: {},
  };

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

  /** The baseline upload with exactly one fact answered `true`. */
  function factPresent(
    fact: TriageFact,
    overrides: Partial<GateListing> = {},
  ): GateUpload {
    return withListing({
      [fact.field]: true,
      ...FACT_EXTRAS[fact.field],
      ...overrides,
    });
  }

  /**
   * Every fact a clearance can settle, answered `true`, with the evidence
   * each needs.
   *
   * A fact the registry marks `settledBy: "nothing"` is deliberately left
   * at the baseline `false`. Answering one `true` is an unconditional stop,
   * so including it here would make every case below report THAT fact's
   * blocker instead of the one it is about — the cases would still fail for
   * a broken gate, but they would stop being about the layer they name.
   * Each such fact gets its own `true` case: the per-fact table below
   * overrides its own field, and ugcportal-qnq9.3's describe covers ALCOHOL
   * in full.
   */
  function allFactsPresent(
    overrides: Partial<GateListing> = {},
  ): Partial<GateListing> {
    const listing: Partial<GateListing> = {};
    for (const fact of TRIAGE_FACTS) {
      if (fact.settledBy === "nothing") {
        continue;
      }
      Object.assign(listing, { [fact.field]: true }, FACT_EXTRAS[fact.field]);
    }
    return { ...listing, ...overrides };
  }

  /**
   * ONE CASE TABLE, GENERATED FROM THE REGISTRY THE GATE ITERATES.
   *
   * This used to be a hand-written list of the three commercial layers,
   * with PEOPLE covered separately above — which is exactly the shape that
   * lets a layer added later be covered by neither. Driving it from
   * TRIAGE_FACTS means a new fact arrives with all of these assertions
   * already made about it, and the coverage test in "the triage-fact
   * mechanism" below fails the suite for a RightsLayer with no entry.
   */
  for (const fact of TRIAGE_FACTS) {
    describe(`triage fact ${fact.field} (${fact.layer})`, () => {
      it("blocks the whole upload while it is unanswered", () => {
        expect(
          evaluateSellability(withListing({ [fact.field]: null }), NOW),
        ).toEqual({ sellable: false, blocker: "triage_incomplete" });
      });

      it("blocks when present with no clearance", () => {
        expect(evaluateSellability(factPresent(fact), NOW)).toEqual({
          sellable: false,
          blocker: fact.blocker,
        });
      });

      if (fact.settledBy === "clearance") {
        it("passes once cleared with a reason by a current admin", () => {
          const upload = factPresent(fact, {
            layerClearances: [clearance(fact.layer)],
          });
          expect(evaluateSellability(upload, NOW)).toEqual({ sellable: true });
        });
      } else {
        /**
         * The inverse of the case above, for a fact the registry says
         * nothing settles. This is the assertion that makes `settledBy`
         * load-bearing rather than decorative: a clearance on this fact's
         * OWN layer, signed by a current admin, with a reason — the exact
         * input that sells every other layer — must leave it blocked.
         */
        it("stays blocked even with a clearance on its own layer", () => {
          const upload = factPresent(fact, {
            layerClearances: [clearance(fact.layer)],
          });
          expect(evaluateSellability(upload, NOW)).toEqual({
            sellable: false,
            blocker: fact.blocker,
          });
        });
      }

      it("blocks when its clearance has no reason", () => {
        const upload = factPresent(fact, {
          layerClearances: [clearance(fact.layer, { reason: "   " })],
        });
        expect(evaluateSellability(upload, NOW)).toEqual({
          sellable: false,
          blocker: fact.blocker,
        });
      });

      it("blocks when nobody signed its clearance", () => {
        const upload = factPresent(fact, {
          layerClearances: [
            clearance(fact.layer, { clearedByUserId: null, clearedBy: null }),
          ],
        });
        expect(evaluateSellability(upload, NOW).sellable).toBe(false);
      });

      // The same read-time role re-check the uploader's reviewer gets.
      // Without it, a demoted admin's justifications keep working as long
      // as some other admin signed the uploader's clearance.
      it("blocks when its clearer is no longer an ADMIN", () => {
        const upload = factPresent(fact, {
          layerClearances: [
            clearance(fact.layer, { clearedBy: { role: "USER" } }),
          ],
        });
        expect(evaluateSellability(upload, NOW)).toEqual({
          sellable: false,
          blocker: fact.blocker,
        });
      });

      it("blocks when its clearer's account is gone", () => {
        const upload = factPresent(fact, {
          layerClearances: [clearance(fact.layer, { clearedBy: null })],
        });
        expect(evaluateSellability(upload, NOW).sellable).toBe(false);
      });

      /**
       * The bug this structure exists to prevent: one justification used
       * to settle every layer, so "music licence purchased" made an upload
       * with an undisclosed sponsorship sellable.
       */
      it("is not settled by a clearance on some other layer", () => {
        for (const other of TRIAGE_FACTS) {
          if (other.layer === fact.layer) {
            continue;
          }
          const upload = factPresent(fact, {
            layerClearances: [clearance(other.layer)],
          });
          expect(evaluateSellability(upload, NOW).sellable).toBe(false);
        }
      });

      it("keeps blocking when every OTHER layer is cleared", () => {
        const upload = withListing(
          allFactsPresent({
            // Spelled out rather than left to allFactsPresent, which skips
            // the facts no clearance settles: this case is about THIS fact
            // being present, whichever kind it is.
            [fact.field]: true,
            ...FACT_EXTRAS[fact.field],
            layerClearances: TRIAGE_FACTS.filter(
              (other) => other.layer !== fact.layer,
            ).map((other) => clearance(other.layer)),
          }),
        );
        expect(evaluateSellability(upload, NOW)).toEqual({
          sellable: false,
          blocker: fact.blocker,
        });
      });
    });
  }

  it("accepts an upload whose every layer is cleared in its own right", () => {
    // Every layer gets a clearance, including the ones no fact consults.
    // That is the point of the `allFactsPresent` shape: a clearance written
    // against a `settledBy: "nothing"` layer is an inert record, so its
    // presence must not change the answer either way.
    const upload = withListing(
      allFactsPresent({
        layerClearances: TRIAGE_FACTS.map((fact) => clearance(fact.layer)),
      }),
    );

    expect(evaluateSellability(upload, NOW)).toEqual({ sellable: true });
  });
});

/**
 * ugcportal-qn3: minors, and the mechanism the fact rides on.
 *
 * Two things are under test here and they are deliberately separate. One is
 * the MINORS fact itself — a depicted child blocks until an admin records a
 * MINORS clearance, and nothing else settles it. The other is the shape:
 * that `null` blocks by default, per fact, for every fact, because the gate
 * iterates one registry rather than a hand-written list of columns.
 */
describe("ugcportal-qn3: minors as a triage fact", () => {
  /** A MINORS justification signed by a current admin. */
  function minorsClearance(
    overrides: Partial<GateLayerClearance> = {},
  ): GateLayerClearance {
    return {
      layer: RightsLayer.MINORS,
      reason:
        "Guardian consent on file, signed, naming online commercial publication.",
      clearedByUserId: "admin-1",
      clearedBy: { role: "ADMIN" },
      ...overrides,
    };
  }

  // K1
  it("blocks a depicted minor with no MINORS clearance", () => {
    expect(
      evaluateSellability(withListing({ depictsMinors: true }), NOW),
    ).toEqual({ sellable: false, blocker: "minors_uncleared" });
  });

  // K1, the demoted-clearer half. A clearance signed by someone who is no
  // longer an admin is not one this instance stands behind, and the whole
  // point of re-reading the role at evaluation time is that a demotion
  // reaches the clearances that person already signed.
  it("blocks a depicted minor whose clearer is no longer an ADMIN", () => {
    const upload = withListing({
      depictsMinors: true,
      layerClearances: [minorsClearance({ clearedBy: { role: "USER" } })],
    });
    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "minors_uncleared",
    });
  });

  // K2
  it("blocks an upload where nobody has answered the minors question", () => {
    expect(
      evaluateSellability(withListing({ depictsMinors: null }), NOW),
    ).toEqual({ sellable: false, blocker: "triage_incomplete" });
  });

  it("does not read an unanswered minors question as a `no`", () => {
    // The distinction the whole mechanism exists for, stated as a
    // comparison rather than two separate assertions: the same upload is
    // sellable with the question answered `false` and blocked with it
    // unanswered. If `null` ever starts meaning `false`, these converge.
    expect(
      evaluateSellability(withListing({ depictsMinors: false }), NOW),
    ).toEqual({ sellable: true });
    expect(
      evaluateSellability(withListing({ depictsMinors: null }), NOW).sellable,
    ).toBe(false);
  });

  /**
   * K3. Asserts the NEXT blocker rather than `sellable: true`, so the test
   * cannot pass by the gate short-circuiting somewhere before the minors
   * check and never reaching it: music is also present and uncleared here,
   * and MUSIC is asked AFTER minors in TRIAGE_FACTS.
   */
  it("passes the minors check once cleared and goes on to the next blocker", () => {
    const upload = withListing({
      depictsMinors: true,
      containsMusic: true,
      layerClearances: [minorsClearance()],
    });

    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "third_party_layer_uncleared",
    });
  });

  it("clears the upload once minors and the layer after it are both settled", () => {
    const upload = withListing({
      depictsMinors: true,
      containsMusic: true,
      layerClearances: [
        minorsClearance(),
        {
          layer: RightsLayer.MUSIC,
          reason: "Sync and master licence covering resale, on file.",
          clearedByUserId: "admin-1",
          clearedBy: { role: "ADMIN" },
        },
      ],
    });

    expect(evaluateSellability(upload, NOW)).toEqual({ sellable: true });
  });

  /**
   * K4, the guardrail: a PEOPLE clearance must never settle a depicted
   * minor. A child IS an identifiable person, so the tempting shortcut is
   * to treat the model release as covering both — but a release signed by
   * a child is not a release, and the admin who wrote the PEOPLE reason
   * was answering a different question.
   *
   * Written as a FIXTURE MUTATION rather than two unrelated cases: the
   * same upload is evaluated with the PEOPLE layer uncleared and then
   * cleared, and the mutation must not move it to sellable. A pair of
   * independent "expect blocked" assertions would both pass against a gate
   * that had been rewritten to block everything.
   */
  it("does not let a PEOPLE clearance settle a depicted minor", () => {
    const base: Partial<GateListing> = {
      depictsPeople: true,
      depictsMinors: true,
      modelReleaseKey: "rights-evidence/owner-1/release.pdf",
    };
    const peopleClearance: GateLayerClearance = {
      layer: RightsLayer.PEOPLE,
      reason: "Release read; covers commercial resale, no time limit.",
      clearedByUserId: "admin-1",
      clearedBy: { role: "ADMIN" },
    };

    // Before the mutation: blocked, and blocked on PEOPLE.
    expect(evaluateSellability(withListing(base), NOW)).toEqual({
      sellable: false,
      blocker: "model_release_unverified",
    });

    // After it: the PEOPLE blocker is gone — so the clearance really did
    // take effect, and this is not a fixture that was broken some other
    // way — and the upload is still not sellable.
    const mutated = evaluateSellability(
      withListing({ ...base, layerClearances: [peopleClearance] }),
      NOW,
    );
    expect(mutated).toEqual({ sellable: false, blocker: "minors_uncleared" });

    // The same mutation on an upload with NO minor shown does reach
    // sellable, which is what makes the assertion above about minors
    // rather than about the fixture never being sellable at all.
    expect(
      evaluateSellability(
        withListing({
          ...base,
          depictsMinors: false,
          layerClearances: [peopleClearance],
        }),
        NOW,
      ),
    ).toEqual({ sellable: true });
  });
});

/**
 * ugcportal-qnq9.3: alcohol as a triage fact, and the one way it is not
 * like the others.
 *
 * docs/ugc-research.md §3.1a: alkoholloven § 9-2 bans alcohol from
 * appearing in advertising for other products, and Helsedirektoratet's
 * examples include pictures giving a clear association with alcohol
 * *whatever the glass actually contains*. The site's chosen angle is wine
 * ACCESSORIES — empty glasses, coolers, tool-type apps — and those are
 * monetisable.
 *
 * So this fact has to cut in both directions, and both are tested here:
 * `false` sells, because that is the entire business angle; `true` never
 * sells, and no clearance changes that; `null` blocks like every other
 * unanswered question.
 */
describe("ugcportal-qnq9.3: alcohol as a triage fact", () => {
  /** An ALCOHOL justification signed by a current admin. */
  function alcoholClearance(
    overrides: Partial<GateLayerClearance> = {},
  ): GateLayerClearance {
    return {
      layer: RightsLayer.ALCOHOL,
      reason: "It was grape juice, not wine.",
      clearedByUserId: "admin-1",
      clearedBy: { role: "ADMIN" },
      ...overrides,
    };
  }

  /**
   * The direction the rewritten bead exists for. An empty glass is an
   * accessory, not alcohol, and an accessory is sellable — a gate that
   * blocked everything wine-adjacent would pass every other test in this
   * describe and kill the angle the site is being built for.
   */
  it("sells an upload that answers the question `no`", () => {
    expect(
      evaluateSellability(withListing({ depictsAlcohol: false }), NOW),
    ).toEqual({ sellable: true });
  });

  it("blocks an upload in which alcohol is visible", () => {
    expect(
      evaluateSellability(withListing({ depictsAlcohol: true }), NOW),
    ).toEqual({ sellable: false, blocker: "alcohol_depicted" });
  });

  /**
   * The guardrail, written as a FIXTURE MUTATION rather than two unrelated
   * "expect blocked" assertions, which would both pass against a gate
   * rewritten to block everything.
   *
   * An admin signing "it was grape juice" is writing a sentence that may
   * well be true and that §3.1a still does not accept: the standard is what
   * the picture looks like. The same clearance shape settles MUSIC two
   * lines down, so the fixture is demonstrably a working one.
   */
  it("is not settled by an ALCOHOL clearance, however well signed", () => {
    expect(
      evaluateSellability(
        withListing({
          depictsAlcohol: true,
          layerClearances: [alcoholClearance()],
        }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "alcohol_depicted" });

    // The same input shape on a layer a clearance CAN settle does reach
    // sellable, so the assertion above is about ALCOHOL rather than about
    // `clearance()` being broken here.
    expect(
      evaluateSellability(
        withListing({
          containsMusic: true,
          layerClearances: [
            {
              layer: RightsLayer.MUSIC,
              reason: "Sync and master licence covering resale, on file.",
              clearedByUserId: "admin-1",
              clearedBy: { role: "ADMIN" },
            },
          ],
        }),
        NOW,
      ),
    ).toEqual({ sellable: true });
  });

  it("stays blocked when every other layer is present and cleared", () => {
    // Nothing else is left to blame: every clearable fact is `true` and
    // carries its own admin-signed justification, so the only reason this
    // upload does not sell is the alcohol in it.
    const upload = withListing({
      depictsPeople: true,
      modelReleaseKey: "rights-evidence/owner-1/release.pdf",
      depictsMinors: true,
      containsMusic: true,
      thirdPartyCreator: true,
      sponsoredContent: true,
      depictsAlcohol: true,
      layerClearances: Object.values(RightsLayer).map((layer) => ({
        layer,
        reason: "Cleared, with evidence on file.",
        clearedByUserId: "admin-1",
        clearedBy: { role: "ADMIN" as const },
      })),
    });

    expect(evaluateSellability(upload, NOW)).toEqual({
      sellable: false,
      blocker: "alcohol_depicted",
    });
  });

  it("blocks an upload where nobody has answered the alcohol question", () => {
    expect(
      evaluateSellability(withListing({ depictsAlcohol: null }), NOW),
    ).toEqual({ sellable: false, blocker: "triage_incomplete" });
  });

  it("does not read an unanswered alcohol question as a `no`", () => {
    // Stated as a comparison, like the minors case above: the same upload
    // sells with the question answered `false` and blocks with it
    // unanswered. If `null` ever starts meaning `false`, these converge —
    // and on this question that would publish a price beside a glass of
    // wine nobody was ever asked about.
    expect(
      evaluateSellability(withListing({ depictsAlcohol: false }), NOW),
    ).toEqual({ sellable: true });
    expect(
      evaluateSellability(withListing({ depictsAlcohol: null }), NOW).sellable,
    ).toBe(false);
  });

  /**
   * The wiring itself, pinned once. Not a tautology over the type: each
   * assertion names a value `tsc` would accept any other member of its
   * union in place of, and getting any of them wrong — a clearable
   * `settledBy`, a different column, a blocker meant for another layer —
   * produces a gate that still compiles and still passes the generic
   * per-fact table.
   */
  it("is registered against ALCOHOL as a fact nothing settles", () => {
    const fact = TRIAGE_FACTS.find(
      (candidate) => candidate.layer === RightsLayer.ALCOHOL,
    );

    expect(fact?.field).toBe("depictsAlcohol");
    expect(fact?.settledBy).toBe("nothing");
    expect(fact?.blocker).toBe("alcohol_depicted");
  });

  it("asks about the picture rather than about what was in the glass", () => {
    // §3.1a's actual standard, and the reason the question is phrased the
    // way it is. A question an admin could answer "no, it was juice" would
    // record the wrong fact perfectly.
    const fact = TRIAGE_FACTS.find(
      (candidate) => candidate.layer === RightsLayer.ALCOHOL,
    );

    expect(fact?.question).toContain("whatever it actually holds");
  });
});

/**
 * K5: the mechanism, not the fact. The failure mode is a second author
 * adding `depictsSomething Boolean?` to MediaListing, writing it from a
 * form, and nothing ever reading it — a "triage fact" that is decorative
 * while the upload sells regardless.
 */
describe("ugcportal-qn3: the triage-fact mechanism", () => {
  /**
   * The registration check. A RightsLayer with no TRIAGE_FACTS entry fails
   * the suite here, which is the only thing standing between "added an
   * enum value" and "added an enum value nothing enforces". The converse
   * is covered too: an entry for a layer the schema does not declare.
   */
  it("registers exactly one fact per RightsLayer, no more and no fewer", () => {
    const registered = TRIAGE_FACTS.map((fact) => fact.layer).sort();
    const declared = Object.values(RightsLayer).sort();

    expect(registered).toEqual(declared);
    // Spelled out so a duplicate entry — which `toEqual` on sorted arrays
    // would catch only by length — reads as its own failure.
    expect(new Set(registered).size).toBe(TRIAGE_FACTS.length);
  });

  it("stores each fact in its own column", () => {
    const fields = TRIAGE_FACTS.map((fact) => fact.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  // THERE IS NO TEST HERE FOR "every fact's blocker has words on the admin
  // screen", and the omission is deliberate. Anything this file could
  // assert about `fact.blocker` on its own is a tautology: it is typed
  // SellabilityBlocker, a closed union of non-empty literals, so every
  // in-type value passes a `typeof`/length check and an out-of-type one
  // fails `tsc` before any test runs. The claim is carried by `has a
  // sentence for every triage fact's uncleared blocker` in
  // src/app/admin/settings/rights/outcomes.test.ts, which indexes
  // BLOCKER_MESSAGES by `fact.blocker` and so fails on a blocker with no
  // wording. It lives there because that is where the wording map is.

  it("asks a question for every fact, so a form can be generated from it", () => {
    for (const fact of TRIAGE_FACTS) {
      expect(fact.question.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * NULL BLOCKS, FOR EVERY REGISTERED FACT — generated from the registry,
   * so a fact added later is asserted about without anyone remembering.
   *
   * This is the one that would have caught the copied-boolean mistake:
   * a column with no registry entry is not iterated here, and the
   * registration test above is what makes that impossible to reach.
   */
  for (const fact of TRIAGE_FACTS) {
    it(`blocks on an unanswered ${fact.field}, by itself`, () => {
      // Everything else about this listing is clean and signed, so
      // `triage_incomplete` can only be coming from this one column.
      expect(
        evaluateSellability(withListing({ [fact.field]: null }), NOW),
      ).toEqual({ sellable: false, blocker: "triage_incomplete" });
    });
  }

  it("refuses the whole upload while any one fact is unanswered", () => {
    // Answering all but one is not a triage. Asserted against the real
    // count rather than a hard-coded 5, so it keeps meaning the same thing
    // when a fact is added.
    expect(TRIAGE_FACTS.length).toBeGreaterThan(1);
    for (const unanswered of TRIAGE_FACTS) {
      const listing: Partial<GateListing> = {};
      for (const fact of TRIAGE_FACTS) {
        listing[fact.field] = fact.field === unanswered.field ? null : false;
      }
      expect(evaluateSellability(withListing(listing), NOW).sellable).toBe(
        false,
      );
    }
  });

  it("voids every answer at once when nobody currently admin signed them", () => {
    // Per upload, not per fact: the signature is what makes any of the
    // answers an assertion somebody is behind.
    expect(
      evaluateSellability(
        withListing({ triagedByUserId: "admin-1", triagedBy: { role: "USER" } }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "triage_not_signed_by_admin" });
  });

  it("asks whether a fact is answered before it asks who signed it", () => {
    // Order matters for the message an admin sees: an upload that is both
    // untriaged and unsigned is reported as untriaged, because that is the
    // first thing to do about it.
    expect(
      evaluateSellability(
        withListing({
          depictsMinors: null,
          triagedByUserId: null,
          triagedBy: null,
        }),
        NOW,
      ),
    ).toEqual({ sellable: false, blocker: "triage_incomplete" });
  });

  it("is the same function the gate uses, not a second copy of the rule", () => {
    // triageBlocker is exported for the admin screen and for tests; a copy
    // of the logic living in evaluateSellability is exactly how the two
    // drift. Asserted by agreement on a case each of them must answer.
    const listing = clearListing({ depictsMinors: true });
    expect(triageBlocker(listing)).toBe("minors_uncleared");
    expect(
      evaluateSellability(sellableUpload({ listing }), NOW),
    ).toEqual({ sellable: false, blocker: "minors_uncleared" });
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
