import {
  MAX_TAGS_PER_ITEM,
  MAX_TAG_NAME_LENGTH,
  hasUnsafeText,
} from "@/lib/media-rules";
import { prisma } from "@/lib/prisma";
import { PRISMA_UNIQUE_VIOLATION, prismaErrorCode } from "@/lib/prisma-errors";

/**
 * Subject tags (ugcportal-jsc): what a tag name may be, and the one way a
 * media row's tag set is written.
 *
 * Tags are LABELS ON ITEMS in a single gallery. Nothing here builds a route, a
 * section or a navigation entry out of a tag, and nothing should: an uneven
 * library makes per-tag pages look broken and puts the thin subjects
 * permanently in the navigation. See K4 of the bead, and the route test that
 * holds the line.
 *
 * Server-side only — it imports the Prisma client. The upload page's tag
 * picker is a client component and receives `{ slug, name }` pairs as props
 * rather than importing anything from here.
 */

/**
 * The two numeric caps moved to src/lib/media-rules.ts, which has no runtime
 * imports and so can be loaded by the upload page's picker — a "use client"
 * component, which cannot load THIS module, because it imports the Prisma
 * client. Re-exported so every server-side reader is unchanged. See the note
 * beside them there for why sharing a constant with the browser is not the
 * same thing as duplicating a rule.
 */
export { MAX_TAGS_PER_ITEM, MAX_TAG_NAME_LENGTH } from "@/lib/media-rules";

/**
 * The two fields of a Tag that any audience is given: what it is called, and
 * the handle that identifies it. `Tag.id` is in neither, on purpose.
 *
 * DEFINED HERE AND IMPORTED BY src/lib/media-access.ts, rather than the other
 * way round, and the direction is not arbitrary. What a tag discloses is a
 * fact about tags; media-access composes it into `MEDIA_TAGS_SELECT` for the
 * two audience projections. Written the other way, this module would import
 * media-access — which imports `@/lib/auth`, and so drags `next-auth` and
 * `next/server` into the module graph of every reader, including a node test
 * run that has no business loading either. That is not a hypothetical: it is
 * how the first attempt at this failed to collect.
 */
export const TAG_PUBLIC_FIELDS = { slug: true, name: true } as const;

/** A tag as every audience sees it. */
export type TagLabel = { slug: string; name: string };

/** A tag name that has been checked, with the identity key it resolves to. */
export type ParsedTag = { name: string; slug: string };

export type TagNameValidation =
  | { ok: true; value: ParsedTag }
  | { ok: false; message: string };

export type TagListValidation =
  | { ok: true; value: ParsedTag[] }
  | { ok: false; message: string };

/**
 * Everything that is not a letter, a digit, or a COMBINING MARK, in any
 * script.
 *
 * `\p{L}` rather than `a-z` is what gets this out of English: "Bøker" slugs
 * to "bøker", where an ASCII-only slugger produces "b-ker" and quietly
 * merges it with anything else that lost a middle character.
 *
 * `\p{M}` IS THE OTHER HALF, and leaving it out was a real bug rather than a
 * tidy simplification. Latin gets away with it because NFC composes its
 * accents into single code points — "Café" survives either way — but a
 * script whose vowels, tones or niqqud are separate code points does not,
 * and the failure is not a cosmetic one:
 *
 *   कफी -> कफ   and   कफ -> कफ      two different names, one row
 *   ข้าว -> ข-าว                      a word cut in half by a hyphen
 *   עִבְרִית -> ע-ב-ר-ית                 likewise, once per niqqud
 *   İstanbul -> i-stanbul            toLowerCase() decomposes U+0130
 *
 * The first line is the one with teeth. `resolveTagRows` upserts on the
 * shared slug with `update: {}`, so the second uploader's photograph would
 * render the FIRST uploader's spelling — the exact failure the "Food"/"food"
 * unification exists to prevent, arriving for names that are genuinely
 * different. That is a collision, not a deliberate collapse like
 * "Wine & drink" and "Wine, drink".
 *
 * What this function does NOT promise, said plainly because the sentence
 * that used to be here promised more than it delivered: it normalises
 * SPELLING, not meaning and not orthography. A name with niqqud and the same
 * name without are two subjects, because they are two strings; "İstanbul"
 * slugs to an i with a combining dot rather than to "istanbul", because
 * dotted-vs-dotless i is a locale question this has no locale to answer
 * with. Both are honest outcomes. Mangling was not.
 *
 * A slug is not guaranteed URL-safe, which is fine: nothing puts one in a
 * URL (K4), and `mediaPreviewPath` in src/lib/routes.ts is the only path
 * builder that takes a value off a row at all.
 */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}\p{M}]+/gu;

/**
 * At least one real character, as opposed to marks that have nothing to
 * attach to.
 *
 * Needed BECAUSE of the `\p{M}` above, and this is the case that fix opened:
 * a name made entirely of combining marks used to strip to the empty string
 * and be refused by the emptiness check below. Keeping marks makes its slug
 * non-empty, so the check stopped firing and a chip that renders as a row of
 * dotted circles became storable. The requirement the error message states —
 * "at least one letter or number" — is now asserted rather than inferred
 * from a side effect of the strip.
 */
const HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * The identity key for a tag name: case-folded, with runs of punctuation and
 * whitespace collapsed to a single hyphen and the ends trimmed.
 *
 * "Wine & drink", "wine and drink" and "Wine&Drink" do NOT all collapse to
 * one tag, and that is deliberate — this normalises spelling, not meaning.
 * What it does guarantee is that "Food" and "food" are the same row, which
 * SQLite's case-sensitive unique index would not give on `name` alone.
 *
 * Returns the empty string for a name with nothing but punctuation in it;
 * `validateTagName` refuses that, and separately refuses a slug made only of
 * combining marks, rather than storing a tag whose identity is "" or is
 * unrenderable.
 */
export function tagSlug(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/**
 * Strict, and strict in the same way `validateOriginalName` is: a caller
 * submitting a tag is deliberately submitting this exact string, so anything
 * wrong with it is worth saying out loud and a refusal costs them a retry.
 *
 * The character denylist is `hasUnsafeText` from src/lib/media-rules.ts —
 * THE SAME ONE the rename path uses, not a second copy. A tag name is the
 * second user-controlled string this product stores and later renders, and a
 * denylist that exists twice is one that eventually differs; the bidi
 * overrides in particular are the whole reason it is wider than it looks, and
 * they reorder a tag chip exactly as readily as they reorder a filename.
 *
 * Note what this does NOT do: it does not escape anything, and it must not
 * start. Escaping is the renderer's job, React does it, and a validator that
 * stored `&lt;b&gt;` would put the escaping in the database where the next
 * consumer double-escapes it.
 */
export function validateTagName(value: unknown): TagNameValidation {
  if (typeof value !== "string") {
    return { ok: false, message: "Each tag must be a string" };
  }

  const name = value.trim();
  if (name.length === 0) {
    return { ok: false, message: "A tag must not be empty" };
  }
  if (Array.from(name).length > MAX_TAG_NAME_LENGTH) {
    return {
      ok: false,
      message: `A tag must be at most ${MAX_TAG_NAME_LENGTH} characters`,
    };
  }
  if (hasUnsafeText(name)) {
    return {
      ok: false,
      message:
        "A tag must not contain control, text-direction or invisible characters",
    };
  }

  const slug = tagSlug(name);
  // One condition, not two. `slug === ""` reads like it covers the
  // punctuation-only case separately, and cannot: the empty string contains
  // no letter or digit either, so the predicate already decides it and the
  // extra clause can never be the one that fires.
  if (!HAS_ALPHANUMERIC.test(slug)) {
    return {
      ok: false,
      message: "A tag must contain at least one letter or number",
    };
  }

  return { ok: true, value: { name, slug } };
}

/**
 * The whole `tags` field off a request, or the reason it is refused.
 *
 * ABSENT AND EMPTY ARE DIFFERENT ANSWERS, and this function does not decide
 * between them — it is only ever called with a value the caller has already
 * established is present. `[]` means "this item has no tags", which is a
 * legitimate thing to ask for and is how a tag is removed; `undefined` means
 * "this request is not about tags", which each route handles for itself.
 *
 * Duplicates are collapsed rather than refused, because two spellings of one
 * tag ("Food" and "food") are not a mistake worth a 400 — they resolve to one
 * row either way, and the relation is a set. The FIRST spelling wins, so the
 * order the caller sent is the order that survives.
 *
 * The count cap is applied AFTER collapsing, so sending "Food" seven times is
 * one tag rather than a refusal.
 */
export function parseTagNames(value: unknown): TagListValidation {
  if (!Array.isArray(value)) {
    return { ok: false, message: "Field 'tags' must be an array of strings" };
  }

  const bySlug = new Map<string, ParsedTag>();
  for (const entry of value) {
    const validated = validateTagName(entry);
    if (!validated.ok) return validated;
    if (!bySlug.has(validated.value.slug)) {
      bySlug.set(validated.value.slug, validated.value);
    }
  }

  if (bySlug.size > MAX_TAGS_PER_ITEM) {
    return {
      ok: false,
      message: `An item may have at most ${MAX_TAGS_PER_ITEM} tags`,
    };
  }

  return { ok: true, value: [...bySlug.values()] };
}

/**
 * Makes sure a `Tag` row exists for every parsed tag, and hands back the
 * references a relation write connects to.
 *
 * `update: {}` on the upsert is load-bearing: a tag that already exists keeps
 * the name the FIRST writer gave it. Writing `name` here instead would mean
 * one uploader typing "FOOD" silently renames the chip under every other
 * uploader's photographs, which is a change nobody asked for and nobody can
 * see happening.
 *
 * WHO CAN REACH THIS. Both callers are owner-scoped writes by an
 * authenticated account, and that is deliberately not described as
 * "trusted". ugcportal-egp has since closed the door that let any Google or
 * Facebook account in, so this is now every account the OPERATOR HAS
 * PERMITTED rather than everyone — but permitted is not the same as trusted
 * to reshape shared state, the permitted set is whatever an operator
 * configured and is not necessarily small, and the rule itself is
 * provisional by its own module's account. That is why `MAX_TAGS_PER_ITEM` and
 * `MAX_TAG_NAME_LENGTH` are small and why the name is validated rather than
 * sanitised. It is also why nothing here deletes a tag: removing a row that
 * other people's media point at is a wider capability than attaching a label
 * to your own upload, and it is not one this path grants.
 *
 * The P2002 catch is a real race and not defensive padding: `upsert` on SQLite
 * is a read followed by a write, so two requests creating the same new tag can
 * both miss and both insert. Losing that race means the row the loser wanted
 * now exists, which is the outcome it was asking for — so it is swallowed
 * rather than retried. Any other Prisma code is rethrown; a disk error
 * answered with a tidy "already exists" is a fault nobody ever looks at.
 */
export async function resolveTagRows(
  tags: ParsedTag[],
  /**
   * The client to write through — a transaction, wherever the caller has one.
   *
   * REQUIRED FOR CORRECTNESS, not offered for tidiness. Both callers create
   * tag rows and then write a Media row that points at them, and the two
   * statements can fail independently. Run outside a transaction, a failing
   * `media.create` leaves behind Tag rows for an upload that never existed —
   * and nothing in this product deletes a tag, so they are permanent. The
   * upload route's compensating cleanup does not help: it removes the
   * objects it put in the bucket, which is a different kind of debris.
   *
   * Defaulted to the global client so a caller with nothing to be atomic
   * with is not forced to invent a transaction, but every caller that
   * follows this with a write should pass one.
   */
  client: Pick<typeof prisma, "tag"> = prisma,
): Promise<{ slug: string }[]> {
  for (const tag of tags) {
    try {
      await client.tag.upsert({
        where: { slug: tag.slug },
        // `curated` is left to its `false` default. Minting a subject puts
        // it on your own item; it does not put it in everybody's picker.
        // See the column's note in prisma/schema.prisma.
        create: { slug: tag.slug, name: tag.name },
        update: {},
      });
    } catch (error: unknown) {
      if (prismaErrorCode(error) !== PRISMA_UNIQUE_VIOLATION) throw error;
    }
  }

  return tags.map((tag) => ({ slug: tag.slug }));
}

/**
 * A ceiling on how many subjects the picker will render, whatever the
 * curated set turns out to contain.
 *
 * SECOND LINE, NOT THE FIRST, and this is worth being exact about because an
 * earlier version of this comment got it wrong in a way that read
 * convincingly. What keeps arbitrary names off everybody's upload page is
 * `curated`, not this number. A cap alone bounds the SIZE of the defacement
 * and nothing else: the table ships with four subjects, so an oldest-24
 * window left twenty slots free and first-come, and any account permitted
 * to sign in could fill them with 32-code-point names that every other
 * uploader would then see, forever, with no un-mint path anywhere in the
 * product. ugcportal-egp bounds WHO that is; it does not make one uploader
 * the right author of everybody else's form. "The page no longer melts"
 * is not the same claim as "the page is not defaced", and the first one is
 * the easier to mistake for the second.
 *
 * What this still buys, once curation is doing the real work: the render
 * cost cannot grow in proportion to a table nothing deletes from, even if
 * curation is later widened to something more generous than a migration.
 *
 * Twenty-four is far more subjects than a photography site has and far fewer
 * than a page can choke on.
 */
export const MAX_PICKER_TAGS = 24;

/**
 * The subjects the upload page offers: the CURATED ones, capped, filtered.
 *
 * `curated` IS THE BOUND THAT MATTERS, and it replaced an argument that was
 * true about the wrong thing. The previous version took the twenty-four
 * OLDEST rows and reasoned that this made the set unspoofable because the
 * seeded subjects are the oldest. The seeds were indeed safe — but only four
 * ship, so slots five through twenty-four were free and first-come. Any
 * account permitted to sign in (ugcportal-egp decides which; it is not an
 * empty set, and being let in is not the same as being trusted with a
 * shared control) could mint twenty 32-code-point names against its own
 * upload and have them rendered as checkboxes on every other user's upload
 * page. Permanently:
 * nothing in this product deletes a tag.
 *
 * So the read now asks for the subjects somebody DECIDED to offer, rather
 * than the ones that happened to be created first. Today that decision is
 * the seeding migration; who else may make it is ugcportal-x0l's, and this
 * function does not need to change when that lands.
 *
 * WHY A FLAG AND NOT A DELETE PATH, the other obvious remedy: `_MediaToTag`
 * cascades, so removing a Tag row strips that subject from every item
 * pointing at it — including other people's published photographs. A
 * curation flag is reversible and touches nobody's media. A delete path may
 * still be worth having, but it is a destructive admin capability and not
 * the fix for a picker that shows too much.
 *
 * MINTING IS UNCHANGED AND STILL ALLOWED. An uploader naming a new subject
 * on their own item still gets a Tag row and still sees it under their own
 * photograph in the gallery. What they no longer get is a line in everyone
 * else's form. That split is the point: their label on their work is the
 * feature; the shared control is not theirs to write to.
 *
 * ORDERING is oldest-first with `id` as the tiebreak. It is no longer
 * carrying a security argument — curation is — but it is still worth being
 * deliberate about: it is stable across requests, it does not let a later
 * curated subject displace an earlier one if the set ever exceeds the cap,
 * and the seeds carry explicit timestamps from 2026-01-01 so they sort ahead
 * of anything curated later. Presentation order is the caller's problem;
 * insertion order is not a sensible way to read a list.
 *
 * ONE HISTORICAL NOTE, KEPT BECAUSE IT NEARLY BIT. `createdAt` is TEXT in
 * SQLite, and the seed used to let `DEFAULT CURRENT_TIMESTAMP` write
 * `2026-09-28 10:34:39` while the libSQL adapter writes
 * `2026-09-28T10:34:39.023+00:00` — two formats in one ordering column,
 * compared bytewise. It happened to sort correctly, and only because the
 * shapes agree to the tenth character where one has a SPACE and the other a
 * `T`, and 0x20 < 0x54; confirmed by reading a real database with `quote()`,
 * in a run where the minted row landed in the same second as the seeds so
 * the date decided nothing. The migration now writes explicit ISO literals,
 * so the comparison is chronological and that accident is no longer
 * load-bearing. Recorded so nobody reintroduces a defaulted timestamp here
 * thinking it is equivalent.
 *
 * `hasUnsafeText` is applied for the reason it is applied in
 * `toGalleryTags`, and its omission was a real gap: this is a third surface
 * that renders a tag, so leaving it out meant the "one denylist, checked at
 * every end" rule had an end nobody was checking. Both fields are tested,
 * not just the name — `slug` reaches the DOM too, as the checkbox's `value`.
 * A row is dropped rather than repaired, and a dropped row is NOT backfilled
 * from further down the table; the list is simply shorter. Both are
 * deliberate: repairing invents a subject nobody named, and backfilling
 * would let a bad row pull an arbitrary later one into the page. It stays
 * even though curation now gates the set, because a curated row is a
 * trusted DECISION and not trusted TEXT.
 *
 * Projected through TAG_PUBLIC_FIELDS, the same two fields every other
 * audience gets — `MEDIA_TAGS_SELECT` is built from the same constant — so
 * the picker cannot become the one surface that hands out `Tag.id`.
 */
export async function listPickerTags(): Promise<TagLabel[]> {
  const rows = await prisma.tag.findMany({
    where: { curated: true },
    select: TAG_PUBLIC_FIELDS,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_PICKER_TAGS,
  });

  return rows.filter(
    (tag) => !hasUnsafeText(tag.name) && !hasUnsafeText(tag.slug),
  );
}
