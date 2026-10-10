/**
 * ugcportal-7g2o: a count-pinned audit of every `text-ink-muted` usage in
 * shipped source, in the shape of AUDITED_DECORATIVE_BORDER_USAGES
 * (contrast.test.ts) and dual-meaning-usage.test.ts's own AUDITED_USAGE.
 *
 * THE DEFECT THIS CLOSES. `--color-ink-muted` (what `text-ink-muted`
 * resolves to) is tuned for the near-black surface scale: light text meant
 * to sit on a dark fill. It measures 1.9003:1 against `--paper`
 * (`--background`'s light-mode value) — verified with this repo's own
 * `parseColor`/`contrastRatio` in a throwaway probe, deleted after, same
 * discipline this file's own live re-measurement below holds to. It is
 * correct on a surface carrying its own darker fill (a `bg-surface-*` well,
 * a `bg-destructive-surface` error well) and wrong on the plain page canvas,
 * and until this file, nothing distinguished the two mechanically.
 *
 * That gap shipped the identical defect three times across three review
 * rounds of ugcportal-6uc2, each filed and fixed separately with the class
 * left intact: `TEXT_LABEL_CLASS`'s own `text-ink` (ugcportal-4r0e — a
 * DIFFERENT token, not tracked by this file, see its own bead), upload-
 * form.tsx's two helper paragraphs (ugcportal-galb), and triage-form.tsx's
 * two attestation spans (named directly in ugcportal-7g2o's own filing,
 * found in the very file an earlier round's correction had already
 * visited). The two plain-canvas usages this bead found still standing —
 * triage-form.tsx:118/:122 and upload-form.tsx's alt-text helper + caption
 * qualifier — are fixed in this same change (see their own comments); this
 * file is what stops a fifth one arriving unnoticed.
 *
 * HOW THIS DIFFERS FROM A BARE COUNT (K3). AUDITED_DECORATIVE_BORDER_USAGES
 * pins a number per file, which is enough for a class whose every usage is
 * the SAME role everywhere it appears. This token is not that: the same
 * literal string is correct on one surface and wrong on another, so a test
 * that only pinned "6 files, 16 usages" could be satisfied by reclassifying
 * an illegible usage as one more of an already-passing count — exactly the
 * failure this bead exists to close. So every entry below carries, not just
 * a count, but the contrast.ts PAIRINGS id(s) that measure
 * `--color-ink-muted` against the EXACT surface that usage renders on, and
 * the ratio those pairings evaluate to in light mode today. Both are
 * asserted live, not merely written down: `pairingId` must resolve to a real
 * PAIRINGS entry whose own `foreground` is `--color-ink-muted` (so an entry
 * cannot be "classified safe" by pointing at a pairing measuring a different
 * token, e.g. `--muted-foreground`, on a background `--color-ink-muted`
 * itself would fail), the live evaluation of that pairing must clear body
 * text's 4.5:1 in BOTH colour schemes, and the ratio recorded here must
 * match the live light-mode number — so raising a count without supplying a
 * real, passing surface is a compile error (the fields are required) and
 * supplying a plausible-looking but wrong one is a failing assertion (the
 * ratio and the pass/fail are recomputed, not trusted).
 *
 * There is deliberately no PAIRINGS entry anywhere pairing `--color-ink-muted`
 * with `--background`: that pairing is known to fail (1.9003:1), so a future
 * usage that genuinely lands on the plain canvas has no passing pairing id to
 * point at, and the classification is structurally impossible to fake rather
 * than merely undocumented.
 *
 * The file walker and comment stripper are shared with dual-meaning-
 * usage.test.ts and no-raw-hex.test.ts via scan-source.ts, not reimplemented
 * here a third time.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PAIRINGS, THRESHOLDS, evaluatePairing, type Pairing } from "./contrast";
import { GLOBALS_CSS_PATH, loadThemeTokens, type ThemeMode } from "./tokens";
import { isTestFile, stripComments, walkSourceFiles } from "./scan-source";

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Matched as a whole Tailwind utility word: `text-ink-muted-x` (no such
 * class exists today) must never be swallowed into this count, the same
 * discipline dual-meaning-usage.test.ts's own TOKEN_PATTERN holds to. */
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

/** Every file with at least one `text-ink-muted` usage, and how many. */
function scanUsage(): Map<string, number> {
  const files = scannedFiles();
  const found = new Map<string, number>();
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"), file);
    const relative = path.relative(path.dirname(SRC_ROOT), file);
    const count = source.match(TOKEN_PATTERN)?.length ?? 0;
    if (count > 0) found.set(relative, count);
  }
  return found;
}

/**
 * One classified group of `text-ink-muted` usages within a file: `count` of
 * them render on `surface`, a surface this scanner cannot see for itself
 * (JSX-ancestor-aware static analysis this codebase does not have — the
 * same documented scope limit dual-meaning-usage.test.ts's own header
 * names), so it is recorded here by hand and checked against reality by the
 * live pairing evaluation below rather than trusted as written.
 *
 * `pairingIds` is more than one entry only when the usage's own className is
 * CONDITIONAL on component state (the upload dropzone's resting/dragging
 * fill) — every state the usage can actually render in is checked, not just
 * whichever is convenient.
 */
type UsageClassification = {
  count: number;
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
 * (or the page canvas, when there is none) — the same method ugcportal-7g2o's
 * own filing notes used for triage-form.tsx, repeated here for the other
 * five files.
 */
const AUDITED_USAGE: Readonly<Record<string, readonly UsageClassification[]>> = {
  // The per-uploader triage summary's <dl>, text-ink-muted only in the
  // `bg-destructive-surface` branch of its enclosing div's own className
  // ternary (the `bg-muted` branch uses text-muted-foreground instead,
  // tracked by dual-meaning-usage.test.ts) — see that div's own comment a
  // few lines above in page.tsx for why the two must track the same
  // condition.
  "src/app/admin/curation/page.tsx": [
    {
      count: 1,
      surface: "bg-destructive-surface (the blocked-triage error well)",
      pairingIds: ["muted-foreground-on-destructive-surface"],
      lightRatio: 7.7703,
    },
  ],
  // Three usages, all inside one of this file's two `bg-destructive-surface`
  // wells: the alcohol-linked-brand disclosure well's "Recorded <date> by
  // <admin>" line (one usage), and the separate "Needs attention: already
  // published under this brand" well's supporting paragraph and its <ul> of
  // affected items (the other two) — neither well has a bg-muted sibling
  // branch the way the curation/rights pages above and below it do.
  "src/app/admin/settings/rights/brands/page.tsx": [
    {
      count: 3,
      surface: "bg-destructive-surface (the alcohol-linked disclosure well and the attention-needed well)",
      pairingIds: ["muted-foreground-on-destructive-surface"],
      lightRatio: 7.7703,
    },
  ],
  // The resale-rights review's blocker message and its <dl>, text-ink-muted
  // only in the `bg-destructive-surface` branch of the same div ternary
  // pattern page.tsx above uses (the non-blocker branch is bg-muted /
  // text-muted-foreground, tracked by dual-meaning-usage.test.ts).
  "src/app/admin/settings/rights/page.tsx": [
    {
      count: 2,
      surface: "bg-destructive-surface (the blocked-resale-rights well)",
      pairingIds: ["muted-foreground-on-destructive-surface"],
      lightRatio: 7.7703,
    },
  ],
  // The dropzone's own "or drag them here" / accepted-types copy
  // (upload-form.tsx lines ~865-866), inside the dropzone panel whose own
  // fill alternates between bg-surface-1 (resting) and bg-surface-2
  // (dragging) — both states are checked, not just the resting one. NOT the
  // alt-text helper paragraph or the caption's "(optional)" qualifier a few
  // lines further down the same file: those two were text-ink-muted on the
  // PLAIN canvas until ugcportal-7g2o fixed them (see their own comments) —
  // they are text-muted-foreground now, tracked by dual-meaning-
  // usage.test.ts, not by this file.
  "src/app/upload/upload-form.tsx": [
    {
      count: 2,
      surface: "bg-surface-1 (resting) / bg-surface-2 (dragging over) — the upload dropzone panel",
      pairingIds: ["ink-muted-on-surface-1", "ink-muted-on-surface-2"],
      lightRatio: 7.5212,
    },
  ],
  // Three usages inside the queue row's own bg-surface-1 <li> (the status
  // label, the mime-type/size line, and the "uploaded, publish it from the
  // gallery" success note), plus one inside that row's own nested
  // bg-destructive-surface failure well (the server's raw error detail).
  "src/app/upload/upload-queue-list.tsx": [
    {
      count: 3,
      surface: "bg-surface-1 (the queue row itself)",
      pairingIds: ["ink-muted-on-surface-1"],
      lightRatio: 8.4066,
    },
    {
      count: 1,
      surface: "bg-destructive-surface (a failed upload's error detail)",
      pairingIds: ["muted-foreground-on-destructive-surface"],
      lightRatio: 7.7703,
    },
  ],
};

const THEME_MODES: readonly ThemeMode[] = ["light", "dark"];
const tokensByMode: Record<ThemeMode, ReturnType<typeof loadThemeTokens>> = {
  light: loadThemeTokens(),
  dark: loadThemeTokens(GLOBALS_CSS_PATH, "dark"),
};

const pairingsById = new Map<string, Pairing>(PAIRINGS.map((p) => [p.id, p]));

function totalCount(entries: readonly UsageClassification[]): number {
  return entries.reduce((sum, entry) => sum + entry.count, 0);
}

type AuditDiff = {
  /** A scanned file with no AUDITED_USAGE entry at all. */
  unaudited: string[];
  /** An AUDITED_USAGE entry naming a file the scanner no longer finds any usage in. */
  stale: string[];
  /** A scanned file that IS audited, but whose live count no longer matches the classifications' own sum. */
  mismatched: Array<{ file: string; found: number; expected: number }>;
};

/**
 * The one comparison both the real assertion below and its two FIXTURE
 * MUTATION tests run — sharing it (rather than the mutation tests merely
 * asserting against Map internals that resemble the real check) is what
 * proves a mutation exercises the actual gate, not a lookalike of it.
 */
function diffAudit(
  found: ReadonlyMap<string, number>,
  audited: Readonly<Record<string, readonly UsageClassification[]>>,
): AuditDiff {
  const foundFiles = new Set(found.keys());
  const auditedFiles = new Set(Object.keys(audited));

  const unaudited = [...foundFiles].filter((file) => !auditedFiles.has(file));
  const stale = [...auditedFiles].filter((file) => !foundFiles.has(file));

  const mismatched: AuditDiff["mismatched"] = [];
  for (const file of auditedFiles) {
    const actual = found.get(file);
    if (actual === undefined) continue; // already reported as `stale`
    const expected = totalCount(audited[file]);
    if (actual !== expected) mismatched.push({ file, found: actual, expected });
  }

  return { unaudited, stale, mismatched };
}

describe("text-ink-muted usage is audited by surface and ratio, not just counted", () => {
  it("finds files to scan", () => {
    expect(scannedFiles().length).toBeGreaterThan(10);
  });

  it("every classification points at a real PAIRINGS entry that actually measures --color-ink-muted", () => {
    for (const [file, entries] of Object.entries(AUDITED_USAGE)) {
      for (const entry of entries) {
        for (const pairingId of entry.pairingIds) {
          const pairing = pairingsById.get(pairingId);
          expect(pairing, `${file}: unknown PAIRINGS id "${pairingId}"`).toBeDefined();
          expect(
            pairing!.foreground,
            `${file}: pairing "${pairingId}" measures "${pairing!.foreground}", not ` +
              `--color-ink-muted — a classification must point at a pairing that measures ` +
              `the token the usage actually renders, not one that merely happens to pass.`,
          ).toBe("--color-ink-muted");
        }
      }
    }
  });

  it("every classification clears body text's 4.5:1 live, in both colour schemes, at its recorded ratio", () => {
    for (const [file, entries] of Object.entries(AUDITED_USAGE)) {
      for (const entry of entries) {
        let worstLight = Infinity;
        for (const pairingId of entry.pairingIds) {
          const pairing = pairingsById.get(pairingId)!;
          for (const mode of THEME_MODES) {
            const result = evaluatePairing(pairing, tokensByMode[mode]);
            expect(
              result.ratio,
              `${file}: "${pairingId}" measures ${result.ratio.toFixed(4)}:1 in ${mode} ` +
                `mode, below body text's ${THRESHOLDS.body}:1`,
            ).toBeGreaterThanOrEqual(THRESHOLDS.body);
            if (mode === "light") worstLight = Math.min(worstLight, result.ratio);
          }
        }
        expect(
          worstLight,
          `${file}: recorded lightRatio ${entry.lightRatio} does not match the live light-mode ` +
            `ratio ${worstLight.toFixed(4)} — a token moved and the recorded figure is stale.`,
        ).toBeCloseTo(entry.lightRatio, 4);
      }
    }
  });

  it("matches the audited (file, count) baseline exactly, and no new usage rides in unaudited", () => {
    const diff = diffAudit(scanUsage(), AUDITED_USAGE);

    expect(
      diff.unaudited,
      `New text-ink-muted usage found with no audit entry. For each file, trace the usage up ` +
        `to the nearest bg-*-carrying ancestor (or the plain page canvas, if there is none) and ` +
        `add a classification to AUDITED_USAGE naming the real surface and PAIRINGS id — there is ` +
        `no passing pairing for --color-ink-muted on --background, so a genuinely plain-canvas ` +
        `usage cannot be classified "safe"; switch it to text-muted-foreground instead, the way ` +
        `ugcportal-7g2o fixed triage-form.tsx and upload-form.tsx.`,
    ).toEqual([]);

    expect(
      diff.stale,
      `AUDITED_USAGE lists a file with no text-ink-muted usage left in it - the audit is stale ` +
        `and should be trimmed.`,
    ).toEqual([]);

    expect(
      diff.mismatched,
      `A usage count changed in an audited file without updating its classification.`,
    ).toEqual([]);
  });

  it("FIXTURE MUTATION: a second, genuinely new usage in an already-audited file does not ride the existing entry", () => {
    const mutated = new Map(scanUsage());
    const file = "src/app/upload/upload-queue-list.tsx";
    mutated.set(file, (mutated.get(file) ?? 0) + 1);

    const diff = diffAudit(mutated, AUDITED_USAGE);
    expect(diff.unaudited, "the file is already audited, so it must not be reported as a new file").toEqual([]);
    expect(diff.mismatched).toEqual([
      { file, found: totalCount(AUDITED_USAGE[file]) + 1, expected: totalCount(AUDITED_USAGE[file]) },
    ]);
  });

  it("FIXTURE MUTATION: a new usage in a previously unaudited file fails naming that file", () => {
    const newFile = "src/components/media/a-hypothetical-new-component.tsx";
    const mutated = new Map(scanUsage());
    mutated.set(newFile, 1);

    const diff = diffAudit(mutated, AUDITED_USAGE);
    expect(diff.unaudited).toEqual([newFile]);
    expect(diff.mismatched, "a brand-new file is reported as unaudited, not as a count mismatch").toEqual([]);
  });
});
