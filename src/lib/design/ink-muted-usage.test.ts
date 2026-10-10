/**
 * ugcportal-7g2o: an audit of every `text-ink-muted` usage in shipped
 * source, in the shape of AUDITED_DECORATIVE_BORDER_USAGES (contrast.test.ts)
 * and dual-meaning-usage.test.ts's own AUDITED_USAGE — but keyed PER
 * OCCURRENCE (`file:line`), not per file. See "WHY PER OCCURRENCE" below for
 * why a per-file count was tried first and found not to hold.
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
 * their own comments); this file is what stops a fifth one arriving
 * unnoticed.
 *
 * WHY PER OCCURRENCE. A per-file key, each entry a `count` plus one
 * classification covering the whole count — the same shape
 * AUDITED_DECORATIVE_BORDER_USAGES uses — has a hole this token's border
 * sibling does not: a border usage is the SAME role at every site, so a
 * per-file count is a legitimate summary of it. `text-ink-muted` is not —
 * the same literal string is correct on one surface and wrong on another —
 * so a file that already holds three correctly-classified `bg-surface-1`
 * usages can ABSORB a fourth, genuinely unsafe, plain-canvas usage by
 * nothing more than incrementing that file's count from 3 to 4: reproduced
 * for real, confirmed to pass every assertion a per-file version of this
 * audit has, including a fixture mutation that only ever tests whether the
 * SCAN disagrees with the allowlist. The count agrees with the allowlist;
 * the classification underneath it is simply never asked for.
 *
 * Keying by `file:line` instead removes the arithmetic entirely: there is no
 * quantity to raise. A new occurrence is either a known key with its own
 * classification, or it is an unknown key, full stop — "bump a sibling's
 * count" is not an operation this shape of data has.
 *
 * WHAT THIS STILL CANNOT CATCH, STATED PLAINLY. This audit cannot verify
 * that a classification's `surface`/`pairingIds` are actually TRUE of the
 * line they are attached to — it has no JSX-ancestor-aware analysis, the
 * same documented scope limit dual-meaning-usage.test.ts's own header names
 * for a different token. Someone could add a new, genuinely unsafe,
 * plain-canvas occurrence and give it its OWN new `file:line` entry that
 * falsely copies an existing safe classification (`ink-muted-on-surface-1`,
 * say) onto it. That would pass every check here: the pairing is real, its
 * foreground really is `--color-ink-muted`, and it really does clear 4.5:1
 * — just not for the reason stated. What this file DOES guarantee is
 * narrower and mechanical: every occurrence has an explicit, individually
 * reviewable entry naming a real, passing, correctly-tokened pairing, and
 * none can ride in by raising a number. Whether a given entry's claimed
 * surface is the TRUE surface is a per-PR-diff question for a human reader,
 * same as it always was for a brand-new file under the old per-file design
 * — this change narrows the blast radius of that trust to one line instead
 * of a whole file, it does not remove the need for it.
 *
 * Every classification is independently re-measured: `pairingId` must
 * resolve to a real PAIRINGS entry whose own `foreground` is
 * `--color-ink-muted` (a classification cannot point at a pairing measuring
 * a different token, e.g. `--muted-foreground`, just because it happens to
 * pass), the live evaluation of that pairing must clear body text's 4.5:1 in
 * BOTH colour schemes, and the ratio recorded here must match the live
 * light-mode number, so a drifted token fails loudly rather than leaving a
 * stale figure. There is deliberately no PAIRINGS entry anywhere pairing
 * `--color-ink-muted` with `--background`: it is known to fail (1.9003:1),
 * so an occurrence genuinely classified against the plain canvas has no
 * passing pairing id to point at.
 *
 * Occurrences are found via the TypeScript AST (the same parser
 * `scan-source.ts`'s `sourceFileOf` already uses for this repo's other
 * source-text scanners), not a comment-stripped regex: a string, template,
 * or JSX-text literal's own text is, by construction, never comment prose,
 * so there is no separate comment-stripping step to get right or wrong here
 * — unlike dual-meaning-usage.test.ts and no-raw-hex.test.ts, which scan
 * raw (de-commented) text for a utility that can appear in more shapes than
 * a single literal.
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

/**
 * Every `file:line` occurrence of `text-ink-muted` inside a string literal,
 * no-substitution template literal, or the static segments of an
 * interpolated template, in one file. A second occurrence landing on the
 * SAME line gets `#2`, `#3`, ... appended, so two usages sharing a line
 * cannot collide into one key — not a case any usage in this codebase hits
 * today, but the counter costs nothing and removes the possibility rather
 * than assuming it never happens.
 *
 * Column position is not tracked, only the line: a Tailwind class string
 * never spans a line break, so the line a match's index resolves to is
 * exact even though the index itself is computed against the literal's
 * OWN text (which excludes its surrounding quotes/backticks) rather than
 * against the full source — an off-by-one in the column that cannot move
 * the answer across a newline.
 */
function occurrencesIn(file: string, relativeFile: string): string[] {
  const sourceFile = sourceFileOf(file);
  const keys: string[] = [];
  const seenOnLine = new Map<number, number>();

  function record(literalStart: number, text: string): void {
    TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_PATTERN.exec(text)) !== null) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(literalStart + match.index).line + 1;
      const seen = (seenOnLine.get(line) ?? 0) + 1;
      seenOnLine.set(line, seen);
      keys.push(seen === 1 ? `${relativeFile}:${line}` : `${relativeFile}:${line}#${seen}`);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      // `.getStart()` is the position of the opening quote/backtick; `.text`
      // is the content AFTER it, so `+ 1` lines the two up (see this
      // function's own doc comment on why a one-character error here cannot
      // move the reported line).
      record(node.getStart(sourceFile) + 1, node.text);
    } else if (ts.isTemplateExpression(node)) {
      record(node.head.getStart(sourceFile) + 1, node.head.text);
      for (const span of node.templateSpans) {
        record(span.literal.getStart(sourceFile) + 1, span.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return keys;
}

/** Every `text-ink-muted` occurrence in the shipped source tree, as `file:line` keys. */
function scanOccurrences(): ReadonlySet<string> {
  const keys: string[] = [];
  for (const file of scannedFiles()) {
    const relative = path.relative(path.dirname(SRC_ROOT), file);
    keys.push(...occurrencesIn(file, relative));
  }
  const unique = new Set(keys);
  // Load-bearing, not a formality: if this ever fired it would mean two
  // DIFFERENT occurrences produced the identical key and one silently
  // vanished from the found set - exactly the kind of silent loss this
  // file's whole design exists to refuse. Not expected to fire; see
  // occurrencesIn's own same-line counter, which exists to prevent it.
  if (unique.size !== keys.length) {
    throw new Error(
      `[ink-muted-usage] two occurrences produced the same key - occurrencesIn's ` +
        `same-line counter has a gap. Keys found: ${keys.join(", ")}`,
    );
  }
  return unique;
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
 * (or the page canvas, when there is none).
 */
const AUDITED_USAGE: Readonly<Record<string, OccurrenceClassification>> = {
  // The per-uploader triage summary's <dl>, text-ink-muted only in the
  // `bg-destructive-surface` branch of its enclosing div's own className
  // ternary (the `bg-muted` branch uses text-muted-foreground instead,
  // tracked by dual-meaning-usage.test.ts).
  "src/app/admin/curation/page.tsx:594": {
    surface: "bg-destructive-surface (the blocked-triage error well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  // All three inside this file's two `bg-destructive-surface` wells: the
  // alcohol-linked-brand disclosure well's "Recorded <date> by <admin>" line,
  // and the separate "Needs attention: already published under this brand"
  // well's supporting paragraph and its <ul> of affected items.
  "src/app/admin/settings/rights/brands/page.tsx:175": {
    surface: "bg-destructive-surface (the alcohol-linked disclosure well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  "src/app/admin/settings/rights/brands/page.tsx:210": {
    surface: "bg-destructive-surface (the attention-needed well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  "src/app/admin/settings/rights/brands/page.tsx:217": {
    surface: "bg-destructive-surface (the attention-needed well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  // The resale-rights review's blocker message and its <dl>, text-ink-muted
  // only in the `bg-destructive-surface` branch of the same div ternary
  // pattern page.tsx above uses.
  "src/app/admin/settings/rights/page.tsx:376": {
    surface: "bg-destructive-surface (the blocked-resale-rights well)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
  },
  "src/app/admin/settings/rights/page.tsx:384": {
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
  "src/app/upload/upload-form.tsx:865": {
    surface: "bg-surface-1 (resting) / bg-surface-2 (dragging over) — the upload dropzone panel",
    pairingIds: ["ink-muted-on-surface-1", "ink-muted-on-surface-2"],
    lightRatio: 7.5212,
  },
  "src/app/upload/upload-form.tsx:866": {
    surface: "bg-surface-1 (resting) / bg-surface-2 (dragging over) — the upload dropzone panel",
    pairingIds: ["ink-muted-on-surface-1", "ink-muted-on-surface-2"],
    lightRatio: 7.5212,
  },
  // Three inside the queue row's own bg-surface-1 <li> (the status label,
  // the mime-type/size line, and the "uploaded, publish it from the
  // gallery" success note).
  "src/app/upload/upload-queue-list.tsx:384": {
    surface: "bg-surface-1 (the queue row itself)",
    pairingIds: ["ink-muted-on-surface-1"],
    lightRatio: 8.4066,
  },
  "src/app/upload/upload-queue-list.tsx:389": {
    surface: "bg-surface-1 (the queue row itself)",
    pairingIds: ["ink-muted-on-surface-1"],
    lightRatio: 8.4066,
  },
  "src/app/upload/upload-queue-list.tsx:422": {
    surface: "bg-surface-1 (the queue row itself)",
    pairingIds: ["ink-muted-on-surface-1"],
    lightRatio: 8.4066,
  },
  // Inside that row's own nested bg-destructive-surface failure well (the
  // server's raw error detail).
  "src/app/upload/upload-queue-list.tsx:203": {
    surface: "bg-destructive-surface (a failed upload's error detail)",
    pairingIds: ["muted-foreground-on-destructive-surface"],
    lightRatio: 7.7703,
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

describe("text-ink-muted usage is audited per occurrence, by surface and ratio", () => {
  it("finds files to scan", () => {
    expect(scannedFiles().length).toBeGreaterThan(10);
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
        `a classification to AUDITED_USAGE keyed "file:line", naming the real surface and ` +
        `PAIRINGS id — there is no passing pairing for --color-ink-muted on --background, so a ` +
        `genuinely plain-canvas occurrence cannot be classified "safe"; switch it to ` +
        `text-muted-foreground instead, the way ugcportal-7g2o fixed triage-form.tsx and ` +
        `upload-form.tsx.`,
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
    // four audited, safe entries. Under the old per-file shape, the
    // "cheapest" adjustment was incrementing that file's one count - no new
    // entry required, and the suite stayed green. Under file:line keys
    // there is no count left to increment: the cheapest adjustment this
    // design allows is making NO change to AUDITED_USAGE at all, which is
    // exactly what is tried here.
    const mutated = new Set(scanOccurrences());
    const newKey = "src/app/upload/upload-queue-list.tsx:999";
    mutated.add(newKey);

    const diff = diffAudit(mutated, AUDITED_USAGE);
    expect(diff.unaudited, "the new occurrence must be reported, naming its own key").toEqual([
      newKey,
    ]);
    expect(diff.stale).toEqual([]);
  });

  it("FIXTURE MUTATION: a new occurrence in a previously unaudited file fails naming that file", () => {
    const mutated = new Set(scanOccurrences());
    const newKey = "src/components/media/a-hypothetical-new-component.tsx:12";
    mutated.add(newKey);

    const diff = diffAudit(mutated, AUDITED_USAGE);
    expect(diff.unaudited).toEqual([newKey]);
  });
});
