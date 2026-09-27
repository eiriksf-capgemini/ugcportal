import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  designSystem,
  discoverColorNamespaces,
  findAlphaColorUtilities,
  isBackgroundRole,
  isNonColorOverload,
} from "./usage";

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
        prefix: "bg",
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

  // ugcportal-j4j finding 1 / K1: side- and offset-qualified colour
  // utilities. `border-t-border/50` used to resolve to the nonexistent
  // token `--color-t-border` and hard-fail CI with misleading advice.

  it("resolves every border side/logical colour qualifier to the real token, not a qualifier-prefixed one", () => {
    const root = fixture({
      "a.tsx": `const c = "border-t-border/50 border-r-border/50 border-b-border/50 border-l-border/50 border-x-border/50 border-y-border/50 border-s-border/50 border-e-border/50";`,
    });
    const found = findAlphaColorUtilities(root);
    expect(found.map((u) => u.property)).toEqual(
      new Array(8).fill("--color-border"),
    );
    expect(found.map((u) => u.alphaPercent)).toEqual(new Array(8).fill(50));
    // A border qualifier is still a boundary, not a fill text sits on.
    expect(found.every((u) => u.role === "foreground")).toBe(true);
  });

  it("resolves ring-offset to its own token, distinct from ring", () => {
    const root = fixture({
      "a.tsx": `const c = "ring-offset-ring/50 ring-ring/50";`,
    });
    const found = findAlphaColorUtilities(root);
    expect(found.map((u) => [u.utility, u.property, u.role])).toEqual([
      ["ring-offset-ring/50", "--color-ring", "background"],
      ["ring-ring/50", "--color-ring", "foreground"],
    ]);
  });

  it("still catches a genuinely unmeasured qualified pairing", () => {
    // The K1 "deliberate failing case": a qualified utility naming a token
    // that truly is not declared must still surface as an unknown token, the
    // same as the unqualified form does, not be waved through because it is
    // qualified.
    const root = fixture({
      "a.tsx": `const c = "border-t-not-a-real-token/50";`,
    });
    expect(findAlphaColorUtilities(root)).toEqual([
      {
        file: expect.stringContaining("a.tsx"),
        utility: "border-t-not-a-real-token/50",
        property: "--color-not-a-real-token",
        alphaPercent: 50,
        role: "foreground",
        prefix: "border-t",
      },
    ]);
  });

  it.each(["border-t-[var(--border)]/50", "border-t-[#ff0000]/50"])(
    "refuses a qualified utility carrying an arbitrary colour value, the same as the bare form does (%s)",
    (utility) => {
      // Both compile in real Tailwind (confirmed), but this gate cannot
      // resolve an arbitrary value to a declared token to measure it, so it
      // refuses with advice rather than guessing - exactly what the bare
      // (unqualified) form already does for `bg-[var(--ring)]/50`.
      const root = fixture({ "a.tsx": `const c = "${utility}";` });
      expect(() => findAlphaColorUtilities(root)).toThrow(/arbitrary colour/);
    },
  );

  it("has no side-qualified colour form for a namespace Tailwind does not give one to", () => {
    // Confirmed against the vendored compiler: divide-x-<color>,
    // outline-t-<color>, decoration-t-<color> and accent-t-<color> do not
    // compile - Tailwind has no per-side colour for these namespaces. They
    // are deliberately absent from COLOR_UTILITY_PREFIXES, so `divide-x-`
    // falls through to bare `divide` and resolves to the (wrong, but
    // loudly wrong) token `--color-x-border`, which the contrast gate's
    // "is this a design token" check then rejects - not silently accepted
    // as if `divide` had gained a qualifier it does not have.
    const root = fixture({
      "a.tsx": `const c = "divide-x-border/50";`,
    });
    expect(findAlphaColorUtilities(root)).toEqual([
      {
        file: expect.stringContaining("a.tsx"),
        utility: "divide-x-border/50",
        property: "--color-x-border",
        alphaPercent: 50,
        role: "foreground",
        prefix: "divide",
      },
    ]);
  });

  // ugcportal-j4j finding 3 / K3: a fractional alpha used to match none of
  // the three modifier patterns and was silently dropped.

  it("measures a fractional alpha rather than skipping it", () => {
    const root = fixture({ "a.tsx": `const c = "bg-primary/12.5";` });
    expect(findAlphaColorUtilities(root)).toEqual([
      {
        file: expect.stringContaining("a.tsx"),
        utility: "bg-primary/12.5",
        property: "--color-primary",
        alphaPercent: 12.5,
        role: "background",
        prefix: "bg",
      },
    ]);
  });

  it.each(["bg-primary/0.5", "bg-primary/5.25", "bg-primary/100.5"])(
    "measures the fractional alpha in %s",
    (utility) => {
      const root = fixture({ "a.tsx": `const c = "${utility}";` });
      if (utility.endsWith("100.5")) {
        // Preserves the existing above-100 guard; a fractional alpha does
        // not get a pass on the sanity check an integer one is held to.
        expect(() => findAlphaColorUtilities(root)).toThrow(/above 100/);
        return;
      }
      expect(findAlphaColorUtilities(root)[0].alphaPercent).toBe(
        Number(utility.split("/")[1]),
      );
    },
  );

  it("does not match a fractional alpha with no leading digit, because Tailwind does not compile one", () => {
    // Confirmed against the vendored compiler: bg-primary/.5 produces no
    // utility at all. Nothing to measure, so nothing should match here
    // either - nothing to fix on the compiler's side of this line, but worth
    // pinning so a future "helpful" widening of the modifier pattern does not
    // start accepting a shape Tailwind itself rejects.
    const root = fixture({ "a.tsx": `const c = "bg-primary/.5";` });
    expect(findAlphaColorUtilities(root)).toEqual([]);
  });

  // ugcportal-j4j round 2, findings 1 and 2: a hand-curated namespace list
  // cannot be complete, because completeness is a property of the installed
  // Tailwind version, not of anyone's memory. `text-shadow` and `placeholder`
  // are two namespaces the round-1 list missed; discoverColorNamespaces (see
  // below) is what closes this class of bug rather than these two names.

  it("resolves text-shadow-<colour>/<alpha> to the real token, not swallowed by `text`", () => {
    // Before this, `text` matched first and `text-shadow-primary/50` resolved
    // to the nonexistent `--color-shadow-primary`.
    const root = fixture({ "a.tsx": `const c = "text-shadow-primary/50";` });
    expect(findAlphaColorUtilities(root)).toEqual([
      {
        file: expect.stringContaining("a.tsx"),
        utility: "text-shadow-primary/50",
        property: "--color-primary",
        alphaPercent: 50,
        role: "foreground",
        prefix: "text-shadow",
      },
    ]);
  });

  it("treats text-shadow's own size/opacity presets as non-colour, the same way shadow's are", () => {
    // text-shadow-lg/20 is a preset shadow at 20% of its own opacity, the
    // exact same shape of overload as shadow-lg/20 and text-sm/6. Before
    // this, `text` matched first and this hard-failed as an attempt to
    // resolve the nonexistent token --color-shadow-lg.
    //
    // text-shadow-none is deliberately not in this list: unlike the other
    // presets, Tailwind refuses a modifier on it entirely (there is no
    // shadow to fade), so `text-shadow-none/10` does not compile as
    // anything - a different, already-correctly-handled case (an unresolvable
    // name is treated as an attempted colour and left for the "is this a
    // design token" check downstream, not excluded here).
    const root = fixture({
      "a.tsx": `const c = "text-shadow-lg/20 text-shadow-md/30 text-shadow-sm/10 text-shadow-xs/10 text-shadow-2xs/10";`,
    });
    expect(findAlphaColorUtilities(root)).toEqual([]);
  });

  it("resolves placeholder-<colour>/<alpha>, a namespace the hand-curated list omitted entirely", () => {
    const root = fixture({ "a.tsx": `const c = "placeholder-primary/50";` });
    expect(findAlphaColorUtilities(root)).toEqual([
      {
        file: expect.stringContaining("a.tsx"),
        utility: "placeholder-primary/50",
        property: "--color-primary",
        alphaPercent: 50,
        role: "foreground",
        prefix: "placeholder",
      },
    ]);
  });

  describe("discoverColorNamespaces", () => {
    const namespaces = discoverColorNamespaces(designSystem);

    it("finds namespaces a hand-curated list is prone to miss", () => {
      // The two findings above, plus others turned up while building this
      // that were never reported because nothing in this codebase uses them
      // yet - proof the derivation covers more than the two names anyone was
      // looking for.
      for (const expected of [
        "bg",
        "text",
        "border",
        "ring",
        "border-t",
        "ring-offset",
        "text-shadow",
        "placeholder",
        "drop-shadow",
      ]) {
        expect(namespaces, expected).toContain(expected);
      }
    });

    it("excludes a namespace-side-qualifier combination Tailwind does not compile", () => {
      // divide-x-<colour> and outline-t-<colour> are not real Tailwind
      // utilities (confirmed: they do not compile), so the derivation must
      // not invent them.
      expect(namespaces).not.toContain("divide-x");
      expect(namespaces).not.toContain("outline-t");
      expect(namespaces).not.toContain("decoration-t");
      expect(namespaces).not.toContain("accent-t");
    });

    it("sorts longest-first, so a compound namespace is tried before the shorter one it starts with", () => {
      expect(namespaces.indexOf("ring-offset")).toBeLessThan(
        namespaces.indexOf("ring"),
      );
      expect(namespaces.indexOf("border-t")).toBeLessThan(
        namespaces.indexOf("border"),
      );
      for (let i = 1; i < namespaces.length; i += 1) {
        expect(namespaces[i].length).toBeLessThanOrEqual(
          namespaces[i - 1].length,
        );
      }
    });

    it("has no duplicates", () => {
      expect(new Set(namespaces).size).toBe(namespaces.length);
    });
  });

  // ugcportal-j4j round 3 finding 2: BACKGROUND_PREFIXES was a hand-written
  // 5-entry Set even after the namespace list itself was derived - the same
  // hand-curation problem one level over. scrollbar-track and every
  // mask-*-from/to were missing (misclassified foreground) as a result.
  // isBackgroundRole replaces the Set with shape-based rules so a namespace
  // matching one of them is covered automatically, not only the ones named
  // here.

  describe("isBackgroundRole", () => {
    it("classifies the namespaces finding 2 named", () => {
      expect(isBackgroundRole("bg")).toBe(true);
      expect(isBackgroundRole("from")).toBe(true);
      expect(isBackgroundRole("via")).toBe(true);
      expect(isBackgroundRole("to")).toBe(true);
      expect(isBackgroundRole("ring-offset")).toBe(true);
      expect(isBackgroundRole("scrollbar-track")).toBe(true);
      // The paired foreground half of scrollbar-track: the handle drawn
      // over the track, not the track itself.
      expect(isBackgroundRole("scrollbar-thumb")).toBe(false);
    });

    it("classifies every mask-*-from/-to gradient stop as background, by shape rather than by name", () => {
      const maskStops = discoverColorNamespaces(designSystem).filter((ns) =>
        ns.startsWith("mask-"),
      );
      expect(maskStops.length).toBeGreaterThan(0);
      for (const ns of maskStops) {
        expect(isBackgroundRole(ns), ns).toBe(true);
      }
    });

    it("defaults everything else to foreground", () => {
      for (const ns of ["text", "border", "ring", "outline", "text-shadow", "placeholder"]) {
        expect(isBackgroundRole(ns), ns).toBe(false);
      }
    });
  });

  // ugcportal-j4j round 3 finding 3: the first version of isNonColorOverload
  // checked for `color-mix(` anywhere in the compiled text - right for every
  // case tried while building it, but a specific implementation detail of
  // this Tailwind minor version rather than a structural fact, and a false
  // "non-colour" verdict is a silent skip (this module's forbidden outcome),
  // not a loud one. This sweeps every namespace discoverColorNamespaces
  // currently finds against both a real project token and a Tailwind
  // built-in keyword colour, live against whatever Tailwind is installed -
  // so a future version narrowing this silently is a red test here, not a
  // quiet regression.

  describe("isNonColorOverload", () => {
    const namespaces = discoverColorNamespaces(designSystem);

    it.each(namespaces)("resolves %s-primary as a colour, not an overload", (ns) => {
      expect(isNonColorOverload(designSystem, ns, "primary")).toBe(false);
    });

    it.each(namespaces)(
      "resolves %s-current (a Tailwind keyword colour) as a colour, not an overload",
      (ns) => {
        expect(isNonColorOverload(designSystem, ns, "current")).toBe(false);
      },
    );

    it("still excludes every known preset/opacity overload", () => {
      // The exact cases this function exists to exclude - confirmed by
      // direct compilation not to assign a colour anywhere in their output.
      expect(isNonColorOverload(designSystem, "shadow", "lg")).toBe(true);
      expect(isNonColorOverload(designSystem, "text-shadow", "lg")).toBe(true);
      expect(isNonColorOverload(designSystem, "drop-shadow", "lg")).toBe(true);
      expect(isNonColorOverload(designSystem, "text", "sm")).toBe(true);
    });
  });
});
