import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GLOBALS_CSS_PATH,
  flattenDeclarations,
  loadThemeTokens,
  parseDeclarations,
  resolveToken,
} from "./tokens";

function tokensFrom(css: string) {
  return flattenDeclarations(parseDeclarations(css));
}

describe("parseDeclarations", () => {
  it("records the block each declaration came from", () => {
    const declarations = parseDeclarations(`
      @theme { --color-a: oklch(0.5 0 0); }
      :root { --b: var(--color-a); }
    `);
    expect(declarations).toEqual([
      { property: "--color-a", value: "oklch(0.5 0 0)", selector: "@theme" },
      { property: "--b", value: "var(--color-a)", selector: ":root" },
    ]);
  });

  it("does not flatten nested blocks into one scope", () => {
    const declarations = parseDeclarations(`
      @layer base { * { --x: 1; } }
    `);
    expect(declarations[0].selector).toBe("@layer base > *");
  });

  it("strips comments, including ones containing braces", () => {
    const declarations = parseDeclarations(`
      /* :root { --decoy: oklch(1 0 0); } */
      :root { --real: oklch(0 0 0); /* trailing */ }
    `);
    expect(declarations.map((d) => d.property)).toEqual(["--real"]);
  });

  it("ignores at-rules and non-custom declarations", () => {
    const declarations = parseDeclarations(`
      @layer base { body { @apply bg-background; color: red; } }
    `);
    expect(declarations).toEqual([]);
  });

  it("throws on unbalanced braces rather than returning a partial parse", () => {
    expect(() => parseDeclarations(":root { --a: 1;")).toThrow(/unbalanced/);
    expect(() => parseDeclarations(":root { --a: 1; } }")).toThrow(/unbalanced/);
  });

  it("throws on an empty value", () => {
    expect(() => parseDeclarations(":root { --a: ; }")).toThrow(/empty value/);
  });
});

describe("flattenDeclarations", () => {
  it("rejects a token declared in two blocks", () => {
    // This is the "one theme, not two" guard: reintroducing a `.dark` palette
    // makes the suite fail rather than quietly shipping a second token set.
    expect(() =>
      tokensFrom(`
        :root { --background: oklch(0.185 0 0); }
        .dark { --background: oklch(0.985 0 0); }
      `),
    ).toThrow(/declared twice/);
  });

  it("rejects a token declared twice in the same block", () => {
    expect(() =>
      tokensFrom(":root { --a: oklch(0 0 0); --a: oklch(1 0 0); }"),
    ).toThrow(/declared twice/);
  });
});

describe("resolveToken", () => {
  it("follows a var() chain to a literal", () => {
    const tokens = tokensFrom(`
      @theme { --color-petrol-400: oklch(0.72 0.085 205); }
      :root { --primary: var(--color-petrol-400); }
      @theme inline { --color-primary: var(--primary); }
    `);
    expect(resolveToken("--color-primary", tokens)).toBe("oklch(0.72 0.085 205)");
  });

  it("uses a var() fallback only when the target is missing", () => {
    const tokens = tokensFrom(`:root { --a: var(--missing, oklch(0 0 0)); }`);
    expect(resolveToken("--a", tokens)).toBe("oklch(0 0 0)");
    const present = tokensFrom(
      `:root { --a: var(--b, oklch(0 0 0)); --b: oklch(1 0 0); }`,
    );
    expect(resolveToken("--a", present)).toBe("oklch(1 0 0)");
  });

  it("resolves a fallback that is itself a var() reference", () => {
    // Previously returned the literal string "var(--b)", which parseColor
    // then rejected as unsupported syntax - blaming the colour parser for a
    // missing token.
    const tokens = tokensFrom(
      `:root { --a: var(--missing, var(--b)); --b: oklch(0.5 0 0); }`,
    );
    expect(resolveToken("--a", tokens)).toBe("oklch(0.5 0 0)");
  });

  it("resolves a chain of var() fallbacks", () => {
    const tokens = tokensFrom(
      `:root { --a: var(--gone, var(--alsogone, oklch(0.25 0 0))); }`,
    );
    expect(resolveToken("--a", tokens)).toBe("oklch(0.25 0 0)");
  });

  it("throws when a fallback chain ends in nothing declared", () => {
    const tokens = tokensFrom(`:root { --a: var(--gone, var(--alsogone)); }`);
    expect(() => resolveToken("--a", tokens)).toThrow(/not declared/);
  });

  it("detects a cycle reached through a fallback", () => {
    const tokens = tokensFrom(
      `:root { --a: var(--gone, var(--b)); } .x { --b: var(--a); }`,
    );
    expect(() => resolveToken("--a", tokens)).toThrow(/cyclic/);
  });

  it("throws on an unknown token", () => {
    expect(() => resolveToken("--nope", tokensFrom(":root { --a: 1; }"))).toThrow(
      /unknown token/,
    );
  });

  it("throws on a dangling reference with no fallback", () => {
    expect(() =>
      resolveToken("--a", tokensFrom(":root { --a: var(--gone); }")),
    ).toThrow(/not declared/);
  });

  it("throws on a reference cycle instead of recursing forever", () => {
    expect(() =>
      resolveToken(
        "--a",
        tokensFrom(":root { --a: var(--b); } .x { --b: var(--a); }"),
      ),
    ).toThrow(/cyclic/);
  });

  it("refuses a value that mixes var() with other syntax", () => {
    expect(() =>
      resolveToken(
        "--a",
        tokensFrom(":root { --a: color-mix(in oklch, var(--b), white 5%); }"),
      ),
    ).toThrow(/only[\s\S]*bare var\(\)/);
  });
});

describe("the shipped stylesheet", () => {
  it("parses, and declares every token exactly once", () => {
    expect(() => loadThemeTokens()).not.toThrow();
    expect(loadThemeTokens().size).toBeGreaterThan(40);
  });
});

/** Writes `css` to a temp file and loads it under `mode`, so these tests exercise the real file-reading path, not just parseDeclarations/flattenDeclarations directly. */
function writeAndLoad(css: string, mode: "light" | "dark") {
  const dir = mkdtempSync(join(tmpdir(), "ugcportal-tokens-test-"));
  const file = join(dir, "globals.css");
  writeFileSync(file, css, "utf8");
  return loadThemeTokens(file, mode);
}

/**
 * ugcportal-rw9j: loadThemeTokens(path, "dark") is the one place "one theme
 * per mode" is actually enforced - these are unit tests of that enforcement
 * against small, synthetic stylesheets, independent of whatever
 * globals.css's real dark override happens to contain today.
 */
describe("loadThemeTokens dual-mode resolution", () => {
  const CSS = `
    :root { --background: oklch(0.9 0 0); --foreground: oklch(0.1 0 0); }
    @media (prefers-color-scheme: dark) {
      :root { --background: oklch(0.1 0 0); }
    }
  `;

  it("light mode ignores anything inside the dark media query", () => {
    const tokens = writeAndLoad(CSS, "light");
    expect(resolveToken("--background", tokens)).toBe("oklch(0.9 0 0)");
    expect(resolveToken("--foreground", tokens)).toBe("oklch(0.1 0 0)");
  });

  it("dark mode layers its override on top of the light value, like a browser's cascade", () => {
    const tokens = writeAndLoad(CSS, "dark");
    // Overridden in the dark block:
    expect(resolveToken("--background", tokens)).toBe("oklch(0.1 0 0)");
    // NOT overridden - falls through to the light declaration:
    expect(resolveToken("--foreground", tokens)).toBe("oklch(0.1 0 0)");
  });

  it("still rejects a property declared twice within the light mode", () => {
    expect(() => writeAndLoad(":root { --a: 1; --a: 2; }", "light")).toThrow(
      /declared twice/,
    );
  });

  it("still rejects a property declared twice within the dark override", () => {
    expect(() =>
      writeAndLoad(
        "@media (prefers-color-scheme: dark) { :root { --a: 1; } :root { --a: 2; } }",
        "dark",
      ),
    ).toThrow(/declared twice/);
  });

  it("does NOT reject the one deliberate pattern: once in light, once in dark", () => {
    expect(() => writeAndLoad(CSS, "dark")).not.toThrow();
    expect(() => writeAndLoad(CSS, "light")).not.toThrow();
  });

  it("parses the real shipped stylesheet's dark override without throwing", () => {
    expect(() => loadThemeTokens(GLOBALS_CSS_PATH, "dark")).not.toThrow();
  });
});
