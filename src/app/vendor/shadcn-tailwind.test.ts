import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * ugcportal-pc7s. shadcn's stylesheet (accordion keyframes, no-scrollbar
 * utilities, ...) is load-bearing: globals.css imports it, and the bead that
 * first covered the shadcn advisories was written on the belief that the
 * package was unused. The package is no longer a dependency; the stylesheet is
 * vendored. These guards stop both halves of the same mistake: dropping the
 * import, and letting the vendored copy drift from the pinned upstream bytes.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = path.join(HERE, "shadcn-tailwind.css");
const GLOBALS = path.resolve(HERE, "..", "globals.css");

// sha256 of shadcn@4.21.0's dist/tailwind.css (16041 bytes), the bytes after
// the header comment in the vendored file.
const UPSTREAM_SHA256 =
  "bc7d83425702955b4cb67cb14ede9d603f9d912376d57a2d81d661094d2a782a";

function importsVendoredShadcnCss(globalsCss: string): boolean {
  return /^@import\s+"\.\/vendor\/shadcn-tailwind\.css";/m.test(globalsCss);
}

function bodyAfterHeader(vendored: string): string {
  const end = vendored.indexOf("*/\n");
  if (!vendored.startsWith("/*") || end === -1) return vendored;
  return vendored.slice(end + 3);
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

  it("matches the pinned upstream bytes", () => {
    const body = bodyAfterHeader(readFileSync(VENDORED, "utf8"));
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      UPSTREAM_SHA256,
    );
    expect(Buffer.byteLength(body)).toBe(16041);
  });

  it("pin check fails on a one-byte edit", () => {
    const body = bodyAfterHeader(readFileSync(VENDORED, "utf8")) + " ";
    expect(createHash("sha256").update(body).digest("hex")).not.toBe(
      UPSTREAM_SHA256,
    );
  });
});
