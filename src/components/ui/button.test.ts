import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { designSystem } from "@/lib/design/usage";
import { isTestFile, stripComments, walkSourceFiles } from "@/lib/design/scan-source";

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
 * the (single, small) walk this file's own hand-pasted-pair guard runs
 * (ugcportal-z1nh, below) is not repeated once per `it`.
 */
let cachedPetrolPairFiles: string[] | undefined;

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
 * What this describe block actually sees, precisely (round 1 review,
 * CONFIRMED medium, narrowed this from an earlier, overbroad "closes that
 * gap in general" claim): it scans real, shipped source (the same file-walk/
 * comment-strip machinery no-raw-hex.test.ts and dual-meaning-usage.test.ts
 * already share via scan-source.ts, not a third hand-rolled copy) for any
 * string OR template literal that bare-names a `bg-petrol-N` fill - the one
 * family of token this repo keeps outside `@theme` on purpose (globals.css's
 * "stopping Tailwind emitting bg-petrol-900 and friends" comment) - and, for
 * every bare `bg-`/`text-`/`border-` candidate found ANYWHERE in that SAME
 * literal's text - including nested inside a `${ condition ? "a" : "b" }`
 * interpolation's own quoted segments, not only when every candidate sits
 * together in one unbroken flat string - compiles it against this repo's own
 * Tailwind design system exactly the way the K1/K3 block above does. A
 * candidate that fails to compile at all is this bug shape, regardless of
 * which file pasted it, whether it ever went near `buttonVariants`, or
 * whether the fill and the label share a flat string or a conditional
 * template literal (this repo's own "conditional className" idiom - no
 * `clsx`/`classnames` helper exists here - see CANDIDATE_TOKEN_DELIMITERS'
 * own comment below for how).
 *
 * The one limit that remains, genuinely undisclosed before this round and
 * stated rather than solved: a BARE INTERPOLATED IDENTIFIER whose class
 * value is computed elsewhere (`` `bg-petrol-400 ${labelClass}` ``, where
 * `labelClass` is a variable) is invisible to this scan - its text in the
 * source is just the identifier name `labelClass`, not whatever string that
 * variable resolves to at runtime, and no static scan of this file alone can
 * follow it to a definition that might live anywhere. No such indirection
 * exists in any `bg-petrol-N` template literal in src/ today (confirmed:
 * every one either carries its candidates as flat text or as directly
 * inlined quoted segments, never a bare variable standing in for a whole
 * class name) - a real instance would still need a human or a different,
 * data-flow-aware tool to catch.
 *
 * Comments are stripped before scanning (`stripComments`): several design-
 * system comments, including this file's and button.tsx's own history of
 * this exact bug, discuss `bg-petrol-400`/`text-petrol-900` in backtick-
 * quoted prose, which an unstripped scan would misread as a second string
 * literal shipping the bug. `src/lib/design/**` is also excluded outright
 * (the same exclusion findBareColorUtilities and no-raw-hex.test.ts already
 * use, for the identical reason their own comments give: that code's job is
 * to describe Tailwind classes as DATA, in prose, not to ship them), and so
 * is button.tsx itself - its every variant is already exhaustively checked
 * by the K1/K3 block above, so re-scanning its raw source here would be
 * redundant rather than additionally protective.
 */
describe("hand-pasted bg-petrol-*/text- pairs outside buttonVariants: every candidate compiles (ugcportal-z1nh)", () => {
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
   * inner text, across all three JS/TSX string forms a `className` can use
   * (`"..."`, `'...'`, `` `...` ``). A template literal's `${...}`
   * interpolation is not given special handling - its raw characters are
   * captured as ordinary text along with everything else between the
   * backticks - but that is harmless here: a BARE interpolated identifier's
   * own text (e.g. `${HERO_DECORATIVE_SHAPE_CLASS}`) contains none of
   * `bg-`/`text-`/`border-` followed by a bare token in this codebase, so it
   * is never mistaken for a colour candidate (confirmed against every
   * current template-literal `className` in src/, e.g.
   * src/components/home/hero.tsx's decorative shapes). That is a narrower
   * claim than "every interpolation is handled", and was never meant to
   * cover a NESTED QUOTED segment inside one (`${active ? "text-petrol-900"
   * : "text-surface-0"}`) - CANDIDATE_TOKEN_DELIMITERS below is what
   * actually reaches in and finds a candidate there.
   */
  const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

  /** The one family of token this scan is watching for: `bg-petrol-N`, bare (no alpha modifier). */
  const BARE_BG_PETROL = /\bbg-petrol-\d+\b/;

  /**
   * Round 1 review, CONFIRMED medium: splitting a matched literal on
   * whitespace alone (`/\s+/`) is correct for a FLAT hand-pasted string
   * (`"bg-petrol-400 ... text-petrol-900 ..."`) but silently misses the
   * other shape this repo's own "conditional className" idiom produces -
   * this repo has no `clsx`/`classnames` helper, so a conditional class is a
   * raw template-literal interpolation instead, e.g. ``className={`bg-
   * petrol-400 ${active ? "text-petrol-900" : "text-surface-0"}`}``.
   * `STRING_LITERAL` above does capture that whole backtick span as one
   * literal (confirmed: `BARE_BG_PETROL.test(literal)` is true for it), but
   * splitting it on whitespace alone leaves the quote characters stuck to
   * `bareColorCandidate`'s own candidates (`"text-petrol-900"`, with the
   * leading/trailing `"`), which its `(?:^|:)...$` anchors do not match -
   * found as a scratch component in review, verified to pass all tests
   * silently before this fix (0 failures against a shape that should fail).
   *
   * The fix: split on whitespace AND every delimiter this idiom's own syntax
   * introduces around a candidate - the three quote characters, `${`/`}`,
   * `(`/`)`, `?`, `:`, and `,` - so each bare class name is isolated the same
   * way regardless of whether it sits in a flat string or inside a ternary's
   * own quoted branch. Including `:` is safe for the SAME reason it was
   * already safe to ignore in `bareColorCandidate`'s own `(?:^|:)` anchor:
   * that anchor only ever looks at what comes AFTER the last `:` in a token
   * (a Tailwind variant prefix like `hover:`), so pre-splitting on `:` here
   * and handing `bareColorCandidate` the bare suffix directly produces the
   * identical match as leaving the prefix attached would.
   */
  const CANDIDATE_TOKEN_DELIMITERS = /[\s"'`${}()?:,]+/;

  type Candidate = { file: string; token: string; candidate: string };

  function findHandPastedPetrolCandidates(): Candidate[] {
    const files = (cachedPetrolPairFiles ??= walkSourceFiles(SRC_ROOT, isExcluded));
    const found: Candidate[] = [];
    for (const file of files) {
      const stripped = stripComments(readFileSync(file, "utf8"), file);
      STRING_LITERAL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = STRING_LITERAL.exec(stripped)) !== null) {
        const literal = match[1] ?? match[2] ?? match[3] ?? "";
        if (!BARE_BG_PETROL.test(literal)) continue;
        for (const token of literal.split(CANDIDATE_TOKEN_DELIMITERS)) {
          if (token === "") continue;
          const candidate = bareColorCandidate(token);
          if (candidate === null) continue;
          found.push({ file: path.relative(SRC_ROOT, file), token, candidate });
        }
      }
    }
    return found;
  }

  it("the scan still finds at least one real bg-petrol-N string to check (a false 0 here would silently stop checking anything)", () => {
    const candidates = findHandPastedPetrolCandidates();
    expect(
      candidates.length,
      "expected at least one shipped bg-petrol-N string under src/ outside button.tsx/src/lib/design - " +
        "if this is 0, the file-walk or string-literal extraction regressed, not that every hand-pasted " +
        "pair disappeared",
    ).toBeGreaterThan(0);
  });

  it("every bg-/text-/border- candidate sharing a string with a bare bg-petrol-N fill compiles to a real Tailwind rule", () => {
    const candidates = findHandPastedPetrolCandidates();
    for (const { file, token, candidate } of candidates) {
      const [css] = designSystem.candidatesToCss([candidate]);
      expect(
        css,
        `${file}: "${token}" names "${candidate}", which compiles to no Tailwind rule at all - ` +
          `a hand-pasted bg-petrol-*/text-* pair outside buttonVariants shipping the exact ` +
          `ugcportal-ei5c bug shape (a token declared outside @theme on purpose, e.g. ` +
          `--color-petrol-900). A contrast.ts pairing for this colour would document a ratio for ` +
          `a colour the browser never paints.`,
      ).not.toBeNull();
    }
  });

  /**
   * Proves the guard above actually bites - the same "mutate and assert it
   * fails" discipline K1 itself asks for - without mutating real source at
   * test time (the K1/K3 block's own sibling test uses the identical
   * discipline, a literal string rather than editing button.tsx): the
   * upload-form.tsx label's literal PRE-fix class string, checked directly
   * through the same extraction and compile step the test above runs.
   *
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily restored this exact string as upload-form.tsx's real
   * `className` (reverting the ugcportal-z1nh fix) and reran both tests in
   * this describe block - the compile-guard test above failed, naming
   * upload-form.tsx and "text-petrol-900" in its message exactly as
   * designed; then reverted.
   */
  it("catches the exact pre-fix upload-form.tsx label string as shipping a non-compiling bare utility (flat shape)", () => {
    const preFixLiteral =
      "cursor-pointer rounded-lg bg-petrol-400 px-3 py-2 text-sm font-medium text-petrol-900 transition-colors hover:brightness-95";
    expect(BARE_BG_PETROL.test(preFixLiteral)).toBe(true);

    const candidates = preFixLiteral
      .split(CANDIDATE_TOKEN_DELIMITERS)
      .filter((token) => token !== "")
      .map(bareColorCandidate)
      .filter((candidate): candidate is string => candidate !== null);
    // Also carries "text-sm" (the label's own font-size utility) - a real,
    // ordinary Tailwind utility that happens to share the "text-" namespace;
    // it is expected to compile, and is not the bug.
    expect(candidates).toEqual(["bg-petrol-400", "text-sm", "text-petrol-900"]);

    const [fillCss] = designSystem.candidatesToCss([candidates[0]]);
    const [sizeCss] = designSystem.candidatesToCss([candidates[1]]);
    const [labelCss] = designSystem.candidatesToCss([candidates[2]]);
    expect(fillCss, "bg-petrol-400 compiles - the fill was never the bug").not.toBeNull();
    expect(sizeCss, "text-sm compiles - an ordinary non-colour utility sharing the namespace").not.toBeNull();
    expect(
      labelCss,
      "text-petrol-900 must compile to NO rule - that is the exact bug this bead fixes",
    ).toBeNull();
  });

  /**
   * Round 1 review finding (CONFIRMED medium): the flat-shape test above
   * passed even while the guard silently missed the SAME non-compiling
   * candidate split across a template-literal interpolation's own quoted
   * segments - this repo's "conditional className" idiom, since no
   * `clsx`/`classnames` helper exists here (`grep -rln 'className={\`'`
   * finds 6 files using this shape, this one among them). Reproduced live as
   * a scratch component outside `button.tsx` in review: the pre-fix
   * tokenizer (`literal.split(/\s+/)`) left the quote characters stuck to
   * `"text-petrol-900"`, which `bareColorCandidate`'s anchors did not match,
   * so the guard reported 0 candidates for it and all 34 tests passed.
   *
   * FIXTURE MUTATION CHECK (performed by hand, not left in the suite):
   * temporarily restored `literal.split(/\s+/)` (this file's pre-round-2
   * tokenizer) in `findHandPastedPetrolCandidates` and reran this file -
   * this test failed (the nested `text-petrol-900` candidate was not found
   * at all, so `candidates` did not equal the expected array), proving the
   * fix above is what catches this shape, not an artefact of the fixture;
   * then reverted.
   */
  it("catches a non-compiling pair split across a template-literal interpolation's nested quoted segments (round 1 review finding)", () => {
    const nestedLiteral = 'bg-petrol-400 ${active ? "text-petrol-900" : "text-surface-0"}';
    expect(BARE_BG_PETROL.test(nestedLiteral)).toBe(true);

    const candidates = nestedLiteral
      .split(CANDIDATE_TOKEN_DELIMITERS)
      .filter((token) => token !== "")
      .map(bareColorCandidate)
      .filter((candidate): candidate is string => candidate !== null);
    // "active" (the ternary's own condition) names neither bg-/text-/border-
    // and is correctly dropped by bareColorCandidate; both quoted branches
    // of the ternary are found as separate candidates.
    expect(candidates).toEqual(["bg-petrol-400", "text-petrol-900", "text-surface-0"]);

    const [fillCss] = designSystem.candidatesToCss([candidates[0]]);
    const [brokenCss] = designSystem.candidatesToCss([candidates[1]]);
    const [okCss] = designSystem.candidatesToCss([candidates[2]]);
    expect(fillCss, "bg-petrol-400 compiles").not.toBeNull();
    expect(
      brokenCss,
      "text-petrol-900 must compile to NO rule even nested inside a ternary's own quoted segment - " +
        "the exact shape the pre-round-2 whitespace-only tokenizer silently missed",
    ).toBeNull();
    expect(okCss, "text-surface-0 compiles").not.toBeNull();
  });
});
