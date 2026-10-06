import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cn } from "cn";

import { ConsentProvider } from "@/components/consent/consent-context";
import {
  COOKIE_BANNER_DECLINE_LABEL,
  CookieBanner,
} from "@/components/consent/cookie-banner";
import { GALLERY_TILE_BASE_CLASS } from "@/components/gallery/containment";
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

/**
 * Round-2 review, LOW, CONFIRMED: `classAttrOf` used to interpolate
 * `textContent` into a `RegExp` unescaped, so a regex metacharacter in the
 * needle (`.`, `(`, `+`, ...) would be read as regex syntax instead of a
 * literal character — dormant today, since every call site in this file
 * passes a hardcoded literal label, but worth hardening rather than leaving
 * for whoever reuses this helper with less-controlled content next.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classAttrOf(markup: string, textContent: string): string {
  const pattern = new RegExp(`class="([^"]*)"[^>]*>${escapeRegExp(textContent)}`);
  const match = pattern.exec(markup);
  if (!match) throw new Error(`no element found containing "${textContent}" in: ${markup}`);
  return unescapeClassAttr(match[1]);
}

describe("classAttrOf escapes regex metacharacters in its needle (round-2 review, finding 6)", () => {
  it("finds the real element, not an earlier decoy an unescaped '.' would also match as a wildcard", () => {
    // Without escaping, "." in the needle is a regex wildcard matching any
    // character, so the pattern would also match the decoy's "v1X2" (X
    // standing in for the literal "." in "v1.2") — and since RegExp#exec
    // scans left to right, it would find THAT match first, because the
    // decoy appears earlier in the markup than the real element.
    const markup =
      '<span class="decoy-class">v1X2</span><a class="real-class">v1.2</a>';
    expect(classAttrOf(markup, "v1.2")).toBe("real-class");
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily reverted classAttrOf to interpolate the raw, unescaped
   * `textContent` (the pre-fix round-2 shape) and confirmed this assertion
   * failed, returning "decoy-class" instead of "real-class" — exactly the
   * wrong-element match the finding describes. Reverted.
   */
});

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
    // ugcportal-o312: GALLERY_TILE_BASE_CLASS's radius was factored out to
    // a shared GALLERY_RADIUS_CLASS constant (so the advertising-disclosure
    // label beside it, containment.radius-parity.test.ts's own subject,
    // could not drift onto its own literal again), so the source text no
    // longer carries a literal "rounded-lg" inside the template string
    // itself — this now checks the RESOLVED class value the tile actually
    // renders with, which is the claim this test cares about either way.
    expect(GALLERY_TILE_BASE_CLASS).toContain("rounded-lg");
    expect(GALLERY_TILE_BASE_CLASS).not.toContain("rounded-md");
    expect(containment).toMatch(
      /GALLERY_TILE_BASE_CLASS\s*=\s*`[^`]*\$\{GALLERY_RADIUS_CLASS\}/,
    );
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

  /**
   * Round-2 review, LOW, PLAUSIBLE (finding 7): `files` above is a
   * hardcoded 4-entry array, not a glob over the directories the bead's
   * own K3 wording names ("a source-scan test over src/components/home and
   * src/components/site-*"). Confirmed exactly complete today by the
   * reviewer's own grep — not an under-scoping bug now, but a file added
   * under either path later would silently not be scanned unless someone
   * remembers to add it here too.
   *
   * CHOSEN: a completeness test over a glob. A glob would make this
   * self-updating, but it would also hide exactly what K3 scans behind a
   * pattern a reviewer has to evaluate mentally; the repo's own convention
   * for "this named list must stay complete" is a test like this one, not
   * a glob (GALLERY_TILE_BASE_CLASS's shared-string check, the
   * MODEL_COVERAGE completeness test in src/app/privacy/content.test.ts).
   * This keeps `files` explicit and reviewable, and fails loudly — instead
   * of silently skipping a new file — the moment it drifts from disk.
   *
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily added a throwaway non-test `.ts` file under
   * src/components/home/ (never committed) and confirmed this assertion
   * failed, listing the new file as unaccounted for; removed it.
   */
  it("files is exactly every non-test component file under src/components/home/ and every site-* file under src/components/", () => {
    function listNonTestFiles(dirRel: string, nameFilter: RegExp): string[] {
      const dirAbs = resolve(process.cwd(), dirRel);
      return readdirSync(dirAbs)
        .filter(
          (name) =>
            nameFilter.test(name) &&
            !/\.test\.(tsx|ts)$/.test(name) &&
            statSync(resolve(dirAbs, name)).isFile(),
        )
        .map((name) => `${dirRel}/${name}`);
    }

    const onDisk = new Set([
      ...listNonTestFiles("src/components/home", /\.(tsx|ts)$/),
      ...listNonTestFiles("src/components", /^site-.*\.(tsx|ts)$/),
    ]);

    expect(
      onDisk,
      `K3's hardcoded files array is out of date against what is on disk: ${[...onDisk].sort().join(", ")}`,
    ).toEqual(new Set(files));
  });

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

    it("both tokens present, but in two separate class strings, is a real near miss — not a false positive", () => {
      /*
       * Round-2 review, LOW, CONFIRMED (mine): the previous version of this
       * fixture was `'className="flex items-center gap-2 bg-petrol-100"
       * otherClassName="rounded-lg block"'` — it never contained the
       * substring `inline-flex` at all (only `flex`), so it could not have
       * failed regardless of what the patterns' middle character class
       * allowed to cross a quote boundary. This fixture actually contains
       * BOTH `inline-flex` and `rounded-` — in two DIFFERENT string
       * literals, not the same one — so it exercises the real property
       * under test: the `[^`"']*` segment must not cross a quote/
       * backtick boundary to join them.
       */
      expect(
        hasHandWrittenButtonShape(
          'className="inline-flex items-center gap-2 bg-petrol-100" otherClassName="rounded-lg block"',
        ),
      ).toBe(false);
    });
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * - Forward-order case: dropped `rounded-lg` from its fixture string and
   *   confirmed the assertion flipped to failing (back to `false`); restored.
   * - Reverse-order case, the one round 1's finding is actually about:
   *   temporarily reverted `hasHandWrittenButtonShape` to
   *   `FORWARD_PATTERN.test(source)` only — i.e. exactly the pre-fix round-1
   *   pattern — and confirmed this fixture's assertion failed (`toBe(true)`
   *   no longer held, the literal bypass the review found); reverted to the
   *   OR'd two-pattern form above.
   * - Negative case (round-2 review, LOW, CONFIRMED): the OLD, vacuous
   *   fixture (no `inline-flex` substring at all) still passed every
   *   mutation below — proving nothing. This one does the job: temporarily
   *   replaced both patterns' `[^`"']*` middle segment with a greedy
   *   `.*` (the reviewer's own mutation, removing the quote-boundary-
   *   stopping protection entirely) and confirmed THIS assertion now fails
   *   (`toBe(false)` no longer holds, `.*` joins the two literals across
   *   the boundary) — exactly the near miss the finding describes. Reverted
   *   to `[^`"']*` immediately after.
   */
});
