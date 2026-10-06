import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cn } from "cn";

import { ConsentProvider } from "@/components/consent/consent-context";
import {
  COOKIE_BANNER_DECLINE_LABEL,
  CookieBanner,
} from "@/components/consent/cookie-banner";
import { EmptyState } from "@/components/home/empty-state";
import { Hero } from "@/components/home/hero";

import { buttonVariants } from "./button";

/**
 * ugcportal-qqnt.2: one button system on the public pages — a primary, a
 * secondary, one radius — checked two ways.
 *
 * K1/the "one radius" half, at the pixel level (getComputedStyle, real
 * buttonVariants output vs. a hand-written string that merely LOOKS the
 * same), is an e2e claim (e2e/front-page.spec.ts) — nothing here compiles
 * Tailwind. What a static render CAN prove is narrower but still real:
 * which component the markup actually came from, and that the only two
 * fill treatments in the diff resolve to real `buttonVariants` output.
 */

/**
 * Every whitespace-separated class in `variantClass` appears somewhere in
 * `markup`'s class attribute for this element, except whatever is listed in
 * `allowOverridden` — proves nothing from the variant string was dropped by
 * `cn()`'s own de-duplication other than a call site's own documented,
 * deliberate override, not merely that the two strings look similar.
 */
function containsEveryToken(
  classAttr: string,
  variantClass: string,
  allowOverridden: ReadonlySet<string> = new Set(),
): boolean {
  const have = new Set(classAttr.split(/\s+/));
  return variantClass
    .split(/\s+/)
    .every((token) => have.has(token) || allowOverridden.has(token));
}

/**
 * `renderToStaticMarkup` HTML-escapes the class attribute it writes (`&` to
 * `&amp;`, `'` to `&#x27;`) — real escaping of real bytes, not a difference
 * in the classes themselves. Undone here, narrowly, rather than widened
 * into a general HTML-entity decoder: these are the only two characters
 * `buttonVariants`' own output ever contains (`[&_svg]`, `class*='size-'`).
 */
function unescapeClassAttr(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&#x27;", "'");
}

function classAttrOf(markup: string, textContent: string): string {
  const pattern = new RegExp(`class="([^"]*)"[^>]*>${textContent}`);
  const match = pattern.exec(markup);
  if (!match) throw new Error(`no element found containing "${textContent}" in: ${markup}`);
  return unescapeClassAttr(match[1]);
}

describe("K1 — the hero and empty-state links resolve to buttonVariants, not a hand-written class string", () => {
  it("the hero's CTA carries every class default-tint/lg produces", () => {
    const markup = renderToStaticMarkup(<Hero signedIn={false} />);
    const classAttr = classAttrOf(markup, "Sign in to upload");
    // Through cn(), the same tailwind-merge pass the real caller's own
    // className applies (hero.tsx calls buttonVariants bare, with no
    // conflicting classes of its own, so this changes nothing there) — see
    // the empty-state assertion below for a case where it does.
    const expected = cn(buttonVariants({ variant: "default-tint", size: "lg" }));
    expect(
      containsEveryToken(classAttr, expected),
      `classAttr: ${classAttr}\nexpected (every token of): ${expected}`,
    ).toBe(true);
  });

  it("the empty state's portfolio link carries every class outline/lg produces, except its own documented wrap override", () => {
    const markup = renderToStaticMarkup(<EmptyState />);
    const classAttr = classAttrOf(markup, "See what is already finished, in the portfolio");
    /*
     * Through cn(), not the raw `buttonVariants()` string (round-1 review,
     * CONFIRMED medium — the first version of this test compared against
     * the raw string and failed on a true positive it misread as a bug):
     * the real call site wraps `buttonVariants("outline")` in its own
     * `cn()` alongside extra classes, and `outline`'s own `border-primary`
     * conflicts with the shared base class's `border-transparent` — so
     * tailwind-merge CORRECTLY drops the base's one, the same resolution
     * `src/components/ui/button.tsx`'s own `Button` component applies via
     * its own `cn(buttonVariants(...))` wrapping. Comparing against the
     * raw, undeduped string would make this assertion fail on EVERY
     * variant that overrides a base utility — not a defect to guard
     * against, but how `cn()` is supposed to work.
     *
     * `h-9`/`whitespace-nowrap` are the two tokens `size: "lg"` contributes
     * that this call site deliberately overrides (round-2 review,
     * CONFIRMED medium — the first version of this test compared the full,
     * unexcepted output and failed on another true positive): this call
     * site's own sentence-length copy does not fit one line at 320px, and
     * overrides exactly those two utilities to `h-auto`/`whitespace-normal`
     * (its own comment in empty-state.tsx explains why) — a real,
     * deliberate exception this test must not fight. Every OTHER token
     * `size: "lg"` contributes (`gap-1.5`, `px-2.5`, ...) still has to be
     * there, along with every colour/border/radius token from `outline`.
     */
    const expected = cn(buttonVariants({ variant: "outline", size: "lg" }));
    const overridden = new Set(["h-9", "whitespace-nowrap"]);
    expect(
      containsEveryToken(classAttr, expected, overridden),
      `classAttr: ${classAttr}\nexpected (every token of, excluding ${[...overridden].join(", ")}): ${expected}`,
    ).toBe(true);
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily changed the hero's variant to "outline" (a real, but WRONG,
   * buttonVariants call) and confirmed the first test above failed on the
   * fill-specific classes ("bg-petrol-100"/"text-surface-0" no longer
   * present); reverted. Confirms `containsEveryToken` is checking the right
   * variant, not merely "some buttonVariants output or other".
   */
});

describe("regression guard (round-1 review, CONFIRMED medium, finding 2) — an out-of-scope caller's computed classes are unchanged", () => {
  /**
   * The round-1 finding: removing `sm`'s own radius cap (see button.tsx's
   * `size` comment) would have silently changed the COMPUTED radius of
   * every `size="sm"` button this bead does not touch — cookie-banner.tsx's
   * two buttons among them. This asserts the fix (the restored cap) by
   * EXACT equality against a snapshot of what `cn(buttonVariants({variant:
   * "outline", size: "sm"}))` produced on `origin/main`, before this bead —
   * captured by running a standalone script against that commit's
   * button.tsx (same `cva`/`cn` calls, same variant/size literals) rather
   * than guessed by hand, so a real drift in any token this button composes
   * from — not only the radius — fails this test, not only a radius-shaped
   * one.
   */
  const MAIN_COOKIE_BANNER_BUTTON_CLASS =
    "group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/80 motion-safe:active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive/75 aria-invalid:ring-3 aria-invalid:ring-destructive/80 [&_svg]:pointer-events-none [&_svg]:shrink-0 border-primary bg-transparent text-primary hover:border-primary-hover hover:underline aria-expanded:border-primary-hover aria-expanded:underline h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5";

  it("CookieBanner's decline button carries exactly the classes it did on main, byte for byte", () => {
    const markup = renderToStaticMarkup(
      <ConsentProvider initialConsent={null}>
        <CookieBanner />
      </ConsentProvider>,
    );
    const classAttr = classAttrOf(markup, COOKIE_BANNER_DECLINE_LABEL);
    expect(classAttr).toBe(MAIN_COOKIE_BANNER_BUTTON_CLASS);
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite): with
   * the round-1 regression reproduced (the `sm` cap removed, matching this
   * PR's own pre-fix state), this assertion failed with the actual rendered
   * class list containing `rounded-lg` where `rounded-[min(var(--radius-md),
   * 12px)]` belongs — the exact drift the finding describes. Reverted.
   */
});

describe("K2 — one radius token for every interactive shape", () => {
  it("every variant and the tile base share the exact rounded-lg radius utility", () => {
    const containment = readFileSync(
      resolve(process.cwd(), "src/components/gallery/containment.ts"),
      "utf8",
    );
    // The button's own base class (shared by every variant) carries
    // rounded-lg once; this is the claim that the tile shares exactly that
    // utility, not a same-looking one of its own.
    expect(buttonVariants({ variant: "default" })).toContain("rounded-lg");
    expect(containment).toMatch(/GALLERY_TILE_BASE_CLASS\s*=\s*`[^`]*\brounded-lg\b/);
    expect(containment).not.toMatch(/GALLERY_TILE_BASE_CLASS\s*=\s*`[^`]*\brounded-md\b/);
  });
});

describe("K3 — no hand-written button-shaped className outside buttonVariants", () => {
  /**
   * The exact shape this bead's own premise named: an `inline-flex` utility
   * co-occurring with a `rounded-*` one in the SAME string literal — the
   * signature of a button hand-built from scratch rather than composed from
   * `buttonVariants`. Raw text, not comment-stripped: both files this scans
   * are plain components with no reason to discuss this combination in
   * prose, and the two directories named are small enough to read by eye if
   * this ever produces a surprising hit.
   *
   * ORDER-INDEPENDENT (round-1 review, CONFIRMED medium): a single
   * `inline-flex[^`"']*rounded-` pattern only matches when `inline-flex`
   * appears BEFORE `rounded-*` in the string. `"rounded-lg inline-flex
   * items-center bg-petrol-100"` — the identical hand-rolled shape with the
   * two utilities swapped — sailed through undetected, a blind spot a
   * routine class-order change (a Tailwind class-sorter plugin, or just a
   * different author's habit) could fall into silently. Two mirrored
   * patterns, OR'd, so either order inside the same string literal (still
   * bounded by a quote/backtick either side, same scope as before) trips
   * the guard.
   */
  const FORWARD_PATTERN = /inline-flex[^`"']*rounded-/;
  const BACKWARD_PATTERN = /rounded-[^`"']*inline-flex/;

  function hasHandWrittenButtonShape(source: string): boolean {
    return FORWARD_PATTERN.test(source) || BACKWARD_PATTERN.test(source);
  }

  const files = [
    "src/components/home/hero.tsx",
    "src/components/home/empty-state.tsx",
    "src/components/site-header.tsx",
    "src/components/site-footer.tsx",
  ];

  it.each(files)("%s carries no inline-flex...rounded- class string", (file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(hasHandWrittenButtonShape(source), source).toBe(false);
  });

  /*
   * Guards the guard: the pattern itself has to be able to fire, in either
   * order, or the checks above pass vacuously whatever these files contain.
   */
  describe("the pattern itself matches the shape it is meant to catch, regardless of order", () => {
    it("inline-flex before rounded-", () => {
      expect(
        hasHandWrittenButtonShape(
          'className="inline-flex items-center rounded-lg bg-petrol-100"',
        ),
      ).toBe(true);
    });

    it("rounded- before inline-flex (round-1 review: the pre-fix single pattern missed this order)", () => {
      expect(
        hasHandWrittenButtonShape(
          'className="rounded-lg inline-flex items-center bg-petrol-100"',
        ),
      ).toBe(true);
    });

    it("neither token present in the same literal is not a false positive", () => {
      expect(
        hasHandWrittenButtonShape(
          'className="flex items-center gap-2 bg-petrol-100" otherClassName="rounded-lg block"',
        ),
      ).toBe(false);
    });
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * - Forward-order case: dropped `rounded-lg` from its fixture string and
   *   confirmed the assertion flipped to failing (back to `false`); restored.
   * - Reverse-order case, the one this round's finding is actually about:
   *   temporarily reverted `hasHandWrittenButtonShape` to
   *   `FORWARD_PATTERN.test(source)` only — i.e. exactly the pre-fix round-1
   *   pattern — and confirmed this fixture's assertion failed (`toBe(true)`
   *   no longer held, the literal bypass the review found); reverted to the
   *   OR'd two-pattern form above.
   * - Negative case: temporarily changed its fixture to a single literal
   *   containing both tokens ("...rounded-lg inline-flex...") and confirmed
   *   the assertion flipped to failing (`toBe(false)` no longer held),
   *   proving it is a real check rather than one that always returns false.
   */
});
