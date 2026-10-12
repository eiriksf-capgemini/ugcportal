import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contrastRatio, parseColor } from "./color";
import {
  BODY_TEXT_SIZE_CLASSES,
  LARGE_TEXT_SIZE_CLASSES,
  hasUnsafeTerracotta500Pairing,
  scanForUnsafeTerracotta500Pairings,
} from "./terracotta-500-guard";
import { loadThemeTokens, resolveToken } from "./tokens";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * K1's own instruction, applied to this module's premise too, not only to
 * the PAIRINGS this bead adds: "each is re-derived by the gate rather than
 * taken from this note." This guard's whole reason to exist is that
 * `--terracotta-500` has NO safe body-text pairing to add to PAIRINGS in
 * the first place (see this file's own header comment) — which means,
 * unlike `terracotta-ink-on-terracotta-600`/`terracotta-900-on-terracotta-100`,
 * neither of the two ratios that justify that claim is re-checked by
 * contrast.test.ts's generic WCAG sweep (there is no PAIRINGS entry for
 * either to sweep). Re-derived here instead, straight from the real,
 * installed globals.css, so a future edit to the terracotta-500 hex value
 * that accidentally made it safe (or re-confirmed it is not) would turn
 * this red or green rather than leaving the prose in button.tsx/this
 * module's header as the only record.
 */
describe("the two ratios this guard's own premise depends on", () => {
  const tokens = loadThemeTokens();
  const terracotta500 = parseColor(resolveToken("--terracotta-500", tokens));
  const white = parseColor("#ffffff");
  const petrol900 = parseColor(resolveToken("--petrol-900", tokens));

  it("white on terracotta-500 is below body's 4.5:1 (large-text only)", () => {
    const ratio = contrastRatio(white, terracotta500);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(4.5);
  });

  it("petrol-900 on terracotta-500 is ALSO below body's 4.5:1 — neither usable ink clears it", () => {
    const ratio = contrastRatio(petrol900, terracotta500);
    expect(ratio).toBeLessThan(4.5);
  });
});

describe("hasUnsafeTerracotta500Pairing", () => {
  /*
   * K3's own required mutation, kept as a permanent regression test rather
   * than a one-off check performed by hand and reverted (ugcportal-dmne):
   * "mutate the fixture by adding such a pairing and confirm it fails" —
   * this fixture IS the mutation (a synthetic class list, not real source
   * from src/components/ui/button.tsx or
   * src/components/media/purchase-offer.tsx), and "confirm it fails" is
   * this assertion.
   */
  it("K3 FIXTURE MUTATION: flags terracotta-500 paired with ordinary body text (text-sm)", () => {
    expect(
      hasUnsafeTerracotta500Pairing(
        "inline-flex items-center rounded-full bg-terracotta-500 px-3 py-1 text-sm text-white",
      ),
    ).toBe(true);
  });

  it("flags terracotta-500 paired with text-xs too", () => {
    expect(hasUnsafeTerracotta500Pairing("bg-terracotta-500 text-xs")).toBe(true);
  });

  it("flags a variant-prefixed fill (hover:bg-terracotta-500) the same way", () => {
    expect(hasUnsafeTerracotta500Pairing("hover:bg-terracotta-500 text-sm text-white")).toBe(
      true,
    );
  });

  it("does NOT flag terracotta-500 paired with a large-text utility (text-lg and up)", () => {
    expect(
      hasUnsafeTerracotta500Pairing("bg-terracotta-500 px-3 py-1 text-lg font-bold text-white"),
    ).toBe(false);
  });

  it("does NOT flag terracotta-600 — only -500 is the unsafe step", () => {
    expect(hasUnsafeTerracotta500Pairing("bg-terracotta-600 text-sm text-white")).toBe(false);
  });

  it("does NOT flag terracotta-500 with no text-size utility at all (ambient size is invisible to this scan, not guessed at)", () => {
    expect(hasUnsafeTerracotta500Pairing("bg-terracotta-500 text-white")).toBe(false);
  });

  it("does NOT flag a class list with no terracotta-500 fill at all", () => {
    expect(hasUnsafeTerracotta500Pairing("bg-petrol-100 text-sm text-surface-0")).toBe(false);
  });

  it("the two size sets this guard treats as the large/body boundary are disjoint", () => {
    for (const cls of LARGE_TEXT_SIZE_CLASSES) {
      expect(BODY_TEXT_SIZE_CLASSES.has(cls)).toBe(false);
    }
  });
});

describe("scanForUnsafeTerracotta500Pairings", () => {
  it("finds zero violations in the real, shipped src/ tree today", () => {
    expect(scanForUnsafeTerracotta500Pairings(SRC_ROOT)).toEqual([]);
  });

  /*
   * The same mutation as above, run through the REAL file-walking scanner
   * rather than the pure function directly — proves the wiring (file walk,
   * comment-stripping, string-literal extraction) also catches a real
   * on-disk occurrence, not only a hand-built string handed straight to
   * `hasUnsafeTerracotta500Pairing`. A synthetic tmpdir fixture, not the
   * real src/ tree (same discipline contrast.test.ts's own tmpdir-based
   * mutation checks use) — this never edits the real, shipped source.
   */
  it("K3 FIXTURE MUTATION (real scan): a synthetic file pairing terracotta-500 with body text is caught", () => {
    const root = mkdtempSync(path.join(tmpdir(), "terracotta-500-guard-"));
    try {
      const file = path.join(root, "lib", "sale-badge.tsx");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        'export const BAD = "rounded-full bg-terracotta-500 px-2 py-0.5 text-xs text-white";\n',
      );
      const found = scanForUnsafeTerracotta500Pairings(root);
      expect(found).toHaveLength(1);
      expect(found[0]?.classList).toContain("bg-terracotta-500");
      expect(found[0]?.classList).toContain("text-xs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes test/spec files and src/lib/design/** from the real sweep (fixtures/prose, not shipped UI)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "terracotta-500-guard-exclusions-"));
    try {
      const testFile = path.join(root, "lib", "sale-badge.test.tsx");
      const designLibFile = path.join(root, "lib", "design", "some-guard.ts");
      mkdirSync(path.dirname(testFile), { recursive: true });
      mkdirSync(path.dirname(designLibFile), { recursive: true });
      const unsafeLiteral =
        'export const BAD = "bg-terracotta-500 text-sm text-white";\n';
      writeFileSync(testFile, unsafeLiteral);
      writeFileSync(designLibFile, unsafeLiteral);
      expect(scanForUnsafeTerracotta500Pairings(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
