/**
 * PR #94 review round 4, finding 5: `HEADER_HEIGHT_PX`'s arithmetic
 * (site-header.tsx's own comment: 56px `h-14` + 1px `border-b` = 57px) was
 * only ever checked for real by e2e/header.spec.ts, which CI does not run
 * (playwright.config.ts needs a live `npm run dev` server - see that file's
 * own comment). This compiles the REAL utility classes site-header.tsx
 * actually ships against the real, vendored Tailwind and the real
 * stylesheet - the same technique app-shell.test.tsx uses for the skip
 * link's padding cascade - rather than re-typing the arithmetic as a second,
 * hand-copied assertion that could drift from the component the same way the
 * component's own comment already warns against.
 *
 * Round 5, finding 4: site-header.tsx expresses the arithmetic as named
 * constants (`WORDMARK_ROW_PX`/`BORDER_PX`), each mirroring one Tailwind
 * class, rather than a single pre-summed total. This file checks each one
 * individually against its real compiled value, not only the total - see the
 * test's own comment for why that is strictly stronger than checking the sum
 * alone.
 *
 * ugcportal-qqnt.3 dropped the header's second, fixed-height tagline row
 * (`h-7`/`TAGLINE_ROW_PX`) entirely - SITE_TAGLINE moved to the footer - so
 * this file now checks only the two terms that remain.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindPostcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { describe, expect, it, vi } from "vitest";

import { stripComments } from "@/lib/design/scan-source";
import { GLOBALS_CSS_PATH } from "@/lib/design/tokens";

/**
 * Only `HEADER_HEIGHT_PX` is read from this module below - nothing here
 * renders `SiteHeader` - but importing the real module still pulls in its
 * whole import graph, and `@/components/auth-status` transitively imports
 * `next-auth`, which (confirmed empirically) fails to resolve `next/server`
 * outside Next's own runtime. Mocked the same way app-shell.nav.test.tsx and
 * site-header.test.tsx already do, for the same reason - not because this
 * file touches either component's own behaviour.
 */
vi.mock("@/components/upload-nav-link", () => ({ UploadNavLink: () => null }));
vi.mock("@/components/auth-status", () => ({ AuthStatus: () => null }));

const { BORDER_PX, HEADER_HEIGHT_PX, WORDMARK_ROW_PX } = await import("./site-header");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_HEADER_PATH = path.join(HERE, "site-header.tsx");

function siteHeaderSourceWithoutComments(): string {
  // Second argument (the file name) was missing here (ugcportal-akv6
  // round 6, discovered while merging origin/main): confirmed against a
  // clean checkout of origin/main at 35800c9 that both `npm run
  // typecheck` ("Expected 2 arguments, but got 1") and this test
  // ("expected exactly one h-14 utility... found 4") already failed there
  // before this merge, independent of it. `stripComments` requires the
  // path so `ts.createSourceFile` can pick the right parser for it
  // (scriptKindFor); without it, parsing throws, and `stripComments`
  // fails CLOSED by returning the source UNSTRIPPED (see its own doc
  // comment on `scanUnstripped`) - which is why every class token below
  // was matching its own comment mentions too, not just its real usage.
  return stripComments(readFileSync(SITE_HEADER_PATH, "utf8"), SITE_HEADER_PATH);
}

/**
 * Fails loudly, rather than silently compiling the wrong rule, if `token`
 * is ever duplicated, removed, or renamed in site-header.tsx - the same
 * "never just skip" contract src/lib/design/usage.ts holds itself to.
 * Token-bounded (no `[\w-]` immediately before or after) so `border-b`
 * does not also match inside the adjacent, unrelated `border-border`.
 */
function assertSoleClassToken(source: string, token: string): void {
  const matches = source.match(new RegExp(`(?<![\\w-])${token}(?![\\w-])`, "g")) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `site-header.height.test.ts: expected exactly one "${token}" utility in ` +
        `site-header.tsx, found ${matches.length}`,
    );
  }
}

/**
 * Compiles `classNames` against the real globals.css with the real
 * (vendored) Tailwind - restricted to exactly those classes, same
 * `source(none)` technique and reasoning as app-shell.test.tsx's own
 * `compile()` (ugcportal-j4j round 2 finding 5): without it, an unrelated
 * utility added anywhere else in this app could change what this test
 * observes.
 */
async function compile(classNames: string): Promise<string> {
  const globalsCss = readFileSync(GLOBALS_CSS_PATH, "utf8");
  const restricted = globalsCss.replace(
    '@import "tailwindcss";',
    '@import "tailwindcss" source(none);',
  );
  if (restricted === globalsCss) {
    throw new Error(
      'site-header.height.test.ts: expected globals.css to start with exactly \'@import "tailwindcss";\' ' +
        "so this test can disable Tailwind's automatic whole-project source scan for it.",
    );
  }
  const input = `${restricted}\n@source inline(${JSON.stringify(classNames)});\n`;
  const result = await postcss([
    tailwindPostcss({ base: path.dirname(GLOBALS_CSS_PATH) }),
  ]).process(input, { from: GLOBALS_CSS_PATH });
  return result.css;
}

/** Tailwind v4's own `--spacing` theme variable, in px (its declared value is in rem; this repo sets no root font-size override - confirmed in globals.css - so 1rem is 16px). */
function spacingPx(css: string): number {
  const match = /--spacing:\s*([\d.]+)rem/.exec(css);
  if (!match) {
    throw new Error("site-header.height.test.ts: could not find --spacing in the compiled theme layer");
  }
  return Number(match[1]) * 16;
}

/** A `h-N` utility compiles to `height: calc(var(--spacing) * N)`; resolves that to px. */
function spacingMultiplePx(css: string, className: string, resolvedSpacingPx: number): number {
  const match = new RegExp(
    `\\.${className}\\s*\\{[^}]*height:\\s*calc\\(var\\(--spacing\\)\\s*\\*\\s*([\\d.]+)\\)`,
  ).exec(css);
  if (!match) {
    throw new Error(`site-header.height.test.ts: could not find a height rule for .${className}`);
  }
  return Number(match[1]) * resolvedSpacingPx;
}

function borderBottomWidthPx(css: string): number {
  const match = /\.border-b\s*\{[^}]*border-bottom-width:\s*([\d.]+)px/.exec(css);
  if (!match) {
    throw new Error("site-header.height.test.ts: could not find border-bottom-width for .border-b");
  }
  return Number(match[1]);
}

describe("HEADER_HEIGHT_PX (ugcportal-14k9 PR #94 review round 4/5; ugcportal-qqnt.3 one-row update)", () => {
  it("each named constant equals the real compiled value of the Tailwind class it mirrors, and the two sum to HEADER_HEIGHT_PX", async () => {
    const source = siteHeaderSourceWithoutComments();
    assertSoleClassToken(source, "h-14");
    assertSoleClassToken(source, "border-b");

    const css = await compile("h-14 border-b");
    const resolvedSpacingPx = spacingPx(css);

    const row1HeightPx = spacingMultiplePx(css, "h-14", resolvedSpacingPx);
    const borderPx = borderBottomWidthPx(css);

    // round 5, finding 4: checked individually against the NAMED constant
    // each mirrors, not only as a pre-summed total - a wrong WORDMARK_ROW_PX
    // compensated by a wrong BORDER_PX could still sum to the right
    // HEADER_HEIGHT_PX, which the total-only version of this test (round 4)
    // could not have told apart from both being right.
    expect(row1HeightPx, "WORDMARK_ROW_PX vs. the real h-14").toBe(WORDMARK_ROW_PX);
    expect(borderPx, "BORDER_PX vs. the real border-b").toBe(BORDER_PX);
    expect(
      row1HeightPx + borderPx,
      `h-14 (${row1HeightPx}px) + border-b (${borderPx}px)`,
    ).toBe(HEADER_HEIGHT_PX);

    // K1: one row, no taller than 64px.
    expect(HEADER_HEIGHT_PX).toBeLessThanOrEqual(64);
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): confirms the
   * assertions above can actually fail, by compiling a DELIBERATELY WRONG
   * row-1 height (`h-16`, 64px, not the real `h-14`) and checking it no
   * longer equals `WORDMARK_ROW_PX`, and that the summed arithmetic no
   * longer equals `HEADER_HEIGHT_PX` either.
   */
  it("the checks above fail against a wrong row height", async () => {
    const css = await compile("h-16 border-b");
    const resolvedSpacingPx = spacingPx(css);

    const wrongRow1HeightPx = spacingMultiplePx(css, "h-16", resolvedSpacingPx);
    const borderPx = borderBottomWidthPx(css);

    expect(wrongRow1HeightPx).not.toBe(WORDMARK_ROW_PX);
    expect(wrongRow1HeightPx + borderPx).not.toBe(HEADER_HEIGHT_PX);
  });

  /**
   * ugcportal-qqnt.3: site-header.tsx's own comment and
   * site-header.test.tsx's both state the brand mark is 28px (docs/design/
   * forside.html's `.brand-mark`, `size-7` in this repo's spacing scale) -
   * a MEASUREMENT claim (review-standards section 5) that belongs in a test
   * that fails if it drifts, not only in prose. `size-7` is a single
   * utility that sets both `width` and `height` to the same `calc(...)`
   * expression (confirmed by compiling it in isolation), so
   * `spacingMultiplePx` - written for an `h-N` utility's `height` property -
   * reads the right value here too without needing a second helper.
   */
  it("the brand mark (`size-7`) compiles to 28px", async () => {
    const source = siteHeaderSourceWithoutComments();
    assertSoleClassToken(source, "size-7");

    const css = await compile("size-7");
    const resolvedSpacingPx = spacingPx(css);
    const brandMarkSizePx = spacingMultiplePx(css, "size-7", resolvedSpacingPx);

    expect(brandMarkSizePx).toBe(28);
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): confirms the check
   * above can actually fail, against a deliberately wrong size (`size-6`,
   * 24px, not the real `size-7`).
   */
  it("the brand mark check above fails against a wrong size", async () => {
    const css = await compile("size-6");
    const resolvedSpacingPx = spacingPx(css);
    const wrongSizePx = spacingMultiplePx(css, "size-6", resolvedSpacingPx);

    expect(wrongSizePx).not.toBe(28);
  });
});
