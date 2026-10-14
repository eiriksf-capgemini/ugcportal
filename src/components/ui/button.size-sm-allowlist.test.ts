import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isTestFile, stripComments, walkSourceFiles } from "@/lib/design/scan-source";

/**
 * ugcportal-gdn3: button.tsx has two same-box-model small sizes. Plain `sm`
 * carries a capped radius; `header-sm` is the uncapped one the public-page
 * controls use. Nothing else stops a new public-page control reaching for the
 * more conventional `size="sm"` and silently losing that radius, so every
 * non-test `size="sm"` / `size: "sm"` caller must be on this list. A new
 * caller fails here until someone adds it deliberately (admin/upload/consent
 * surfaces only; a public-page control uses "header-sm").
 *
 * Counts are per file, so a second `sm` use in an allowlisted file is also
 * flagged. The list is the output of
 * `grep -rnE 'size(=|: *)\{?["'"'"']sm["'"'"']' src` (non-test, comments
 * stripped), not a recollection.
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

/** JSX prop `size="sm"` / `size={"sm"}` and object form `size: "sm"`. */
const SIZE_SM = /\bsize(?:=|\s*:\s*)\{?\s*["']sm["']/g;

let cachedSourceFiles: string[] | undefined;

function countSmCallers(): Record<string, number> {
  const found: Record<string, number> = {};
  const files = (cachedSourceFiles ??= walkSourceFiles(SRC_ROOT, isTestFile));
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, "utf8"), file);
    const n = stripped.match(SIZE_SM)?.length ?? 0;
    if (n > 0) found[path.relative(REPO_ROOT, file).split(path.sep).join("/")] = n;
  }
  return found;
}

describe("button size=sm caller allowlist (ugcportal-gdn3)", () => {
  const found = countSmCallers();

  it("K1: every current size=sm caller is allowlisted and the list has no stale entries", () => {
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(ALLOWED_SM_CALLERS);
  });

  it("K2: the pattern matches the JSX and cva-object forms (the scan can match something)", () => {
    expect('<Button size="sm">'.match(SIZE_SM)).toHaveLength(1);
    expect('<Button size={"sm"}>'.match(SIZE_SM)).toHaveLength(1);
    expect('buttonVariants({ size: "sm" })'.match(SIZE_SM)).toHaveLength(1);
    expect('<Button size="header-sm">'.match(SIZE_SM)).toBeNull();
  });
});
