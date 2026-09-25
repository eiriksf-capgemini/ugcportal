import type { RightsHolderOption } from "./decision-form";

/**
 * Cap on the rights-holder `<select>`. Bounds one page render; it is not a
 * statement about how many users the instance may have.
 */
export const MAX_RIGHTS_HOLDER_OPTIONS = 200;

export type RightsHolderList = {
  /** What the form renders, recorded holder included whether or not they fit. */
  options: RightsHolderOption[];
  /** Whether the underlying query hit the cap, so the screen can say so. */
  truncated: boolean;
};

/**
 * Assembles the rights-holder options for one account's form.
 *
 * Two rules that pulled in opposite directions until they were written down
 * together, which is why this is a function rather than four lines in the
 * page:
 *
 *  1. the recorded holder is **always** an option, even when they fall
 *     outside the capped slice — a select missing its own stored value
 *     submits a blank, which the handler reads as "clear it", erasing whose
 *     rights were cleared;
 *  2. "the list was truncated" is a fact about the **query**, decided before
 *     rule 1 adds anyone. Reading it off the final length afterwards made
 *     the notice vanish at exactly the size it was written for: adding the
 *     holder pushed the length past the cap, so the `=== cap` test went
 *     false for the one admin whose holder was outside the slice.
 */
export function resolveRightsHolders({
  holders,
  recorded,
  cap = MAX_RIGHTS_HOLDER_OPTIONS,
}: {
  /** The capped query result, in display order. */
  holders: RightsHolderOption[];
  /** The account's recorded rights holder, if it has one. */
  recorded: RightsHolderOption | null;
  cap?: number;
}): RightsHolderList {
  const truncated = holders.length >= cap;

  const alreadyListed =
    recorded !== null && holders.some((holder) => holder.id === recorded.id);

  return {
    options: recorded && !alreadyListed ? [recorded, ...holders] : holders,
    truncated,
  };
}
