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
 */
const DUAL_MEANING_TOKENS = [
  "text-foreground",
  "text-primary",
  "text-muted-foreground",
  "border-primary",
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
    const source = stripComments(readFileSync(file, "utf8"));
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
  "src/app/admin/settings/rights/decision-form.tsx": { "text-muted-foreground": 3 },
  "src/app/admin/settings/users/page.tsx": { "text-muted-foreground": 4 },
  "src/app/admin/settings/instagram/page.tsx": { "text-muted-foreground": 3 },
  "src/app/upload/page.tsx": { "text-muted-foreground": 1 },
  "src/app/upload/upload-form.tsx": { "text-foreground": 2, "text-muted-foreground": 5 },
  "src/components/upload-link.tsx": { "text-foreground": 1, "text-primary": 1 },
  "src/components/ui/button.tsx": { "border-primary": 1, "text-primary": 2 },
  // ugcportal-akv6 moved the footer (and its one text-muted-foreground
  // usage) out to src/components/site-footer.tsx; the header markup this
  // bead left untouched keeps its own text-foreground/text-primary pair.
  "src/components/app-shell.tsx": {
    "text-foreground": 1,
    "text-primary": 1,
  },
  "src/components/gallery/gallery.tsx": { "text-foreground": 2, "text-muted-foreground": 2 },
  "src/components/gallery/gallery-unavailable.tsx": {
    "text-foreground": 1,
    "text-muted-foreground": 1,
  },
  "src/components/gallery/containment.ts": { "text-muted-foreground": 2 },
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
  "src/components/site/page-shell.tsx": { "text-foreground": 1 },
  "src/components/site/section-heading.ts": { "text-foreground": 1 },
  // Round-1 review simplified this component (K2's spec marker renders
  // unconditionally, the K3 advertising-label branch is gone until
  // ugcportal-qnq9.1 lands) — one text-foreground usage now, not two.
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
   * cookie-settings-link.tsx above). Four text-muted-foreground: the
   * brand description paragraph, the blocked-draft-link <span>, the
   * compact variant's "SITE_NAME · © year" <span>, and the full variant's
   * copyright line (FOOTER_LINK_CLASS's own one moved to footer-link.ts
   * above, round 1). Two text-foreground: the brand name, and
   * FOOTER_HEADING_CLASS's own definition (reused by both the "Pages" and
   * "Legal" headings — FOOTER_LINK_CLASS's "hover:text-foreground" moved
   * out the same way).
   */
  "src/components/site-footer.tsx": {
    "text-muted-foreground": 4,
    "text-foreground": 2,
  },
};

describe("dual-meaning token usage is audited, not just found", () => {
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
