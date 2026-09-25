import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findAlphaColorUtilities } from "./usage";

const created: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "axu-usage-"));
  created.push(root);
  const src = path.join(root, "src");
  mkdirSync(src, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(src, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return src;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe("findAlphaColorUtilities", () => {
  it("finds an alpha-modified utility behind any number of variants", () => {
    const root = fixture({
      "a.tsx": `const c = "focus-visible:ring-3 focus-visible:ring-ring/80 aria-invalid:border-destructive/75";`,
    });
    expect(
      findAlphaColorUtilities(root).map((u) => [u.property, u.alphaPercent]),
    ).toEqual([
      ["--color-ring", 80],
      ["--color-destructive", 75],
    ]);
  });

  it("finds utilities in CSS @apply as well as TSX", () => {
    const root = fixture({
      "globals.css": `@layer base { * { @apply border-border outline-ring/80; } }`,
    });
    expect(findAlphaColorUtilities(root)).toHaveLength(1);
    expect(findAlphaColorUtilities(root)[0].utility).toBe("outline-ring/80");
  });

  it("finds two adjacent utilities, not just the first", () => {
    // The boundary character is consumed by the match, so without rewinding
    // the scanner would skip every other utility in a run.
    const root = fixture({
      "a.tsx": `const c = "bg-primary/90 ring-ring/80 border-destructive/75";`,
    });
    expect(findAlphaColorUtilities(root).map((u) => u.alphaPercent)).toEqual([
      90, 80, 75,
    ]);
  });

  it("ignores prose about a utility in comments", () => {
    const root = fixture({
      "a.tsx": `// shadcn ships ring-ring/50 here, which fails 3:1\n/* and border-destructive/40 */\nconst c = "ring-ring/80";`,
      "b.css": `/* outline-ring/70 was the old value */\n.x { @apply outline-ring/80; }`,
    });
    expect(findAlphaColorUtilities(root).map((u) => u.alphaPercent)).toEqual([
      80, 80,
    ]);
  });

  it("ignores non-colour utilities that merely contain a slash", () => {
    const root = fixture({
      "a.tsx": `const c = "group/button w-1/2 opacity-50 aspect-16/9 basis-1/3 size-3.5";`,
    });
    expect(findAlphaColorUtilities(root)).toEqual([]);
  });

  it("skips test files and generated output", () => {
    const root = fixture({
      "a.test.tsx": `const c = "ring-ring/10";`,
      "generated/prisma/index.tsx": `const c = "ring-ring/20";`,
      "real.tsx": `const c = "ring-ring/80";`,
    });
    expect(findAlphaColorUtilities(root).map((u) => u.alphaPercent)).toEqual([
      80,
    ]);
  });

  // Round 2 of review: the scanner is only as good as the shapes it sees, and
  // a shape it silently does not see is worse than no scanner, because the
  // gate above it then reports coverage it does not have. These pin the
  // classes found by going back over it as a whole.

  it("ignores Tailwind's non-colour slash shorthands", () => {
    // text-<size>/<leading> and shadow-<size>/<opacity> are ordinary Tailwind
    // that 71y and n3c will write. Before this, `text-sm/6` parsed as the
    // colour `sm` at 6% alpha and failed the suite with "unknown token
    // --color-sm", in a file the author had not touched.
    const root = fixture({
      "a.tsx": `const c = "text-sm/6 text-2xl/9 text-base/7 shadow-lg/20 inset-shadow-sm/30";`,
    });
    expect(findAlphaColorUtilities(root)).toEqual([]);
  });

  it("still treats a real colour under those namespaces as a colour", () => {
    const root = fixture({
      "a.tsx": `const c = "text-destructive/75 shadow-ring/80";`,
    });
    expect(
      findAlphaColorUtilities(root).map((u) => [u.property, u.alphaPercent]),
    ).toEqual([
      ["--color-destructive", 75],
      ["--color-ring", 80],
    ]);
  });

  it("does not mistake an arbitrary line-height for an arbitrary alpha", () => {
    const root = fixture({ "a.tsx": `const c = "text-sm/[1.6]";` });
    expect(findAlphaColorUtilities(root)).toEqual([]);
  });

  it("scans every extension a class name can live in", () => {
    // Moving buttonVariants into a plain .ts file is an ordinary cva split.
    // It used to drop three of the four measured alphas from the gate.
    const root = fixture({
      "variants.ts": `export const v = "ring-ring/80";`,
      "legacy.js": `export const v = "border-destructive/75";`,
      "esm.mjs": `export const v = "ring-destructive/80";`,
      "c.jsx": `const c = "bg-primary/90";`,
    });
    expect(
      findAlphaColorUtilities(root)
        .map((u) => u.alphaPercent)
        .sort((a, b) => a - b),
    ).toEqual([75, 80, 80, 90]);
  });

  it("refuses an interpolated alpha rather than missing it", () => {
    const root = fixture({
      "a.tsx": "const c = `ring-ring/${alpha}`;",
    });
    expect(() => findAlphaColorUtilities(root)).toThrow(/interpolates/);
  });

  it("refuses an alpha applied to an arbitrary colour value", () => {
    // Slips past the numeric-alpha pattern entirely, because the name is not
    // a bare word.
    const root = fixture({
      "a.tsx": `const c = "bg-[var(--ring)]/50";`,
    });
    expect(() => findAlphaColorUtilities(root)).toThrow(/arbitrary colour/);
  });

  it("reports a Tailwind built-in colour as a token the stylesheet lacks", () => {
    // Not the scanner's job to reject it, but it must be *seen*, so the
    // coverage test can say "that is not a design token" rather than letting
    // resolveToken blame itself for an unknown --color-black.
    const root = fixture({ "a.tsx": `const c = "bg-black/50";` });
    expect(findAlphaColorUtilities(root)).toEqual([
      {
        file: expect.stringContaining("a.tsx"),
        utility: "bg-black/50",
        property: "--color-black",
        alphaPercent: 50,
        role: "background",
      },
    ]);
  });

  it("refuses an arbitrary alpha it cannot turn into a number", () => {
    // The create-next-app default page used `border-black/[.08]`. A scanner
    // that silently skipped that shape would leave a hole exactly where the
    // old code had one.
    const root = fixture({ "a.tsx": `const c = "border-destructive/[.08]";` });
    expect(() => findAlphaColorUtilities(root)).toThrow(/arbitrary alpha/);
  });

  // Round 3 of review. Both halves of the same mistake: the round-2 scanner
  // used one pattern per unresolvable shape, which over-matched an arbitrary
  // *length* and under-matched an arbitrary colour carrying an arbitrary
  // alpha. The matrix is now enumerated over both name forms and all three
  // alpha forms, so neither is possible.

  it("does not treat an arbitrary length as a colour", () => {
    // button.tsx already ships text-[0.8rem]; adding a line height to it is
    // one character away, and used to hard-fail with advice about PAIRINGS.
    const root = fixture({
      "a.tsx": `const c = "text-[0.8rem]/5 text-[14px]/6 text-[length:var(--x)]/5 text-[1.6]/7";`,
    });
    expect(findAlphaColorUtilities(root)).toEqual([]);
  });

  it("refuses an arbitrary colour carrying an arbitrary alpha", () => {
    // Matched none of the round-2 patterns and was silently skipped, which
    // contradicted this module's own "it never just skips" contract.
    const root = fixture({ "a.tsx": `const c = "bg-[var(--x)]/[.5]";` });
    expect(() => findAlphaColorUtilities(root)).toThrow(/arbitrary colour/);
  });

  it("refuses an arbitrary colour carrying an interpolated alpha", () => {
    const root = fixture({ "a.tsx": "const c = `bg-[var(--x)]/${a}`;" });
    expect(() => findAlphaColorUtilities(root)).toThrow(/arbitrary colour/);
  });

  it("honours Tailwind's explicit colour hint on an arbitrary value", () => {
    const root = fixture({ "a.tsx": `const c = "text-[color:var(--x)]/50";` });
    expect(() => findAlphaColorUtilities(root)).toThrow(/arbitrary colour/);
  });

  it("ignores a gradient interpolation modifier, which is not an alpha", () => {
    // bg-linear-to-r/oklch has a slash and a colour namespace, but the
    // modifier is a colour space. An alpha is a number, a bracketed value or
    // an interpolation - never a bare keyword.
    const root = fixture({
      "a.tsx": `const c = "bg-linear-to-r/oklch bg-conic/srgb bg-radial/longer";`,
    });
    expect(findAlphaColorUtilities(root)).toEqual([]);
  });

  it("tags backgrounds and foregrounds apart", () => {
    const root = fixture({
      "a.tsx": `const c = "bg-primary/80 from-primary/80 ring-ring/80 text-destructive/75";`,
    });
    expect(
      findAlphaColorUtilities(root).map((u) => [u.utility, u.role]),
    ).toEqual([
      ["bg-primary/80", "background"],
      ["from-primary/80", "background"],
      ["ring-ring/80", "foreground"],
      ["text-destructive/75", "foreground"],
    ]);
  });

  it("throws rather than returning nothing when pointed at an empty tree", () => {
    const root = fixture({});
    expect(() => findAlphaColorUtilities(root)).toThrow(/no source files/);
  });
});
