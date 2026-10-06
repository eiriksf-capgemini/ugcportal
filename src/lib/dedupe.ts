/**
 * One first-occurrence-wins dedupe (ugcportal-oejb), replacing the
 * hand-rolled Set/Map loop that `appendGalleryItems`
 * (src/lib/gallery-items.ts, by id) and `parseTagNames` (src/lib/tags.ts, by
 * slug) each kept a separate copy of. `permittedIdentities`
 * (src/lib/sign-in-policy.ts) is NOT a third adopter — see the comment
 * beside its own dedupe loop for why building `byEmail` and `malformed` in
 * one pass is a different shape than this function covers.
 *
 * A TINY, DEPENDENCY-FREE MODULE, deliberately — the same reasoning
 * src/lib/curation-tags.ts gives for being one: every caller above is
 * otherwise unrelated to the others, so the one thing they share should not
 * drag any of them into the others' module graph.
 *
 * FIRST OCCURRENCE WINS, not last — the item kept for a repeated key is the
 * earliest one in `items`, and every later item sharing that key is dropped
 * silently rather than replacing it. Getting this backwards is the
 * regression this bead exists to make impossible to reintroduce unnoticed;
 * see dedupe.test.ts's own mutation-checked test for it.
 *
 * `keyOf` decides what "the same" means — a database id, a slug, a
 * normalised string — so any case- or whitespace-folding a caller needs
 * (e.g. `tagSlug`'s lower-casing) belongs in the function it passes here,
 * not in this one. This function does no normalisation of its own: two keys
 * are the same only if they are `===`-equal (`Set`'s own equality), nothing
 * looser and nothing stricter.
 */
export function dedupeBy<T, K>(items: readonly T[], keyOf: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
