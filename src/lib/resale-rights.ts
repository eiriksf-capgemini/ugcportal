import {
  ResaleRightsRoute,
  ResaleRightsStatus,
  MediaAuthorship,
  RightsLayer,
  type Role,
} from "@/generated/prisma/enums";
import {
  ACCEPTED_ATTESTATION_VERSIONS,
  ATTESTATION_QUESTIONS,
  type AttestationAnswers,
  isMediaAuthorship,
} from "@/lib/attestation";

/**
 * The sellability gate (ugcportal-0ss, re-anchored by ugcportal-vsm),
 * implementing Part E.3 of
 * docs/legal/instagram-resale-rights-checklist.md.
 *
 * Nothing may be offered for sale until a human ADMIN has recorded a
 * clearance for the person who uploaded it AND signed off what is in the
 * file itself. This module is the single place that decides that, so
 * curation (ugcportal-74w), checkout (ugcportal-p3v) and the public
 * catalogue cannot each grow their own slightly different version of the
 * rule.
 *
 * The grain is a hybrid, and the two halves answer different questions at
 * different frequencies:
 *
 *   1. PER UPLOADER — ResaleRightsReview. "May this person's own work be
 *      resold at all?" Asked once per person, expires, and stops counting
 *      when the checklist version it was granted under is retired.
 *   2. PER UPLOAD — MediaListing's triage plus a MediaRightsClearance per
 *      rights layer that is actually present. "What is in this file?" An
 *      identifiable person, a depicted minor, licensed music, an
 *      uncredited collaborator and undisclosed sponsorship are properties
 *      of the file, not of the uploader, so a cleared uploader does not
 *      get to sell whatever they upload next. The layers are not listed
 *      twice: TRIAGE_FACTS below is the list, and the gate iterates it.
 *
 * WHERE THE REVIEW COMES FROM IS THE SECURITY PROPERTY. The gate starts at
 * a Media row and follows `media.user.resaleRightsReview`. Nobody assembling
 * a listing picks which clearance applies, so there is no second value for
 * the owner check to disagree with — which is why ugcportal-0ss's
 * `clearedOwnerUserId` comparison (and its `media_not_owned` /
 * `rights_holder_not_recorded` blockers) are gone rather than ported. The
 * only relation in MEDIA_GATE_SELECT that reaches a review is the file's own
 * `user`, so a caller using it is reading the uploader's clearance by
 * construction rather than by remembering to.
 *
 * Everything here fails closed: a missing review row, a missing listing, an
 * un-triaged upload, an unknown checklist version and a demoted reviewer all
 * mean "not sellable". There is no input that produces `true` by default.
 *
 * The predicate is pure; callers load the row themselves with
 * MEDIA_GATE_SELECT below (inside the same transaction as any write they are
 * gating) and pass it in. That keeps the rule in one place without forcing
 * every caller through one query shape.
 */

/**
 * Checklist version currently in force — the string at the top of
 * docs/legal/instagram-resale-rights-checklist.md. New clearances are
 * recorded against this one.
 *
 * Bumped from `2026-09-24.1` by ugcportal-vsm. That version asked about the
 * content of one connected Instagram account; this one asks about an
 * uploader, and a clearance against an uploader authorises their entire past
 * and future upload history. A different question about a different subject
 * with a wider blast radius is precisely what retiring a version is for — see
 * E.0 in the checklist. The bump retires nothing in practice, because the
 * migration discarded every account-level clearance, which is exactly why it
 * was cheap to do now and would not have been later.
 */
export const CURRENT_CHECKLIST_VERSION = "2026-09-27.1";

/**
 * Versions a *past* clearance may still rely on. Revising the checklist in a
 * way that changes what the reviewer had to check means dropping the old
 * version from this set, which immediately makes every uploader cleared under
 * it unsellable until someone re-reviews them. That is the intended blast
 * radius: the alternative is selling under a review that never asked the
 * question the revision added.
 */
export const ACCEPTED_CHECKLIST_VERSIONS: ReadonlySet<string> = new Set([
  CURRENT_CHECKLIST_VERSION,
]);

/**
 * The product decision every clearance is currently made under: ugcportal-2eh
 * Option A — the file sold is always the owner-uploaded original from
 * ugcportal-8wa. Recorded on the review row so a later reader can tell which
 * decision the human was applying.
 */
export const PRODUCT_DECISION_REF = "ugcportal-2eh";

/**
 * Every status, derived from the generated enum rather than hand-listed, so
 * adding one to the schema can't leave a form or a test silently covering
 * five of six.
 */
export const RESALE_RIGHTS_STATUSES = Object.values(
  ResaleRightsStatus,
) as readonly ResaleRightsStatus[];

export const RESALE_RIGHTS_ROUTES = Object.values(
  ResaleRightsRoute,
) as readonly ResaleRightsRoute[];

export function isResaleRightsStatus(
  value: unknown,
): value is ResaleRightsStatus {
  return (
    typeof value === "string" &&
    (RESALE_RIGHTS_STATUSES as readonly string[]).includes(value)
  );
}

export function isResaleRightsRoute(value: unknown): value is ResaleRightsRoute {
  return (
    typeof value === "string" &&
    (RESALE_RIGHTS_ROUTES as readonly string[]).includes(value)
  );
}

/**
 * Why the uploader's own declaration (ugcportal-15r) does not hold. Separate
 * codes rather than one `attestation_invalid`, because each one names a
 * different person's next action: the uploader re-attests, an admin stops
 * ticking boxes on someone's behalf, everyone re-reads a revised document,
 * and the last two are not fixable at all.
 *
 * A NAMED SUBSET of SellabilityBlocker rather than six members spelled
 * inline there (ugcportal-3ae). The publish gate
 * (src/lib/publishability.ts) asks the same question about the same row and
 * reaches a DIFFERENT answer for one of these codes — publishing is not
 * selling — so it has to decide, per code, whether that code blocks a
 * publish too. It does that with a `Record<AttestationBlocker, …>`, which is
 * what makes a seventh code added here a `tsc` failure over there rather
 * than a code that silently permits a publish nobody considered.
 *
 * IN CHECK ORDER, matching `attestationBlocker` below, and the order is
 * load-bearing for exactly one reader: `attestation_uploader_not_adult` is
 * the LAST check, which is what lets the publish gate treat it as
 * non-blocking without also having to re-run the five before it. Pinned by
 * "checks the adult declaration last" in resale-rights.test.ts.
 */
export const ATTESTATION_BLOCKERS = [
  "attestation_missing",
  "attestation_incomplete",
  "attestation_not_by_uploader",
  "attestation_version_retired",
  "attestation_rights_disclaimed",
  "attestation_uploader_not_adult",
] as const;

export type AttestationBlocker = (typeof ATTESTATION_BLOCKERS)[number];

/** Why an upload is not sellable. Closed set, safe to render and to log. */
export type SellabilityBlocker =
  | "no_review"
  | "status_not_cleared"
  | "clearance_expired"
  | "checklist_version_retired"
  | "reviewer_not_admin"
  | "upload_owner_unknown"
  | AttestationBlocker
  | "not_listed_for_sale"
  | "triage_incomplete"
  | "triage_not_signed_by_admin"
  | "model_release_missing"
  | "model_release_unverified"
  | "minors_uncleared"
  | "alcohol_depicted"
  | "third_party_layer_uncleared";

export type SellabilityResult =
  | { sellable: true }
  | { sellable: false; blocker: SellabilityBlocker };

/** The review columns the gate reads, plus the reviewer's *current* role. */
export type GateReview = {
  status: ResaleRightsStatus;
  checklistVersion: string;
  reviewedByUserId: string | null;
  validUntil: Date | null;
  reviewedBy: { role: Role } | null;
};

/**
 * One layer's justification, with the clearer's *current* role — re-read for
 * the same reason the uploader reviewer's is: a demotion has to take effect
 * on the clearances that person signed.
 */
export type GateLayerClearance = {
  layer: RightsLayer;
  reason: string;
  clearedByUserId: string | null;
  clearedBy: { role: Role } | null;
};

/**
 * The sale record for one upload, as the gate sees it: the Part C triage and
 * the per-layer justifications. Absent (`null` on the upload) means nobody
 * has put this file forward for sale, which is not sellable.
 */
export type GateListing = {
  depictsPeople: boolean | null;
  /**
   * Is anyone shown under 18 (ugcportal-qn3)? A triage fact of its own, not
   * a shade of `depictsPeople`: see the MINORS entry in TRIAGE_FACTS below.
   */
  depictsMinors: boolean | null;
  modelReleaseKey: string | null;
  containsMusic: boolean | null;
  thirdPartyCreator: boolean | null;
  sponsoredContent: boolean | null;
  /**
   * Is alcohol visible, named or clearly evoked (ugcportal-qnq9.3)? The one
   * fact in the registry that no clearance settles; see the ALCOHOL entry in
   * TRIAGE_FACTS below.
   */
  depictsAlcohol: boolean | null;
  /**
   * Is the subject a wine accessory (ugcportal-qnq9.3)? The one fact in the
   * registry where NEITHER answer blocks; see the WINE_ACCESSORY entry in
   * TRIAGE_FACTS below.
   */
  wineAccessory: boolean | null;
  /**
   * Who signed off the triage flags above, with their *current* role. Every
   * one of those flags is an assertion about someone else's rights — "no
   * identifiable people", "no music" — and an unattributed assertion is not
   * one this gate accepts.
   */
  triagedByUserId: string | null;
  triagedBy: { role: Role } | null;
  /** One justification per layer; see layerIsCleared and TRIAGE_FACTS. */
  layerClearances: GateLayerClearance[];
};

/**
 * The uploader's own rights declaration about this file (ugcportal-15r), as
 * the gate sees it.
 *
 * EVERY ANSWER IS A PLAIN `boolean`, NOT `boolean | null`, which is the one
 * structural difference from `GateListing` above and the point of
 * ugcportal-15r K4. A triage column is nullable because an admin answers the
 * questions one screen at a time, long after the row exists, so `null` has to
 * mean "not answered yet". An attestation row is written complete or not at
 * all (`NOT NULL` on every column, no defaults — see the migration), so there
 * is no half-answered state for a `?? false` to turn into a warranty. "Not
 * asked" is `attestation: null` on the upload, and nothing can coerce the
 * absence of a row into a row of `no`s.
 *
 * `attestedByUserId` is typed nullable anyway, like `GateUpload.userId` above
 * and for the same stated reason: the column is `NOT NULL` under the real
 * schema, so an ordinary Prisma read cannot produce null, and the guard is
 * for a hand-assembled input.
 */
export type GateAttestation = AttestationAnswers & {
  attestedByUserId: string | null;
  attestationVersion: string;
};

/**
 * An upload as the gate sees it: the Media row, its uploader's standing
 * review, its own attestation, and its sale record.
 *
 * Shaped like the Prisma row so callers can pass the result of
 * MEDIA_GATE_SELECT straight in. Note the direction — the review hangs off
 * `user`, i.e. off the column that says who uploaded the file. That is the
 * anchor, and it is why this type has no "whose rights were cleared" field
 * to compare against.
 */
export type GateUpload = {
  userId: string | null;
  user: { resaleRightsReview: GateReview | null } | null;
  /**
   * `null` means NOBODY ASKED THE UPLOADER ANYTHING — the state every upload
   * made before ugcportal-15r is in, and the state an upload written by any
   * future second writer would be in. It is never "the uploader said no"; see
   * GateAttestation.
   */
  attestation: GateAttestation | null;
  listing: GateListing | null;
};

/**
 * The review columns the gate reads, named separately from the select below
 * so the nesting stays legible — this is the part that hangs off `user`,
 * which is the whole argument of this module.
 */
const REVIEW_GATE_SELECT = {
  status: true,
  checklistVersion: true,
  reviewedByUserId: true,
  validUntil: true,
  reviewedBy: { select: { role: true } },
} as const;

/**
 * Prisma `select` matching GateUpload exactly, rooted at Media. Shared so a
 * caller can't forget to load `reviewedBy.role` and quietly get
 * `reviewer_not_admin` — or, worse, hand-roll a narrower select that omits a
 * field the gate checks.
 *
 * Rooted at Media rather than at the listing on purpose: the path from the
 * file to the clearance that governs it (`user.resaleRightsReview`) is
 * written down here, once, instead of being re-derived by each caller. A
 * caller cannot substitute a different user's review without abandoning this
 * constant, which is a visible act rather than an omission.
 */
export const MEDIA_GATE_SELECT = {
  userId: true,
  user: { select: { resaleRightsReview: { select: REVIEW_GATE_SELECT } } },
  // The uploader's own declaration (ugcportal-15r). Written out rather than
  // spread from ATTESTATION_QUESTIONS for the same reason the listing's keys
  // are written out below — Prisma infers the row type from the literal — and
  // kept honest the same way: GateAttestation requires every answer, so a
  // missing key here fails `tsc` at the call sites that pass this select's
  // result to the gate, and "selects every attested answer the gate reads"
  // (resale-rights.test.ts) asserts these keys are exactly
  // ATTESTATION_QUESTIONS' fields plus the three below.
  attestation: {
    select: {
      attestedByUserId: true,
      attestationVersion: true,
      authorship: true,
      ownOriginalNotFromWeb: true,
      showsIdentifiablePeople: true,
      showsMinors: true,
      containsMusicNotOwned: true,
      otherCreativeContributor: true,
      brandOrSponsorship: true,
      aiGenerated: true,
      uploaderIsAdult: true,
    },
  },
  listing: {
    select: {
      // One key per TRIAGE_FACTS entry, plus the evidence pointer PEOPLE
      // needs. Written out rather than spread from the registry because
      // Prisma infers the row type from the literal — but it is not left to
      // memory either: GateListing requires every fact's column, so a
      // missing key here fails `tsc` at the call sites that pass this
      // select's result to the gate, and "routes the review through the
      // uploader and nowhere else" (resale-rights.test.ts) asserts these
      // keys are exactly TRIAGE_FACTS' fields plus the four below.
      depictsPeople: true,
      depictsMinors: true,
      modelReleaseKey: true,
      containsMusic: true,
      thirdPartyCreator: true,
      sponsoredContent: true,
      depictsAlcohol: true,
      wineAccessory: true,
      triagedByUserId: true,
      triagedBy: { select: { role: true } },
      layerClearances: {
        select: {
          layer: true,
          reason: true,
          clearedByUserId: true,
          clearedBy: { select: { role: true } },
        },
      },
    },
  },
} as const;

/**
 * Milliseconds for a value that is supposed to be a Date, or NaN.
 *
 * NaN is the honest answer for "not a readable instant", and every
 * comparison in this module is written so that NaN lands on the blocked
 * side. Anything that is not a Date — a string that survived a hand-written
 * query, a column a future select forgot to map — gets the same treatment
 * as an Invalid Date rather than throwing or being silently coerced.
 */
function timeOf(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number.NaN;
}

/**
 * True only for a real boolean. `null` means "not triaged"; so does
 * `undefined`, and so does anything else that turns up in a column typed
 * `Boolean?`. Written as a type check rather than `=== null` because
 * `undefined === null` is false, which used to let an untriaged
 * `depictsPeople` skip the model-release requirement entirely.
 */
function isTriaged(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * True when *this specific layer* carries a justification an admin signed.
 *
 * Per layer, not per upload. An earlier revision took any item-level
 * clearance as settling all three, so an upload cleared with "music licence
 * purchased" became sellable with an untriaged third-party creator and an
 * untriaged sponsorship attached — one answer standing in for three
 * unrelated questions, in a module whose contract is that nothing passes by
 * default.
 *
 * The clearer's role is re-read here rather than trusted from write time,
 * exactly as uploaderClearanceBlocker does for the reviewer: a justification
 * signed by someone since demoted is not one this instance stands behind.
 * Without it, a demoted admin's layer clearances quietly survive as long as
 * some *other* admin signed the uploader.
 */
export function layerIsCleared(
  /**
   * Narrowed to the one field this reads (ugcportal-3ae). It used to take a
   * whole `GateListing`, which is more than the question needs and more than
   * the publish gate has: `src/lib/publishability.ts` asks about exactly one
   * layer on a listing it loaded two columns of, and widening its read to
   * satisfy a parameter type would have meant loading the whole triage to
   * answer a question about none of it. The alternative — a second copy of
   * these four conditions over there — is this repo's defect family 4, a
   * rule enforced at one of N call sites.
   */
  listing: { layerClearances?: GateLayerClearance[] } | null | undefined,
  layer: RightsLayer,
): boolean {
  // `?? []` and `?.trim()` for the same reason as everything else in this
  // module: a missing relation or a null column must answer "not cleared",
  // not throw a TypeError that some caller might catch and treat as a
  // transient failure.
  const clearance = (listing?.layerClearances ?? []).find(
    (candidate) => candidate.layer === layer,
  );
  if (!clearance) {
    return false;
  }
  return Boolean(
    clearance.reason?.trim() &&
      clearance.clearedByUserId &&
      clearance.clearedBy?.role === "ADMIN",
  );
}

/**
 * ---------------------------------------------------------------------------
 * THE TRIAGE-FACT MECHANISM (ugcportal-qn3)
 * ---------------------------------------------------------------------------
 *
 * One registry entry per rights layer, and the gate iterates it. Three
 * properties follow from that, and all three are the reason it exists
 * rather than a hand-written list of `if`s:
 *
 *   1. NULL BLOCKS. A fact nobody has answered is `null` on the column, and
 *      `triageBlocker` refuses before it looks at anything else. "Not
 *      asked" and "asked, answer no" are different states and only one of
 *      them sells. Absence is never consent.
 *   2. PRESENT NEEDS ITS OWN CLEARANCE. `true` is settled only by a
 *      MediaRightsClearance for *that* layer, signed by someone who is an
 *      ADMIN at read time. No clearance covers two layers, so no single
 *      admin-written sentence settles two legal questions. A fact may also
 *      declare that NOTHING settles it (`settledBy: "nothing"`, today only
 *      ALCOHOL): there the registry says so once, rather than each call
 *      site remembering which of the answers is final. A third kind,
 *      `settledBy: "recorded"`, says the opposite — that NEITHER answer
 *      encumbers the item (today only WINE_ACCESSORY) — so for that one
 *      rule 2 does not apply at all and only rule 1 does.
 *   3. ADDING A FACT DOES NOT FAIL OPEN. The only way to add one is to add
 *      a RightsLayer and register it here: a layer with no entry fails
 *      "registers exactly one fact per RightsLayer, no more and no fewer"
 *      in resale-rights.test.ts, and an entry naming a column GateListing
 *      does not declare fails `tsc`, because TriageFactField is derived
 *      from that type. The failure mode this closes is the obvious one — a second
 *      author copies `depictsPeople Boolean?` onto MediaListing, writes it
 *      from a form, and nothing ever reads it, so the "fact" is decorative
 *      and the upload sells regardless (K5).
 *
 * What it deliberately does NOT do: decide the law. Whether a particular
 * depicted child needs guardian consent, and in what form, is
 * ugcportal-ryd; this makes the fact recordable, attributable and blocking.
 */

/** The MediaListing triage columns a fact may be stored in. */
export type TriageFactField = Extract<
  {
    [K in keyof GateListing]: GateListing[K] extends boolean | null ? K : never;
  }[keyof GateListing],
  string
>;

/** The part of a triage fact that does not depend on how `true` is settled. */
type TriageFactBase = {
  /** The nullable Boolean column on MediaListing holding the answer. */
  readonly field: TriageFactField;
  /** The layer this fact is registered against, one per RightsLayer. */
  readonly layer: RightsLayer;
  /**
   * The yes/no question an admin answers, as the curation form will ask it
   * (ugcportal-74w) and as the rights screen lists it today — the screen
   * maps over this array, which is what keeps the wording and the
   * enforcement from drifting apart ("asks a question for every rights
   * layer the schema declares", src/app/admin/settings/rights/page.test.tsx).
   */
  readonly question: string;
};

/**
 * What a `true` answer returns when nothing has settled it.
 *
 * NOT ON TriageFactBase, deliberately, and that placement is load-bearing
 * rather than tidy. It belongs only to the two kinds of fact that CAN block:
 * a `settledBy: "recorded"` fact has nothing to return, so it declares
 * `blocker?: never` and `tsc` refuses one that names a blocker — a blocker no
 * code path can reach would otherwise sit in the registry reading as
 * enforcement. The reverse direction is closed too: a blocking entry that
 * omits it fails `tsc`, so neither kind can be written with the wrong set of
 * properties.
 */
type TriageFactBlocker = { readonly blocker: SellabilityBlocker };

/**
 * One registered fact, discriminated by what a `true` answer is held
 * against.
 *
 * `settledBy` is REQUIRED on every entry rather than an optional
 * "unclearable" flag, and that is the fail-closed direction: an optional
 * negative flag left off a new entry would quietly make it clearable, which
 * is exactly the shape of mistake the rest of this module is built to
 * refuse. Written as a discriminated union, `tsc` refuses an entry that does
 * not say which kind it is.
 */
export type TriageFact = TriageFactBase &
  (
    | (TriageFactBlocker & {
        /**
         * `true` is settled by a MediaRightsClearance for this fact's layer,
         * signed by someone who is an ADMIN at read time.
         */
        readonly settledBy: "clearance";
        /**
         * An extra requirement checked *before* the clearance when the
         * answer is `true` — today only PEOPLE, which needs the release file
         * itself on top of an admin saying it covers this use. Returns its
         * own blocker, or null when satisfied.
         */
        readonly alsoRequires?: (
          listing: GateListing,
        ) => SellabilityBlocker | null;
      })
    | (TriageFactBlocker & {
        /**
         * `true` is final: no clearance, and no evidence file, makes this
         * upload sellable. Today only ALCOHOL (ugcportal-qnq9.3).
         */
        readonly settledBy: "nothing";
        /**
         * Not available here: `alsoRequires` describes what a clearance
         * needs alongside it, and there is no clearance to go alongside.
         * Optional-`never` leaves `undefined` as the only value this
         * property may hold, so an entry that carries a predicate fails
         * `tsc` rather than registering one the gate would never call —
         * verified by mutation (adding `alsoRequires: () => null` to the
         * ALCOHOL entry fails `npm run typecheck` with "Type '() => null' is
         * not assignable to type 'undefined'").
         */
        readonly alsoRequires?: never;
      })
    | {
        /**
         * NEITHER ANSWER ENCUMBERS THE ITEM. The question is asked, recorded
         * and attributed, and that is all it does: `true` and `false` both
         * pass, and only leaving it unanswered blocks — which it does in
         * phase 1, like every other fact, because an item nobody has
         * classified is an item nobody has looked at.
         *
         * Today only WINE_ACCESSORY (ugcportal-qnq9.3,
         * docs/ugc-research.md §3.1a). The site's wine angle IS the
         * accessory — an empty glass, a cooler, a tool-type wine app — and
         * §3.1a settles that accessories are monetisable. A fact whose `true`
         * blocked would therefore refuse the chosen business angle outright,
         * which is the mistake the bead was rewritten to undo.
         *
         * WHY A THIRD DISCRIMINANT RATHER THAN LEAVING IT OUT OF THE REGISTRY.
         * A column with no entry here is read by nothing (ugcportal-qn3 K5) —
         * the whole mechanism rests on that — so a fact kept outside it would
         * be decorative: nobody would have to answer it, and the layout
         * separation in ugcportal-qnq9.11 would be reading a column that is
         * NULL on every row. Registered, it is asked on the admin screen and
         * its absence blocks the sale.
         */
        readonly settledBy: "recorded";
        /**
         * Not available: see TriageFactBlocker. There is no state this fact
         * can be in that stops a sale except being unanswered, which phase 1
         * reports as `triage_incomplete` for every fact alike.
         */
        readonly blocker?: never;
        /**
         * Not available either, for the same reason the `"nothing"` variant
         * says: `alsoRequires` describes what a clearance needs alongside it,
         * and there is no clearance here to go alongside.
         */
        readonly alsoRequires?: never;
      }
  );

/**
 * Every rights layer, in the order the gate asks about them.
 * "registers exactly one fact per RightsLayer, no more and no fewer"
 * (resale-rights.test.ts) asserts this covers `RightsLayer` exactly —
 * every member once, nothing else — so neither this list nor the per-fact
 * case table generated from it can end up covering a subset.
 */
export const TRIAGE_FACTS: readonly TriageFact[] = [
  {
    field: "depictsPeople",
    layer: RightsLayer.PEOPLE,
    question: "Is an identifiable person shown?",
    settledBy: "clearance",
    blocker: "model_release_unverified",
    // The release file, on top of the clearance. A key alone is free text:
    // it can point at a document licensing something else, or at nothing.
    alsoRequires: (listing) =>
      listing.modelReleaseKey?.trim() ? null : "model_release_missing",
  },
  {
    field: "depictsMinors",
    layer: RightsLayer.MINORS,
    question: "Is anyone shown under 18?",
    settledBy: "clearance",
    blocker: "minors_uncleared",
    // No `alsoRequires` naming a guardian-consent document, deliberately.
    // What that document must say — specific, written, naming online
    // commercial publication, with the child's own view where they are old
    // enough — is ugcportal-ryd, and a half-specified file check here would
    // read as the legal threshold having been met. The MINORS clearance
    // reason carries it in the meantime, and until one exists the upload
    // does not sell.
  },
  {
    field: "containsMusic",
    layer: RightsLayer.MUSIC,
    question: "Is there audible music?",
    settledBy: "clearance",
    blocker: "third_party_layer_uncleared",
  },
  {
    field: "thirdPartyCreator",
    layer: RightsLayer.THIRD_PARTY_CREATOR,
    question: "Did anyone other than the uploader create or co-create it?",
    settledBy: "clearance",
    blocker: "third_party_layer_uncleared",
  },
  {
    field: "sponsoredContent",
    layer: RightsLayer.SPONSORED_CONTENT,
    question: "Was it made for a brand, or under a sponsorship?",
    settledBy: "clearance",
    blocker: "third_party_layer_uncleared",
  },
  {
    // ugcportal-qnq9.3 / docs/ugc-research.md §3.1a. The site's wine angle
    // is ACCESSORIES — empty glasses, coolers, tool-type apps — and those
    // are monetisable. The drink is not: alkoholloven § 9-2 bans alcohol
    // from appearing in advertising for other products, and
    // Helsedirektoratet's examples count a picture that gives a clear
    // association with alcohol *whatever the glass actually contains*.
    //
    // So the question is about what the image looks like, not about what
    // was really in the glass, and the answer is `settledBy: "nothing"`
    // rather than a layer somebody could clear. A clearance reading "it was
    // grape juice" would be a true sentence that does not make the picture
    // lawful to advertise with, and the registry is the only place that can
    // say so once for every caller. The fix for a `true` here is a different
    // photograph, not a signature.
    field: "depictsAlcohol",
    layer: RightsLayer.ALCOHOL,
    question:
      "Is alcohol visible, named or clearly evoked — including a glass that reads as wine or beer, whatever it actually holds?",
    settledBy: "nothing",
    blocker: "alcohol_depicted",
  },
  {
    // ugcportal-qnq9.3 / docs/ugc-research.md §3.1a, and the other half of
    // the same rule as the entry above. §3.1a's Decisions table settles the
    // site's wine angle as ACCESSORIES AND TOOLS — empty glasses, coolers,
    // wine apps — and says in terms that those are monetisable, because the
    // § 9-2 ban is on the drink appearing in advertising, not on the gear
    // around it.
    //
    // So this entry's whole content is `settledBy: "recorded"`: a `yes` here
    // is not a problem to be cleared, it is the subject of the site. The
    // question exists so that the accessory and the drink are distinguishable
    // ON THE RECORD rather than by someone's memory of a photograph — which
    // is what the item beside a price has to rest on if a regulator ever
    // asks — and so that ugcportal-qnq9.11 can lay commercial and personal
    // wine content out apart from each other.
    //
    // INDEPENDENT OF ALCOHOL, with no rule relating the two. A `true` here
    // does not soften `depictsAlcohol`: a cooler with labelled bottles on the
    // shelf is an accessory and shows alcohol, and the ALCOHOL entry above
    // stops it whatever this one says ("an accessory answer does not rescue
    // an item that shows the drink", resale-rights.test.ts).
    field: "wineAccessory",
    layer: RightsLayer.WINE_ACCESSORY,
    question:
      "Is the subject a wine accessory — an empty glass, a cooler, or a tool-type wine app?",
    settledBy: "recorded",
  },
];

/**
 * Part C of the checklist, in full: the one helper the gate iterates.
 * Returns the first blocker, or null when the whole triage holds.
 *
 * Three phases, in this order, and the order is the contract:
 *
 *   1. Every fact answered. One unanswered question blocks the upload, not
 *      just its own layer — a half-filled triage is not a triage, and
 *      answering all but one of them must not sell anything.
 *   2. The answers attributable to a current ADMIN. Each one is an
 *      assertion about a third party's rights and the dangerous direction
 *      is `false` ("no identifiable person here" is what sells the
 *      photograph), so an unsigned or since-demoted signature voids all of
 *      them at once rather than per fact.
 *   3. Each `true` settled on its own terms — or, for a fact the registry
 *      marks `settledBy: "nothing"`, not settled at all; or, for one marked
 *      `settledBy: "recorded"`, nothing to settle, because neither answer
 *      encumbers the item.
 */
export function triageBlocker(listing: GateListing): SellabilityBlocker | null {
  for (const fact of TRIAGE_FACTS) {
    if (!isTriaged(listing[fact.field])) {
      return "triage_incomplete";
    }
  }

  if (!listing.triagedByUserId || listing.triagedBy?.role !== "ADMIN") {
    return "triage_not_signed_by_admin";
  }

  for (const fact of TRIAGE_FACTS) {
    const answer = listing[fact.field];
    // `=== false` rather than `!== true`, which is not a style choice.
    // Phase 1 already guarantees a real boolean here, so the two read the
    // same today — but `!== true` treats `null` as "skip", which is the
    // fail-OPEN reading, so weakening or reordering phase 1 later would
    // turn an unanswered fact into an absent one with nothing to notice.
    // Written this way the skip needs an explicit `no`, and anything else
    // falls through to the block below.
    if (answer === false) {
      continue;
    }
    if (!isTriaged(answer)) {
      return "triage_incomplete";
    }
    // A fact the registry records for its own sake is answered here and goes
    // no further in the permitting direction: neither answer encumbers the
    // item, so there is nothing to settle and nothing to block on
    // (WINE_ACCESSORY — §3.1a's accessories are monetisable).
    //
    // THIS BRANCH IS FIRST, AND `tsc` KEEPS IT FIRST. Below it, `fact` is
    // narrowed to the two variants that carry a `blocker`; move this test
    // after them and `fact.blocker` is `SellabilityBlocker | undefined`,
    // which does not typecheck as a return value. So the one ordering in
    // which a non-encumbering fact could fall through to a blocker that does
    // not exist is not expressible.
    //
    // Written as `=== "recorded"` rather than a negation, which is the
    // opposite choice from the line below it and for the same underlying
    // reason: this is the branch that PERMITS, so only the exact discriminant
    // may reach it. An object whose `settledBy` is unreadable — a
    // hand-built fixture, a registry assembled at runtime — falls past this
    // test and is blocked by the next one.
    if (fact.settledBy === "recorded") {
      continue;
    }
    // A fact nothing settles is answered here and goes no further: no
    // clearance is consulted, so none can be written to get past it. This
    // branch is what makes ALCOHOL a stop rather than a hurdle, and it is
    // read off the registry so the rule lives beside the fact it governs.
    //
    // Written as `!== "clearance"` rather than `=== "nothing"`, for the same
    // reason phase 3 skips on `=== false` rather than `!== true`. `tsc`
    // refuses an entry with a missing or unrecognised `settledBy` (verified
    // by mutation: removing the key from the ALCOHOL entry fails
    // `npm run typecheck`), but an object that reached here some other way —
    // a hand-built fixture, a registry assembled at runtime — would then
    // have an unreadable discriminant, and the readings differ on exactly
    // that input: this one blocks, `=== "nothing"` would fall through to the
    // clearance path and sell on an admin's signature.
    if (fact.settledBy !== "clearance") {
      return fact.blocker;
    }
    const missingEvidence = fact.alsoRequires?.(listing) ?? null;
    if (missingEvidence) {
      return missingEvidence;
    }
    if (!layerIsCleared(listing, fact.layer)) {
      return fact.blocker;
    }
  }

  return null;
}

/**
 * Item 7 of the target contract in docs/legal/manual-upload-rights-review.md
 * §4: "an uploader attestation exists for this file, at an accepted
 * attestation version, made by `Media.userId` (not by an admin on their
 * behalf)." Returns the blocker, or null when the declaration holds.
 *
 * `uploaderUserId` is passed in rather than read off a field on the
 * attestation, so the comparison is always against the file's OWN owner.
 * There is no second value here for the owner check to disagree with, which
 * is the same construction `uploaderClearanceBlocker` relies on one function
 * down.
 *
 * WHAT THIS DOES NOT DO, deliberately, and this is the boundary of
 * ugcportal-15r rather than an omission. Six of the nine answers — people,
 * minors, music, another contributor, brand/sponsorship, AI — are the same
 * questions MediaListing's triage asks an ADMIN, and this function reads none
 * of them. Nothing here decides what it means when the uploader says "yes,
 * there is music" and the admin triaged `containsMusic: false`, or the other
 * way round. That question is open, it is not this bead's to settle, and
 * answering it by quietly taking the stricter of the two would hard-code a
 * policy nobody chose into a function whose other rules are all written down.
 * The answers are stored and attributed so the disagreement can be SEEN
 * (ugcportal-vlnn renders them side by side); what it costs is
 * ugcportal-9pic.
 *
 * The three it does act on are the three nobody else asks, so no disagreement
 * is possible:
 *
 *   - `authorship: NEITHER` — the uploader says they are neither the author
 *     nor licensed by the author. There is nothing for them to grant, and no
 *     admin triage flag expresses this at all (§3.1).
 *   - `uploaderIsAdult: false` — §3.2: under vergemålsloven a resale licence
 *     granted by someone under 18 is at best voidable. Blocking on an
 *     explicit "no" is reading the answer that was collected; it is not age
 *     VERIFICATION, which nothing here does and which is ugcportal-5pik.
 *   - a version no longer accepted — nobody but this module tracks that.
 */
export function attestationBlocker(
  attestation: GateAttestation | null,
  uploaderUserId: string,
): AttestationBlocker | null {
  // (a) Fail closed, and fail closed with a code that says SILENCE rather
  // than a code that says no. Every upload made before ugcportal-15r is in
  // this state, as is anything a future second write path creates without an
  // attestation — which is the state K3's repository scan exists to keep from
  // arriving unnoticed.
  if (!attestation) {
    return "attestation_missing";
  }

  // (b) Every answer present and of the right shape.
  //
  // The columns are `NOT NULL` and `GateAttestation` types them `boolean`, so
  // an ordinary Prisma read cannot reach this branch — which is exactly why
  // it is here rather than left to the type. The input this guards is the
  // hand-assembled one: a fixture, a hand-written query, a future select that
  // maps a column wrong. `typeof value === "boolean"` rather than a null
  // check, for the reason `isTriaged` gives above: `undefined === null` is
  // false, and that specific reading is how a fail-open got into this module
  // once already.
  //
  // Iterated over ATTESTATION_QUESTIONS rather than listed, so a tenth
  // question added to the form and the schema cannot be left unchecked here.
  for (const { field } of ATTESTATION_QUESTIONS) {
    if (typeof attestation[field] !== "boolean") {
      return "attestation_incomplete";
    }
  }
  if (!isMediaAuthorship(attestation.authorship)) {
    return "attestation_incomplete";
  }

  // (c) Made by the uploader, not by an admin on their behalf. This is the
  // one check that makes the table worth more than the triage it sits beside:
  // an attestation signed by somebody who did not make the file is the same
  // admin-asserts-what-they-cannot-know problem §3.1 describes, wearing the
  // uploader's name.
  if (
    typeof attestation.attestedByUserId !== "string" ||
    attestation.attestedByUserId !== uploaderUserId
  ) {
    return "attestation_not_by_uploader";
  }

  // (d) At a version still in force. A revision that adds or narrows a
  // question retires the old string, and every upload attested under it stops
  // selling until its uploader answers the new text.
  if (!ACCEPTED_ATTESTATION_VERSIONS.has(attestation.attestationVersion)) {
    return "attestation_version_retired";
  }

  // (e) The uploader says there is nothing for them to grant. No clearance
  // settles this and none is consulted — the same `settledBy: "nothing"`
  // shape ALCOHOL has in TRIAGE_FACTS, for the same reason: the fix is a
  // different file, not a signature.
  if (attestation.authorship === MediaAuthorship.NEITHER) {
    return "attestation_rights_disclaimed";
  }

  // (f) §3.2. Self-declared, unverified, and still the pragmatic floor: a
  // licence this platform cannot rely on is not one it should be selling.
  if (!attestation.uploaderIsAdult) {
    return "attestation_uploader_not_adult";
  }

  return null;
}

/**
 * Steps 1–4 of Part E.3: is this *uploader* cleared right now. Returns the
 * blocker, or null when the standing clearance holds.
 *
 * Split out because the admin screen needs exactly this question — "is this
 * uploader's clearance currently good?" — and a screen that answered it with
 * its own copy of the rule would eventually disagree with the gate.
 */
export function uploaderClearanceBlocker(
  review: GateReview | null,
  now: Date = new Date(),
): SellabilityBlocker | null {
  // (1) Fail closed. A missing review row is UNREVIEWED — an uploader nobody
  // has looked at, which is the state everyone starts in.
  if (!review) {
    return "no_review";
  }
  if (review.status !== ResaleRightsStatus.CLEARED) {
    return "status_not_cleared";
  }

  // (2) A clearance with a validity window stops counting the moment it ends.
  // No background job is required for the gate to be correct — EXPIRED as a
  // *status* is bookkeeping, this comparison is the enforcement.
  //
  // Written as `!(expiry > now)` rather than `expiry <= now`, which is not a
  // style choice. An Invalid Date's getTime() is NaN, and every comparison
  // against NaN is false — so `expiry <= now` answered "not expired" for a
  // date nobody can read, and the gate could return sellable. Inverting a
  // `>` makes the unreadable case fall to the blocked side, because `NaN >
  // n` is false and `!false` is true. Same for a caller that hands in a
  // broken `now`.
  //
  // `validUntil` truthiness rather than `!== null` covers `undefined` too: a
  // row assembled by hand, or a future select that omits the column, would
  // otherwise have thrown on `.getTime()`.
  if (review.validUntil) {
    const expiresAt = timeOf(review.validUntil);
    if (!(expiresAt > timeOf(now))) {
      return "clearance_expired";
    }
  }

  // (3) Re-checked here rather than trusted from write time: the reviewer may
  // have been demoted since, and a clearance signed by someone who is no
  // longer an admin is not a clearance this instance stands behind.
  if (!review.reviewedByUserId || review.reviewedBy?.role !== "ADMIN") {
    return "reviewer_not_admin";
  }

  // (4) A retired checklist version forces re-review.
  if (!ACCEPTED_CHECKLIST_VERSIONS.has(review.checklistVersion)) {
    return "checklist_version_retired";
  }

  // There is deliberately no (5) "does the clearance say whose rights it
  // covers". It always does, and it cannot say anything else: the review row
  // hangs off the uploader, so the only way to reach it is through the file's
  // own owner. ugcportal-0ss needed `rights_holder_not_recorded` because its
  // review hung off a connected account and had to name a user separately.
  return null;
}

/**
 * Part E.3, in order. Returns the *first* blocker rather than a list: the
 * admin has to fix them one at a time anyway, and a single code keeps the
 * caller's messaging a closed set.
 *
 * `now` is injectable so the expiry branch is testable without faking the
 * clock globally.
 */
export function evaluateSellability(
  upload: GateUpload,
  now: Date = new Date(),
): SellabilityResult {
  // (0) A file with no owner has no uploader to have been cleared. Under the
  // real schema `Media.userId` is a non-null foreign key, so an ordinary
  // Prisma read is not expected to produce this — the guard is for a
  // hand-assembled input (a fixture, a hand-written query, a future select
  // that maps the column wrong), which is exactly how the
  // `undefined === null` fail-open got in last time. It claims nothing about
  // what the column can hold; it says that if the value is ever not a
  // non-blank string — a number, an object, undefined — the answer is no
  // rather than a TypeError.
  if (typeof upload.userId !== "string" || !upload.userId.trim()) {
    return { sellable: false, blocker: "upload_owner_unknown" };
  }

  // (1–4) The uploader's standing clearance, reached through the file's own
  // owner. `user` being absent is the same answer as the review being
  // absent: nobody has cleared the person who uploaded this.
  const review = upload.user?.resaleRightsReview ?? null;
  const uploaderBlocker = uploaderClearanceBlocker(review, now);
  if (uploaderBlocker) {
    return { sellable: false, blocker: uploaderBlocker };
  }

  // (5) The uploader's own declaration about THIS FILE
  // (ugcportal-15r; §4 item 7). Placed here, between the uploader's standing
  // clearance and the admin's per-upload triage, because that is the order
  // §4 sets out and because it is the order the facts are created in: a
  // person is cleared once, declares once per file at upload, and is triaged
  // by an admin afterwards. A `bare` upload with no listing therefore reports
  // `attestation_missing` rather than `not_listed_for_sale`, which is the
  // more useful of the two — the sale record is an admin's next action, the
  // missing declaration is a question nobody ever put to the only person who
  // could answer it.
  const attestation = attestationBlocker(upload.attestation ?? null, upload.userId);
  if (attestation) {
    return { sellable: false, blocker: attestation };
  }

  // (6) The upload has to have been put forward for sale at all. The
  // clearance above says the *person* may resell their work; it says nothing
  // about this particular file, and an upload nobody has triaged is an
  // upload nobody has looked at.
  const listing = upload.listing;
  if (!listing) {
    return { sellable: false, blocker: "not_listed_for_sale" };
  }

  // (7) Per-upload triage (Part C). The uploader-level clearance covers the
  // owner's own copyright only.
  //
  // One call, over TRIAGE_FACTS — not a list of per-column checks here.
  // Pairing each triage column with its own RightsLayer in one registry is
  // what keeps a single justification from covering unrelated questions,
  // and what makes a layer added later fail the suite rather than go
  // unenforced; see the mechanism comment above triageBlocker.
  const triage = triageBlocker(listing);
  if (triage) {
    return { sellable: false, blocker: triage };
  }

  // The file sold is the owner-uploaded original (ugcportal-8wa), which is
  // now a structural fact rather than a check: this predicate starts at a
  // Media row, and MediaListing.mediaId is a real foreign key to it. Under
  // ugcportal-0ss the listing carried an unconstrained `mediaId` string and
  // the gate had to prove the pointer resolved and pointed at the right
  // person's file. There is no pointer left to get wrong.
  //
  // Part E.3 phrases the Option A boundary as "unless productDecisionRef
  // records a different decision"; no such decision exists, and a
  // data-driven bypass of a Platform-Terms boundary is not something this
  // gate offers. If one is ever taken, it belongs in code, in review.
  return { sellable: true };
}

/** Boolean form of {@link evaluateSellability}, for call sites that only branch. */
export function isSellable(upload: GateUpload, now: Date = new Date()): boolean {
  return evaluateSellability(upload, now).sellable;
}
