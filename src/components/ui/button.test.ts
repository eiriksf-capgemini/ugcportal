import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseColor } from "@/lib/design/color";
import { isTestFile, stripComments, walkSourceFiles } from "@/lib/design/scan-source";
import { loadThemeTokens, resolveToken } from "@/lib/design/tokens";
import { designSystem, discoverColorNamespaces } from "@/lib/design/usage";

import { buttonVariants } from "./button";

/**
 * `token` is one whitespace-separated class from a compiled class string,
 * possibly with a chain of leading `variant:` prefixes (`hover:bg-primary-
 * hover`, `aria-expanded:bg-accent`) - Tailwind compiles the base utility
 * identically regardless of which variant triggers it, the same
 * simplification findBareColorUtilities's own BOUNDARY regex relies on.
 * Returns the bare `bg-`/`text-`/`border-` candidate at the end of that
 * chain, with NO alpha modifier (a trailing `/NN` breaks the match, same as
 * findBareColorUtilities's own bare-vs-alpha split), or null if `token`
 * names neither of the three bare colour namespaces this bug shape can
 * occur in.
 *
 * Hoisted out of the `buttonVariants K1/K3` describe block below (it used
 * to live only there) so the hand-pasted-pair guard further down (ugcportal-
 * z1nh) can reuse the exact same extraction rather than a second, possibly
 * drifting copy.
 */
function bareColorCandidate(token: string): string | null {
  const match = /(?:^|:)((?:bg|text|border)-(?:\[[^\]]+\]|\([^)]+\)|[a-zA-Z][\w-]*))$/.exec(
    token,
  );
  return match ? match[1] : null;
}

/**
 * scripts/tree-walk-timeout-guard.test.mjs (ugcportal-9faa) requires every
 * test file calling scan-source.ts's shared `walkSourceFiles` walker to
 * either declare an explicit timeout or memoize the walk behind a module-
 * level `cache*` binding - the same `cachedFiles ??= walkSourceFiles(...)`
 * idiom dual-meaning-usage.test.ts and no-raw-hex.test.ts already use, so
 * the (single, small) walk this file's own colour-token compile guard runs
 * (ugcportal-z1nh, below) is not repeated once per `it`.
 */
let cachedColorTokenScanFiles: string[] | undefined;

/**
 * ugcportal-rw9j round 5: e2e/petrol-theme.spec.ts's K1 test checks the
 * primary-button fill by proxy (the header's own bg-primary/text-primary-
 * foreground skip link, chosen because the gallery's only default-variant
 * Button is conditionally rendered and this repo has no e2e DB-seeding
 * infrastructure yet) rather than by rendering <Button variant="default">
 * itself. That proxy cannot see a regression in button.tsx's own variant
 * map - verified directly: reassigning the `default` variant's background
 * utility leaves the skip-link check, which duplicates the same two
 * utilities independently in app-shell.tsx, completely unaffected. This
 * test closes exactly that gap, cheaply and deterministically, by asserting
 * on the variant map itself rather than a rendered DOM node.
 */
describe("buttonVariants", () => {
  it("default variant fills with the primary petrol token and primary-foreground label", () => {
    // Split into individual class tokens rather than a substring `toContain`:
    // "bg-primary" is itself a substring of "hover:bg-primary-hover", so a
    // naive toContain("bg-primary") can never fail even with the resting
    // fill removed entirely - verified by mutating the fixture (temporarily
    // dropping "bg-primary" from the default variant left a substring
    // toContain check green).
    const classes = buttonVariants({ variant: "default" }).split(/\s+/);
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("text-primary-foreground");
  });
});

/**
 * ugcportal-oavb: the base-level guard for the fix itself. A bare
 * `outline-none` with no accompanying forced-colors-visible outline is
 * exactly the regression this bead closes — `outline-none` compiles to
 * `outline-style: none`, which `forced-colors: active` (Windows High
 * Contrast) respects same as anywhere else, so it drops keyboard focus
 * entirely the moment the only OTHER focus indicator is a `box-shadow`-based
 * ring (`focus-visible:ring-3 focus-visible:ring-ring/80`), which
 * forced-colors modes ignore. This can only assert on the CLASS NAMES
 * `buttonVariants` emits, not on what a real browser paints — that pixel-
 * level claim is e2e/front-page.spec.ts's "forced colors: focus stays
 * visible..." suite, run under Playwright's `forcedColors: "active"`
 * emulation against real rendered controls (the hero CTA, the empty-state
 * link, a header sign-in button and an admin-surface button). This test is
 * the cheap, always-on backstop that fails the instant the base class
 * string regresses, independent of any browser.
 *
 * Checked across every variant, not only `default`: the base class (where
 * `outline-none` used to live, and where the fix now lives) is shared by
 * all of them, and a hypothetical per-variant override reintroducing
 * `outline-none` on exactly one variant would not be caught by checking
 * only one.
 */
describe("buttonVariants base: no bare outline-none without a forced-colors-visible outline (ugcportal-oavb)", () => {
  const variants = [
    "default",
    "default-neutral",
    "default-tint",
    "outline",
    "secondary",
    "outline-neutral",
    "ghost",
    "destructive",
    "link",
  ] as const;

  it.each(variants)("%s variant: no bare outline-none token", (variant) => {
    const classes = buttonVariants({ variant }).split(/\s+/);
    expect(
      classes,
      `outline-none would drop forced-colors focus visibility entirely (see this file's own comment); found in: ${classes.join(" ")}`,
    ).not.toContain("outline-none");
  });

  it.each(variants)(
    "%s variant: carries a focus-visible outline that actually SETS outline-style (outline-solid), not a bare outline/outline-2 that only reads it",
    (variant) => {
      const classes = buttonVariants({ variant }).split(/\s+/);
      // `focus-visible:outline`/`focus-visible:outline-2` alone would be a
      // false fix: those utilities only read the shared `--tw-outline-style`
      // custom property in this Tailwind v4 setup, they do not set it, so
      // without `outline-solid` present too they silently stay whatever
      // `outline-style` already resolved to elsewhere (see button.tsx's own
      // base-class comment for the compiled-and-rendered proof). Asserting
      // the presence of `outline-solid` itself, not merely the absence of
      // `outline-none`, is what catches that specific false fix.
      expect(
        classes,
        `expected a real forced-colors-visible outline (focus-visible:outline-solid) in: ${classes.join(" ")}`,
      ).toContain("focus-visible:outline-solid");
    },
  );

  it("the base class carries outline-2, outline-offset-2 and outline-transparent alongside outline-solid, all under focus-visible", () => {
    const classes = buttonVariants({ variant: "default" }).split(/\s+/);
    for (const cls of [
      "focus-visible:outline-solid",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-transparent",
    ]) {
      expect(classes, `missing ${cls} in: ${classes.join(" ")}`).toContain(cls);
    }
  });

  /*
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily restored the pre-oavb base class (`outline-none`, no
   * `focus-visible:outline-*` utilities) and confirmed every assertion
   * above failed with the real, non-vacuous message (either an unexpected
   * "outline-none" token present, or a missing "focus-visible:outline-solid"
   * token) — then reverted. Also tried the specific false-fix this bead's
   * own notes call out (a bare `focus-visible:outline focus-visible:outline-2`
   * pair with `outline-none` still present) and confirmed the "carries a
   * focus-visible outline that actually SETS outline-style" assertion still
   * failed, since `outline-solid` was absent; reverted.
   */
});

/**
 * ugcportal-ei5c K1/K3: default-neutral used to name `text-petrol-900` - a
 * class that compiles to NO Tailwind rule at all, because `--color-petrol-900`
 * is declared in globals.css's near-black `:root` block, deliberately
 * outside `@theme`, specifically so Tailwind does not emit `bg-`/`text-`
 * utilities for it (see that block's own "stopping Tailwind emitting
 * bg-petrol-900 and friends" comment). The label therefore rendered in
 * whatever colour it happened to inherit from the page's ambient
 * `--foreground` - confirmed by rendering both colour schemes: `rgb(11,
 * 46, 51)` in light mode, which happens to equal `--petrol-900`'s own
 * value only because light mode's `--foreground` IS `--petrol-900`, not
 * because the utility painted it, but `rgb(250, 247, 242)` (`--paper`,
 * near-white) in dark mode - while contrast.ts's `petrol-900-on-petrol-400`
 * pairing (now `surface-0-on-petrol-400`, retargeted at the token the
 * variant actually paints today) documented a measured ratio for a colour
 * that was never reliably painted - a false claim of coverage. Nothing in
 * this repo's existing scanners would have caught
 * it: findBareColorUtilities (src/lib/design/usage.ts) deliberately EXCLUDES
 * a non-compiling bare candidate rather than flagging it (a candidate that
 * fails to compile might be a `border-style`/`background-size` keyword
 * utility sharing the namespace, not an undeclared colour - see that
 * function's own doc comment), so this family of bug is invisible to the
 * contrast gate's normal coverage sweep. This describe block is the
 * dedicated guard K1/K3 ask for instead.
 *
 * Compiles every bare (non-alpha-modified) `bg-`/`text-`/`border-` utility
 * each variant's REAL `buttonVariants` output names against `designSystem` -
 * the real Tailwind design system loaded from this repo's own globals.css
 * (src/lib/design/usage.ts's `__unstable__loadDesignSystem` call) - the same
 * mechanism `isBareColorUtility`/`findBareColorUtilities` already use to ask
 * "does this candidate compile to a real rule", and the same one the bead's
 * own premise used by hand ("compiling globals.css through
 * @tailwindcss/postcss with @source inline(...) appended") to first confirm
 * the bug empirically. Run over every variant (K3's sibling sweep), not only
 * `default-neutral` - the one variant this bead actually fixes - so a
 * sibling shipping the identical mistake in the future cannot hide behind
 * only one variant being checked.
 */
describe("buttonVariants K1/K3 (ugcportal-ei5c): every bare colour utility a variant names actually compiles", () => {
  const ALL_VARIANTS = [
    "default",
    "default-neutral",
    "default-tint",
    "outline",
    "secondary",
    "outline-neutral",
    "ghost",
    "destructive",
    "link",
  ] as const;

  // `bareColorCandidate` is now hoisted to module scope, above - see its own
  // doc comment for why, and ugcportal-z1nh's describe block below for its
  // second caller.

  it.each(ALL_VARIANTS)(
    "%s variant: every bare bg-/text-/border- utility compiles to a real Tailwind rule",
    (variant) => {
      const classes = buttonVariants({ variant }).split(/\s+/);
      for (const token of classes) {
        const candidate = bareColorCandidate(token);
        if (candidate === null) continue;
        const [css] = designSystem.candidatesToCss([candidate]);
        expect(
          css,
          `"${variant}" variant's "${token}" names "${candidate}", which compiles to no Tailwind ` +
            `rule at all - the exact ugcportal-ei5c bug shape (a token declared outside @theme on ` +
            `purpose, e.g. --color-petrol-900). A contrast.ts pairing for this colour would document ` +
            `a ratio for a colour the browser never paints.`,
        ).not.toBeNull();
      }
    },
  );

  /**
   * Proves the guard above actually bites, the same "mutate and assert it
   * fails" discipline K1 itself asks for - without mutating the real
   * button.tsx (contrast.test.ts's own tmpdir-based mutation checks use the
   * identical discipline, a synthetic fixture rather than editing real
   * source at test time): default-neutral's literal PRE-ei5c class string,
   * checked directly through the same bare-candidate extraction and
   * compile step the `it.each` above runs.
   */
  it("catches the exact pre-fix default-neutral string (bg-petrol-400 text-petrol-900 hover:brightness-95) as shipping a non-compiling bare utility", () => {
    const preFixClasses = "bg-petrol-400 text-petrol-900 hover:brightness-95".split(/\s+/);
    const candidates = preFixClasses
      .map(bareColorCandidate)
      .filter((candidate): candidate is string => candidate !== null);
    expect(candidates).toEqual(["bg-petrol-400", "text-petrol-900"]);

    const [fillCss] = designSystem.candidatesToCss([candidates[0]]);
    const [labelCss] = designSystem.candidatesToCss([candidates[1]]);
    expect(fillCss, "bg-petrol-400 compiles - the fill was never the bug").not.toBeNull();
    expect(
      labelCss,
      "text-petrol-900 must compile to NO rule - that is the exact bug this bead fixes",
    ).toBeNull();
  });

  it("the real, current default-neutral variant no longer ships that non-compiling candidate", () => {
    const classes = buttonVariants({ variant: "default-neutral" }).split(/\s+/);
    expect(classes).not.toContain("text-petrol-900");
    expect(classes).toContain("text-surface-0");
    const [css] = designSystem.candidatesToCss(["text-surface-0"]);
    expect(css, "text-surface-0 must compile to a real rule").not.toBeNull();
  });
});

/**
 * ugcportal-z1nh: the K1/K3 describe block above only ever compiled
 * `buttonVariants`' OWN generated class strings - it could not have caught
 * src/app/upload/upload-form.tsx's "Choose files" label, which paints the
 * identical `bg-petrol-400`/`text-petrol-900` pair by pasting the classes
 * directly into a hand-written `className` string, never calling
 * `buttonVariants` at all. That was ugcportal-ei5c's own stated scope
 * boundary (see this file's and button.tsx's comments on the gap, and
 * contrast.test.ts's dedicated disclosure case for it) - fixed here, along
 * with the label itself.
 *
 * THIS IS ROUND 3 OF THIS DESCRIBE BLOCK, and its shape changed each round
 * because each previous shape had a real, demonstrated gap:
 *
 *   - Round 1 shipped a PAIRED guard: find a string naming a bare
 *     `bg-petrol-N` fill, then compile every bare `bg-`/`text-`/`border-`
 *     candidate sharing that SAME string. Round 1 review (CONFIRMED medium)
 *     found it missed the identical pair split across a template-literal
 *     interpolation's nested quoted segments (``className={`bg-petrol-400
 *     ${active ? "text-petrol-900" : "text-surface-0"}`}``) - fixed by
 *     tokenising on quote/template delimiters too (CANDIDATE_TOKEN_DELIMITERS
 *     below), not only whitespace.
 *   - Round 2 review (CONFIRMED medium) found the PAIRING requirement
 *     itself was the deeper bug: this repo's real conditional-className
 *     idiom is `cn()` (the npm `cn` package, used in 13 files including
 *     `button.tsx` itself: `cn(buttonVariants({ variant, size, className
 *     }))`) with SEPARATE STRING ARGUMENTS -
 *     `cn("bg-petrol-400", active ? "text-petrol-900" : "text-surface-0")`
 *     - never one shared literal for a pairing check to find, no matter how
 *     the tokeniser inside one literal was fixed. (Both round-1 and this
 *     file's own round-1/2 comments wrongly said no `clsx`/`classnames`-
 *     equivalent helper exists here; it does, under a different name, and
 *     the reviewer's own round-2 comment flags that as their own miss too,
 *     not only the PR's.)
 *
 * Round 3's fix is architectural, not another tokeniser patch: DROP THE
 * PAIRING REQUIREMENT ENTIRELY. The bug this whole family is about - "a
 * colour utility that compiles to nothing" - is a property of ONE candidate
 * token on its own; it was never actually about two tokens sharing a
 * string, and requiring that was what let both round-1's split-segment
 * shape and round-2's separate-cn()-argument shape through. What this
 * describe block does now: scan every string OR template literal in every
 * non-excluded file, tokenise each on CANDIDATE_TOKEN_DELIMITERS (as
 * before), and for every token that matches the SHAPE of a declared colour
 * token utility - `COLOR_TOKEN_SHAPE` below, built from the real, installed
 * Tailwind design system (the namespaces) and the real, parsed
 * globals.css (the token names) rather than a hand-kept list of either -
 * compile it. A candidate that fails to compile at all is this bug shape,
 * full stop, regardless of which file pasted it, whether it ever went near
 * `buttonVariants`, and regardless of whether it ever shares a string, a
 * template literal, or even a `cn()` CALL with any other candidate - a
 * `cn()` argument, a ternary branch, and a flat string are all just string
 * literals to this scan, covered by construction rather than by chasing
 * one more call shape.
 *
 * The one limit that remains, stated rather than solved: a CLASS NAME
 * COMPUTED AT RUNTIME FROM SOMETHING THAT IS NOT A LITERAL - a bare
 * interpolated identifier (`` `bg-petrol-400 ${labelClass}` ``, where
 * `labelClass` is a variable), a function call, string concatenation
 * resolved outside this one file, or any value this scan cannot read
 * directly off the page as quoted text - is invisible to it. This is a
 * STATIC TEXT scan; it has no notion of what a variable's value is at
 * runtime, and no static scan of one file can follow an identifier to a
 * definition that might live anywhere in the tree. No such indirection
 * exists in any colour-token-shaped candidate in src/ today (confirmed: the
 * production scan below finds only directly-inlined quoted text) - a real
 * instance would still need a human or a different, data-flow-aware tool to
 * catch.
 *
 * Comments are stripped before scanning (`stripComments`): several design-
 * system comments, including this file's and button.tsx's own history of
 * this exact bug, discuss these token names in backtick-quoted prose, which
 * an unstripped scan would misread as a second string literal shipping the
 * bug. `src/lib/design/**` is also excluded outright (the same exclusion
 * findBareColorUtilities and no-raw-hex.test.ts already use, for the
 * identical reason their own comments give: that code's job is to describe
 * Tailwind classes as DATA, in prose, not to ship them), and so is
 * button.tsx itself - its every variant is already exhaustively checked by
 * the K1/K3 block above, so re-scanning its raw source here would be
 * redundant rather than additionally protective.
 */
describe("colour-token compile guard: every literal class token naming a declared colour family compiles (ugcportal-z1nh)", () => {
  const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const BUTTON_TSX = path.join(SRC_ROOT, "components", "ui", "button.tsx");
  const DESIGN_LIB_DIR = path.join(SRC_ROOT, "lib", "design") + path.sep;

  function isExcluded(file: string): boolean {
    if (file === BUTTON_TSX) return true;
    if (file.startsWith(DESIGN_LIB_DIR)) return true;
    if (isTestFile(file)) return true;
    return false;
  }

  /**
   * Matches one quoted or backtick-delimited string literal and captures its
   * inner text, across all three JS/TSX string forms a `className` or a
   * `cn(...)` argument can use (`"..."`, `'...'`, `` `...` ``). A template
   * literal's `${...}` interpolation is not given special handling - its raw
   * characters are captured as ordinary text along with everything else
   * between the backticks - but that is harmless: `CANDIDATE_TOKEN_DELIMITERS`
   * below splits on `${`/`}` (and on the quote characters a NESTED segment
   * introduces) regardless, so whatever text sits inside an interpolation is
   * tokenised the same as anything else in the literal.
   */
  const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

  /**
   * Splits a matched literal into candidate tokens on whitespace AND every
   * delimiter this repo's two conditional-className idioms introduce around
   * one: the three quote characters and `${`/`}` (a template-literal
   * interpolation's own nested quoted segment, round 1 review), plus
   * `(`/`)`/`,` (separate arguments to `cn(...)`, round 2 review) and `?`/`:`
   * (a ternary's own syntax, which can appear in either idiom). Each bare
   * class name is isolated the same way regardless of which idiom - or
   * neither - produced it.
   *
   * Including `:` is safe for the same reason `bareColorCandidate` above
   * ignores a variant prefix via its own `(?:^|:)` anchor: a Tailwind variant
   * (`hover:`, `aria-expanded:`) sits before the LAST `:` in a token, so
   * pre-splitting on `:` here and matching the bare suffix directly against
   * `COLOR_TOKEN_SHAPE` below (itself fully anchored, `^...$`, with no `:`
   * alternative - there is nothing left to anchor around once `:` has
   * already split the token) produces the identical result as leaving the
   * prefix attached would.
   */
  const CANDIDATE_TOKEN_DELIMITERS = /[\s"'`${}()?:,]+/;

  /**
   * Every Tailwind utility namespace that genuinely accepts a colour, asked
   * of the real, installed Tailwind design system (`discoverColorNamespaces`,
   * already exported from usage.ts and used elsewhere in this gate for alpha-
   * modifier discovery) rather than a second, hand-kept list. Round 2's own
   * guard hardcoded `bg`/`text`/`border` - correct as far as it went, but
   * `discoverColorNamespaces` finds 51 real namespaces today (`ring`,
   * `outline`, `fill`, `stroke`, `accent`, `caret`, `divide`, `shadow`,
   * `decoration`, every directional `border-*`, every `mask-*`/`scrollbar-*`
   * variant, and more) - reusing the derived list here is strictly more
   * complete, for no extra cost, than re-hardcoding a narrower one a second
   * time in the same file.
   */
  const COLOR_TOKEN_PREFIXES = discoverColorNamespaces(designSystem);

  /**
   * Every colour TOKEN NAME this design system actually declares - read
   * straight out of globals.css via tokens.ts's own parser (`loadThemeTokens`),
   * not hand-copied, so a token renamed or added there is picked up here for
   * free, the same "derive, don't hardcode" discipline this gate's sibling
   * functions in usage.ts already hold to.
   *
   * A declared custom property counts as a colour NAME if, once resolved
   * through its `var()` chain (`resolveToken`), it parses as a real CSS
   * colour (`color.ts`'s `parseColor`: `oklch()` or hex) - the exact
   * resolve-and-parse this repo's own contrast gate already does to measure
   * a pairing, reused here to decide "is this a colour family" rather than
   * guessing from the property's NAME, which would need a hand-kept
   * exclusion list for `--font-*`/`--radius-*` and go stale the same way
   * every hand-kept list in usage.ts's own history has gone stale before
   * (see that file's header). A property that fails to resolve
   * (`color-mix()`, a genuinely missing reference, a bare `calc()`) or
   * resolves to something that is not a colour (a font stack, `0.625rem`) is
   * EXCLUDED, not flagged - the same "exclude, don't guess" precedent
   * `isBareColorUtility`'s own doc comment argues for.
   *
   * Deliberately includes names declared OUTSIDE `@theme` (`--petrol-900`
   * and its siblings, `--terracotta-*`) as well as inside it: those are
   * exactly the names this whole guard exists to catch a USE of, and
   * excluding them from the candidate shape would make the compile check
   * below unreachable for the one bug family this bead is about. 68 names
   * resolve this way today (confirmed by running this function standalone
   * in review) - `petrol-50` through `petrol-950` and `petrol-deep`,
   * `surface-0` through `surface-4`, `ink`/`ink-muted`, `primary`/
   * `primary-hover`/`primary-foreground`, `destructive`/`destructive-surface`
   * (and its `-hover`), `accent`/`accent-foreground`, `chart-1` through
   * `chart-5`, every `sidebar-*` alias, and more - none hand-typed here.
   */
  function discoverColorTokenNames(): string[] {
    const tokens = loadThemeTokens();
    const names = new Set<string>();
    for (const property of tokens.keys()) {
      let resolved: string;
      try {
        resolved = resolveToken(property, tokens);
      } catch {
        continue;
      }
      try {
        parseColor(resolved);
      } catch {
        continue;
      }
      const bare = property.slice(2);
      names.add(bare.startsWith("color-") ? bare.slice("color-".length) : bare);
    }
    // Longest-first: a regex alternation matches the first alternative that
    // fits at a position, not the longest, so "ink-muted" must be tried
    // before "ink" or the shorter one wins and leaves "-muted" dangling -
    // the identical reasoning discoverColorNamespaces's own doc comment
    // gives for sorting namespaces the same way.
    return [...names].sort((a, b) => b.length - a.length);
  }

  const COLOR_TOKEN_NAMES = discoverColorTokenNames();

  function escapeForAlternation(word: string): string {
    return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Matches a token that NAMES a design-token colour utility, full stop - no
   * requirement that it share a string, a template literal, or a `cn()` call
   * with any other candidate (round 3, replacing round 1/2's paired
   * `BARE_BG_PETROL`-gated guard). Fully anchored (`^...$`), not
   * `(?:^|:)...$`: by the time a token reaches this check it has already
   * been split on `CANDIDATE_TOKEN_DELIMITERS`, which includes `:` - any
   * variant prefix is already gone, so there is nothing before the bare name
   * left to anchor around.
   *
   * Arbitrary-value and CSS-variable-shorthand candidates
   * (`bg-[rgb(0,0,0)]`, `text-[oklch(0.5,0.1,180)]`, `bg-(--foo)`) are not
   * given special handling and need none: splitting one of those on
   * `CANDIDATE_TOKEN_DELIMITERS` shreds it into fragments
   * (`"rounded-[min"`, `"var"`, `"--radius-md"`, `"bg-"`, `"--foo"`, etc.),
   * and none of those fragments is EQUAL to one of the exact, derived names
   * above, so this anchored match never fires on them - confirmed both by
   * direct regex simulation and by a live scratch-component reproduction in
   * round 2 review, which is also why this shape can never produce a false
   * positive: Tailwind's `bg-(--anything)` form always compiles to a real
   * rule (`var(--anything)`) regardless of whether that custom property is
   * ever declared, so even a real instance of it could never trip the
   * "compiles to no rule at all" check below in the first place.
   */
  const COLOR_TOKEN_SHAPE = new RegExp(
    `^(?:${COLOR_TOKEN_PREFIXES.map(escapeForAlternation).join("|")})-` +
      `(?:${COLOR_TOKEN_NAMES.map(escapeForAlternation).join("|")})` +
      // Optional alpha modifier (round 3 review finding): `text-petrol-900/50`
      // is the same bug as `text-petrol-900` - Tailwind resolves the colour
      // first and applies the alpha to it, so an undeclared colour compiles to
      // no rule with or without the modifier - and `/` is deliberately NOT in
      // CANDIDATE_TOKEN_DELIMITERS, so the whole token (name AND modifier)
      // reaches this check and is compiled as written, for the bare
      // percentage (`/50`) and arbitrary (`/[0.5]`) forms. The variable form
      // (`/(--alpha)`) is shredded at its parentheses into `text-petrol-900/`
      // plus `--alpha`; `tokensInLiteral` below trims that trailing `/` so the
      // bare colour is still checked.
      `(?:/(?:\\d{1,3}|\\[[^\\]]+\\]))?$`,
  );

  /** Every colour-token-shaped candidate token in one already-extracted literal's text. */
  function tokensInLiteral(literal: string): string[] {
    return literal
      .split(CANDIDATE_TOKEN_DELIMITERS)
      .map((token) => (token.endsWith("/") ? token.slice(0, -1) : token))
      .filter((token) => token !== "" && COLOR_TOKEN_SHAPE.test(token));
  }

  /**
   * The one compiling step every test in this describe block shares -
   * pulled out to its own function (round 3) specifically so the required
   * "remove the compile check and watch detection escape" mutation has a
   * single place to apply: mutating ONLY this function's body, leaving
   * every caller untouched, is what proves the compile step - not the
   * shape-matching regex above - is what actually tells a broken candidate
   * apart from a fine one (shape-matching alone cannot: `text-petrol-900`
   * and `text-surface-0` match `COLOR_TOKEN_SHAPE` identically).
   */
  function compileCandidate(token: string): string | null {
    const [css] = designSystem.candidatesToCss([token]);
    return css;
  }

  type Candidate = { file: string; token: string };

  function findColorTokenCandidates(): Candidate[] {
    const files = (cachedColorTokenScanFiles ??= walkSourceFiles(SRC_ROOT, isExcluded));
    const found: Candidate[] = [];
    for (const file of files) {
      const stripped = stripComments(readFileSync(file, "utf8"), file);
      STRING_LITERAL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = STRING_LITERAL.exec(stripped)) !== null) {
        const literal = match[1] ?? match[2] ?? match[3] ?? "";
        for (const token of tokensInLiteral(literal)) {
          found.push({ file: path.relative(SRC_ROOT, file), token });
        }
      }
    }
    return found;
  }

  it("the scan still finds at least one real colour-token-shaped candidate to check (a false 0 here would silently stop checking anything)", () => {
    const candidates = findColorTokenCandidates();
    expect(
      candidates.length,
      "expected at least one colour-token-shaped candidate under src/ outside button.tsx/src/lib/design - " +
        "if this is 0, the file-walk or token-shape match regressed, not that every such candidate disappeared",
    ).toBeGreaterThan(0);
  });

  it("every colour-token-shaped candidate found anywhere in scanned src/ compiles to a real Tailwind rule", () => {
    const candidates = findColorTokenCandidates();
    for (const { file, token } of candidates) {
      expect(
        compileCandidate(token),
        `${file}: "${token}" names a declared colour token family but compiles to no Tailwind rule at all - ` +
          `this is the ugcportal-ei5c/ugcportal-z1nh bug shape (a token declared outside @theme on purpose, ` +
          `e.g. --color-petrol-900, or a genuine typo). A contrast.ts pairing for this colour would document ` +
          `a ratio for a colour the browser never paints.`,
      ).not.toBeNull();
    }
  });

  /**
   * One fixture test per shape this guard's own history (round 1 and round
   * 2 review) found escaping a narrower version of it, plus the original
   * flat shape - proving all three are caught BY CONSTRUCTION now, with no
   * pairing or idiom-specific handling needed for any of them.
   *
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily made `compileCandidate` return a constant non-null string
   * regardless of its argument (i.e. "removed the compile check") and
   * reran this file - the fixture test below for all three shapes failed
   * (each one's "must compile to NO rule" assertion), proving the compile
   * step, not the shape-matching regex, is what catches this bug family;
   * reverted.
   */
  it("flat string shape (the original ugcportal-ei5c/ugcportal-z1nh bug shape): a non-compiling candidate sharing a flat string with others is caught", () => {
    const preFixLiteral =
      "cursor-pointer rounded-lg bg-petrol-400 px-3 py-2 text-sm font-medium text-petrol-900 transition-colors hover:brightness-95";
    const candidates = tokensInLiteral(preFixLiteral);
    // "text-sm" is NOT a colour-token-shaped candidate under this round's
    // matcher (unlike round 1/2's bareColorCandidate, which matched any
    // bg-/text-/border- name and relied on a comment to explain "text-sm is
    // fine, it just shares the namespace") - "sm" is not a declared colour
    // token name, so COLOR_TOKEN_SHAPE never matches it at all. Likewise
    // "rounded-lg", "font-medium", "transition-colors" and
    // "hover:brightness-95" name no colour namespace this scan watches.
    expect(candidates).toEqual(["bg-petrol-400", "text-petrol-900"]);

    expect(compileCandidate(candidates[0]), "bg-petrol-400 compiles - the fill was never the bug").not.toBeNull();
    expect(
      compileCandidate(candidates[1]),
      "text-petrol-900 must compile to NO rule - that is the exact bug this bead fixes",
    ).toBeNull();
  });

  it("nested-quote template-literal shape (round 1 review finding): a candidate split across a ternary's own quoted segments is caught with no bg-petrol-N fill required nearby", () => {
    const nestedLiteral = 'bg-petrol-400 ${active ? "text-petrol-900" : "text-surface-0"}';
    const candidates = tokensInLiteral(nestedLiteral);
    // "active" (the ternary's own condition) names no colour namespace and
    // is correctly absent; both quoted branches are found as separate
    // candidates, with no pairing step required to find either.
    expect(candidates).toEqual(["bg-petrol-400", "text-petrol-900", "text-surface-0"]);

    expect(compileCandidate(candidates[0]), "bg-petrol-400 compiles").not.toBeNull();
    expect(
      compileCandidate(candidates[1]),
      "text-petrol-900 must compile to NO rule even nested inside a ternary's own quoted segment",
    ).toBeNull();
    expect(compileCandidate(candidates[2]), "text-surface-0 compiles").not.toBeNull();
  });

  it("separate cn() arguments shape (round 2 review finding): a candidate that never shares ANY string with another candidate is caught", () => {
    // cn("bg-petrol-400", active ? "text-petrol-900" : "text-surface-0") -
    // button.tsx's own conditional-className idiom (the `cn` npm package,
    // used in 13 files including button.tsx itself). Three separate string
    // ARGUMENTS, no template literal or interpolation at all - unlike the
    // nested-quote shape above, the fill and each label candidate never
    // share a single matched literal, which is exactly what let this shape
    // through round 1 and round 2's PAIRED guards regardless of how well
    // either tokenised within one literal. Modelled here as three
    // independently-extracted literals - exactly what STRING_LITERAL would
    // match from that real source line, one call argument at a time - with
    // no shared state or ordering between them.
    const fillLiteral = "bg-petrol-400";
    const brokenLiteral = "text-petrol-900";
    const okLiteral = "text-surface-0";

    const fillCandidates = tokensInLiteral(fillLiteral);
    const brokenCandidates = tokensInLiteral(brokenLiteral);
    const okCandidates = tokensInLiteral(okLiteral);
    expect(fillCandidates).toEqual(["bg-petrol-400"]);
    expect(brokenCandidates).toEqual(["text-petrol-900"]);
    expect(okCandidates).toEqual(["text-surface-0"]);

    expect(compileCandidate(fillCandidates[0]), "bg-petrol-400 compiles").not.toBeNull();
    expect(
      compileCandidate(brokenCandidates[0]),
      "text-petrol-900 must compile to NO rule - found and checked with zero dependence on " +
        "bg-petrol-400 (or anything else) appearing in the same string, template literal, or cn() call",
    ).toBeNull();
    expect(compileCandidate(okCandidates[0]), "text-surface-0 compiles").not.toBeNull();
  });

  it("alpha-modifier shape (round 3 review finding): a non-compiling candidate carrying an opacity suffix is caught, and a compiling one with the same suffix is not flagged", () => {
    // `text-petrol-900/50` - the same undeclared colour, with Tailwind's
    // opacity modifier appended. `/` is not a delimiter, so the token reaches
    // COLOR_TOKEN_SHAPE whole; the shape's optional alpha group admits it,
    // and compiling it as written yields no rule, exactly like the bare name.
    // The sibling with a declared colour (`bg-petrol-400/50`) compiles, so the
    // modifier itself is never what trips the guard.
    const literal = "bg-petrol-400/50 text-petrol-900/50 text-surface-0/[0.5]";
    const candidates = tokensInLiteral(literal);
    expect(candidates).toEqual(["bg-petrol-400/50", "text-petrol-900/50", "text-surface-0/[0.5]"]);
    // The variable-alpha form is shredded at its parentheses; the bare colour
    // left behind is what gets checked, so the undeclared one is still caught.
    expect(tokensInLiteral("text-petrol-900/(--alpha)")).toEqual(["text-petrol-900"]);
    expect(compileCandidate(candidates[0]), "bg-petrol-400/50 compiles").not.toBeNull();
    expect(
      compileCandidate(candidates[1]),
      "text-petrol-900/50 must compile to NO rule - the alpha modifier does not rescue an undeclared colour",
    ).toBeNull();
    expect(compileCandidate(candidates[2]), "text-surface-0/[0.5] compiles").not.toBeNull();
  });

  /**
   * Round 2 review's own specific ask, answered directly rather than only
   * by construction: does the broader namespace/name alternation risk a
   * FALSE positive on a legitimate arbitrary-value or CSS-variable-shorthand
   * candidate? Confirmed no, for both shapes raised in round 2 review.
   */
  it("ignores arbitrary-value candidates and the bg-(--var) shorthand, which compile and are not this bug shape", () => {
    const arbitraryLiteral =
      "rounded-[min(var(--radius-md),12px)] bg-petrol-400 bg-[rgb(0,0,0)] text-[oklch(0.5,0.1,180)]";
    const shorthandLiteral = "bg-petrol-400 text-(--scratch-undeclared-var)";

    // Only the real, declared fill is extracted - every arbitrary-value
    // fragment and the CSS-variable shorthand are shredded into pieces that
    // match no declared token name, exactly as this file's own
    // COLOR_TOKEN_SHAPE comment states.
    expect(tokensInLiteral(arbitraryLiteral)).toEqual(["bg-petrol-400"]);
    expect(tokensInLiteral(shorthandLiteral)).toEqual(["bg-petrol-400"]);

    // Confirmed directly, not only by absence from the candidate list: both
    // forms compile regardless, so even if a future change made this scan
    // see them, they could never trip the "compiles to no rule" check this
    // guard runs.
    expect(
      compileCandidate("bg-[rgb(0,0,0)]"),
      "an arbitrary bracket value compiles",
    ).not.toBeNull();
    expect(
      compileCandidate("text-(--scratch-undeclared-var)"),
      "bg-(--var)/text-(--var) shorthand compiles to var(...) regardless of whether the custom " +
        "property is ever declared - inert for this guard by construction, not merely unseen",
    ).not.toBeNull();
  });
});
