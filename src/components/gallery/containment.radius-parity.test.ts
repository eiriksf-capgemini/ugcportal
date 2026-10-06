import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { GALLERY_ADVERTISING_LABEL_CLASS, GALLERY_TILE_BASE_CLASS } from "./containment";

/**
 * ugcportal-o312: a labelled, published gallery item renders the
 * advertising-disclosure badge (`GalleryItemAdvertisingLabel`,
 * gallery-item.tsx) as a sibling immediately before the tile it describes
 * (gallery.tsx's tiles, src/app/media/[previewId]/page.tsx) — so the two
 * elements sit edge to edge on the same public page and any difference in
 * corner radius between them is immediately visible.
 *
 * This is exactly what drifted silently once already: PR #122
 * (ugcportal-qqnt.2) moved `GALLERY_TILE_BASE_CLASS` from `rounded-md` (8px)
 * to `rounded-lg` (10px) and updated that one literal, but
 * `GALLERY_ADVERTISING_LABEL_CLASS` hand-typed its OWN `rounded-md` literal
 * a few hundred lines below — untouched by that PR — with a comment
 * claiming the two matched. Nothing failed, because nothing asserted the
 * two strings agreed; the mismatch was only found later, by hand, against
 * the merged tree (ugcportal-o312's own discovery note).
 *
 * The fix factors the shared radius out to one constant
 * (`GALLERY_RADIUS_CLASS`, containment.ts) that both classes interpolate.
 * This test does NOT merely check that both reference that one constant —
 * a future edit could reintroduce two independent literals that happen to
 * agree today and this test would still need to catch that. Instead it
 * extracts the actual `rounded-*` token each EXPORTED CLASS STRING resolves
 * to at runtime and asserts they are the same token, so a regression is
 * caught however it is introduced: a hand-typed literal, a renamed/forked
 * constant, or a future second radius token added to only one of the two
 * strings.
 */

const ROUNDED_TOKEN = /\brounded-(?:none|sm|md|lg|xl|2xl|3xl|full|\[[^\]]+\])\b/;

function roundedTokenOf(classString: string): string {
  const match = classString.match(ROUNDED_TOKEN);
  if (match === null) {
    throw new Error(`expected a rounded-* utility in: ${classString}`);
  }
  return match[0];
}

describe("gallery tile and its advertising-disclosure label share one radius (ugcportal-o312)", () => {
  it("GALLERY_TILE_BASE_CLASS and GALLERY_ADVERTISING_LABEL_CLASS resolve to the identical rounded-* token", () => {
    const tileToken = roundedTokenOf(GALLERY_TILE_BASE_CLASS);
    const labelToken = roundedTokenOf(GALLERY_ADVERTISING_LABEL_CLASS);
    expect(labelToken).toBe(tileToken);
  });

  it("that shared token is rounded-lg, not the pre-fix rounded-md (pins the current design value, not just parity)", () => {
    expect(roundedTokenOf(GALLERY_TILE_BASE_CLASS)).toBe("rounded-lg");
    expect(roundedTokenOf(GALLERY_ADVERTISING_LABEL_CLASS)).toBe("rounded-lg");
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily reverted GALLERY_ADVERTISING_LABEL_CLASS's template literal
   * to a hand-typed "rounded-md" (the exact pre-fix string), leaving
   * GALLERY_TILE_BASE_CLASS untouched — both tests above failed, the first
   * on the token mismatch ("rounded-md" !== "rounded-lg") and the second on
   * the label's pinned value. Reverted.
   */

  it("source-level: both definitions in containment.ts derive their radius from the shared GALLERY_RADIUS_CLASS constant, not a hand-typed literal", () => {
    const containment = readFileSync(
      resolve(process.cwd(), "src/components/gallery/containment.ts"),
      "utf8",
    );
    const tileDefinition = containment.match(
      /export const GALLERY_TILE_BASE_CLASS = `[^`]*`;/,
    )?.[0];
    const labelDefinition = containment.match(
      /export const GALLERY_ADVERTISING_LABEL_CLASS =\s*`[^`]*`;/,
    )?.[0];
    expect(tileDefinition).toBeDefined();
    expect(labelDefinition).toBeDefined();
    // Both definitions interpolate the shared constant...
    expect(tileDefinition).toContain("${GALLERY_RADIUS_CLASS}");
    expect(labelDefinition).toContain("${GALLERY_RADIUS_CLASS}");
    // ...and neither ALSO hand-types its own `rounded-*` utility outside
    // that interpolation (stripping the `${GALLERY_RADIUS_CLASS}`
    // placeholder before checking, so the interpolation site itself does
    // not trip this).
    expect(tileDefinition?.replace("${GALLERY_RADIUS_CLASS}", "")).not.toMatch(/\brounded-/);
    expect(labelDefinition?.replace("${GALLERY_RADIUS_CLASS}", "")).not.toMatch(/\brounded-/);
  });
});
