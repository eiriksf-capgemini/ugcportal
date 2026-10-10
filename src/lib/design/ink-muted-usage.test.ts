/**
 * ugcportal-7g2o: an audit of every `text-ink-muted` usage in shipped
 * source, in the shape of AUDITED_DECORATIVE_BORDER_USAGES (contrast.test.ts)
 * and dual-meaning-usage.test.ts's own AUDITED_USAGE — but keyed PER
 * OCCURRENCE, by its line AND its own literal content, not by file, and not
 * by line alone. See "WHY CONTENT, NOT JUST A COUNT OR A LINE" below for the
 * two shapes that were tried first and found not to hold.
 *
 * THE DEFECT THIS CLOSES. `--color-ink-muted` (what `text-ink-muted`
 * resolves to) is tuned for the near-black surface scale: light text meant
 * to sit on a dark fill. It measures 1.9003:1 against `--paper`
 * (`--background`'s light-mode value) — verified with this repo's own
 * `parseColor`/`contrastRatio` in a throwaway probe, deleted after. It is
 * correct on a surface carrying its own darker fill (a `bg-surface-*` well,
 * a `bg-destructive-surface` error well) and wrong on the plain page canvas.
 *
 * That gap shipped the identical defect three times across three review
 * rounds of ugcportal-6uc2, each filed and fixed separately with the class
 * left intact: `TEXT_LABEL_CLASS`'s own `text-ink` (ugcportal-4r0e — a
 * DIFFERENT token, not tracked by this file, see its own bead), upload-
 * form.tsx's two helper paragraphs (ugcportal-galb), and triage-form.tsx's
 * two attestation spans. The two plain-canvas usages this bead found still
 * standing — triage-form.tsx's two attestation spans and upload-form.tsx's
 * alt-text helper + caption qualifier — are fixed in this same change (see
 * their own comments); this file is what stops the next one arriving
 * unnoticed.
 *
 * WHY CONTENT, NOT JUST A COUNT OR A LINE. Two earlier shapes of this file
 * were each found to have the same underlying hole, re-expressed:
 *
 * 1. A per-FILE key, each entry a `count` plus one classification covering
 *    the whole count — the shape AUDITED_DECORATIVE_BORDER_USAGES uses, fine
 *    for a class whose every usage is the SAME role everywhere (true of a
 *    border; not true of this token, correct on one surface and wrong on
 *    another). A file already holding three correctly-classified
 *    `bg-surface-1` usages could absorb a fourth, genuinely unsafe,
 *    plain-canvas one by incrementing that file's count from 3 to 4 — no new
 *    classification required, and every existing assertion (including a
 *    fixture mutation) stayed green, because both only compared the raw
 *    SCAN's total against the allowlist's total, never asked whether the
 *    classification covering that total was true of every occurrence in it.
 *
 * 2. A per-OCCURRENCE key by `file:line` alone closed that hole but opened a
 *    narrower one of the same shape: a LINE NUMBER is a coordinate, not an
 *    identity. If an edit shifts an existing, correctly-classified
 *    occurrence away from its audited line while a DIFFERENT, unsafe
 *    occurrence happens to land exactly on the line number it vacated, the
 *    set of `file:line` keys can come out IDENTICAL to the audited set even
 *    though the content behind one key completely changed — silently
 *    absorbed, same as (1), just by coincidence of position instead of
 *    arithmetic. See the "FIXTURE MUTATION: a collision" test below, which
 *    demonstrates this shape failing to be caught by a line-only comparison
 *    before showing the fix that catches it.
 *
 * The key below is `file:line:content`, where `content` is the literal's own
 * raw source text (the whole string/template literal, quotes included,
 * whitespace collapsed). Content cannot coincide by accident the way a line
 * number can — two genuinely different usages hashing to the identical
 * literal text is not a coordinate collision, it is the two usages being
 * textually indistinguishable, a different and far narrower residual (see
 * "WHAT THIS STILL CANNOT CATCH" below). There is no longer a count to
 * raise and no longer a bare coordinate to squat on: a new occurrence is
 * either a known `file:line:content` key with its own classification, or it
 * is unknown, full stop.
 *
 * SCANNED, PRECISELY. `occurrencesIn` walks the TypeScript AST (the same
 * parser `scan-source.ts`'s `sourceFileOf` already uses) and looks inside
 * the shapes `visit()` below checks for: a string literal / no-substitution
 * template literal (`ts.isStringLiteralLike`), and the static head/span
 * segments of an interpolated template (`ts.isTemplateExpression`). A
 * match's position is found by searching the literal's own RAW source slice
 * (`sourceFile.text.slice(node.getStart(), node.getEnd())`), not its decoded
 * `.text` — the two can differ in length wherever the source contains an
 * escape sequence, which would have put the computed position at the wrong
 * OFFSET and, for a literal that itself spans a line break, at the wrong
 * LINE. Searching the raw slice removes the gap instead of documenting it:
 * the index of a match within the raw slice is already an exact offset into
 * the real source.
 *
 * NOT scanned: bare JSX text (the text between tags, as opposed to a
 * string/template value inside an attribute). A Tailwind class is a
 * `className` attribute's VALUE, never JSX text content, and every real
 * usage in this codebase bears that out — so the omission costs nothing
 * today. Stated as a scope boundary, not papered over: `occurrencesIn`
 * does not call `ts.isJsxText` anywhere, and a literal `text-ink-muted`
 * written as JSX text rather than inside a `className` string is invisible
 * to this audit.
 *
 * WHAT THIS STILL CANNOT CATCH. Stated rather than solved, and not offered
 * as an exhaustive list: what follows is what this design's mechanism is
 * known not to see, not a closed inventory of everything it might miss.
 *
 * - This audit has no JSX-ancestor-aware static analysis, so it cannot
 *   verify that a classification's `surface`/`pairingIds` are actually TRUE
 *   of the occurrence they are attached to (the same scope limit dual-
 *   meaning-usage.test.ts's own header names for a different token). A new,
 *   genuinely unsafe occurrence could be given its own new, honestly-unique
 *   key paired with a FALSE classification that happens to name a real,
 *   passing pairing (`ink-muted-on-surface-1`, say). That passes every
 *   check below: the pairing is real, its foreground really is
 *   `--color-ink-muted`, and it really does clear 4.5:1 — just not for the
 *   occurrence it is attached to. What IS enforced, mechanically: every
 *   occurrence gets its own explicit, individually reviewable entry naming
 *   a real, passing, correctly-tokened pairing, and none can ride in
 *   unlabelled. Whether a given entry's claimed surface is the TRUE surface
 *   is a per-PR-diff question for a human reader; this design does not
 *   remove that need. It only guarantees there is always something
 *   concrete, keyed to real content, for that reader to check.
 * - Two occurrences whose entire literal is BYTE-IDENTICAL, on the same
 *   line (an unlikely ternary like `cond ? "...text-ink-muted..." :
 *   "...text-ink-muted..."` with identical branches) produce the
 *   identical key and collide. `scanOccurrences` below treats that as a hard
 *   failure (it throws, naming the duplicate key) rather than silently
 *   merging the two or silently keeping only one — the same "never just
 *   skip" discipline `usage.ts`'s own header holds itself to.
 * - A usage reached through a SHARED NAMED IDENTIFIER — a `const` holding a
 *   class string, a pattern this codebase already uses (`TEXT_LABEL_CLASS`,
 *   `SELECT_CLASS`, `FIELD_CLASS`), and which CAN be referenced from more
 *   than one call site (`TEXT_LABEL_CLASS` is, from both upload-form.tsx and
 *   contact-mailto-form.tsx) — is recorded only once, at wherever its
 *   literal actually sits: the identifier's own declaration.
 *   `occurrencesIn` walks string/template literals, not
 *   references to them, so a second call site that renders the identical
 *   class list on a genuinely unsafe surface produces no signal of its own
 *   at all — no new key, nothing in `unaudited`, nothing `stale`. This is a
 *   different shape from the first residual above, not a restatement of it:
 *   there, a key exists and carries a false label; here, nothing is ever
 *   recorded for a second call site to be labelled (falsely or otherwise).
 *   Following an identifier out to every call site and judging each one's
 *   own surface is call-site- and JSX-ancestor-aware analysis this file does
 *   not attempt — the same gap dual-meaning-usage.test.ts's own header
 *   discloses for the tokens it tracks (DUAL_MEANING_TOKENS) rather than
 *   solves, for the same reason. Not live today: every occurrence
 *   AUDITED_USAGE lists above is an inline literal, not a shared identifier,
 *   so this gap is latent rather than shipped — it would stop being latent
 *   the moment a `text-ink-muted` call site is refactored onto a constant
 *   used on more than one surface.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { PAIRINGS, THRESHOLDS, evaluatePairing, type Pairing } from "./contrast";
import { GLOBALS_CSS_PATH, loadThemeTokens, type ThemeMode } from "./tokens";
import { isTestFile, sourceFileOf, walkSourceFiles } from "./scan-source";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Matched as a whole Tailwind utility word: `text-ink-muted-x` (no such
 * class exists today) must never be swallowed into this scan. */
const TOKEN_PATTERN = /\btext-ink-muted\b(?!-)/g;

const DESIGN_LIB_DIR = path.join(SRC_ROOT, "lib", "design") + path.sep;

/** Design-system internals reason about this string as data, not rendered UI — see dual-meaning-usage.test.ts's identical exclusion. */
function isExcluded(file: string): boolean {
  if (file.startsWith(DESIGN_LIB_DIR)) return true;
  if (isTestFile(file)) return true;
  return false;
}

let cachedFiles: string[] | undefined;
function scannedFiles(): string[] {
  return (cachedFiles ??= walkSourceFiles(SRC_ROOT, isExcluded));
}

/** Collapses a literal's raw source slice to a single-line, single-spaced identity string, for both the audit key and human readability. */
function normalize(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Every `file:line:content` occurrence of `text-ink-muted` in one file — see
 * this file's own header for exactly which two literal shapes are scanned,
 * why the match position is computed against the literal's RAW source slice
 * rather than its decoded text, and why JSX text is deliberately not among
 * the shapes scanned.
 */
function occurrencesIn(file: string, relativeFile: string): string[] {
  const sourceFile = sourceFileOf(file);
  const keys: string[] = [];

  function record(node: ts.Node): void {
    const start = node.getStart(sourceFile);
    const raw = sourceFile.text.slice(start, node.getEnd());
    TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_PATTERN.exec(raw)) !== null) {
      const line = sourceFile.getLineAndCharacterOfPosition(start + match.index).line + 1;
      keys.push(`${relativeFile}:${line}:${normalize(raw)}`);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      record(node);
    } else if (ts.isTemplateExpression(node)) {
      record(node.head);
      for (const span of node.templateSpans) record(span.literal);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return keys;
}

/** Every `text-ink-muted` occurrence in the shipped source tree, as `file:line:content` keys. */
/**
 * Refuses to silently merge or silently keep one of two occurrences whose
 * (file, line, literal content) key is identical - see this file's own
 * header, "WHAT THIS STILL CANNOT CATCH" - the same discipline usage.ts's
 * own header holds itself to for an unresolvable shape. Exported as its own
 * function, not inlined, so the throw itself has a direct unit test below
 * rather than depending on a real duplicate source occurrence ever existing
 * to exercise it.
 */
function assertUniqueKeys(keys: readonly string[]): ReadonlySet<string> {
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    throw new Error(
      `[ink-muted-usage] two occurrences produced the identical file:line:content key - ` +
        `cannot tell them apart. Keys found: ${keys.join(" | ")}`,
    );
  }
  return unique;
}

function scanOccurrences(): ReadonlySet<string> {
  const keys: string[] = [];
  for (const file of scannedFiles()) {
    const relative = path.relative(path.dirname(SRC_ROOT), file);
    keys.push(...occurrencesIn(file, relative));
  }
  return assertUniqueKeys(keys);
}

/**
 * One occurrence's classification: the surface this scanner cannot see for
 * itself (JSX-ancestor-aware static analysis this codebase does not have),
 * recorded by hand and checked against reality by the live pairing
 * evaluation below rather than trusted as written.
 *
 * `pairingIds` is more than one entry only when the usage's own className is
 * CONDITIONAL on component state (the upload dropzone's resting/dragging
 * fill) — every state the usage can actually render in is checked, not just
 * whichever is convenient.
 */
type OccurrenceClassification = {
  surface: string;
  pairingIds: readonly string[];
  /**
   * The worst (lowest) of evaluatePairing's live LIGHT-mode ratios across
   * pairingIds, to 4 decimal places. Re-asserted against a live computation
   * in the test below — a token change that moves this number fails the
   * suite loudly rather than leaving a stale, unchecked figure here.
   */
  lightRatio: number;
};

/**
 * Audited 2026-10-10 (ugcportal-7g2o). Every entry was traced by reading the
 * component's own render tree up to the nearest `bg-*`-carrying ancestor
 * (or the page canvas, when there is none). Keys are generated by
 * `occurrencesIn` above, not hand-typed — copy a failure message's exact key
 * rather than re-deriving the line/content formatting by eye.
 */
const AUDITED_USAGE: Readonly<Record<string, OccurrenceClassification>> = {
  // The per-uploader triage summary's <dl>, text-ink-muted only in the
  // `bg-destructive-surface` branch of its enclosing div's own className
  // ternary (the `bg-muted` branch uses text-muted-foreground instead,
  // tracked by dual-meaning-usage.test.ts).
  "src/app/admin/curation/page.tsx:594:\"mt-2 space-y-1 text-xs text-ink-muted\"": {
    surface: "bg-destructive-surface (the blocked-triage error well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  // Inside this file's alcohol-linked-brand disclosure well: the "Recorded
  // <date> by <admin>" line.
  "src/app/admin/settings/rights/brands/page.tsx:175:\"mt-1 text-ink-muted\"": {
    surface: "bg-destructive-surface (the alcohol-linked disclosure well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  // The separate "Needs attention: already published under this brand" well:
  // its supporting paragraph and its <ul> of affected items.
  "src/app/admin/settings/rights/brands/page.tsx:210:\"mt-1 text-ink-muted\"": {
    surface: "bg-destructive-surface (the attention-needed well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  "src/app/admin/settings/rights/brands/page.tsx:217:\"mt-2 list-disc space-y-1 pl-5 text-ink-muted\"": {
    surface: "bg-destructive-surface (the attention-needed well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  // The resale-rights review's blocker message and its <dl>, text-ink-muted
  // only in the `bg-destructive-surface` branch of the same div ternary
  // pattern page.tsx above uses.
  "src/app/admin/settings/rights/page.tsx:376:\"mt-1 text-ink-muted\"": {
    surface: "bg-destructive-surface (the blocked-resale-rights well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  "src/app/admin/settings/rights/page.tsx:384:\"mt-2 space-y-1 text-xs text-ink-muted\"": {
    surface: "bg-destructive-surface (the blocked-resale-rights well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  // The dropzone's own "or drag them here" / accepted-types copy, inside the
  // dropzone panel whose own fill alternates between bg-surface-1 (resting)
  // and bg-surface-2 (dragging) — both states are checked, not just resting.
  // NOT the alt-text helper paragraph or the caption's "(optional)"
  // qualifier a few lines further down the same file: those two were
  // text-ink-muted on the PLAIN canvas until ugcportal-7g2o fixed them (see
  // their own comments) — they are text-muted-foreground now, tracked by
  // dual-meaning-usage.test.ts, not by this file.
  "src/app/upload/upload-form.tsx:865:\"text-sm text-ink-muted\"": {
    surface: "bg-surface-1 (resting) / bg-surface-2 (dragging over) — the upload dropzone panel",
    pairingIds: ["ink-muted-on-surface-1", "ink-muted-on-surface-2"],
    lightRatio: 7.5212,
  },
  "src/app/upload/upload-form.tsx:866:\"max-w-prose text-xs text-ink-muted\"": {
    surface: "bg-surface-1 (resting) / bg-surface-2 (dragging over) — the upload dropzone panel",
    pairingIds: ["ink-muted-on-surface-1", "ink-muted-on-surface-2"],
    lightRatio: 7.5212,
  },
  // Inside the queue row's own nested bg-destructive-surface failure well
  // (the server's raw error detail).
  "src/app/upload/upload-queue-list.tsx:203:\"mt-1 font-mono text-xs text-ink-muted\"": {
    surface: "bg-destructive-surface (a failed upload's error detail)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  // Three inside the queue row's own bg-surface-1 <li> (the status label,
  // the mime-type/size line, and the "uploaded, publish it from the
  // gallery" success note).
  "src/app/upload/upload-queue-list.tsx:384:\"shrink-0 rounded-sm text-xs text-ink-muted outline-hidden focus:ring-3 focus:ring-ring/80\"": {
    surface: "bg-surface-1 (the queue row itself)",
    pairingIds: ["ink-muted-on-surface-1"],
    lightRatio: 8.4066,
  },
  "src/app/upload/upload-queue-list.tsx:389:\"mt-1 text-xs text-ink-muted\"": {
    surface: "bg-surface-1 (the queue row itself)",
    pairingIds: ["ink-muted-on-surface-1"],
    lightRatio: 8.4066,
  },
  "src/app/upload/upload-queue-list.tsx:422:\"text-xs text-ink-muted\"": {
    surface: "bg-surface-1 (the queue row itself)",
    pairingIds: ["ink-muted-on-surface-1"],
    lightRatio: 8.4066,
  },
};

const THEME_MODES: readonly ThemeMode[] = ["light", "dark"];
const tokensByMode: Record<ThemeMode, ReturnType<typeof loadThemeTokens>> = {
  light: loadThemeTokens(),
  dark: loadThemeTokens(GLOBALS_CSS_PATH, "dark"),
};

const pairingsById = new Map<string, Pairing>(PAIRINGS.map((p) => [p.id, p]));

type AuditDiff = {
  /** A scanned occurrence with no AUDITED_USAGE entry at all. */
  unaudited: string[];
  /** An AUDITED_USAGE entry naming an occurrence the scanner no longer finds. */
  stale: string[];
};

/**
 * The one comparison both the real assertion below and its FIXTURE MUTATION
 * tests run — sharing it (rather than the mutation tests asserting against
 * Set internals that merely resemble it) is what proves a mutation
 * exercises the actual gate, not a lookalike of it.
 */
function diffAudit(
  found: ReadonlySet<string>,
  audited: Readonly<Record<string, OccurrenceClassification>>,
): AuditDiff {
  const auditedKeys = new Set(Object.keys(audited));
  return {
    unaudited: [...found].filter((key) => !auditedKeys.has(key)),
    stale: [...auditedKeys].filter((key) => !found.has(key)),
  };
}

/**
 * Strips a `file:line:content` key down to `file:line` — used ONLY by the
 * collision test below to show what a line-only comparison would have seen,
 * never by the real audit.
 */
function fileAndLineOf(key: string): string {
  const secondColon = key.indexOf(":", key.indexOf(":") + 1);
  return key.slice(0, secondColon);
}

describe("text-ink-muted usage is audited per occurrence, by surface and ratio", () => {
  it("finds files to scan", () => {
    expect(scannedFiles().length).toBeGreaterThan(10);
  });

  it("the duplicate-key guard actually throws on a genuine collision", () => {
    expect(() => assertUniqueKeys(["a:1:\"x\"", "a:1:\"x\""])).toThrow(
      /identical file:line:content key/,
    );
    expect(() => assertUniqueKeys(["a:1:\"x\"", "a:2:\"x\""])).not.toThrow();
  });

  it("every classification points at a real PAIRINGS entry that actually measures --color-ink-muted", () => {
    for (const [key, entry] of Object.entries(AUDITED_USAGE)) {
      for (const pairingId of entry.pairingIds) {
        const pairing = pairingsById.get(pairingId);
        expect(pairing, `${key}: unknown PAIRINGS id "${pairingId}"`).toBeDefined();
        expect(
          pairing!.foreground,
          `${key}: pairing "${pairingId}" measures "${pairing!.foreground}", not ` +
            `--color-ink-muted — a classification must point at a pairing that measures ` +
            `the token the usage actually renders, not one that merely happens to pass.`,
        ).toBe("--color-ink-muted");
      }
    }
  });

  it("every classification clears body text's 4.5:1 live, in both colour schemes, at its recorded ratio", () => {
    for (const [key, entry] of Object.entries(AUDITED_USAGE)) {
      let worstLight = Infinity;
      for (const pairingId of entry.pairingIds) {
        const pairing = pairingsById.get(pairingId)!;
        for (const mode of THEME_MODES) {
          const result = evaluatePairing(pairing, tokensByMode[mode]);
          expect(
            result.ratio,
            `${key}: "${pairingId}" measures ${result.ratio.toFixed(4)}:1 in ${mode} mode, ` +
              `below body text's ${THRESHOLDS.body}:1`,
          ).toBeGreaterThanOrEqual(THRESHOLDS.body);
          if (mode === "light") worstLight = Math.min(worstLight, result.ratio);
        }
      }
      expect(
        worstLight,
        `${key}: recorded lightRatio ${entry.lightRatio} does not match the live light-mode ` +
          `ratio ${worstLight.toFixed(4)} — a token moved and the recorded figure is stale.`,
      ).toBeCloseTo(entry.lightRatio, 4);
    }
  });

  it("matches the audited occurrences exactly: no new one rides in, none is left stale", () => {
    const diff = diffAudit(scanOccurrences(), AUDITED_USAGE);

    expect(
      diff.unaudited,
      `New text-ink-muted occurrence(s) found with no audit entry. For each, trace it up to ` +
        `the nearest bg-*-carrying ancestor (or the plain page canvas, if there is none) and add ` +
        `a classification to AUDITED_USAGE keyed "file:line:content" (copy the exact key from ` +
        `this message), naming the real surface and PAIRINGS id — there is no passing pairing ` +
        `for --color-ink-muted on --background, so a genuinely plain-canvas occurrence cannot be ` +
        `classified "safe"; switch it to text-muted-foreground instead, the way ugcportal-7g2o ` +
        `fixed triage-form.tsx and upload-form.tsx.`,
    ).toEqual([]);

    expect(
      diff.stale,
      `AUDITED_USAGE names an occurrence the scanner no longer finds - the audit is stale and ` +
        `should be trimmed.`,
    ).toEqual([]);
  });

  it("FIXTURE MUTATION: a new occurrence in a file that already has audited, safe usages is not absorbed", () => {
    // The scenario a per-file COUNT let through: a brand-new, unaudited
    // occurrence lands in upload-queue-list.tsx, a file that already has
    // several audited, safe entries. Under the old per-file shape, the
    // "cheapest" adjustment was incrementing that file's one count - no new
    // entry required, and the suite stayed green. There is no count left to
    // increment here: the cheapest adjustment this design allows is making
    // NO change to AUDITED_USAGE at all, which is exactly what is tried.
    const mutated = new Set(scanOccurrences());
    const newKey = 'src/app/upload/upload-queue-list.tsx:999:"text-ink-muted"';
    mutated.add(newKey);

    const diff = diffAudit(mutated, AUDITED_USAGE);
    expect(diff.unaudited, "the new occurrence must be reported, naming its own key").toEqual([
      newKey,
    ]);
    expect(diff.stale).toEqual([]);
  });

  it("FIXTURE MUTATION: a new occurrence in a previously unaudited file fails naming that file", () => {
    const mutated = new Set(scanOccurrences());
    const newKey = 'src/components/media/a-hypothetical-new-component.tsx:12:"text-ink-muted"';
    mutated.add(newKey);

    const diff = diffAudit(mutated, AUDITED_USAGE);
    expect(diff.unaudited).toEqual([newKey]);
  });

  it("FIXTURE MUTATION: a collision - a new, unsafe occurrence landing on an audited line it did not shift from is not absorbed", () => {
    // The exact shape a LINE-ONLY key (file:line, no content) cannot tell
    // apart from nothing happening at all: pick a real audited occurrence,
    // pretend its true content shifted away to a new line (an unrelated
    // edit above it in the file), and pretend a DIFFERENT, unsafe occurrence
    // landed exactly on the line number it vacated. The set of real
    // `file:line` COORDINATES is unchanged by this - same count, same
    // numbers - only the content behind one of them is now a lie.
    const [victimKey] = Object.keys(AUDITED_USAGE).filter((key) =>
      key.startsWith("src/app/upload/upload-form.tsx:865:"),
    );
    expect(victimKey, "fixture assumption: this occurrence still exists").toBeDefined();
    const victimLine = fileAndLineOf(victimKey);

    const shiftedAwayKey = victimLine.replace(":865", ":9999") + ':"text-sm text-ink-muted"';
    const unsafeNewKey = `${victimLine}:"text-ink-muted"`; // same file:line, different (shorter, fabricated) content

    const realFound = scanOccurrences();
    const collided = new Set(realFound);
    collided.delete(victimKey);
    collided.add(shiftedAwayKey);
    collided.add(unsafeNewKey);

    // What a LINE-ONLY comparison would have seen: strip every key (both
    // sides) down to file:line and diff that. The collision is invisible -
    // victimLine is still present on both sides, and the genuinely new
    // shiftedAwayKey's line (:9999) is the only thing that would show up,
    // which is NOT the unsafe occurrence - it is the SAFE one that moved.
    // A reviewer fixing just that one "new file" complaint would never be
    // shown the unsafe occurrence silently sitting at :865 at all.
    const lineOnlyFound = new Set([...collided].map(fileAndLineOf));
    const lineOnlyAudited = new Set(Object.keys(AUDITED_USAGE).map(fileAndLineOf));
    const lineOnlyUnaudited = [...lineOnlyFound].filter((k) => !lineOnlyAudited.has(k));
    const lineOnlyStale = [...lineOnlyAudited].filter((k) => !lineOnlyFound.has(k));
    expect(
      lineOnlyUnaudited,
      "demonstrates the hole: a line-only key reports only the shifted SAFE occurrence's new line, never the unsafe one squatting on the old line",
    ).toEqual([fileAndLineOf(shiftedAwayKey)]);
    expect(lineOnlyStale, "demonstrates the hole: the vacated line is not reported stale, because something (the wrong thing) is still there").toEqual([]);

    // The real, content-keyed audit does not have this hole: both the
    // genuinely new content at the old coordinate AND the shifted content at
    // its new coordinate are unknown keys, and the original entry is stale.
    const diff = diffAudit(collided, AUDITED_USAGE);
    expect(diff.unaudited.sort()).toEqual([shiftedAwayKey, unsafeNewKey].sort());
    expect(diff.stale).toEqual([victimKey]);
  });
});
