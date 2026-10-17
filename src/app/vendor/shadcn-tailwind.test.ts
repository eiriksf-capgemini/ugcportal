import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindPostcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

import { stripCssComments } from "@/lib/design/scan-source";

/**
 * ugcportal-pc7s. shadcn's stylesheet (accordion keyframes, no-scrollbar
 * utilities, ...) is load-bearing: globals.css imports it, and the bead that
 * first covered the shadcn advisories was written on the belief that the
 * package was unused. The package is no longer a dependency; the stylesheet is
 * vendored. These guards stop both halves of the same mistake: dropping or
 * commenting out the import (checked on comment-stripped text, and by compiling
 * the real globals.css and requiring a utility only the vendored file defines),
 * and letting the vendored copy drift from the pinned upstream bytes. The
 * compile check asserts against the vendored file's own utility names; once the
 * package is gone there is no upstream copy to compare token values against.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = path.join(HERE, "shadcn-tailwind.css");
const GLOBALS = path.resolve(HERE, "..", "globals.css");

// sha256 of shadcn@4.21.0's dist/tailwind.css (16041 bytes), the bytes after
// the header comment in the vendored file. The header itself is checked
// separately: it must be exactly one comment, so it cannot carry CSS.
const UPSTREAM_SHA256 =
  "bc7d83425702955b4cb67cb14ede9d603f9d912376d57a2d81d661094d2a782a";

function importsVendoredShadcnCss(globalsCss: string): boolean {
  return /^@import\s+"\.\/vendor\/shadcn-tailwind\.css";/m.test(
    stripCssComments(globalsCss),
  );
}

function pinMatches(body: string): boolean {
  return (
    createHash("sha256").update(body).digest("hex") === UPSTREAM_SHA256 &&
    Buffer.byteLength(body) === 16041
  );
}

async function compileGlobals(css: string, classNames: string): Promise<string> {
  const input = `${css}\n@source inline(${JSON.stringify(classNames)});\n`;
  const result = await postcss([
    tailwindPostcss({ base: path.dirname(GLOBALS) }),
  ]).process(input, { from: GLOBALS });
  return result.css;
}

/**
 * Splits the vendored file into header and body. The header is exactly one
 * block comment: it opens the file with the comment opener, the FIRST comment
 * closer in the file ends it, and that closer is followed directly by a
 * newline. Anything else (a closer mid-line, so CSS could follow it before a
 * re-opened comment) returns null, so no CSS can hide in the header.
 */
function splitVendored(vendored: string): { header: string; body: string } | null {
  if (!vendored.startsWith("/*")) return null;
  const end = vendored.indexOf("*/");
  if (end === -1 || vendored[end + 2] !== "\n") return null;
  return { header: vendored.slice(0, end + 2), body: vendored.slice(end + 3) };
}

function bodyAfterHeader(vendored: string): string {
  const parts = splitVendored(vendored);
  if (!parts) throw new Error("vendored header is not exactly one block comment");
  return parts.body;
}

describe("vendored shadcn stylesheet", () => {
  it("is still imported by globals.css", () => {
    expect(importsVendoredShadcnCss(readFileSync(GLOBALS, "utf8"))).toBe(true);
  });

  it("guard fails on a globals.css fixture with the import removed", () => {
    const real = readFileSync(GLOBALS, "utf8");
    const mutated = real.replace(
      /^@import "\.\/vendor\/shadcn-tailwind\.css";\n/m,
      "",
    );
    expect(mutated).not.toBe(real);
    expect(importsVendoredShadcnCss(mutated)).toBe(false);
  });

  it("guard fails on a globals.css fixture with the import commented out", () => {
    const real = readFileSync(GLOBALS, "utf8");
    const mutated = real.replace(
      /^(@import "\.\/vendor\/shadcn-tailwind\.css";)$/m,
      "/* $1 */",
    );
    expect(mutated).not.toBe(real);
    expect(importsVendoredShadcnCss(mutated)).toBe(false);
  });

  it("compiling the real globals.css emits a utility only the vendored file defines", async () => {
    const real = readFileSync(GLOBALS, "utf8");
    const css = await compileGlobals(real, "no-scrollbar");
    expect(css).toContain(".no-scrollbar");
    // Same compile without the import loses it, so the assertion can fail.
    const without = real.replace(
      /^@import "\.\/vendor\/shadcn-tailwind\.css";\n/m,
      "",
    );
    expect(without).not.toBe(real);
    expect(await compileGlobals(without, "no-scrollbar")).not.toContain(
      ".no-scrollbar",
    );
  });

  it("matches the pinned upstream bytes", () => {
    const body = bodyAfterHeader(readFileSync(VENDORED, "utf8"));
    expect(pinMatches(body)).toBe(true);
  });

  it("header is exactly one block comment and the rest is the pinned body", () => {
    const vendored = readFileSync(VENDORED, "utf8");
    const parts = splitVendored(vendored);
    expect(parts).not.toBeNull();
    // Comments stripped, the header is empty: it carries no CSS.
    expect(stripCssComments(parts!.header).trim()).toBe("");
    expect(parts!.header + "\n" + parts!.body).toBe(vendored);
    expect(pinMatches(parts!.body)).toBe(true);
  });

  it("header guard fails on a header that closes its comment early and hides CSS", () => {
    const vendored = readFileSync(VENDORED, "utf8");
    const lines = vendored.split("\n");
    lines[1] += " */ .evil{color:#f00;} /*";
    const mutated = lines.join("\n");
    expect(mutated).not.toBe(vendored);
    expect(splitVendored(mutated)).toBeNull();
    expect(() => bodyAfterHeader(mutated)).toThrow();
  });

  it("pin check fails on a one-byte edit of the vendored bytes", () => {
    const body = bodyAfterHeader(readFileSync(VENDORED, "utf8"));
    expect(pinMatches(body + " ")).toBe(false);
    // Same length, one byte changed: the size check alone cannot catch this.
    const flipped = (body[0] === "@" ? "#" : "@") + body.slice(1);
    expect(Buffer.byteLength(flipped)).toBe(Buffer.byteLength(body));
    expect(pinMatches(flipped)).toBe(false);
  });
});
