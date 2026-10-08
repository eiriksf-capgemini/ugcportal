/**
 * ugcportal-rw9j review round 2, finding 4: the existing K2 coverage check
 * (findAlphaColorUtilities in usage.ts, exercised in contrast.test.ts) only
 * sees ALPHA-MODIFIED colour utilities (`ring-ring/80`). It has no way to
 * notice a plain `text-foreground`/`text-primary`/`text-muted-foreground`/
 * `border-primary` usage at all, which is exactly how three real
 * regressions shipped undetected in this bead's first two review rounds:
 * `--foreground`, `--primary` and `--muted-foreground` all changed meaning
 * from "whatever this near-black surface scale needs" to "whatever pairs
 * with the new --background" (see globals.css), and nothing caught a
 * component still relying on the old meaning until a human (round 1) and
 * another review pass (round 2) read the diff by hand.
 *
 * This does not attempt the general fix - a real one needs to know which
 * background element each usage actually renders inside, which means
 * JSX-ancestor-aware static analysis this codebase does not have and this
 * bead is not the place to build. What it does instead: every CURRENT
 * (file, count) pairing for these four "dual-meaning" tokens has been
 * manually audited (rounds 2 and 4 of this bead) and is pinned below. A
 * usage this scanner has not seen before - a new file, or a changed count in
 * an existing one - fails loudly rather than shipping silently, the same
 * "never just skip" contract usage.ts holds itself to for alpha utilities.
 *
 * Known scope limit (review round 4, NOT closed by this file): this is a
 * literal-text scan. It sees a utility string written directly in a
 * `className`, but it cannot see one reaching a file through component
 * composition - `<Button variant="outline">` or
 * `buttonVariants({ variant: "outline" })` carry no "border-primary"/
 * "text-primary" substring of their own; those live only inside button.tsx's
 * PETROL_OUTLINE_STYLE definition, which IS scanned (and pinned below).
 * Every such call site in this codebase was traced by hand across rounds 2-4
 * (see the PR's review comments) and confirmed either safe (renders on
 * --background) or fixed (upload-queue-list.tsx's "Try again" now uses
 * button.tsx's dedicated `outline-neutral` variant instead); this file does
 * not re-verify that automatically, and a future PR adding a new
 * `variant="outline"`/`"secondary"` call site inside an untouched near-black
 * surface would not be caught here. That gap is real and is not claimed
 * otherwise.
 *
 * To add or move a usage: audit where it actually renders (what background,
 * if any, sits behind it - --background is safe, any --card/--popover/
 * --muted/--accent/--secondary/--destructive-surface/--sidebar/--color-
 * surface-* fill needs the matching old-scale token instead, e.g.
 * text-ink/text-ink-muted - see contrast.ts's muted-foreground-on-background
 * and ink-on-destructive-surface comments for worked examples), then update
 * AUDITED_USAGE to match. A mismatch names the exact file and token so the
 * audit is a one-line diff, not a re-hunt. Yes, this means an unrelated
 * change that happens to add or remove one of these four tokens anywhere in
 * an audited file will fail this test and ask for that one-line diff - that
 * is the intended friction, not a defect in it: the alternative is exactly
 * the kind of silent drift that let three real regressions through in
 * rounds 1-2.
 *
 * The file walker and comment stripper are shared with no-raw-hex.test.ts
 * via scan-source.ts (ugcportal-rw9j review round 4) rather than duplicated
 * here a second time.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isTestFile, stripComments, walkSourceFiles } from "./scan-source";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * The four tokens whose MEANING this bead split in two (see globals.css):
 * "whatever pairs with --background" vs. the old near-black-scale meaning.
 * Matched as a whole Tailwind utility word, with a negative lookahead for
 * `-` so `text-primary` does not also match inside `text-primary-foreground`
 * or `border-primary` inside `border-primary-hover` (ugcportal-rw9j's own
 * PETROL_OUTLINE_STYLE uses exactly that pair, deliberately not pinned here
 * since --primary-hover is not one of the dual-meaning tokens).
 *
 * `text-ink` (ugcportal-14k9 PR #94 review round 1, low finding 5) is NOT a
 * fifth dual-meaning token - its meaning never changed, and `button.tsx`
 * documents it as safe only inside one of the old near-black wells, never
 * against `--background`. It is pinned here anyway, for a related but
 * distinct reason: this file's own mechanism - fail loudly on any (file,
 * count) this scanner has not seen audited before - catches a NEW file
 * typing the literal `text-ink` class string somewhere outside an audited
 * well, the moment it happens, rather than at review.
 *
 * What it does NOT catch, confirmed empirically rather than assumed: PR
 * #94's own round-1 medium finding was `<Button variant="ghost">` inside
 * mobile-nav-toggle.tsx, not a literal `text-ink` string in that file - this
 * is exactly the scope limit this file's own docstring already names
 * ("it cannot see one reaching a file through component composition -
 * `<Button variant="outline">`... carries no `border-primary`/`text-primary`
 * substring of their own"). Reverting that variant back to `"ghost"` and
 * re-running this suite leaves it green, because `ghost` is a string inside
 * button.tsx, not inside mobile-nav-toggle.tsx. The real guard against THAT
 * class of regression is mobile-nav-toggle.contrast.test.tsx, which resolves
 * whichever token the component's REAL rendered className carries and
 * measures it directly - confirmed to catch the identical mutation this
 * paragraph describes. `text-ink`'s addition here is still worth having for
 * what it DOES catch (the literal-string case), just not a substitute for
 * that component-level test.
 *
 * The negative lookahead above still matters for this addition the same way
 * it does for the other four: `text-ink-muted` is a different, unrelated
 * token and must not be swallowed into `text-ink`'s count.
 */
const DUAL_MEANING_TOKENS = [
  "text-foreground",
  "text-primary",
  "text-muted-foreground",
  "border-primary",
  "text-ink",
] as const;
type DualMeaningToken = (typeof DUAL_MEANING_TOKENS)[number];

const TOKEN_PATTERN = new RegExp(
  `\\b(${DUAL_MEANING_TOKENS.join("|")})\\b(?!-)`,
  "g",
);

const DESIGN_LIB_DIR = path.join(SRC_ROOT, "lib", "design") + path.sep;

/** Design-system internals (color.ts, contrast.ts, tokens.ts, usage.ts) reason about these strings as data, not as rendered UI - see no-raw-hex.test.ts's identical exclusion for the same reasoning. */
function isExcluded(file: string): boolean {
  if (file.startsWith(DESIGN_LIB_DIR)) return true;
  if (isTestFile(file)) return true;
  return false;
}

/**
 * Memoised (round 5): "finds files to scan" and the real assertion below it
 * both need the file list, and the source tree does not change mid-run, so
 * walking it twice bought nothing but a second filesystem traversal.
 */
let cachedFiles: string[] | undefined;
function scannedFiles(): string[] {
  return (cachedFiles ??= walkSourceFiles(SRC_ROOT, isExcluded));
}

/** Every (file, token) count found in the current source tree. */
function scanDualMeaningUsage(): Map<string, Partial<Record<DualMeaningToken, number>>> {
  const files = scannedFiles();

  const found = new Map<string, Partial<Record<DualMeaningToken, number>>>();
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"), file);
    const relative = path.relative(path.dirname(SRC_ROOT), file);

    TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    const counts: Partial<Record<DualMeaningToken, number>> = {};
    while ((match = TOKEN_PATTERN.exec(source)) !== null) {
      const token = match[1] as DualMeaningToken;
      counts[token] = (counts[token] ?? 0) + 1;
    }
    if (Object.keys(counts).length > 0) found.set(relative, counts);
  }
  return found;
}

/**
 * Audited rounds 2, 4 and 5 of ugcportal-rw9j. Every entry below renders on
 * --background (the page canvas, where the new meaning is correct) with one
 * documented exception: src/components/ui/button.tsx's `border-primary`/
 * `text-primary` are PETROL_OUTLINE_STYLE, shared by the `outline` and
 * `secondary` button variants - correct wherever a caller renders them on
 * --background (every current caller except one, which now uses the
 * dedicated `outline-neutral` variant instead - see button.tsx), and its own
 * `text-primary` in the (currently unused) `link` variant is the same token
 * for the same reason, dead code only for now.
 *
 * Round 4 added src/app/upload/page.tsx, upload-form.tsx and
 * src/components/gallery/containment.ts: all three used text-ink/
 * text-ink-muted directly on --background (safe before this bead, wrong
 * once --background stopped being the near-black surface scale) and were
 * switched to the semantic tokens this file tracks.
 *
 * Round 5 (code-review) found a second instance in containment.ts itself:
 * GALLERY_CAPTION_CLASS, three lines above GALLERY_TAG_CLASS in the real
 * file, used text-ink and was missed in round 4 - the caption feature
 * (ugcportal-gwr) landed on a diverging branch and merged into this one only
 * after round 4, so round 4's own audit never saw it. Switched to
 * text-muted-foreground, the same token its sibling already uses.
 *
 * ugcportal-qnq9.2.2 added a third instance, GALLERY_COMMERCIAL_LINK_MARKER_
 * CLASS: the per-link bilingual marker renders as a sibling of the gallery
 * tile's own `<button>`, directly on --background - the identical placement
 * GALLERY_CAPTION_CLASS and GALLERY_TAG_CLASS already use the same token
 * for, not a new context this file needs to re-audit from scratch.
 */
const AUDITED_USAGE: Record<string, Partial<Record<DualMeaningToken, number>>> = {
  // The page h1 moved out of auth/error, upload and the legal frame into
  // src/components/page-title.tsx (ugcportal-qnq9.4, PR #90 round 2); it
  // still renders straight on --background inside the app shell's <main>,
  // so the page-canvas token stays the correct one.
  "src/components/page-title.tsx": { "text-foreground": 1 },
  "src/app/auth/error/page.tsx": { "text-muted-foreground": 1 },
  // ugcportal-qnq9.4: the legal pages render straight on --background inside
  // the app shell's <main>, with no surface well of their own - the same
  // situation as auth/error/page.tsx and upload/page.tsx, so the page-canvas
  // pair is the correct one.
  "src/components/legal/legal-page.tsx": {
    "text-foreground": 3,
    "text-muted-foreground": 5,
  },
  // ugcportal-qnq9.7 round 5: the inline-link class string these admin pages
  // wrote out by hand is now INLINE_LINK_CLASS (src/components/ui/inline-link.ts),
  // so their own "text-primary" counts drop; rights/page.tsx keeps one
  // differently-styled link of its own.
  "src/app/admin/settings/rights/page.tsx": { "text-muted-foreground": 5, "text-primary": 1 },
  // ugcportal-mqh8: the brand list renders on the same plain page canvas as
  // its sibling above - the body copy and the brand slug both sit outside
  // any bg-muted/bg-destructive-surface well (those wells use text-ink/
  // text-ink-muted instead, per contrast.ts), so the page-canvas token is
  // the correct one here too.
  "src/app/admin/settings/rights/brands/page.tsx": { "text-muted-foreground": 5 },
  // text-ink counts (ugcportal-14k9 PR #94 review round 1, low finding 5):
  // every field in this form - five identically-styled inputs/textareas -
  // renders on the resale-rights decision screen's plain page canvas, not
  // any well; text-ink here is the pre-existing body-text token for that
  // same safe context, pinned so a new usage cannot land silently.
  "src/app/admin/settings/rights/decision-form.tsx": {
    "text-muted-foreground": 3,
    "text-ink": 5,
  },
  "src/app/admin/settings/users/page.tsx": { "text-muted-foreground": 4 },
  "src/app/admin/settings/instagram/page.tsx": { "text-muted-foreground": 3 },
  "src/app/upload/page.tsx": { "text-muted-foreground": 1 },
  // text-ink used to be 2 here (low finding 5): the alt-text and caption
  // labels, on the upload form's own plain canvas (ugcportal-gwr). The two
  // inputs that used to make this 4 already took their class from the
  // shared text-input.ts constant (ugcportal-qnq9.7 round 3); the two
  // labels now do too (ugcportal-qnq9.16, item 4 of the lows deferred from
  // PR #93's round-6 review — TEXT_LABEL_CLASS, audited below), so this
  // file carries no literal "text-ink" of its own left to pin.
  // Raised from text-foreground: 2 / text-muted-foreground: 5 by
  // ugcportal-15r's AttestationFields, which renders directly on
  // --background like the tag picker beside it (its own legend, each
  // question's legend, and one label per radio - the yes/no pairs, the three
  // authorship options - take text-foreground; the block's intro, every "why
  // we ask" line and each question's own help text take
  // text-muted-foreground). No new token and no new context: the same two
  // the TagPicker fieldset immediately below it already uses, on the same
  // page canvas, which is the case this whole audit calls correct.
  "src/app/upload/upload-form.tsx": {
    "text-foreground": 7,
    "text-muted-foreground": 8,
  },
  // text-ink: 1 (low finding 5) - the queued file's name, on the upload
  // page's own plain canvas (ugcportal-n3c).
  "src/app/upload/upload-queue-list.tsx": { "text-ink": 1 },
  // text-ink: 2 (ugcportal-qnq9.16, item 4 of the lows deferred from PR
  // #93's round-6 review): TEXT_INPUT_CLASS's one usage (on the input's
  // own bg-surface-1 fill, the same well-interior case as
  // decision-form.tsx's bg-surface-3 fields) plus TEXT_LABEL_CLASS's one
  // (on the page canvas, the same case upload-form.tsx's and the
  // About/Portfolio contact form's labels were each pinned under before
  // both were extracted to this one shared constant). Both shared by
  // upload-form.tsx and contact-mailto-form.tsx, neither of which has a
  // literal "text-ink" of its own left to pin as a result.
  "src/components/ui/text-input.ts": { "text-ink": 2 },
  // text-ink: 2 (low finding 5) - button.tsx's OWN two usages
  // (NEUTRAL_OUTLINE_STYLE and the `ghost` variant), each documented there
  // as measured and safe only inside one of the old near-black wells. Pinned
  // so a third usage inside button.tsx cannot land silently; a caller
  // choosing `variant="ghost"` on an unsafe background has no "text-ink"
  // substring of its own and is this scanner's documented scope limit -
  // mobile-nav-toggle.contrast.test.tsx is the guard for that case.
  "src/components/ui/button.tsx": { "border-primary": 1, "text-primary": 2, "text-ink": 2 },
  /*
   * ugcportal-14k9: the wordmark and tagline tokens app-shell.tsx's former
   * entry covered moved with the header's markup into site-header.tsx. The
   * nav links' shared base class (text-foreground/hover:text-primary) lives
   * in src/components/header-nav-link.ts, shared with upload-link.tsx (PR
   * #94 round 1, low finding 4) - upload-link.tsx's own former entry is
   * retired with it, since the literal class string no longer appears in
   * that file. The sticky header is bg-background, so the page-canvas
   * tokens are exactly right here, same as the wordmark always was.
   *
   * ugcportal-qqnt.3: the wordmark stopped sharing HEADER_NAV_LINK_CLASS
   * (K1 asks it to be visibly bigger than the nav links - text-lg/
   * font-heading - which that shared class's own text-sm/font-medium would
   * have fought), so it now carries its own literal `text-foreground
   * hover:text-primary` pair directly in site-header.tsx instead of
   * reaching it through that import. The tagline row (and its
   * text-muted-foreground) moved to the footer in the same change - see
   * site-footer.tsx's own entry below, which gained it.
   */
  "src/components/header-nav-link.ts": { "text-foreground": 1, "text-primary": 1 },
  // Just the aria-[current=page]:text-primary highlight this component adds
  // on top of the shared base class above.
  "src/components/primary-nav-link.tsx": { "text-primary": 1 },
  "src/components/site-header.tsx": { "text-foreground": 1, "text-primary": 1 },
  // app-shell.tsx itself carries no entry (round-6 review, merge with
  // ugcportal-14k9): the header's markup moved out to site-header.tsx
  // above and the footer's moved out to site-footer.tsx below, so the
  // file this bead's own doc comment still calls "the application frame"
  // is left with no literal className of its own for any of these four
  // tokens — zero matches, per this file's own "zero matches" rule.
  "src/components/gallery/gallery.tsx": { "text-foreground": 2, "text-muted-foreground": 2 },
  "src/components/gallery/gallery-unavailable.tsx": {
    "text-foreground": 1,
    "text-muted-foreground": 1,
  },
  "src/components/gallery/containment.ts": { "text-muted-foreground": 3 },
  "src/components/auth-status.tsx": { "text-muted-foreground": 1 },
  // cookie-settings-link.tsx carried its own literal class string here
  // until PR #96 round-1 review (ugcportal-akv6): it now imports
  // FOOTER_LINK_CLASS from src/components/ui/footer-link.ts instead
  // (shared with site-footer.tsx), so its own source text carries neither
  // token any more — no entry, per this file's own "zero matches" rule.
  // Deliberately bg-background, not bg-popover (see this file's own
  // comment, added after an axe run caught text-primary on bg-popover at
  // 1.81:1 in dark mode) — the safe case.
  "src/components/consent/cookie-banner.tsx": { "text-foreground": 1 },

  /*
   * ugcportal-qnq9.7: the public About and Portfolio pages, and the shared
   * sections they're built from. Every entry below renders directly on the
   * page canvas (--background) — none of these sit inside a --card/
   * --popover/--muted/--accent/--secondary/--destructive-surface/--sidebar
   * fill or any src/components/gallery/containment.ts well, which is the one
   * condition that would need text-ink/text-ink-muted instead (see this
   * file's header comment).
   *
   * Round 2 moved the shared `<h1>` both pages used to carry out to
   * `src/components/site/page-shell.tsx` (`PageShell`) — so
   * `src/app/about/page.tsx` carries none of these tokens directly any more
   * (no entry below: an audited file with zero matches simply isn't one).
   *
   * Round 3 did the same for the shared `<h2>` section heading
   * (`src/components/site/section-heading.ts`, `SECTION_HEADING_CLASS`):
   * `/portfolio`'s own `text-foreground` count is now zero too (its
   * "Samples" `<h2>` moved to the constant; its empty-state `<p>` still
   * accounts for the one `text-muted-foreground`), and
   * `contact-section.tsx`'s "Get in touch" `<h2>` moved the same way, so
   * that file's own `text-foreground` count also dropped to zero.
   * `what-we-offer-section.tsx` keeps one `text-foreground` of its own —
   * its per-item `<dt>`, not the section `<h2>`, which also moved to the
   * shared constant.
   */
  "src/app/portfolio/page.tsx": { "text-muted-foreground": 1 },
  // ugcportal-qnq9.12: the per-item page's "short text" paragraph, directly
  // on the page canvas (--background) like every other entry in this
  // group — the same muted-foreground-on-background pairing
  // GALLERY_CAPTION_CLASS and /portfolio's own empty-state paragraph use,
  // just not reused verbatim (see that file's own comment for why: its
  // margin is sized for sitting under a cropped grid tile, not this page's
  // full-width image).
  "src/app/media/[previewId]/page.tsx": { "text-muted-foreground": 1 },
  // ugcportal-lju: the share control's status announcement ("Link copied" /
  // "Shared" / "Could not copy the link"), rendered as a direct sibling of
  // the Share button on the SAME per-item page canvas (--background) as the
  // "short text" paragraph audited directly above — the identical
  // muted-foreground-on-background pairing, just a status region instead of
  // a caption.
  "src/components/share/share-control.tsx": { "text-muted-foreground": 1 },
  "src/components/site/page-shell.tsx": { "text-foreground": 1 },
  "src/components/site/section-heading.ts": { "text-foreground": 1 },
  // Round-1 review simplified this component (K2's spec marker rendered
  // unconditionally, since nothing yet recorded a real paid/gifted job to
  // branch on) — one text-foreground usage, not two. UPDATED
  // (ugcportal-e0jv, part B of ugcportal-qnq9.1): the K3 advertising-label
  // branch exists now, conditional on the spec marker's own absence — but
  // its badge is GALLERY_ADVERTISING_LABEL_CLASS (bg-primary/text-primary-
  // foreground, src/components/gallery/containment.ts), a DIFFERENT pair
  // this file does not track, so the spec marker's own text-foreground
  // count is unaffected and stays at exactly one.
  "src/components/portfolio/portfolio-tile.tsx": { "text-foreground": 1 },
  // Round 2 extracted INLINE_LINK_CLASS as a LOCAL constant for the two
  // identically-styled links in this file; round 5 moved that constant out
  // to src/components/ui/inline-link.ts (shared with the three admin
  // pages above), so "text-primary" no longer appears in this file's own
  // source text at all — the two `<a>` elements import the string instead
  // of writing it.
  "src/components/site/contact-section.tsx": { "text-muted-foreground": 3 },
  "src/components/site/intro-section.tsx": { "text-muted-foreground": 1 },
  "src/components/site/what-we-offer-section.tsx": {
    "text-foreground": 1,
    "text-muted-foreground": 1,
  },
  "src/components/ui/inline-link.ts": { "text-primary": 1 },

  /*
   * ugcportal-akv6, PR #96 round 1: FOOTER_LINK_CLASS moved out to its own
   * module (shared between site-footer.tsx and cookie-settings-link.tsx,
   * same reasoning as inline-link.ts above). Renders on --background via
   * both its callers — it carries no background of its own.
   */
  "src/components/ui/footer-link.ts": {
    "text-muted-foreground": 1,
    "text-foreground": 1,
  },

  /*
   * ugcportal-akv6: the site footer. Renders directly on --background
   * (the app shell's <footer>, no --card/--popover/--muted/etc. fill
   * behind it — the same safe case as the header and
   * cookie-settings-link.tsx above). Four text-muted-foreground (was three
   * - PR #96 originally dropped the footer's own about/tagline line
   * rather than duplicating the header's SITE_TAGLINE; ugcportal-qqnt.3
   * reversed that call the OTHER way - it removed the header's own
   * tagline row instead, and moved SITE_TAGLINE here so the one-sentence
   * description is not lost outright): the blocked-draft-link <span>, the
   * new SITE_TAGLINE <p> in the full variant's brand column, the compact
   * variant's own wrapping <div> (not the "SITE_NAME · © year" <span> it
   * contains, which carries no class of its own — round-2 review
   * finding), and the full variant's copyright line (FOOTER_LINK_CLASS's
   * own one moved to footer-link.ts above, round 1). Two text-foreground:
   * the brand name, and FOOTER_HEADING_CLASS's own definition (reused by
   * both the "Pages" and "Legal" headings — FOOTER_LINK_CLASS's
   * "hover:text-foreground" moved out the same way).
   */
  "src/components/site-footer.tsx": {
    "text-muted-foreground": 4,
    "text-foreground": 2,
  },

  /*
   * ugcportal-6dvg: the front page's "living empty state" — rendered by
   * src/app/page.tsx directly on --background inside the app shell's
   * <main>, the exact same placement as GalleryEmpty/GalleryUnavailable it
   * replaces when the gallery is genuinely empty (not inside any well), so
   * the page-canvas pair is the correct one here too. One text-foreground:
   * the heading (ugcportal-qqnt.1's SECTION_TITLE_CLASS caller); one
   * text-muted-foreground: the supporting paragraph. The "see the
   * portfolio" link's own text-foreground is gone (ugcportal-qqnt.2): it
   * now renders through buttonVariants({variant: "outline"}), which reads
   * text-primary — a literal that lives in src/components/ui/button.tsx's
   * own PETROL_OUTLINE_STYLE, not in this file's source text, so it is that
   * file's count which carries it, not this one's.
   */
  /*
   * ugcportal-qqnt.5: two `text-foreground` usages now, not one — the
   * "Nothing is published yet." heading (pre-existing) and the new "From
   * the portfolio" tile-row title. Both audited the same way: this
   * component's own container (`GALLERY_STATE_CONTAINER_CLASS`) sets no
   * background of its own, so every heading inside it renders straight on
   * `--background`, the safe case this file's own header comment names.
   */
  "src/components/home/empty-state.tsx": {
    "text-foreground": 2,
    "text-muted-foreground": 1,
  },
  /*
   * ugcportal-6dvg's own hero.tsx: the front page's hero, which renders
   * inside its own petrol-gradient well instead of --background and uses
   * `text-ink` only (round-2 review, low finding: this comment used to
   * also say "text-ink-muted" — that token measured below threshold on
   * this specific well and was dropped from hero.tsx entirely during this
   * bead's own round-1 review fix; see hero.tsx's own comment on its lead
   * paragraph), measured safe in contrast.ts's ink-on-hero-petrol.
   *
   * ugcportal-akv6 round 6: this entry itself was MISSING from main at the
   * point PR #96 merged origin/main in — "text-ink" was already a tracked
   * token by the time #97 (this file's bead) shipped, so the file's own
   * dual-meaning-usage audit should already have required this entry; the
   * two literal `text-ink` usages are the heading and the lead paragraph
   * (hero.tsx lines ~161 and ~173). Confirmed against a clean checkout of
   * origin/main at 35800c9 before adding this — this test fails there
   * too, independent of this merge.
   */
  "src/components/home/hero.tsx": { "text-ink": 2 },
};

// ugcportal-9faa: scannedFiles() above already memoizes the real-tree walk
// (`cachedFiles ??=`), so there is nothing redundant left to cache here —
// the remaining cost is the TypeScript parse itself (stripComments, inside
// scanDualMeaningUsage), real CPU work a busy machine can push past the 5s
// default on its own. Explicit timeout, not a bigger global default; see
// analytics-host.grep.test.ts and throttled-log.no-sibling-copy.test.ts for
// the same shape of fix and the measurements behind it.
describe("dual-meaning token usage is audited, not just found", { timeout: 15_000 }, () => {
  it("finds files to scan", () => {
    expect(scannedFiles().length).toBeGreaterThan(10);
  });

  it("matches the audited (file, token, count) baseline exactly", () => {
    const found = scanDualMeaningUsage();

    const foundFiles = new Set(found.keys());
    const auditedFiles = new Set(Object.keys(AUDITED_USAGE));

    const unaudited = [...foundFiles].filter((file) => !auditedFiles.has(file));
    expect(
      unaudited,
      `New dual-meaning token usage found with no audit entry. For each file, check what ` +
        `background it actually renders on (see this file's header) and add it to ` +
        `AUDITED_USAGE:\n${unaudited.map((f) => `  ${f}: ${JSON.stringify(found.get(f))}`).join("\n")}`,
    ).toEqual([]);

    const missing = [...auditedFiles].filter((file) => !foundFiles.has(file));
    expect(
      missing,
      `AUDITED_USAGE lists a file with no dual-meaning token usage left in it - the audit ` +
        `is stale and should be trimmed:\n${missing.join("\n")}`,
    ).toEqual([]);

    for (const file of auditedFiles) {
      expect(found.get(file), file).toEqual(AUDITED_USAGE[file]);
    }
  });
});
