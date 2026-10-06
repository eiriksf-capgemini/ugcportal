import type { BenefitKind } from "@/generated/prisma/enums";

/**
 * The advertising-labelling rules (ugcportal-qnq9.1), in one module with no
 * runtime imports.
 *
 * WHAT THIS IS FOR. Forbrukertilsynet requires that any item the operator was
 * paid for, or received another benefit for, carries a prominent advertising
 * label, and that the label comes first (docs/ugc-research.md §3.2). §5.7 adds
 * that the site being written in English changes nothing, because it is run
 * from Norway. Both the regulator and the brand are held responsible for an
 * undisclosed advertisement, so this is a compliance rule rather than a
 * presentation preference.
 *
 * NO PRISMA IMPORT, and no import that reaches one. Nothing client-side needs
 * these rules today — unlike src/lib/media-rules.ts, which is split out
 * precisely because the upload form runs it in a browser — so that is not the
 * claim being made here. The claim is narrower: the label rules are decidable
 * from a string, so a test of them should not need a database, and the publish
 * gate's decision should be testable without standing one up. The single
 * `import type` above erases.
 *
 * WHAT IS NOT HERE: rendering. Putting the label first on the gallery tile,
 * in the lightbox and in the public feed is ugcportal-qnq9.1's part B, which
 * widens MEDIA_ANONYMOUS_SELECT. This module decides what may be STORED and
 * what may be PUBLISHED; it has no opinion about markup.
 */

/**
 * The labels an item may carry, and the exact spelling each is stored as.
 *
 * BILINGUAL BY DECISION, not by preference. §5.7: "the label must be clear to
 * your audience. Using 'Advertisement / Reklame' (or 'Advertisement /
 * Annonse') covers both English-speaking and Norwegian followers." The site's
 * language is English (the Decisions table in docs/ugc-research.md), and §3.1
 * warns against assuming an English-language post escapes Norwegian law — so
 * the English word alone is not on this list, while the Norwegian words alone
 * are: "Reklame" and "Annonse" are the two words Forbrukertilsynet itself
 * recommends (§3.2), and they are what the standard is written in.
 *
 * "Advertisement", never "Ad" — ugcportal-qnq9.14, Eirik's own call. "Ad" is
 * not on this list in any combination.
 *
 * A CLOSED ALLOWLIST rather than a "does it look like a label" heuristic. The
 * downside of an allowlist is that a lawful wording nobody thought of is
 * refused, and that is the right way round: a refused label costs the operator
 * one message, and an accepted-but-non-compliant one costs a regulator
 * finding on a page that looks fine.
 */
export const PERMITTED_ADVERTISING_LABELS = Object.freeze([
  "Advertisement / Reklame",
  "Advertisement / Annonse",
  "Reklame",
  "Annonse",
] as const);

export type PermittedAdvertisingLabel =
  (typeof PERMITTED_ADVERTISING_LABELS)[number];

/**
 * The wordings Forbrukertilsynet names as NOT acceptable (§3.2), plus the
 * obvious English equivalents.
 *
 * The English half is not in the regulator's own text and is added
 * deliberately: the site is written in English, so "sponsored" and "gifted"
 * are the first words anyone reaches for, and the Norwegian list would not
 * catch either. "gifted" is on Forbrukertilsynet's own list already.
 *
 * STRICTLY REDUNDANT against the allowlist above — none of these is a
 * permitted label, so every one of them would be refused anyway. They are
 * listed because the MESSAGE differs and the difference is the point: "that
 * is not one of the permitted labels" invites the operator to try another
 * near-miss, where "Forbrukertilsynet names this word as unacceptable" tells
 * them why the one they reached for is wrong. Matched as whole words, so a
 * phrase containing one ("Sponset innhold") is caught too.
 */
export const FORBIDDEN_ADVERTISING_LABEL_TERMS = Object.freeze([
  "sponset",
  "i samarbeid med",
  "affiliatelenke",
  "gifted",
  "gave",
  "ambassadør",
  "invitert",
  "sponsored",
  "in collaboration with",
  "affiliate link",
  "gift",
  "ambassador",
  "invited",
] as const);

/**
 * The opening words of the refusal the FORBIDDEN list — and only that list —
 * produces.
 *
 * Exported so a test can assert that a refusal came from the forbidden path
 * specifically, rather than from the allowlist fall-through that would
 * refuse the same input anyway. Producing this message is the ONLY behaviour
 * FORBIDDEN_ADVERTISING_LABEL_TERMS adds (see its own note on being
 * redundant against the allowlist), so an assertion that merely checks
 * `ok === false`, or that the message mentions the submitted term, holds
 * just as well with the whole list deleted — the generic refusal interpolates
 * the caller's input and appends the permitted labels, so both needles are
 * present either way. advertising-disclosure.test.ts therefore asserts this
 * marker on every forbidden row, and asserts its ABSENCE on a non-forbidden
 * refusal.
 *
 * A constant rather than the string typed again in the test file, so the two
 * cannot drift: this is the string the message is built from.
 */
export const FORBIDDEN_LABEL_REFUSAL_PREFIX =
  "Forbrukertilsynet does not accept";

/**
 * English-only labels that are refused with a reason of their own.
 *
 * These cannot go in the term list above: "advertisement" is a WORD IN two of
 * the permitted labels, so a whole-word term match on it would refuse
 * "Advertisement / Reklame" as well. They are compared as whole VALUES
 * instead, and only to replace the generic refusal with the specific one —
 * §3.1's warning that an English-language post does not escape Norwegian law.
 */
export const ENGLISH_ONLY_ADVERTISING_LABELS = Object.freeze([
  "Ad",
  "Advertisement",
] as const);

/**
 * Longest string this will even look at, in UTF-16 code units.
 *
 * Not a product rule — the allowlist below already bounds a STORED label to
 * the longest value on it. It is a bound on the WORK done before the
 * allowlist decides:
 * `labelWords` below runs a global Unicode regex over whatever arrives, and a
 * route handler must not do that to a megabyte because the caller felt like
 * sending one. 256 is far above anything that could ever be a near-miss of a
 * two-word label and far below anything worth scanning.
 */
export const MAX_ADVERTISING_LABEL_INPUT_LENGTH = 256;

export type AdvertisingLabelValidation =
  | { ok: true; value: PermittedAdvertisingLabel }
  | { ok: false; message: string };

/**
 * The words of a string, lower-cased, with punctuation and spacing dropped.
 *
 * A TOKENISER RATHER THAN `\b`-ANCHORED REGEXES, for two reasons that are
 * both exercised by entries in the lists this serves.
 *
 * Whitespace: three forbidden entries are PHRASES ("i samarbeid med", "in
 * collaboration with", "affiliate link") and two permitted labels are two
 * words around a slash. A literal-space pattern is exact about spacing that
 * carries no meaning — `/\bi samarbeid med\b/u` does not match "i  samarbeid
 * med" — so each of those would need its own whitespace-tolerant spelling.
 * Comparing word SEQUENCES makes spacing and punctuation stop existing, once,
 * for both lists and for the permitted-label match below.
 *
 * Non-ASCII letters: JavaScript's `\b` is defined over `[A-Za-z0-9_]` even
 * under `/u`, so a Norwegian letter counts as a word SEPARATOR. `/\bgave\b/u`
 * therefore matches inside "ågave", flagging a word that is not on the list
 * and refusing it with a message naming one that is. Tokenising on `\p{L}`
 * makes "ågave" one token, which is what it is. Both failures are pinned by
 * the test named "the \\b trap" in advertising-disclosure.test.ts, so a later
 * tidy-up back to boundary regexes fails rather than quietly misbehaving.
 *
 * NO UNICODE NORMALISATION HERE, deliberately, unlike `benefitSourceSlug`
 * (src/lib/benefit-source.ts) which does normalise. A brand name is arbitrary
 * text whose composed and decomposed spellings must resolve to one identity;
 * these two lists are seventeen fixed strings, not one of which contains a
 * character that has a canonical decomposition — "ø" notably does not, it is
 * a letter with a stroke rather than a letter plus a combining mark. Calling
 * `.normalize()` here would therefore be a no-op dressed as a safeguard, and
 * it could not be the safeguard anyway: a label spelled with combining marks
 * is not one of the four permitted values, so the allowlist refuses it
 * whatever these tokens come out as. Only the refusal MESSAGE is at stake.
 */
function labelWords(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** True when `words` contains `phrase`'s words contiguously, in order. */
function containsPhrase(words: string[], phrase: string[]): boolean {
  if (phrase.length === 0) return false;
  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (words[start + offset] !== phrase[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The permitted label `value` spells, or null.
 *
 * CASE-INSENSITIVE, AND TOLERANT OF SPACING AROUND THE SLASH, canonicalising
 * to the exact spelling in PERMITTED_ADVERTISING_LABELS. "REKLAME",
 * "advertisement/reklame" and "Advertisement  /  Reklame" are the same label
 * said three ways; refusing two of them would be refusing a correct
 * disclosure over its capitalisation, which no reading of §3.2 supports.
 *
 * Comparison is on the WORD SEQUENCE, which is what makes the spacing and
 * punctuation tolerance fall out rather than needing a second rule — and it
 * is also what keeps the tolerance from widening into something it should not
 * be. "Reklame Advertisement" has the same words as no permitted label (order
 * matters) and "Advertisement / Reklame, maybe" has an extra one, so both are
 * refused.
 */
function canonicalAdvertisingLabel(
  value: string,
): PermittedAdvertisingLabel | null {
  const words = labelWords(value);
  if (words.length === 0) return null;
  return (
    PERMITTED_ADVERTISING_LABELS.find((permitted) => {
      const permittedWords = labelWords(permitted);
      return (
        permittedWords.length === words.length &&
        permittedWords.every((word, index) => word === words[index])
      );
    }) ?? null
  );
}

/**
 * Validates an advertising label, answering with the exact string to store.
 *
 * REJECTS RATHER THAN REPAIRS anything that is not a permitted label — the
 * same call `validateOriginalName` and `validateAltText` make, for the same
 * reason: this is a value someone deliberately typed into a form immediately
 * before submitting it, so there is no "theirs, but slightly mangled" version
 * worth storing. The canonicalisation above is not a repair; it chooses the
 * spelling of a label the caller already supplied.
 *
 * NOT run through `hasUnsafeText` (src/lib/media-rules.ts), and that absence
 * is deliberate rather than an omission: every value this function can return
 * is one of the four literals above, so no caller's input string is ever
 * stored — only a literal chosen here — and a control character or a bidi
 * override cannot reach the column through this validator. (A raw write
 * straight to the table bypasses it, which is why the publish gate re-checks
 * the stored value against the same allowlist rather than trusting it.)
 * Adding the check here would be a defence that nothing can exercise — which
 * this codebase's own comments warn against elsewhere.
 */
export function validateAdvertisingLabel(
  value: unknown,
): AdvertisingLabelValidation {
  if (typeof value !== "string") {
    return { ok: false, message: "Field 'label' must be a string" };
  }
  if (value.length > MAX_ADVERTISING_LABEL_INPUT_LENGTH) {
    return {
      ok: false,
      message: `Field 'label' must be at most ${MAX_ADVERTISING_LABEL_INPUT_LENGTH} characters`,
    };
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return {
      ok: false,
      message: `An advertising label is required. Permitted labels: ${PERMITTED_ADVERTISING_LABELS.join(", ")}.`,
    };
  }

  const words = labelWords(trimmed);

  const forbidden = FORBIDDEN_ADVERTISING_LABEL_TERMS.find((term) =>
    containsPhrase(words, labelWords(term)),
  );
  if (forbidden) {
    return {
      ok: false,
      message: `${FORBIDDEN_LABEL_REFUSAL_PREFIX} "${forbidden}" as an advertising label. Permitted labels: ${PERMITTED_ADVERTISING_LABELS.join(", ")}.`,
    };
  }

  const englishOnly = ENGLISH_ONLY_ADVERTISING_LABELS.find(
    (candidate) => trimmed.toLowerCase() === candidate.toLowerCase(),
  );
  if (englishOnly) {
    return {
      ok: false,
      message: `"${englishOnly}" on its own is not enough: the site is run from Norway, so the label must also carry the Norwegian word. Permitted labels: ${PERMITTED_ADVERTISING_LABELS.join(", ")}.`,
    };
  }

  const canonical = canonicalAdvertisingLabel(trimmed);
  if (canonical === null) {
    return {
      ok: false,
      message: `"${trimmed}" is not a permitted advertising label. Permitted labels: ${PERMITTED_ADVERTISING_LABELS.join(", ")}.`,
    };
  }

  return { ok: true, value: canonical };
}

/**
 * True when `value` is, exactly, a stored permitted label.
 *
 * Deliberately STRICTER than `validateAdvertisingLabel`: no canonicalisation,
 * no trimming, no case folding. This one reads a value that is already in the
 * database and asks whether it is one of the four strings this module would
 * have written. A row saying "reklame" was not written by the validator, and
 * the right answer to that is to refuse to publish rather than to quietly
 * accept the near-miss on a read path that cannot fix it.
 */
export function isPermittedAdvertisingLabel(
  value: string | null | undefined,
): value is PermittedAdvertisingLabel {
  return (
    typeof value === "string" &&
    (PERMITTED_ADVERTISING_LABELS as readonly string[]).includes(value)
  );
}

/** Every benefit kind the schema's `BenefitKind` enum admits. */
export const BENEFIT_KINDS = Object.freeze([
  "PAYMENT",
  "FREE_PRODUCT",
  "LOANED_PRODUCT",
  "DISCOUNT",
  "TRIP",
  "EVENT_INVITATION",
] as const satisfies readonly BenefitKind[]);

/**
 * Narrows an unknown to a BenefitKind.
 *
 * The list above is `satisfies readonly BenefitKind[]`, so a kind added to the
 * schema but not here is not caught by the compiler — only the reverse is.
 * src/lib/advertising-disclosure.test.ts closes that direction by comparing
 * this list against the generated enum's own keys, which is the check that
 * actually fails when the schema grows a seventh kind.
 */
export function isBenefitKind(value: unknown): value is BenefitKind {
  return (
    typeof value === "string" &&
    (BENEFIT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The two columns the publish gate reads. A structural type rather than the
 * generated row type, so a caller can hand over a projection of exactly these
 * two fields and a test can write the pair out by hand.
 */
export type AdvertisingDisclosureFacts = {
  benefitReceived: boolean | null;
  label: string | null;
};

/** How a refused publish is reported: the same `{ error, field }` 400 body
 * the alt-text refusal in POST /api/media/[id]/publish already uses. */
export type AdvertisingLabelRefusal = { error: string; field: string };

/**
 * Whether this item's disclosure forbids publishing it, and why.
 *
 * THE ONE PLACE the three states of a disclosure are collapsed (K2, and the
 * storage half of K5):
 *
 *   no row at all        unanswered — publishes, see below
 *   benefitReceived null unanswered — publishes, see below
 *   benefitReceived false no benefit — publishes, and must carry no label (K4)
 *   benefitReceived true  must carry a PERMITTED label or it does not publish
 *
 * The first two are the same state said two ways, and collapsing them here
 * rather than at each call site is what stops a later reader from checking one
 * and missing the other — a bug that would read as correct and fail open.
 * This really is the only place today: `grep -rn benefitReceived src` outside
 * the generated client and the tests reaches this function, the write path in
 * PUT /api/media/[id]/disclosure, and the two-column select in POST
 * /api/media/[id]/publish that feeds this function — no second reader
 * interprets the column.
 *
 * UNANSWERED IS PERMISSIVE, TODAY. Every item that existed when this bead's
 * migration ran is in that state, there is no honest backfill for it, and no
 * surface in the product could clear it for them — the exact trap
 * 20261001150000_add_media_alt_text_caption needed a backfill to escape. If
 * ugcportal-qn3's "an unanswered question blocks publishing" mechanism lands,
 * `benefitReceived` is shaped to move onto it (nullable, no default, so
 * "nobody has said" is still distinguishable from "somebody said no") and this
 * function is the one place that would change.
 *
 * THE LABEL IS RE-CHECKED AGAINST THE ALLOWLIST, not merely checked for being
 * non-blank. PUT /api/media/[id]/disclosure will not store a benefit of true
 * without a permitted label, so through the API this can only ever agree with
 * what was written — but this gate is the last thing between a row and a
 * public page, and it must not assume every row in the table was written
 * through that route. The same reasoning the publish route states for
 * `.trim()`-ing alt text it already validated on the way in.
 */
export function advertisingLabelPublishRefusal(
  disclosure: AdvertisingDisclosureFacts | null | undefined,
): AdvertisingLabelRefusal | null {
  if (!disclosure || disclosure.benefitReceived !== true) return null;
  if (isPermittedAdvertisingLabel(disclosure.label)) return null;

  return {
    error:
      "This item records a benefit received, so it needs an advertising label before it can be published. " +
      `Permitted labels: ${PERMITTED_ADVERTISING_LABELS.join(", ")}.`,
    field: "advertisingLabel",
  };
}
