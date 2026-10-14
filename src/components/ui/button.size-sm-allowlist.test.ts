import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import ts from "typescript";

import { isTestFile, sourceFileOf, walkSourceFiles } from "@/lib/design/scan-source";
import { JS_FAMILY_EXTENSIONS } from "@/lib/source-extensions.mjs";

/**
 * ugcportal-gdn3: button.tsx has two same-box-model small sizes. Plain `sm`
 * carries a capped radius; `header-sm` is the uncapped one the public-page
 * controls use. Neither lint nor types distinguish them, so a new public-page
 * control could reach for the more conventional `size="sm"` and silently lose
 * that radius; this test is the check.
 *
 * WHAT THE SCAN SEES. Every string literal (and no-substitution template
 * literal) whose text is exactly `sm`, in any non-test file under src with an
 * extension from src/lib/source-extensions.mjs, found in the AST so comments
 * cannot match and the spelling does not matter: `size="sm"`, `size={"sm"}`,
 * `size: "sm"`, `"size": "sm"`, `size = "sm"`, a ternary arm, `size ?? "sm"`
 * and `` `sm` `` all count. (There are no .js/.jsx files under src today; the
 * extension list is the walk's protection if one appears.) It counts the
 * literal, not the prop: a non-size `"sm"` would also count and be added here
 * deliberately, which is the failure mode we prefer to a miss.
 *
 * WHAT IT CANNOT SEE. A `sm` that reaches a Button without being written as
 * that literal in a file under src: a value whose initialiser lives in another
 * file, a prop spread from an object built elsewhere, or a string assembled at
 * runtime. A literal held in a variable in the SAME file is seen (at its
 * initialiser).
 *
 * THE ALLOWLIST IS THE MECHANISM, not a surface split. A new `sm` literal
 * fails here and its entry is added deliberately. The current entries are
 * mostly admin, upload and consent surfaces, but src/app/auth/error/page.tsx
 * (x2) renders for anyone, signed in or not, so it is a public caller on plain
 * `sm`; do not read the list as "public pages never use sm". A new
 * public-page control should still prefer "header-sm" unless it is
 * deliberately added here.
 *
 * Counts are per file, so a second `sm` use in an allowlisted file is also
 * flagged. The list is the output of this scan, not a recollection.
 */
const ALLOWED_SM_CALLERS: Readonly<Record<string, number>> = {
  "src/app/admin/curation/clearance-form.tsx": 1,
  "src/app/admin/curation/price-form.tsx": 1,
  "src/app/admin/curation/triage-form.tsx": 1,
  "src/app/admin/settings/instagram/page.tsx": 1,
  "src/app/admin/settings/rights/brands/page.tsx": 1,
  "src/app/admin/settings/rights/decision-form.tsx": 1,
  "src/app/admin/settings/users/page.tsx": 1,
  "src/app/auth/error/page.tsx": 2,
  "src/app/upload/upload-queue-list.tsx": 5,
  "src/components/consent/cookie-banner.tsx": 2,
};

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = path.resolve(SRC_ROOT, "..");

const SOURCE_EXTENSIONS = new RegExp(`\\.(${JS_FAMILY_EXTENSIONS.join("|")})$`);

/** Number of string / no-substitution-template literals whose text is exactly `sm`. */
function countSmLiterals(sourceFile: ts.SourceFile): number {
  let n = 0;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "sm") {
      n += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return n;
}

let cachedSourceFiles: string[] | undefined;

function countSmCallers(): Record<string, number> {
  const found: Record<string, number> = {};
  const files = (cachedSourceFiles ??= walkSourceFiles(SRC_ROOT, isTestFile, SOURCE_EXTENSIONS));
  for (const file of files) {
    const n = countSmLiterals(sourceFileOf(file));
    if (n > 0) found[path.relative(REPO_ROOT, file).split(path.sep).join("/")] = n;
  }
  return found;
}

function countIn(code: string): number {
  return countSmLiterals(ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
}

describe("button size=sm caller allowlist (ugcportal-gdn3)", () => {
  const found = countSmCallers();

  it("K1: every current size=sm caller is allowlisted and the list has no stale entries", () => {
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(ALLOWED_SM_CALLERS);
  });

  it("K2: the scan counts every spelling of an sm request and ignores header-sm and comments", () => {
    expect(countIn('<Button size="sm">')).toBe(1);
    expect(countIn('<Button size={"sm"}>')).toBe(1);
    expect(countIn('buttonVariants({ size: "sm" })')).toBe(1);
    expect(countIn('<Button size={dense ? "sm" : "default"}>')).toBe(1);
    expect(countIn('const s = size ?? "sm";')).toBe(1);
    expect(countIn('<Button size = "sm">')).toBe(1);
    expect(countIn('buttonVariants({ "size": "sm" })')).toBe(1);
    expect(countIn("<Button size={`sm`}>")).toBe(1);
    expect(countIn('<Button size="header-sm">')).toBe(0);
    expect(countIn('// size="sm"\n/* size: "sm" */')).toBe(0);
  });
});
