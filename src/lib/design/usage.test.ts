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

  it("refuses an arbitrary alpha it cannot turn into a number", () => {
    // The create-next-app default page used `border-black/[.08]`. A scanner
    // that silently skipped that shape would leave a hole exactly where the
    // old code had one.
    const root = fixture({ "a.tsx": `const c = "border-destructive/[.08]";` });
    expect(() => findAlphaColorUtilities(root)).toThrow(/arbitrary alpha/);
  });

  it("throws rather than returning nothing when pointed at an empty tree", () => {
    const root = fixture({});
    expect(() => findAlphaColorUtilities(root)).toThrow(/no source files/);
  });
});
