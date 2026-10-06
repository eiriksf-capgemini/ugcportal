/**
 * Tests for the sensitive-file-bundling guard (ugcportal-6hmh).
 *
 * The originating defect: PR #113 (CLAUDE.md only, the companion PR
 * CLAUDE.md's own policy requires for a dedicated human-reviewed change) was
 * red on this check by construction, because the old inline `grep -Ex`
 * step failed on any sensitive file touched regardless of whether anything
 * else changed. These cases are the bead's K1 "Verified by" list.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkSensitiveFiles, SENSITIVE_PATTERN } from "./check-sensitive-files.mjs";

const CLI_PATH = fileURLToPath(new URL("./check-sensitive-files.mjs", import.meta.url));

/**
 * Spawns the real CLI entry point the way ci.yml does (CHANGED_FILES env
 * var, newline-separated, nothing on argv) and returns its exit code --
 * `execFileSync` throws on a non-zero exit, with the code on `error.status`.
 * @param {string[]} changedFiles
 * @returns {number}
 */
function runCli(changedFiles) {
  const env = { ...process.env, CHANGED_FILES: changedFiles.join("\n") };
  try {
    execFileSync("node", [CLI_PATH], { env, stdio: "pipe" });
    return 0;
  } catch (err) {
    return err.status;
  }
}

describe("checkSensitiveFiles", () => {
  it("passes when CLAUDE.md is the only changed file", () => {
    const result = checkSensitiveFiles(["CLAUDE.md"]);
    expect(result.ok).toBe(true);
    expect(result.sensitive).toEqual(["CLAUDE.md"]);
    expect(result.nonSensitive).toEqual([]);
  });

  it("passes when .claude/settings.json is the only changed file", () => {
    const result = checkSensitiveFiles([".claude/settings.json"]);
    expect(result.ok).toBe(true);
    expect(result.sensitive).toEqual([".claude/settings.json"]);
  });

  it("passes when .claude/settings.local.json is the only changed file", () => {
    const result = checkSensitiveFiles([".claude/settings.local.json"]);
    expect(result.ok).toBe(true);
    expect(result.sensitive).toEqual([".claude/settings.local.json"]);
  });

  it("passes when both sensitive files change together and nothing else does", () => {
    const result = checkSensitiveFiles(["CLAUDE.md", ".claude/settings.json"]);
    expect(result.ok).toBe(true);
    expect(result.sensitive.sort()).toEqual([".claude/settings.json", "CLAUDE.md"].sort());
    expect(result.nonSensitive).toEqual([]);
  });

  it("fails when CLAUDE.md is bundled with a source file", () => {
    const result = checkSensitiveFiles(["CLAUDE.md", "src/app/page.tsx"]);
    expect(result.ok).toBe(false);
    expect(result.sensitive).toEqual(["CLAUDE.md"]);
    expect(result.nonSensitive).toEqual(["src/app/page.tsx"]);
  });

  it("fails when .claude/settings.json is bundled with a source file", () => {
    const result = checkSensitiveFiles([".claude/settings.json", "src/app/page.tsx"]);
    expect(result.ok).toBe(false);
  });

  it("passes when no sensitive file changed at all", () => {
    const result = checkSensitiveFiles(["src/app/page.tsx", "README.md"]);
    expect(result.ok).toBe(true);
    expect(result.sensitive).toEqual([]);
    expect(result.nonSensitive).toEqual(["src/app/page.tsx", "README.md"]);
  });

  it("passes on an empty change list", () => {
    const result = checkSensitiveFiles([]);
    expect(result.ok).toBe(true);
  });

  it("matches sensitive paths exactly, not as a substring", () => {
    // A nested or renamed file that merely contains "CLAUDE.md" or
    // ".claude/settings.json" as a substring of its own path must not be
    // treated as the sensitive file itself -- mirrors the original step's
    // `grep -Ex` (whole-line match).
    expect(SENSITIVE_PATTERN.test("docs/CLAUDE.md.bak")).toBe(false);
    expect(SENSITIVE_PATTERN.test("some/CLAUDE.md")).toBe(false);
    expect(SENSITIVE_PATTERN.test(".claude/settings.json.orig")).toBe(false);
  });

  // K2's guardrail: if the bundling check were loosened to "any sensitive
  // file present" regardless of co-changes, bundled cases above would start
  // passing. Proven directly by reconstructing that looser rule and
  // asserting it now accepts the bundled case this test suite rejects.
  it("would wrongly pass the bundled case above if 'ok' ignored nonSensitive entirely", () => {
    const looselyOk = (changedFiles) => {
      const sensitive = changedFiles.filter((f) => SENSITIVE_PATTERN.test(f));
      return sensitive.length >= 0; // always true -- the regression this guards against
    };
    expect(looselyOk(["CLAUDE.md", "src/app/page.tsx"])).toBe(true);
    expect(checkSensitiveFiles(["CLAUDE.md", "src/app/page.tsx"]).ok).toBe(false);
  });
});

describe("main() via the CLI", () => {
  it("exits 0 for CLAUDE.md alone", () => {
    expect(runCli(["CLAUDE.md"])).toBe(0);
  });

  it("exits 0 for .claude/settings.json alone", () => {
    expect(runCli([".claude/settings.json"])).toBe(0);
  });

  it("exits 0 for both sensitive files together", () => {
    expect(runCli(["CLAUDE.md", ".claude/settings.json"])).toBe(0);
  });

  it("exits 1 for CLAUDE.md plus a source file", () => {
    expect(runCli(["CLAUDE.md", "src/app/page.tsx"])).toBe(1);
  });

  it("exits 0 when no sensitive file is changed", () => {
    expect(runCli(["src/app/page.tsx", "README.md"])).toBe(0);
  });

  it("exits 0 when CHANGED_FILES is unset (no changes to evaluate)", () => {
    const env = { ...process.env };
    delete env.CHANGED_FILES;
    expect(
      (() => {
        try {
          execFileSync("node", [CLI_PATH], { env, stdio: "pipe" });
          return 0;
        } catch (err) {
          return err.status;
        }
      })(),
    ).toBe(0);
  });
});
