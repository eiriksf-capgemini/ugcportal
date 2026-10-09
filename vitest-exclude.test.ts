import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { glob } from "tinyglobby";
import { defaultInclude } from "vitest/config";
import { afterEach, describe, expect, it } from "vitest";

import vitestConfig from "./vitest.config";

/**
 * Named vitest-exclude.test.ts rather than vitest.config.test.ts
 * deliberately: defaultExclude's `**\/{...,vitest,...}.config.*` entry (see
 * the array this file imports below) would match and silently drop a file
 * actually named vitest.config.test.ts — exactly the kind of invisible
 * exclusion this bead is about.
 *
 * ugcportal-l99p: a prior `npm run build` makes Turbopack trace the whole
 * project (schema-mismatch.ts's readdirSync over the migrations dir defeats
 * its static analysis) and copies every src/**\/*.test.* into
 * .next/standalone. vitest.config.ts's test.exclude didn't cover .next/, so
 * a `vitest run` in the same tree afterwards collected that copy as a
 * second, broken suite.
 *
 * Asserting `.test.exclude` merely *contains* the string ".next/**" would
 * pass whether or not that pattern actually matches anything - a glob typo
 * (".next" with no "/**", or ".nextt/**") would still satisfy an
 * array-membership check. Instead this drives the exact function vitest
 * itself uses to turn `include`/`exclude` into a file list - tinyglobby's
 * `glob()`, called the same way ViteNodeRunner.globFiles does (`dot: true`,
 * `ignore: exclude`, `expandDirectories: false`) - against a real temp
 * directory standing in for a post-build tree, so the test fails if the
 * pattern stops actually excluding anything, not just if it goes missing
 * from the array.
 */
const { exclude } = vitestConfig.test!;

let tmpRoot: string | undefined;

afterEach(async () => {
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

async function globFixture(relativeFiles: string[]): Promise<string[]> {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ugcportal-vitest-exclude-"));
  for (const relativeFile of relativeFiles) {
    const absolute = path.join(tmpRoot, relativeFile);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "");
  }
  return glob(defaultInclude, {
    dot: true,
    cwd: tmpRoot,
    ignore: exclude,
    expandDirectories: false,
  });
}

describe("vitest.config.ts: test.exclude (ugcportal-l99p)", () => {
  it("still collects a real test file alongside the .next/standalone copy", async () => {
    const found = await globFixture(["src/real.test.ts", ".next/standalone/src/real.test.ts"]);
    expect(found).toEqual(["src/real.test.ts"]);
  });

  it("MUTATION CHECK: excludes a build-traced copy nested several directories deep under .next", async () => {
    const found = await globFixture([
      "src/lib/thing.test.ts",
      ".next/standalone/src/lib/thing.test.ts",
    ]);
    expect(found).not.toContain(".next/standalone/src/lib/thing.test.ts");
    expect(found).toEqual(["src/lib/thing.test.ts"]);
  });

  it("does not regress the existing .claude/** and e2e/** exclusions", async () => {
    const found = await globFixture([
      "src/real.test.ts",
      ".claude/worktrees/wt/src/real.test.ts",
      "e2e/smoke.spec.ts",
    ]);
    expect(found).toEqual(["src/real.test.ts"]);
  });
});
