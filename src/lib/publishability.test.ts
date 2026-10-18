import { describe, expect, it } from "vitest";

import { MediaAuthorship, RightsLayer, Role } from "@/generated/prisma/enums";
import { CURRENT_ATTESTATION_VERSION } from "@/lib/attestation";
import {
  PUBLISH_ATTESTATION_BLOCKER_CODES,
  PUBLISH_BLOCKERS,
  PUBLISH_BLOCKER_MESSAGES,
  PUBLISH_PERMITTED_ATTESTATION_BLOCKERS,
  SALE_ATTESTATION_BLOCKER_CODES,
  publishRightsRefusal,
  publishabilityBlocker,
  type PublishabilityUpload,
} from "@/lib/publishability";

/**
 * ugcportal-3ae, at the predicate. The route's HTTP contract is asserted in
 * src/app/api/media/[id]/publish/route.test.ts; the agreement between this
 * predicate and the rights half of the query filter — which has to mean the
 * same thing, though the filter also carries a third, unrelated arm since
 * ugcportal-pgpq — is asserted, against a real database, in
 * src/lib/publishability.scope-agreement.test.ts.
 */

const OWNER = "owner-3ae";
const ADMIN = "admin-3ae";

const VALID_ATTESTATION = {
  attestedByUserId: OWNER,
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

const PEOPLE_CLEARANCE = {
  layer: RightsLayer.PEOPLE,
  reason: "Model release on file; covers online commercial publication.",
  // Only MUSIC carries a basis (ugcportal-hx2); every other layer's is null.
  basis: null,
  basisEvidence: null,
  clearedByUserId: ADMIN,
  clearedBy: { role: Role.ADMIN },
};

function upload(
  overrides: Partial<PublishabilityUpload> = {},
): PublishabilityUpload {
  return {
    userId: OWNER,
    attestation: VALID_ATTESTATION,
    listing: null,
    // Not configured, unless a case says so: every case written before
    // ugcportal-ho7j is about an ordinary uploader, and keeps testing that.
    uploaderConfigured: false,
    ...overrides,
  };
}

describe("the closed set of publish blockers", () => {
  it("has a message for every member, and every message is distinct", () => {
    // `tsc` already refuses a member with no entry. What it cannot catch is
    // two members sharing one sentence, which would make the two refusals
    // indistinguishable to the person reading them — the exact failure K2
    // is written against, arriving through the message instead of the code.
    const messages = PUBLISH_BLOCKERS.map(
      (blocker) => PUBLISH_BLOCKER_MESSAGES[blocker],
    );
    expect(messages).toHaveLength(PUBLISH_BLOCKERS.length);
    expect(new Set(messages).size).toBe(PUBLISH_BLOCKERS.length);
    for (const message of messages) {
      expect(message.trim().length).toBeGreaterThan(20);
    }
  });

  it("decides every attestation blocker the sale gate can produce, and no others", () => {
    /*
     * The runtime half of the `Record<AttestationBlocker, …>`. `tsc` proves
     * no key is MISSING; this proves none was added that
     * `attestationBlocker` never returns — a key for a code that does not
     * exist reads as a considered decision and is dead.
     */
    expect(PUBLISH_ATTESTATION_BLOCKER_CODES).toEqual(
      SALE_ATTESTATION_BLOCKER_CODES,
    );
  });

  it("permits exactly one of them to publish anyway: the under-18 declaration", () => {
    // The decision, as an assertion rather than as prose. Mapping a sixth
    // code to `null` — or this one back to a blocker — changes this line.
    expect(PUBLISH_PERMITTED_ATTESTATION_BLOCKERS).toEqual([
      "attestation_uploader_not_adult",
    ]);
  });
});

describe("K1: publishing requires the uploader's own declaration (uploader not configured)", () => {
  it("refuses an upload with no attestation at all", () => {
    expect(publishabilityBlocker(upload({ attestation: null }))).toBe(
      "attestation_missing",
    );
  });

  it("refuses an attestation missing an answer", () => {
    // The columns are NOT NULL, so this is the hand-assembled input the
    // sale gate's own completeness check is written for: a fixture, a
    // hand-written query, or a future select that maps a column wrong.
    expect(
      publishabilityBlocker(
        upload({
          attestation: {
            ...VALID_ATTESTATION,
            showsMinors: undefined as unknown as boolean,
          },
        }),
      ),
    ).toBe("attestation_incomplete");
  });

  it("refuses an attestation signed by anyone but the uploader", () => {
    expect(
      publishabilityBlocker(
        upload({
          attestation: { ...VALID_ATTESTATION, attestedByUserId: ADMIN },
        }),
      ),
    ).toBe("attestation_not_by_uploader");
  });

  it("refuses an attestation at a version no longer in force", () => {
    expect(
      publishabilityBlocker(
        upload({
          attestation: {
            ...VALID_ATTESTATION,
            attestationVersion: "1999-01-01.1",
          },
        }),
      ),
    ).toBe("attestation_version_retired");
  });

  it("refuses an uploader who disclaims the rights", () => {
    expect(
      publishabilityBlocker(
        upload({
          attestation: {
            ...VALID_ATTESTATION,
            authorship: MediaAuthorship.NEITHER,
          },
        }),
      ),
    ).toBe("attestation_rights_disclaimed");
  });

  it("refuses an upload with no recorded owner", () => {
    expect(publishabilityBlocker(upload({ userId: null }))).toBe(
      "upload_owner_unknown",
    );
    expect(publishabilityBlocker(upload({ userId: "   " }))).toBe(
      "upload_owner_unknown",
    );
  });

  it("publishes an upload whose uploader declared they are under 18", () => {
    // §3.2 is about capacity to grant a LICENCE. Publishing grants none.
    expect(
      publishabilityBlocker(
        upload({
          attestation: { ...VALID_ATTESTATION, uploaderIsAdult: false },
        }),
      ),
    ).toBeNull();
  });

  it("still refuses an under-18 declaration that is ALSO defective some other way", () => {
    /*
     * The ordering dependency `PUBLISH_ATTESTATION_BLOCKERS` relies on,
     * exercised from this side as well as pinned on the sale gate's: a
     * declaration that is both under-18 and at a retired version must not
     * publish merely because the first code this module forgives happens to
     * be reachable. `attestationBlocker` returns the version code, because
     * it checks the adult declaration last.
     */
    expect(
      publishabilityBlocker(
        upload({
          attestation: {
            ...VALID_ATTESTATION,
            uploaderIsAdult: false,
            attestationVersion: "1999-01-01.1",
          },
        }),
      ),
    ).toBe("attestation_version_retired");
  });

  it("publishes an ordinary, fully declared upload", () => {
    expect(publishabilityBlocker(upload())).toBeNull();
    expect(publishRightsRefusal(upload())).toBeNull();
  });
});

describe("K2: a person in the frame needs the PEOPLE layer settled", () => {
  const showingPeople = {
    ...VALID_ATTESTATION,
    showsIdentifiablePeople: true,
  };

  it("refuses on `people_uncleared` — not on an attestation code", () => {
    const blocker = publishabilityBlocker(
      upload({ attestation: showingPeople }),
    );
    // Asserted by name, against the one value that is right, rather than
    // also against a value that is merely wrong: `toBe("people_uncleared")`
    // already fails on any other blocker, including `attestation_missing`,
    // so a second assertion naming that one specifically added no case this
    // one did not already cover (review round 2, finding 2 — the twin of
    // round 1's finding 7 in route.test.ts, which removed the same shape).
    expect(blocker).toBe("people_uncleared");
  });

  it("publishes the same upload once a PEOPLE clearance exists", () => {
    expect(
      publishabilityBlocker(
        upload({
          attestation: showingPeople,
          listing: { depictsPeople: true, layerClearances: [PEOPLE_CLEARANCE] },
        }),
      ),
    ).toBeNull();
  });

  it("refuses when the clearer is no longer an admin", () => {
    expect(
      publishabilityBlocker(
        upload({
          attestation: showingPeople,
          listing: {
            depictsPeople: true,
            layerClearances: [
              { ...PEOPLE_CLEARANCE, clearedBy: { role: Role.USER } },
            ],
          },
        }),
      ),
    ).toBe("people_uncleared");
  });

  it("refuses when the clearance is unsigned", () => {
    expect(
      publishabilityBlocker(
        upload({
          attestation: showingPeople,
          listing: {
            depictsPeople: true,
            layerClearances: [
              { ...PEOPLE_CLEARANCE, clearedByUserId: null, clearedBy: null },
            ],
          },
        }),
      ),
    ).toBe("people_uncleared");
  });

  it("refuses when the justification is blank or whitespace", () => {
    for (const reason of ["", "   "]) {
      expect(
        publishabilityBlocker(
          upload({
            attestation: showingPeople,
            listing: {
              depictsPeople: true,
              layerClearances: [{ ...PEOPLE_CLEARANCE, reason }],
            },
          }),
        ),
      ).toBe("people_uncleared");
    }
  });

  it("refuses when some OTHER layer is cleared and PEOPLE is not", () => {
    for (const layer of [
      RightsLayer.MINORS,
      RightsLayer.MUSIC,
      RightsLayer.THIRD_PARTY_CREATOR,
      RightsLayer.SPONSORED_CONTENT,
      RightsLayer.ALCOHOL,
      RightsLayer.WINE_ACCESSORY,
    ]) {
      expect(
        publishabilityBlocker(
          upload({
            attestation: showingPeople,
            listing: {
              depictsPeople: true,
              layerClearances: [{ ...PEOPLE_CLEARANCE, layer }],
            },
          }),
        ),
        layer,
      ).toBe("people_uncleared");
    }
  });

  it("takes the ADMIN's `yes` even when the uploader said no", () => {
    // The two answers can disagree and the dangerous direction is the `no`.
    expect(
      publishabilityBlocker(
        upload({ listing: { depictsPeople: true, layerClearances: [] } }),
      ),
    ).toBe("people_uncleared");
  });

  it("takes the UPLOADER's `yes` even when the admin said no", () => {
    expect(
      publishabilityBlocker(
        upload({
          attestation: showingPeople,
          listing: { depictsPeople: false, layerClearances: [] },
        }),
      ),
    ).toBe("people_uncleared");
  });

  it("asks for nothing when neither says a person is shown", () => {
    // Including the untriaged case, which is every upload on this site: an
    // unanswered admin question must not become a precondition on the
    // owner's own publish.
    expect(publishabilityBlocker(upload({ listing: null }))).toBeNull();
    expect(
      publishabilityBlocker(
        upload({ listing: { depictsPeople: null, layerClearances: [] } }),
      ),
    ).toBeNull();
    expect(
      publishabilityBlocker(
        upload({ listing: { depictsPeople: false, layerClearances: [] } }),
      ),
    ).toBeNull();
  });
});

describe("the refusal body", () => {
  it("carries the blocker and its own message, never free text", () => {
    const refusal = publishRightsRefusal(upload({ attestation: null }));
    expect(refusal).toEqual({
      blocker: "attestation_missing",
      error: PUBLISH_BLOCKER_MESSAGES.attestation_missing,
    });
  });

  it("distinguishes the two K2 refusals in the body, not just in the code", () => {
    const missing = publishRightsRefusal(upload({ attestation: null }));
    const uncleared = publishRightsRefusal(
      upload({
        attestation: { ...VALID_ATTESTATION, showsIdentifiablePeople: true },
      }),
    );
    expect(missing?.blocker).not.toBe(uncleared?.blocker);
    expect(missing?.error).not.toBe(uncleared?.error);
  });
});

/**
 * ugcportal-ho7j K5, at the predicate: the 2x2 of (configured uploader or
 * not) x (declaration present or missing). The same 2x2 against the Prisma
 * scope, in a real database, is in
 * src/lib/publishability.scope-agreement.test.ts ("the configured-uploader
 * exemption, in the scope itself").
 */
describe("K5: a configured uploader's MISSING declaration, and only that, is exempt (ugcportal-ho7j)", () => {
  it("configured, declaration missing: no blocker", () => {
    // Fails if the exemption is removed: this is `attestation_missing` for
    // everybody else (next case).
    expect(
      publishabilityBlocker(
        upload({ attestation: null, uploaderConfigured: true }),
      ),
    ).toBeNull();
    expect(
      publishRightsRefusal(upload({ attestation: null, uploaderConfigured: true })),
    ).toBeNull();
  });

  it("NOT configured, declaration missing: still `attestation_missing`", () => {
    expect(
      publishabilityBlocker(
        upload({ attestation: null, uploaderConfigured: false }),
      ),
    ).toBe("attestation_missing");
  });

  it("configured, declaration PRESENT: every declaration blocker still applies", () => {
    // Fails if the exemption is widened to "configured uploaders skip the
    // declaration check" rather than "a configured uploader's MISSING
    // declaration is not a refusal".
    const configured = { uploaderConfigured: true } as const;
    expect(
      publishabilityBlocker(
        upload({
          ...configured,
          attestation: { ...VALID_ATTESTATION, authorship: MediaAuthorship.NEITHER },
        }),
      ),
    ).toBe("attestation_rights_disclaimed");
    expect(
      publishabilityBlocker(
        upload({
          ...configured,
          attestation: { ...VALID_ATTESTATION, attestationVersion: "1999-01-01.1" },
        }),
      ),
    ).toBe("attestation_version_retired");
    expect(
      publishabilityBlocker(
        upload({
          ...configured,
          attestation: { ...VALID_ATTESTATION, attestedByUserId: ADMIN },
        }),
      ),
    ).toBe("attestation_not_by_uploader");
    expect(
      publishabilityBlocker(
        upload({
          ...configured,
          attestation: { ...VALID_ATTESTATION, showsIdentifiablePeople: true },
        }),
      ),
    ).toBe("people_uncleared");
  });

  it("NOT configured, declaration present and clean: no blocker, as before", () => {
    expect(publishabilityBlocker(upload({ uploaderConfigured: false }))).toBeNull();
  });

  it("with no declaration, the listing alone decides whether a person is shown", () => {
    const undeclared = { attestation: null, uploaderConfigured: true } as const;
    expect(
      publishabilityBlocker(
        upload({
          ...undeclared,
          listing: { depictsPeople: true, layerClearances: [] },
        }),
      ),
    ).toBe("people_uncleared");
    expect(
      publishabilityBlocker(
        upload({
          ...undeclared,
          listing: { depictsPeople: true, layerClearances: [PEOPLE_CLEARANCE] },
        }),
      ),
    ).toBeNull();
    for (const depictsPeople of [false, null]) {
      expect(
        publishabilityBlocker(
          upload({ ...undeclared, listing: { depictsPeople, layerClearances: [] } }),
        ),
      ).toBeNull();
    }
    expect(publishabilityBlocker(upload({ ...undeclared, listing: null }))).toBeNull();
  });

  it("still refuses an upload with no owner, configured or not", () => {
    expect(
      publishabilityBlocker(
        upload({ userId: null, attestation: null, uploaderConfigured: true }),
      ),
    ).toBe("upload_owner_unknown");
  });
});
