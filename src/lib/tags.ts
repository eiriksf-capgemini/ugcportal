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
 * Everything that is neither a letter nor a digit, in any script.
 *
 * `\p{L}` rather than `a-z` is what keeps this usable outside English:
 * "Bøker" slugs to "bøker", where an ASCII-only slugger would produce
 * "b-ker" and quietly merge it with anything else that lost a middle
 * character. The cost is that a slug is not guaranteed URL-safe — which is
 * fine, because nothing puts one in a URL (K4), and `mediaPreviewPath` in
 * src/lib/routes.ts is the only path builder that takes a value off a row at
 * all.
 */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * The identity key for a tag name: case-folded, with runs of punctuation and
 * whitespace collapsed to a single hyphen and the ends trimmed.
 *
 * "Wine & drink", "wine and drink" and "Wine&Drink" do NOT all collapse to
 * one tag, and that is deliberate — this normalises spelling, not meaning.
 * What it does guarantee is that "Food" and "food" are the same row, which
 * SQLite's case-sensitive unique index would not give on `name` alone.
 *
 * Returns the empty string for a name with no letters or digits in it at all;
 * `validateTagName` treats that as a refusal rather than storing a tag whose
 * identity is "".
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
  if (slug === "") {
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
 * authenticated account, and that is deliberately not described as "trusted":
 * sign-in currently has no allowlist (ugcportal-egp), so any account that can
 * upload can also mint a tag row. That is why `MAX_TAGS_PER_ITEM` and
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
): Promise<{ slug: string }[]> {
  for (const tag of tags) {
    try {
      await prisma.tag.upsert({
        where: { slug: tag.slug },
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
 * How many subjects the picker will ever offer.
 *
 * A BOUND ON THE READ, because the WRITE is not bounded and this bead is not
 * the place that decides it should be. `resolveTagRows` creates a row for any
 * name that passes validation; both writers are reachable by any
 * authenticated account; sign-in has no allowlist (ugcportal-egp); and
 * nothing deletes a tag. `MAX_TAGS_PER_ITEM` caps a REQUEST, not the
 * vocabulary — six fresh names per call, in a loop, grows the table without
 * limit.
 *
 * Unbounded, that was a denial of service on the only page media comes in
 * through, and not a subtle one: an unbounded `SELECT` plus one checkbox per
 * row in the server-rendered HTML, on every `/upload` render, for every user,
 * caused by any one of them. Bounding the read does not stop the table
 * growing — that is ugcportal-x0l's decision about who may mint a subject —
 * but it does mean nothing renders in proportion to it.
 *
 * Twenty-four is far more subjects than a photography site has and far fewer
 * than a page can choke on.
 */
export const MAX_PICKER_TAGS = 24;

/**
 * The subjects the upload page offers, bounded and filtered.
 *
 * ORDERED OLDEST-FIRST, WHICH IS THE HALF THAT MAKES THE BOUND WORTH
 * ANYTHING. With `take` alone and an alphabetical order, an attacker mints
 * twenty-four subjects beginning with "a" and the four real ones fall off the
 * end — the page no longer melts, is exactly as unusable, and the cap would
 * have hidden it. The seeded subjects are inserted by the migration, so they
 * are the oldest rows in the table, and `createdAt` is not a value any
 * WRITER IN THIS CODEBASE chooses: `resolveTagRows` is the only way a tag is
 * created and it lets the column default. `id` is the tiebreak, because the
 * four seeds share one `CURRENT_TIMESTAMP`.
 *
 * State the limit rather than overclaiming it: this orders by a column, not
 * by a proof. Anyone with direct database access can write any `createdAt`
 * they like, and this does not stop them — it stops the writers that are
 * actually reachable, which is every one an account on the internet has.
 *
 * Presentation order is decided by the caller — oldest-first is a security
 * property, not a sensible way to read a list.
 *
 * `hasUnsafeText` is applied here for the reason it is applied in
 * `toGalleryTags`, and the omission was a real gap: this is a third surface
 * that renders a tag, so leaving it out meant the "one denylist, checked at
 * every end" rule had an end nobody was checking. Both fields are tested,
 * not just the name — `slug` reaches the DOM too, as the checkbox's `value`.
 * A row is dropped rather than repaired, and a dropped row is NOT backfilled
 * from further down the table; the list is simply shorter. Both are
 * deliberate: repairing invents a subject nobody named, and backfilling
 * would let a bad row pull an arbitrary later one into the page.
 *
 * Projected through TAG_PUBLIC_FIELDS, the same two fields every other
 * audience gets — `MEDIA_TAGS_SELECT` is built from the same constant — so
 * the picker cannot become the one surface that hands out `Tag.id`.
 */
export async function listPickerTags(): Promise<TagLabel[]> {
  const rows = await prisma.tag.findMany({
    select: TAG_PUBLIC_FIELDS,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_PICKER_TAGS,
  });

  return rows.filter(
    (tag) => !hasUnsafeText(tag.name) && !hasUnsafeText(tag.slug),
  );
}
