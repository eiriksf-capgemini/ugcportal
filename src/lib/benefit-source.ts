import { hasUnsafeText } from "@/lib/media-rules";
import { prisma } from "@/lib/prisma";
import { PRISMA_UNIQUE_VIOLATION, prismaErrorCode } from "@/lib/prisma-errors";

/**
 * The brand behind an advertising benefit (ugcportal-qnq9.1), as a row rather
 * than as a string on the item.
 *
 * WHY A ROW. ugcportal-qnq9.3 K4 has to answer "does this brand produce,
 * import or sell alcohol" and refuse the benefit if it does (§3.1a practical
 * rule 1). That is a fact about the brand, not about one photograph —
 * "Vinmonopolet" has the same answer on every item it ever appears on — so
 * free text would mean either re-asking the question per item or minting a
 * brand table later and reconciling every spelling anyone ever typed. This
 * module does not add the alcohol answer; it makes the thing that can carry
 * one.
 *
 * SHAPED AFTER src/lib/tags.ts, which solves the same problem for subject
 * tags: a `slug` identity key computed from the display `name`, resolved by
 * upsert inside the caller's transaction. The slug is what makes "Riedel" and
 * "riedel" one brand — and, once qnq9.3 lands, what stops an alcohol answer
 * recorded against one spelling from being bypassed by typing another.
 *
 * Deliberately NOT merged into src/lib/tags.ts and deliberately not sharing
 * its `tagSlug`: a subject tag and a brand are different vocabularies with
 * different writers and different rules — a tag is curated for a public
 * picker, a brand is named by whoever declares the benefit — and the one
 * thing they have in common is three lines of string normalisation. Sharing
 * those would couple the two the next time either one's rules move.
 */

/** Longest brand name, in CODE POINTS — the same counting MAX_TAG_NAME_LENGTH
 * and MAX_ALT_TEXT_LENGTH use, so a count can never split a surrogate pair.
 *
 * 64 rather than tag's 32: a brand's legal name ("Norsk Vin og Brennevin AS")
 * runs longer than a subject label, and this string is not rendered as a chip
 * under a thumbnail. It is not rendered publicly at all by this bead — the
 * public surface carries the LABEL, not the brand. */
export const MAX_BENEFIT_SOURCE_NAME_LENGTH = 64;

/** Everything that is not a letter or a digit, for the slug below. Unicode
 * aware (`\p{L}`), so "Rémy" and "Hågen" slug to something that still
 * distinguishes them rather than collapsing to hyphens. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * The identity key for a brand: `name` case-folded, with every run of
 * non-letter, non-digit characters collapsed to a single hyphen and any
 * leading or trailing hyphens removed.
 *
 * NFC first, so a composed "é" and a decomposed one produce the same slug —
 * otherwise two visually identical brand names are two brands, and an alcohol
 * answer recorded against one does not apply to the other.
 */
export function benefitSourceSlug(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export type BenefitSourceValidation =
  | { ok: true; value: { slug: string; name: string } }
  | { ok: false; message: string };

/**
 * Validates a submitted brand name.
 *
 * The character denylist is `hasUnsafeText` from src/lib/media-rules.ts — THE
 * SAME ONE the rename and tag paths use, not a second copy. A brand name is a
 * user-controlled string this product stores and ugcportal-qnq9.3 will later
 * surface; the bidi overrides in that list reorder a brand name exactly as
 * readily as they reorder a filename.
 *
 * A name that slugs to the empty string is refused rather than stored with an
 * empty key. "???" and "---" are not brands, and an empty slug would be a
 * single shared identity that every such submission collapses onto — one row
 * carrying an alcohol answer for unrelated brands, which is the opposite of
 * what the slug exists for.
 */
export function validateBenefitSourceName(
  value: unknown,
): BenefitSourceValidation {
  if (typeof value !== "string") {
    return { ok: false, message: "Field 'benefitSource' must be a string" };
  }

  const name = value.trim();
  if (name.length === 0) {
    return { ok: false, message: "Field 'benefitSource' must not be empty" };
  }
  if (Array.from(name).length > MAX_BENEFIT_SOURCE_NAME_LENGTH) {
    return {
      ok: false,
      message: `Field 'benefitSource' must be at most ${MAX_BENEFIT_SOURCE_NAME_LENGTH} characters`,
    };
  }
  if (hasUnsafeText(name)) {
    return {
      ok: false,
      message:
        "Field 'benefitSource' must not contain control or text-direction characters",
    };
  }

  const slug = benefitSourceSlug(name);
  if (slug === "") {
    return {
      ok: false,
      message: "Field 'benefitSource' must contain a letter or a digit",
    };
  }

  return { ok: true, value: { slug, name } };
}

/**
 * The brand row for this name, minting it if this is the first time anyone
 * has named it. Returns its id.
 *
 * `client` is the transaction to write through, for the reason
 * `resolveTagRows` states at length: this is always followed by a write that
 * points at the row, the two statements can fail independently, and nothing
 * in this product deletes a BenefitSource — so a brand minted for a
 * disclosure that then failed to save is permanent debris. Defaulted to the
 * global client only so a caller with nothing to be atomic with is not forced
 * to invent a transaction.
 *
 * `update: {}` rather than writing `name`: the slug is the identity, and the
 * first spelling to arrive is the one kept. Letting a later submission rewrite
 * the display name would mean one operator's typo silently renames a brand on
 * every item that already named it. The unique-violation catch is the race
 * between two first-time writers of the same slug; losing it is fine, because
 * the row the winner created is the row this one wanted.
 */
export async function resolveBenefitSource(
  source: { slug: string; name: string },
  client: Pick<typeof prisma, "benefitSource"> = prisma,
): Promise<string> {
  try {
    const row = await client.benefitSource.upsert({
      where: { slug: source.slug },
      create: { slug: source.slug, name: source.name },
      update: {},
      select: { id: true },
    });
    return row.id;
  } catch (error: unknown) {
    if (prismaErrorCode(error) !== PRISMA_UNIQUE_VIOLATION) throw error;
    const row = await client.benefitSource.findUniqueOrThrow({
      where: { slug: source.slug },
      select: { id: true },
    });
    return row.id;
  }
}
