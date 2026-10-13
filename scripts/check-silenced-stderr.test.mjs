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

import {
  ALLOWLIST,
  SILENCING_KINDS,
  auditTree,
  entryCoversHit,
  findMalformedAllowlistEntries,
  findStderrSilencers,
  formatAudit,
  listScannableFiles,
} from "./check-silenced-stderr.mjs";
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
// The four forms the first version of this scanner did not match. Each one
// was reproduced live as a `bd update` write that scanned green at exit 0
// before the widening, and as a NOT ALLOWED hit after it.
const APPEND = `2>>${NULL_DEVICE}`;
const MERGE = `&>${NULL_DEVICE}`;
const MERGE_APPEND = `&>>${NULL_DEVICE}`;
const OLD_MERGE = `>& ${NULL_DEVICE}`;
const DUP = `>${NULL_DEVICE} 2>&1`;
// Not silencing: stderr goes to the ORIGINAL stdout, which is still a pipe.
const DUP_REVERSED = `2>&1 >${NULL_DEVICE}`;
const PY_QUALIFIED = "stderr=" + "subprocess.DEVNULL";
const PY_BARE = "stderr=" + "DEVNULL";

describe("findStderrSilencers — text that SHOULD match", () => {
  it("flags a shell redirect of stderr to the null device", () => {
    const hits = findStderrSilencers(`bd update ugcportal-a --set-metadata k=v ${REDIRECT}\n`, "x.md");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "x.md", line: 1, kind: "shell-devnull" });
  });

  it("flags the spaced form, which a plain substring grep for the tight one misses", () => {
    expect(findStderrSilencers(`bd close ugcportal-a 2>  ${NULL_DEVICE}\n`, "x.md")[0].kind).toBe("shell-devnull");
  });

  it("flags the APPENDING stderr redirect, which destroys the text exactly as the truncating one does", () => {
    const hits = findStderrSilencers(`bd update ugcportal-a --set-metadata k=v ${APPEND}\n`, "x.sh");
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("shell-devnull");
  });

  it("flags the both-streams shorthand", () => {
    expect(findStderrSilencers(`bd update ugcportal-a ${MERGE}\n`, "x.sh")[0].kind).toBe("shell-merge-devnull");
    expect(findStderrSilencers(`bd update ugcportal-a ${MERGE_APPEND}\n`, "x.sh")[0].kind).toBe("shell-merge-devnull");
    expect(findStderrSilencers(`bd update ugcportal-a ${OLD_MERGE}\n`, "x.sh")[0].kind).toBe("shell-merge-devnull");
  });

  it("flags stdout to the null device followed by stderr duplicated onto it -- the commonest spelling of all", () => {
    const hits = findStderrSilencers(`bd update ugcportal-a --set-metadata k=v ${DUP}\n`, "x.sh");
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("shell-dup-devnull");
  });

  it("flags the Python DEVNULL sentinel, qualified or bare, since .py is in SCAN_EXTENSIONS", () => {
    expect(findStderrSilencers(`subprocess.run(["bd", "update", "a"], ${PY_QUALIFIED})\n`, "x.py")[0].kind).toBe("py-devnull");
    expect(findStderrSilencers(`subprocess.run(["bd", "update", "a"], ${PY_BARE})\n`, "x.py")[0].kind).toBe("py-devnull");
  });

  it("carries the hit line in full, not only the display snippet, because the allowlist binds to it", () => {
    const long = "x".repeat(300);
    const hits = findStderrSilencers(`bd update ${long} ${REDIRECT}\n`, "x.sh");
    expect(hits[0].snippet).toHaveLength(160);
    expect(hits[0].lineText).toContain(long);
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

  it("does not flag stderr duplicated onto stdout BEFORE stdout is redirected -- stderr still goes to the original stdout", () => {
    expect(findStderrSilencers(`bd update ugcportal-a ${DUP_REVERSED}\n`, "x.sh")).toEqual([]);
  });

  it("does not flag stderr merged onto stdout with no null redirect on the line at all", () => {
    expect(findStderrSilencers("npm run build 2>&1 | tee /tmp/out.txt\n", "x.md")).toEqual([]);
  });

  it("does not flag a DEVNULL handed to stdout rather than stderr", () => {
    expect(findStderrSilencers(`subprocess.run(["bd", "list"], stdout=${"subprocess.DEVNULL"})\n`, "x.py")).toEqual([]);
  });

  it("does not flag an ordinary file with no redirection at all", () => {
    expect(findStderrSilencers("const x = 1;\nexport default x;\n", "x.mjs")).toEqual([]);
  });
});

describe("auditTree", () => {
  const allow = [{ file: "a.mjs", kind: "shell-devnull", commandContains: "git rev-parse", reason: "read-only probe" }];

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

  // The defect these cover: the allowlist used to match on the 3-line context
  // window alone, so a mutating command one line below an allowlisted
  // read-only probe was reported `allowed` at exit 0. Reproduced live against
  // the real tree before the fix, and again after it.
  it("does NOT allow a different command on a neighbouring line, even inside the entry's context window", () => {
    const crossLine = [
      { file: "a.md", kind: "shell-devnull", commandContains: "gh api repos/:owner/:repo/compare", lineContains: "--jq '.files[]'", reason: "read-only probe" },
    ];
    const text = `gh api repos/:owner/:repo/compare/a...b \\\n  --jq '.files[]' ${REDIRECT}\nbd update ugcportal-x --set-metadata k=v ${REDIRECT}\n`;
    const audit = auditTree(["a.md"], () => text, crossLine);
    expect(audit.hits).toHaveLength(2);
    expect(audit.unallowed).toHaveLength(1);
    expect(audit.unallowed[0].line).toBe(3);
    expect(audit.unallowed[0].snippet).toContain("bd update");
    // The legitimate site is still allowed, so this is a narrowing and not a
    // blanket refusal.
    expect(audit.staleAllowlistEntries).toEqual([]);
    expect(formatAudit(audit).ok).toBe(false);
  });

  it("allows the cross-line pipeline the entry was written for", () => {
    const crossLine = [
      { file: "a.md", kind: "shell-devnull", commandContains: "gh api repos/:owner/:repo/compare", lineContains: "--jq '.files[]'", reason: "read-only probe" },
    ];
    const text = `gh api repos/:owner/:repo/compare/a...b \\\n  --jq '.files[]' ${REDIRECT}\n`;
    const audit = auditTree(["a.md"], () => text, crossLine);
    expect(audit.unallowed).toEqual([]);
    expect(formatAudit(audit).ok).toBe(true);
  });

  it("fails closed when a cross-line entry omits lineContains: it matches nothing and reads as stale", () => {
    const noLine = [{ file: "a.md", kind: "shell-devnull", commandContains: "gh api repos/:owner/:repo/compare", reason: "read-only probe" }];
    const text = `gh api repos/:owner/:repo/compare/a...b \\\n  --jq '.files[]' ${REDIRECT}\n`;
    const audit = auditTree(["a.md"], () => text, noLine);
    expect(audit.unallowed).toHaveLength(1);
    expect(audit.staleAllowlistEntries).toHaveLength(1);
    expect(formatAudit(audit).ok).toBe(false);
  });

  it("reports a malformed entry rather than silently skipping it", () => {
    const bad = [{ file: "a.mjs", kind: "shell-devnull", commandContains: "git rev-parse", reason: "" }, { file: "a.mjs", kind: "shell-devnull", commandContains: "git rev-parse", lineContains: "  ", reason: "read-only probe" }];
    expect(findMalformedAllowlistEntries(bad)).toHaveLength(2);
    const audit = auditTree(["a.mjs"], () => `git rev-parse --verify origin/main ${REDIRECT}\n`, bad);
    const { ok, lines } = formatAudit(audit);
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("MALFORMED ALLOWLIST ENTRY");
  });

  it("states the denominator on a clean run, so a pass is a measurement rather than a silence", () => {
    const audit = auditTree(["a.mjs", "b.mjs"], () => "const x = 1;\n", []);
    const text = formatAudit(audit).lines.join("\n");
    expect(text).toContain("files examined: 2 under scripts, .claude/skills");
    expect(text).toContain("stderr-silencing sites found: 0 (allowed: 0, not allowed: 0)");
    expect(text).not.toContain("EXAMINED NOTHING");
  });
});

describe("SILENCING_KINDS — the detection claim, as a checkable list", () => {
  it("is exactly the seven kinds the header enumerates", () => {
    expect([...SILENCING_KINDS].sort()).toEqual(
      ["py-devnull", "shell-close", "shell-devnull", "shell-dup-devnull", "shell-merge-devnull", "stdio-array-ignore", "stdio-ignore"].sort(),
    );
    expect(SILENCING_KINDS).toHaveLength(7);
  });

  it("has a reachable piece of real text for every one of them, so none is a kind in name only", () => {
    const samples = {
      "shell-devnull": `bd update a ${REDIRECT}`,
      "shell-merge-devnull": `bd update a ${MERGE}`,
      "shell-dup-devnull": `bd update a ${DUP}`,
      "shell-close": `bd update a ${CLOSE}`,
      "py-devnull": `subprocess.run(["bd"], ${PY_QUALIFIED})`,
      "stdio-ignore": `execFileSync("bd", args, { ${IGNORE_STRING} });`,
      "stdio-array-ignore": `execFileSync("bd", args, { ${IGNORE_STDERR_ARRAY} });`,
    };
    expect(Object.keys(samples).sort()).toEqual([...SILENCING_KINDS].sort());
    for (const kind of SILENCING_KINDS) {
      const hits = findStderrSilencers(`${samples[kind]}\n`, "x.sh");
      expect(hits.map((h) => h.kind), kind).toContain(kind);
    }
  });

  it("refuses an undeclared kind rather than reporting one SILENCING_KINDS does not list", () => {
    const saved = SILENCING_KINDS.splice(0, SILENCING_KINDS.length, "shell-close");
    try {
      expect(() => findStderrSilencers(`bd update a ${REDIRECT}\n`, "x.sh")).toThrow(/undeclared silencing kind/);
    } finally {
      SILENCING_KINDS.splice(0, SILENCING_KINDS.length, ...saved);
    }
  });
});

describe("entryCoversHit — the binding rule on its own", () => {
  const hit = {
    file: "a.md",
    kind: "shell-devnull",
    lineText: `  --jq '.files[]' ${REDIRECT}`,
    context: `gh api repos/:owner/:repo/compare/a...b \\\n  --jq '.files[]' ${REDIRECT}`,
  };

  it("requires file and kind to match", () => {
    const entry = { file: "a.md", kind: "shell-devnull", commandContains: "gh api repos/:owner/:repo/compare", lineContains: "--jq '.files[]'" };
    expect(entryCoversHit(entry, hit)).toBe(true);
    expect(entryCoversHit({ ...entry, file: "b.md" }, hit)).toBe(false);
    expect(entryCoversHit({ ...entry, kind: "shell-close" }, hit)).toBe(false);
  });

  it("requires lineContains on the hit line, not merely in the context", () => {
    const entry = { file: "a.md", kind: "shell-devnull", commandContains: "gh api repos/:owner/:repo/compare", lineContains: "gh api" };
    // `gh api` is in the context but not on the hit line.
    expect(entryCoversHit(entry, hit)).toBe(false);
  });

  it("without lineContains, requires the command itself on the hit line", () => {
    const entry = { file: "a.md", kind: "shell-devnull", commandContains: "gh api repos/:owner/:repo/compare" };
    expect(entryCoversHit(entry, hit)).toBe(false);
    const sameLine = { ...hit, lineText: `gh api repos/:owner/:repo/compare/a...b ${REDIRECT}` };
    expect(entryCoversHit(entry, sameLine)).toBe(true);
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

  it("every allowlist entry is well formed, so none of them is a permission that cannot be evaluated", () => {
    expect(findMalformedAllowlistEntries(ALLOWLIST)).toEqual([]);
  });

  it("scans the extensions its own header claims, including .py and .sh", () => {
    for (const ext of [".mjs", ".md", ".py", ".sh"]) {
      expect(files.some((f) => f.endsWith(ext)), `no ${ext} file in the scanned set`).toBe(true);
    }
  });
});
