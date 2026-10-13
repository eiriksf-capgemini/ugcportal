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

import { checkSensitiveFiles, classifyChangedFilesInput, SENSITIVE_PATTERN } from "./check-sensitive-files.mjs";

const CLI_PATH = fileURLToPath(new URL("./check-sensitive-files.mjs", import.meta.url));

/**
 * Spawns the real CLI entry point the way ci.yml does (CHANGED_FILES env
 * var, newline-separated, nothing on argv) and returns its exit code --
 * `execFileSync` throws on a non-zero exit, with the code on `error.status`.
 * @param {string[]} changedFiles
 * @returns {number}
 */
function runCli(changedFiles) {
  return runCliRaw({ ...process.env, CHANGED_FILES: changedFiles.join("\n") }).status;
}

/**
 * The same spawn, but with the environment built by the caller (so a test
 * can DELETE `CHANGED_FILES` rather than set it) and with stdout/stderr
 * returned alongside the status -- the ugcportal-kssp cases below are about
 * what this guard SAYS when it examined nothing, which an exit code alone
 * cannot show.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runCliRaw(env) {
  try {
    const stdout = execFileSync("node", [CLI_PATH], { env, stdio: "pipe", encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: (err.stdout ?? "").toString(), stderr: (err.stderr ?? "").toString() };
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

  it("states the denominator on a clean PR, so the pass is readable as a measurement", () => {
    const { status, stdout } = runCliRaw({ ...process.env, CHANGED_FILES: "src/app/page.tsx\nREADME.md" });
    expect(status).toBe(0);
    expect(stdout).toContain("Changed files (2):");
    expect(stdout).toContain("No sensitive files among the 2 file(s) this PR changes.");
  });
});

describe("main() when the guard examined nothing (ugcportal-kssp)", () => {
  // This block replaces a test that asserted the opposite -- "exits 0 when
  // CHANGED_FILES is unset (no changes to evaluate)" -- which pinned the
  // fail-open in place: a sensitive-path CI guard that silently passed
  // whenever its input never arrived. Reaching this guard at all means a
  // pull request exists, and a pull request that changes zero files does
  // not, so "0 files" is always a fact about the input.

  it("FAILS, rather than passing, when CHANGED_FILES is unset", () => {
    const env = { ...process.env };
    delete env.CHANGED_FILES;
    const { status, stderr, stdout } = runCliRaw(env);
    expect(status).toBe(1);
    expect(stderr).toContain("CHANGED_FILES is not set, so this guard examined 0 files");
    expect(stderr).toContain("That is a broken check, not a clean PR");
    expect(stdout).not.toContain("No sensitive files");
  });

  it("FAILS, rather than passing, when CHANGED_FILES is set but empty", () => {
    const { status, stderr, stdout } = runCliRaw({ ...process.env, CHANGED_FILES: "" });
    expect(status).toBe(1);
    expect(stderr).toContain("CHANGED_FILES is set but empty, so this guard examined 0 files");
    expect(stdout).not.toContain("No sensitive files");
  });

  it("distinguishes the two in its message, because they point at different mistakes", () => {
    const unsetEnv = { ...process.env };
    delete unsetEnv.CHANGED_FILES;
    expect(runCliRaw(unsetEnv).stderr).not.toContain("is set but empty");
    expect(runCliRaw({ ...process.env, CHANGED_FILES: "" }).stderr).not.toContain("is not set");
  });
});

describe("classifyChangedFilesInput", () => {
  it("reports an absent variable as unset, not as an empty PR", () => {
    expect(classifyChangedFilesInput(undefined)).toEqual({ files: [], verdict: "unset" });
  });

  it("reports a present-but-blank variable as empty", () => {
    expect(classifyChangedFilesInput("")).toEqual({ files: [], verdict: "empty" });
    expect(classifyChangedFilesInput("\n  \n")).toEqual({ files: [], verdict: "empty" });
  });

  it("trims and drops blank lines but keeps every real path", () => {
    expect(classifyChangedFilesInput("CLAUDE.md\n\n  src/a.ts  \n")).toEqual({
      files: ["CLAUDE.md", "src/a.ts"],
      verdict: "ok",
    });
  });
});
