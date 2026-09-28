import { MAX_TAGS_PER_ITEM } from "@/lib/media-rules";

/**
 * What the tag picker draws, and what ticking a box does (ugcportal-jsc).
 *
 * Its own module for the reason the four siblings beside it are: the repo's
 * vitest runs in a node environment with no DOM, so anything reachable only
 * through a React event handler is in practice untested. `upload-form.tsx`
 * holds state wiring; the decisions live here, where a test can make them.
 *
 * That is not a formality here. The cap below is the whole of the fix for a
 * review finding, and a cap enforced inside a JSX callback would have shipped
 * with no test that could fail without it.
 *
 * NO RUNTIME IMPORT BUT THE CAP ITSELF. `src/lib/tags.ts` owns what a tag
 * name may BE and cannot be loaded here — it imports the Prisma client — so
 * the number comes from `media-rules.ts`, the dependency-free module that
 * exists so the browser can share the server's constants without carrying a
 * second copy of its rules. `validateUpload` and MAX_SIZE_BYTES already work
 * this way (ugcportal-n3c).
 */

/** A subject the picker can offer, as the upload page read it. */
export type SelectableTag = { slug: string; name: string };

/** One checkbox: what it says, whether it is on, and whether it can be used. */
export type TagPickerRow = SelectableTag & {
  checked: boolean;
  disabled: boolean;
};

/**
 * Ticks or unticks one subject, keeping the order they were chosen in.
 *
 * Order matters a little: `addFiles` maps the selection back through
 * `availableTags` before sending, so what actually goes on the wire is the
 * vocabulary's order — but keeping this stable means the checkbox state never
 * reshuffles under the pointer.
 *
 * DOES NOT ENFORCE THE CAP. `tagPickerRows` decides what is reachable, and
 * putting the limit in both places would mean a click that the UI allowed
 * could still be silently dropped here, which is the worst of the three
 * available behaviours.
 */
export function toggleTagSlug(
  selected: readonly string[],
  slug: string,
): string[] {
  return selected.includes(slug)
    ? selected.filter((each) => each !== slug)
    : [...selected, slug];
}

/**
 * The rows to draw, with the per-item cap applied.
 *
 * TICKED BOXES STAY ENABLED AT THE CAP. Only the unticked ones are disabled,
 * because the way out of the cap has to remain available — disabling all six
 * would freeze the selection and the control becomes a trap with no
 * affordance for escaping it.
 *
 * `>=` rather than `>`: at exactly `MAX_TAGS_PER_ITEM` the next tick is the
 * one the server refuses, so that is where the picker has to stop. `>` would
 * allow a seventh and hand the 400 back after the upload had been paid for.
 *
 * A selection longer than the cap is possible in principle — it is React
 * state, and nothing here re-validates history — and it disables everything
 * unticked rather than doing arithmetic that could go negative. The server
 * still refuses such a request; this is an affordance, not a boundary.
 */
export function tagPickerRows(
  availableTags: readonly SelectableTag[],
  selectedSlugs: readonly string[],
): TagPickerRow[] {
  const atCap = selectedSlugs.length >= MAX_TAGS_PER_ITEM;
  return availableTags.map((tag) => {
    const checked = selectedSlugs.includes(tag.slug);
    return { ...tag, checked, disabled: atCap && !checked };
  });
}

/**
 * Why the boxes went grey, or the empty string when they have not.
 *
 * A control that stops responding without saying why reads as a bug, and
 * this one would be a confusing bug: the boxes are greyed by something the
 * user did to a DIFFERENT box. The empty string rather than null so the
 * live region that carries it can be rendered unconditionally — a live
 * region inserted at the same moment as its text is frequently not announced
 * at all, which is the rule `GalleryPaging` follows for the same reason.
 *
 * The number is interpolated from the shared constant rather than written
 * out, so the sentence cannot come to disagree with the rule it describes.
 */
export function tagCapMessage(selectedCount: number): string {
  if (selectedCount < MAX_TAGS_PER_ITEM) return "";
  return `That is the most subjects one item can have (${MAX_TAGS_PER_ITEM}). Untick one to choose another.`;
}
