import { describe, expect, it } from "vitest";

import { MAX_TAGS_PER_ITEM } from "@/lib/media-rules";

import {
  tagCapMessage,
  tagPickerRows,
  toggleTagSlug,
  type SelectableTag,
} from "./tag-selection";

/**
 * The tag picker's decisions (ugcportal-jsc, round-1 review).
 *
 * The cap is the point of this file. `parseTagNames` refuses a seventh tag
 * only after POST /api/media has buffered the whole multipart body, so a
 * picker that allowed one would spend an entire video upload to earn a 400 —
 * once per file in the batch, and again on every retry, with nothing on
 * screen suggesting the tag picker was the cause.
 *
 * Unreachable with the four seeded subjects and reachable the moment the
 * vocabulary grows past six, which any authenticated account can arrange
 * (ugcportal-egp). So the fixtures here are built from MAX_TAGS_PER_ITEM
 * rather than from the number four.
 */

/** A vocabulary of `count` distinct subjects. */
function vocabulary(count: number): SelectableTag[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `subject-${index}`,
    name: `Subject ${index}`,
  }));
}

/** The slugs of the first `count` subjects, as a selection. */
function selection(count: number): string[] {
  return vocabulary(count).map((tag) => tag.slug);
}

describe("toggleTagSlug", () => {
  it("adds a subject that was not selected", () => {
    expect(toggleTagSlug(["food"], "books")).toEqual(["food", "books"]);
  });

  it("removes one that was", () => {
    expect(toggleTagSlug(["food", "books"], "food")).toEqual(["books"]);
  });

  it("does not mutate the array it was given", () => {
    // It is React state. Mutating it in place means the next render compares
    // the array against itself and draws nothing.
    const before = ["food"];
    toggleTagSlug(before, "books");
    expect(before).toEqual(["food"]);
  });

  it("does NOT enforce the cap", () => {
    /*
     * Deliberate, and asserted so it stays deliberate. `tagPickerRows`
     * decides what is reachable; a second limit here would mean a click the
     * UI had offered could be silently dropped, which is worse than either
     * refusing it visibly or allowing it.
     */
    const full = selection(MAX_TAGS_PER_ITEM);
    expect(toggleTagSlug(full, "one-more")).toHaveLength(
      MAX_TAGS_PER_ITEM + 1,
    );
  });
});

describe("tagPickerRows", () => {
  it("marks the selected subjects and leaves the rest available", () => {
    const rows = tagPickerRows(vocabulary(3), ["subject-1"]);

    expect(rows.map((row) => [row.slug, row.checked, row.disabled])).toEqual([
      ["subject-0", false, false],
      ["subject-1", true, false],
      ["subject-2", false, false],
    ]);
  });

  it("disables the UNTICKED boxes once the cap is reached", () => {
    // The vocabulary has to exceed the cap for this to be constructible at
    // all — with four seeded subjects and a cap of six there is no seventh
    // box to disable, which is exactly why the finding was "not reachable
    // today" rather than "not a bug".
    const rows = tagPickerRows(
      vocabulary(MAX_TAGS_PER_ITEM + 2),
      selection(MAX_TAGS_PER_ITEM),
    );

    const ticked = rows.filter((row) => row.checked);
    const unticked = rows.filter((row) => !row.checked);

    expect(ticked).toHaveLength(MAX_TAGS_PER_ITEM);
    expect(unticked).toHaveLength(2);
    expect(unticked.every((row) => row.disabled)).toBe(true);
  });

  it("keeps the TICKED boxes enabled at the cap, so there is a way out", () => {
    /*
     * The half that turns a limit into a trap if it is got wrong. Disabling
     * every box at the cap would leave the user unable to change their mind
     * — six subjects, permanently, for the rest of the session.
     */
    const rows = tagPickerRows(
      vocabulary(MAX_TAGS_PER_ITEM + 2),
      selection(MAX_TAGS_PER_ITEM),
    );

    expect(rows.filter((row) => row.checked).every((row) => !row.disabled)).toBe(
      true,
    );
  });

  it("disables nothing one below the cap", () => {
    // Both sides of the boundary, so what is pinned is the number rather
    // than the direction of the comparison. A `>` instead of `>=` passes the
    // test above and fails this one's mirror below.
    const rows = tagPickerRows(
      vocabulary(MAX_TAGS_PER_ITEM + 2),
      selection(MAX_TAGS_PER_ITEM - 1),
    );

    expect(rows.some((row) => row.disabled)).toBe(false);
  });

  it("stops at the cap, not one past it", () => {
    /*
     * THE MUTATION THIS EXISTS FOR. With `>` the picker allows a seventh
     * tick, and the seventh is precisely the one POST /api/media refuses —
     * after the file has been sent. At exactly MAX_TAGS_PER_ITEM there must
     * already be nothing further to tick.
     */
    const rows = tagPickerRows(
      vocabulary(MAX_TAGS_PER_ITEM + 1),
      selection(MAX_TAGS_PER_ITEM),
    );

    const reachable = rows.filter((row) => !row.checked && !row.disabled);
    expect(reachable).toEqual([]);
  });

  it("disables everything unticked if the selection is somehow over the cap", () => {
    const rows = tagPickerRows(
      vocabulary(MAX_TAGS_PER_ITEM + 3),
      selection(MAX_TAGS_PER_ITEM + 1),
    );

    expect(rows.filter((row) => !row.checked).every((row) => row.disabled)).toBe(
      true,
    );
  });

  it("carries the name through, since that is what the label reads", () => {
    expect(tagPickerRows([{ slug: "wine-drink", name: "Wine & drink" }], [])).toEqual(
      [
        {
          slug: "wine-drink",
          name: "Wine & drink",
          checked: false,
          disabled: false,
        },
      ],
    );
  });
});

describe("tagCapMessage", () => {
  it("says nothing below the cap", () => {
    expect(tagCapMessage(0)).toBe("");
    expect(tagCapMessage(MAX_TAGS_PER_ITEM - 1)).toBe("");
  });

  it("explains the greyed boxes at the cap", () => {
    const message = tagCapMessage(MAX_TAGS_PER_ITEM);

    expect(message).not.toBe("");
    // The number comes from the constant, so the sentence cannot drift from
    // the rule it describes. Asserted against the constant rather than
    // against the literal 6 for the same reason.
    expect(message).toContain(String(MAX_TAGS_PER_ITEM));
    expect(message).toContain("Untick");
  });

  it("appears at exactly the same count the boxes go grey", () => {
    /*
     * The message and the disabling are two computations over the same
     * number, and a picker whose boxes stop responding one tick before it
     * says why — or one tick after — is worse than one that says nothing.
     * This pins them together across the whole range rather than at a point.
     */
    for (let count = 0; count <= MAX_TAGS_PER_ITEM + 1; count += 1) {
      const rows = tagPickerRows(
        vocabulary(MAX_TAGS_PER_ITEM + 2),
        selection(count),
      );
      const anythingDisabled = rows.some((row) => row.disabled);
      expect(tagCapMessage(count) !== "").toBe(anythingDisabled);
    }
  });
});
