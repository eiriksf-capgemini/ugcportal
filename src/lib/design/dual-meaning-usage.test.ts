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

/** Every (file, token) count found in the current source tree. */
function scanDualMeaningUsage(): Map<string, Partial<Record<DualMeaningToken, number>>> {
  const files = walkSourceFiles(SRC_ROOT, isExcluded);

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
 * Audited rounds 2 and 4 of ugcportal-rw9j. Every entry below renders on
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
 */
const AUDITED_USAGE: Record<string, Partial<Record<DualMeaningToken, number>>> = {
  "src/app/auth/error/page.tsx": { "text-foreground": 1, "text-muted-foreground": 1 },
  "src/app/admin/settings/rights/page.tsx": { "text-muted-foreground": 5, "text-primary": 2 },
  "src/app/admin/settings/rights/decision-form.tsx": { "text-muted-foreground": 3 },
  "src/app/admin/settings/users/page.tsx": { "text-muted-foreground": 4, "text-primary": 1 },
  "src/app/admin/settings/instagram/page.tsx": { "text-muted-foreground": 3, "text-primary": 1 },
  "src/app/upload/page.tsx": { "text-foreground": 1, "text-muted-foreground": 1 },
  "src/app/upload/upload-form.tsx": { "text-foreground": 2, "text-muted-foreground": 5 },
  "src/components/upload-link.tsx": { "text-foreground": 1, "text-primary": 1 },
  "src/components/ui/button.tsx": { "border-primary": 1, "text-primary": 2 },
  "src/components/app-shell.tsx": {
    "text-foreground": 1,
    "text-primary": 1,
    "text-muted-foreground": 1,
  },
  "src/components/gallery/gallery.tsx": { "text-foreground": 2, "text-muted-foreground": 2 },
  "src/components/gallery/gallery-unavailable.tsx": {
    "text-foreground": 1,
    "text-muted-foreground": 1,
  },
  "src/components/gallery/containment.ts": { "text-muted-foreground": 1 },
  "src/components/auth-status.tsx": { "text-muted-foreground": 1 },
};

describe("dual-meaning token usage is audited, not just found", () => {
  it("finds files to scan", () => {
    const files = walkSourceFiles(SRC_ROOT, isExcluded);
    expect(files.length).toBeGreaterThan(10);
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
