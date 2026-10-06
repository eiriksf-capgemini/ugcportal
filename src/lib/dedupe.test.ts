import { describe, expect, it } from "vitest";

import { dedupeBy } from "@/lib/dedupe";

/**
 * ugcportal-oejb K2: "a call site's first-wins order silently becoming
 * last-wins" must never happen. These tests pin FIRST occurrence, by
 * identity, not merely by value — two objects sharing a key are
 * distinguishable here only by which one survives, so a last-wins
 * regression fails loudly rather than passing by accident on
 * interchangeable fixtures.
 */
describe("dedupeBy", () => {
  it("returns an empty array for empty input", () => {
    expect(dedupeBy<{ id: string }, string>([], (item) => item.id)).toEqual([]);
  });

  it("keeps every item, in order, when no key repeats", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(dedupeBy(items, (item) => item.id)).toEqual(items);
  });

  it("keeps the FIRST item for a repeated key, not the last (K2)", () => {
    const first = { id: "x", label: "kept" };
    const second = { id: "x", label: "dropped" };
    const result = dedupeBy([first, second], (item) => item.id);

    expect(result).toEqual([first]);
    // Identity, not just a value that happens to match: a first-wins
    // implementation that coincidentally produced an object with the same
    // shape as `first` would still be wrong if it was not actually `first`.
    expect(result[0]).toBe(first);
  });

  it("keeps the order of first occurrences, not of the whole input", () => {
    const a1 = { id: "a", n: 1 };
    const b1 = { id: "b", n: 2 };
    const a2 = { id: "a", n: 3 };
    const c1 = { id: "c", n: 4 };

    expect(dedupeBy([a1, b1, a2, c1], (item) => item.id)).toEqual([a1, b1, c1]);
  });

  it("treats keys as distinct only by ===, applying no case or whitespace folding of its own", () => {
    // Any folding a caller needs (tagSlug's lower-casing, for instance)
    // belongs in the keyOf it passes in, not in this function.
    const items = [{ key: "Food" }, { key: "food" }, { key: " Food" }];
    expect(dedupeBy(items, (item) => item.key)).toEqual(items);
  });

  it("dedupes by a derived, non-string key just as well", () => {
    const items = [
      { bucket: 1, value: "a" },
      { bucket: 1, value: "b" },
      { bucket: 2, value: "c" },
    ];
    expect(dedupeBy(items, (item) => item.bucket)).toEqual([
      { bucket: 1, value: "a" },
      { bucket: 2, value: "c" },
    ]);
  });
});
