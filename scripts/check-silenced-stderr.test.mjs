/**
 * Tests for the silenced-stderr guard (ugcportal-kssp, mitigation 2).
 *
 * Two halves. The pure-function cases below feed synthetic file text to the
 * scanner, both ways round: text that SHOULD match and text that must not.
 * The last block runs the real audit over the real tree, which is what makes
 * this a standing gate rather than a one-off grep -- a future `2>` redirect
 * to the null device on a `bd update`, anywhere under scripts/ or
 * .claude/skills/, turns this red on the next `vitest run`.
 *
 * The literals this file must never contain: see the comment above
 * check-silenced-stderr.mjs's own pattern constants. Everything here builds
 * the forms it tests out of pieces for the same reason the scanner does --
 * the guard scans itself, with no self-exclusion.
 */
import { describe, expect, it } from "vitest";

import { ALLOWLIST, auditTree, findStderrSilencers, formatAudit, listScannableFiles } from "./check-silenced-stderr.mjs";
import { getRepoRoot } from "./lib/git-diff.mjs";
import fs from "node:fs";
import path from "node:path";

const NULL_DEVICE = `/${"dev"}/${"null"}`;
const REDIRECT = `2>${NULL_DEVICE}`;
const CLOSE = "2>&" + "-";
const IGNORE_STRING = 'stdio: "' + 'ignore"';
// Same assembly-from-pieces discipline as the scanner's own constants: this
// file is inside the scanned tree, so writing the array form literally would
// make the guard flag its own test fixture.
const IGNORE_STDERR_ARRAY = 'stdio: ["ignore", "pipe", "' + 'ignore"]';

describe("findStderrSilencers — text that SHOULD match", () => {
  it("flags a shell redirect of stderr to the null device", () => {
    const hits = findStderrSilencers(`bd update ugcportal-a --set-metadata k=v ${REDIRECT}\n`, "x.md");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "x.md", line: 1, kind: "shell-devnull" });
  });

  it("flags the spaced form, which a plain substring grep for the tight one misses", () => {
    expect(findStderrSilencers(`bd close ugcportal-a 2>  ${NULL_DEVICE}\n`, "x.md")[0].kind).toBe("shell-devnull");
  });

  it("flags closing stderr outright", () => {
    expect(findStderrSilencers(`bd update ugcportal-a ${CLOSE}\n`, "x.sh")[0].kind).toBe("shell-close");
  });

  it("flags an stdio option set to the ignore string", () => {
    expect(findStderrSilencers(`execFileSync("bd", args, { ${IGNORE_STRING} });\n`, "x.mjs")[0].kind).toBe("stdio-ignore");
  });

  it("flags an stdio array whose third slot is ignore", () => {
    const hits = findStderrSilencers(`execFileSync("bd", args, { ${IGNORE_STDERR_ARRAY} });\n`, "x.mjs");
    expect(hits[0].kind).toBe("stdio-array-ignore");
  });

  it("reports the right line number in a multi-line file", () => {
    const hits = findStderrSilencers(`one\ntwo\nbd update a ${REDIRECT}\nfour\n`, "x.md");
    expect(hits[0].line).toBe(3);
  });

  it("carries the three preceding lines as context, so an allowlist entry can name the command", () => {
    const hits = findStderrSilencers(`gh api repos/:owner/:repo/compare/a...b \\\n  --jq '.x' ${REDIRECT}\n`, "x.md");
    expect(hits[0].context).toContain("gh api repos/:owner/:repo/compare");
  });
});

describe("findStderrSilencers — text that must NOT match", () => {
  it("does not flag an stdio array that PIPES stderr, which captures rather than discards it", () => {
    expect(findStderrSilencers(`execFileSync("git", a, { stdio: ["ignore", "pipe", "pipe"] });\n`, "x.mjs")).toEqual([]);
  });

  it("does not flag a two-slot stdio array, where stderr keeps its piping default", () => {
    expect(findStderrSilencers(`execFileSync("git", a, { stdio: ["ignore", "pipe"] });\n`, "x.mjs")).toEqual([]);
  });

  it("does not flag stdout alone being redirected", () => {
    expect(findStderrSilencers(`npm run build > ${NULL_DEVICE}\n`, "x.md")).toEqual([]);
  });

  it("does not flag an ordinary file with no redirection at all", () => {
    expect(findStderrSilencers("const x = 1;\nexport default x;\n", "x.mjs")).toEqual([]);
  });
});

describe("auditTree", () => {
  const allow = [{ file: "a.mjs", kind: "shell-devnull", contains: "git rev-parse", reason: "read-only probe" }];

  it("passes a hit that an allowlist entry covers", () => {
    const audit = auditTree(["a.mjs"], () => `git rev-parse --verify origin/main ${REDIRECT}\n`, allow);
    expect(audit.unallowed).toEqual([]);
    expect(audit.staleAllowlistEntries).toEqual([]);
    expect(formatAudit(audit).ok).toBe(true);
  });

  it("fails a hit no allowlist entry covers", () => {
    const audit = auditTree(["a.mjs"], () => `bd update ugcportal-a --set-metadata k=v ${REDIRECT}\n`, allow);
    expect(audit.unallowed).toHaveLength(1);
    const { ok, lines } = formatAudit(audit);
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("NOT ALLOWED a.mjs:1");
  });

  it("fails an allowlist entry that matched nothing, rather than letting it stand unused", () => {
    const audit = auditTree(["a.mjs"], () => "const x = 1;\n", allow);
    expect(audit.hits).toEqual([]);
    expect(audit.staleAllowlistEntries).toHaveLength(1);
    const { ok, lines } = formatAudit(audit);
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("STALE ALLOWLIST ENTRY matched nothing");
  });

  it("fails on zero files examined, instead of reporting a clean tree", () => {
    const audit = auditTree(
      [],
      () => "",
      [],
    );
    expect(audit.hits).toEqual([]);
    const { ok, lines } = formatAudit(audit);
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("EXAMINED NOTHING: 0 files matched the scan roots");
  });

  it("states the denominator on a clean run, so a pass is a measurement rather than a silence", () => {
    const audit = auditTree(["a.mjs", "b.mjs"], () => "const x = 1;\n", []);
    const text = formatAudit(audit).lines.join("\n");
    expect(text).toContain("files examined: 2 under scripts, .claude/skills");
    expect(text).toContain("stderr-silencing sites found: 0 (allowed: 0, not allowed: 0)");
    expect(text).not.toContain("EXAMINED NOTHING");
  });
});

describe("the real tree (this is the standing gate)", () => {
  const repoRoot = getRepoRoot();
  const files = listScannableFiles(repoRoot);

  it("scans a non-trivial number of files, so a pass cannot be the walker failing", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("scripts/check-silenced-stderr.mjs");
    expect(files).toContain(".claude/skills/pr-review-merge/SKILL.md");
  });

  it("has every silenced-stderr site allowlisted, and every allowlist entry live", () => {
    const audit = auditTree(files, (f) => fs.readFileSync(path.join(repoRoot, f), "utf8"));
    const { ok, lines } = formatAudit(audit);
    // The report is the failure message on purpose: a reader of a red run
    // gets the full enumeration, not just a count.
    expect(ok, lines.join("\n")).toBe(true);
  });

  it("every allowlist entry states a reason, not just a path", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason, `${entry.file} [${entry.kind}]`).toMatch(/Read-only\./);
      expect(entry.reason.length).toBeGreaterThan(80);
    }
  });
});
