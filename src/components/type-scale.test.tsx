import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Gallery } from "@/components/gallery/gallery";
import { GalleryUnavailable } from "@/components/gallery/gallery-unavailable";
import { EmptyState } from "@/components/home/empty-state";
import { Hero } from "@/components/home/hero";
import { toGalleryItems } from "@/lib/gallery-items";

/**
 * `EmptyState` now renders `PortfolioTile` (ugcportal-qqnt.5), whose module
 * graph reaches `@/lib/portfolio` -> `@/lib/media-access` -> `@/lib/auth` at
 * import time — the same reason src/components/portfolio/portfolio-tile.test.tsx
 * mocks this. This file never signs anyone in or out; the stub only exists
 * so importing `EmptyState` does not pull in next-auth's own module graph.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("rendering these components must not consult the session");
  },
}));

/**
 * ugcportal-qqnt.1: the front page's type scale is ONE shared pair of
 * utility strings (src/components/type-scale.ts), not several components
 * independently choosing similar-looking sizes — which is what makes
 * "section titles step down" a fact the code enforces rather than an
 * impression from a screenshot.
 *
 * K1/K3 below are render-based: real markup from the actual components,
 * counted. K2 is a source scan, in the style of
 * src/lib/design/motion-reduce-pairing.test.ts: it reads the files
 * themselves rather than their output, because the claim is that these
 * specific components import the SAME constant, not merely that they
 * happen to render similar-looking classes today.
 *
 * Pixel-level "the h1 computes larger than the h2" and "/about and
 * /portfolio agree with /" are e2e claims (e2e/front-page.spec.ts,
 * e2e/about-portfolio.spec.ts) — nothing here compiles Tailwind, so a class
 * NAME is the strongest claim this file can make.
 */

/** Present only in DISPLAY_TITLE_CLASS, never in SECTION_TITLE_CLASS. */
const DISPLAY_MARKER = "sm:text-5xl";
/** Present only in SECTION_TITLE_CLASS, and not a substring of the display marker. */
const SECTION_MARKER = "text-2xl";

function occurrences(markup: string, marker: string): number {
  return markup.split(marker).length - 1;
}

const ITEMS = toGalleryItems([
  { id: "a", previewId: "pv-a", publishedAt: "2026-03-01T00:00:00.000Z" },
]);

describe("K1/K3 — exactly one display title and one section title per branch", () => {
  /*
   * Every branch src/app/page.tsx can render below the hero, rendered here
   * in isolation (no database needed — this is a claim about these
   * components' own markup, the same scope src/components/home/
   * empty-state.test.tsx and src/components/gallery/gallery.test.tsx already
   * cover for heading PRESENCE; this file adds the SIZE claim).
   */
  const branches: Record<string, () => string> = {
    "empty state": () => renderToStaticMarkup(<EmptyState pieces={[]} />),
    unavailable: () => renderToStaticMarkup(<GalleryUnavailable />),
    "gallery with items": () =>
      renderToStaticMarkup(
        <Gallery initialItems={ITEMS} initialCursor={null} initialHasMore={false} />,
      ),
    "gallery with no usable items": () =>
      renderToStaticMarkup(
        <Gallery initialItems={[]} initialCursor={null} initialHasMore={false} />,
      ),
  };

  for (const [label, renderBranch] of Object.entries(branches)) {
    it(`${label}: carries a section title and no display title of its own`, () => {
      const markup = renderBranch();
      expect(occurrences(markup, DISPLAY_MARKER), markup).toBe(0);
      expect(occurrences(markup, SECTION_MARKER), markup).toBeGreaterThanOrEqual(1);
    });
  }

  it("the hero carries exactly one display title and no section title", () => {
    const markup = renderToStaticMarkup(<Hero signedIn={false} portfolioPieces={[]} />);
    expect(occurrences(markup, DISPLAY_MARKER), markup).toBe(1);
    expect(occurrences(markup, SECTION_MARKER), markup).toBe(0);
  });

  /*
   * K3: composed with the hero above it (the real shape src/app/page.tsx
   * produces), every branch still carries exactly one display title —
   * never two, however many sections render below the hero.
   */
  for (const [label, renderBranch] of Object.entries(branches)) {
    it(`hero + ${label}: exactly one display title on the whole page`, () => {
      const markup =
        renderToStaticMarkup(<Hero signedIn={false} portfolioPieces={[]} />) + renderBranch();
      expect(occurrences(markup, DISPLAY_MARKER), markup).toBe(1);
    });
  }
});

describe("K2 — /, /about and /portfolio share the same display and section utilities", () => {
  /** Raw source text, not stripped of comments: a plain import-line regex is enough here — see this file's own header for why. */
  function sourceOf(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), "utf8");
  }

  function importsConstant(source: string, constant: string): boolean {
    const pattern = new RegExp(
      `import\\s*\\{[^}]*\\b${constant}\\b[^}]*\\}\\s*from\\s*"@/components/type-scale"`,
    );
    return pattern.test(source);
  }

  it.each([
    "src/components/home/hero.tsx",
    "src/components/site/page-shell.tsx",
  ])("%s imports DISPLAY_TITLE_CLASS from the shared type scale", (file) => {
    expect(importsConstant(sourceOf(file), "DISPLAY_TITLE_CLASS"), file).toBe(true);
  });

  it.each([
    "src/components/gallery/gallery.tsx",
    "src/components/home/empty-state.tsx",
    "src/components/gallery/gallery-unavailable.tsx",
    // /about and /portfolio's "What we offer" / "Get in touch" / "Samples"
    // headings all go through this one file's SECTION_HEADING_CLASS —
    // checking it here is checking all three at once, see its own comment.
    "src/components/site/section-heading.ts",
  ])("%s imports SECTION_TITLE_CLASS from the shared type scale", (file) => {
    expect(importsConstant(sourceOf(file), "SECTION_TITLE_CLASS"), file).toBe(true);
  });
});
