/**
 * Tests for the pure parts of the release cost report (ugcportal-apsq):
 * CHANGELOG membership parsing, estimate (~) marking, median, the step-4b
 * round-chain reader, the stated-severity classifier and the close-reason
 * round parser. The bd / gh / git plumbing is not exercised here; the
 * fixtures below are shaped like the real comments and notes in this repo
 * (quoted from PRs #75, #79, #94, #95, #98 and the beads they belong to).
 */
import { describe, expect, it } from "vitest";

import {
  GENERATED_END,
  GENERATED_START,
  addendumRound,
  beadsAndPrsFromGitLog,
  classifySeverity,
  clusterByTime,
  estimateFlags,
  firstLine,
  fmtTokens,
  median,
  parseChangelogMembership,
  parsePrs,
  parseRoundsFromCloseReason,
  readRoundChain,
  spliceGenerated,
  tailRounds,
} from "./release-cost-report.mjs";

const CHANGELOG = `# Changelog

## v0.5.0 - 2026-10-05

### 💰 Cost Summary

| Type | Impl |
|---|---:|

### ✨ Features

- **Header: wordmark, tagline and navigation (English)** (\`ugcportal-14k9\`, scope: design) — [#94](https://github.com/x/y/pull/94)
- **Front page** (\`ugcportal-6dvg\`, scope: design) — [#97](https://github.com/x/y/pull/97)

### 🐛 Fixes

- **Six unaddressed review findings** (\`ugcportal-4il\`, scope: process) — [#51](https://github.com/x/y/pull/51), [#53](https://github.com/x/y/pull/53), [#57](https://github.com/x/y/pull/57)
- **Button press translate animates under prefers-reduced-motion** (\`ugcportal-52ue\`, scope: design) — [#101](https://github.com/x/y/pull/101)

### 📝 Documentation

- **Write handoff** (\`ugcportal-205x\`, scope: process)

## v0.4.0 - 2026-09-28

### ✨ Features

- **Gallery UI with lightbox (PhotoSwipe), on the dark surface palette** (\`ugcportal-71y\`, scope: gallery) — [#41](https://github.com/x/y/pull/41)

## v0.3.0 - 2026-09-18

### ✨ Features

- **Older** (\`ugcportal-old\`, scope: auth) — [#4](https://github.com/x/y/pull/4)
`;

describe("parseChangelogMembership", () => {
  it("lists each release's beads in order, once, with type heading, scope and PR numbers", () => {
    const releases = parseChangelogMembership(CHANGELOG);
    expect([...releases.keys()]).toEqual(["v0.5.0", "v0.4.0", "v0.3.0"]);
    const v5 = releases.get("v0.5.0");
    expect(v5.date).toBe("2026-10-05");
    expect(v5.ids).toEqual(["ugcportal-14k9", "ugcportal-6dvg", "ugcportal-4il", "ugcportal-52ue", "ugcportal-205x"]);
    expect(v5.entries.get("ugcportal-4il")).toEqual({ type: "Fixes", scope: "process", prs: [51, 53, 57], title: "Six unaddressed review findings" });
    expect(v5.entries.get("ugcportal-205x").prs).toEqual([]);
    expect(releases.get("v0.4.0").ids).toEqual(["ugcportal-71y"]);
  });

  it("does not let a bead listed under one release leak into another", () => {
    const releases = parseChangelogMembership(CHANGELOG);
    expect(releases.get("v0.4.0").ids).not.toContain("ugcportal-14k9");
    expect(releases.get("v0.5.0").ids).not.toContain("ugcportal-71y");
  });

  it("ignores the cost-summary table and headings that are not releases", () => {
    const releases = parseChangelogMembership("## Unreleased\n- **x** (`ugcportal-z`, scope: a)\n\n## v1.0.0 - 2027-01-01\n### ✨ Features\n- **y** (`ugcportal-y`, scope: b) — [#1](u)\n");
    expect([...releases.keys()]).toEqual(["v1.0.0"]);
  });
});

describe("parsePrs", () => {
  it("reads the comma-separated gh-NN form used in bead metadata", () => {
    expect(parsePrs("gh-67,gh-72")).toEqual([67, 72]);
    expect(parsePrs("gh-94")).toEqual([94]);
    expect(parsePrs("#12, 13")).toEqual([12, 13]);
    expect(parsePrs("")).toEqual([]);
    expect(parsePrs(undefined)).toEqual([]);
  });
});

describe("estimateFlags (K3: an estimate is never shown as exact)", () => {
  it("marks tokens_impl when the notes say the build figure is a rough estimate", () => {
    const flags = estimateFlags("Merged as gh-81. tokens_impl is a rough estimate: implemented inline in the orchestration session, not as a measured subagent run.");
    expect(flags).toMatchObject({ impl: true, qa: false });
    expect(flags.reasons).toHaveLength(1);
  });

  it("marks only the figure the sentence names", () => {
    const flags = estimateFlags("tokens_impl=8000 is a rough estimate (one-line fix, small slice of a larger session); tokens_qa=36464 is exact, from code-review's reported subagent_tokens.");
    expect(flags).toMatchObject({ impl: true, qa: false });
  });

  it("marks tokens_qa when that is the estimated one", () => {
    const flags = estimateFlags("tokens_qa is an approximate sum across forks that reported usage. tokens_impl exact from the subagent passes.");
    expect(flags).toMatchObject({ impl: false, qa: true });
  });

  it("marks both when the sentence is about tokens but names neither field", () => {
    const flags = estimateFlags("Token figures are rough session-level estimates.");
    expect(flags).toMatchObject({ impl: true, qa: true });
  });

  it("does not treat 'chain approx' as a cost estimate", () => {
    const flags = estimateFlags("Merged round 1 (chain approx: reviewer authenticates as PR author in this repo, so self-asserted). Six review rounds.");
    expect(flags).toMatchObject({ impl: false, qa: false });
    expect(flags.reasons).toEqual([]);
  });

  it("is quiet on empty input", () => {
    expect(estimateFlags("")).toMatchObject({ impl: false, qa: false });
    expect(estimateFlags(undefined)).toMatchObject({ impl: false, qa: false });
  });
});

describe("fmtTokens", () => {
  it("prefixes estimated figures with a tilde and leaves exact ones bare", () => {
    expect(fmtTokens(250000, true)).toBe("~250,000");
    expect(fmtTokens(250000, false)).toBe("250,000");
    expect(fmtTokens(null, true)).toBe("—");
  });
});

describe("median", () => {
  it("returns the middle value for an odd count and the mean of the two middle values for an even count", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("ignores non-finite values and returns null when nothing is left", () => {
    expect(median([NaN, 2, undefined, 4])).toBe(3);
    expect(median([])).toBeNull();
    expect(median([null])).toBeNull();
  });
});

describe("parseRoundsFromCloseReason", () => {
  it("reads the number-word forms used in this repo's close reasons", () => {
    expect(parseRoundsFromCloseReason("Merged as gh-33 (squash) after seven implementation rounds and seven review passes.")).toMatchObject({ rounds: 7 });
    expect(parseRoundsFromCloseReason("after SIX implementation rounds and FIVE independent code-review passes that produced 19 findings")).toMatchObject({ rounds: 5 });
    expect(parseRoundsFromCloseReason("Header with wordmark; six review rounds, mediums found and fixed at rounds 3 and 4.")).toMatchObject({ rounds: 6 });
    expect(parseRoundsFromCloseReason("Merged via PR #78, squash-merged after 5 review rounds on an approx chain")).toMatchObject({ rounds: 5 });
    expect(parseRoundsFromCloseReason("Went through 4 real review rounds that found and fixed 15 genuine bugs")).toMatchObject({ rounds: 4 });
    expect(parseRoundsFromCloseReason("P2002 race-recovery path driven by a real test. Three rounds.")).toMatchObject({ rounds: 3 });
    expect(parseRoundsFromCloseReason("Review: round 1, approx chain, zero findings, tokens_qa=62447.")).toMatchObject({ rounds: 1 });
  });

  it("returns null rather than guessing when no round count is stated", () => {
    expect(parseRoundsFromCloseReason("Closed")).toBeNull();
    expect(parseRoundsFromCloseReason("Merged as PR #91. Revoked identities lose their live session; lows deferred to ugcportal-0p5s.")).toBeNull();
    expect(parseRoundsFromCloseReason("")).toBeNull();
  });
});

describe("readRoundChain (pr-review-merge step 4b)", () => {
  const me = "eiriksf-capgemini";
  const c = (n, body, extra = {}) => ({ kind: "comment", login: me, at: `2026-10-05T0${n}:00:00Z`, edited: false, body, ...extra });

  it("reads only an anchored first-line marker, and strips a trailing CR before matching", () => {
    expect(firstLine("<!-- ugcportal-review-round: 4 -->\r\nbody")).toBe("<!-- ugcportal-review-round: 4 -->");
    const chain = readRoundChain(
      [
        c(1, "<!-- ugcportal-review-round: 1 -->\nround one"),
        c(2, "<!-- ugcportal-review-round: 2 -->\r\nposted from the web UI"),
        c(3, "Discussion that quotes a marker:\n<!-- ugcportal-review-round: 6 -->\nis not a marker"),
        c(4, "> <!-- ugcportal-review-round: 7 -->\nquoted, not a marker"),
      ],
      "someone-else",
      me,
    );
    expect(chain.ns).toEqual([1, 2]);
    expect(chain.highest).toBe(2);
    expect(chain.status).toBe("exact");
  });

  it("reads a self-asserted chain (reviewer is the PR author) as approx, never exact", () => {
    const chain = readRoundChain([c(1, "<!-- ugcportal-review-round: 1 approx -->\nx"), c(2, "<!-- ugcportal-review-round: 2 approx -->\ny")], me, me);
    expect(chain).toMatchObject({ highest: 2, status: "approx", self: true });
  });

  it("reads no markers as 0 exact for a third-party reviewer and 0 approx for a self-review", () => {
    expect(readRoundChain([], "author", me)).toMatchObject({ highest: 0, status: "exact" });
    expect(readRoundChain([], me, me)).toMatchObject({ highest: 0, status: "approx" });
  });

  it("reads a gap as broken (the real shape on PR #81: {1,4,5,6})", () => {
    const chain = readRoundChain([1, 4, 5, 6].map((n) => c(n, `<!-- ugcportal-review-round: ${n} approx -->\nx`)), me, me);
    expect(chain).toMatchObject({ highest: 6, status: "broken", ns: [1, 4, 5, 6] });
  });

  it("reads an edited marker, a duplicate marker, a foreign author or a marker above the ceiling as broken", () => {
    const edited = readRoundChain([c(1, "<!-- ugcportal-review-round: 1 -->\nx", { edited: true })], "a", me);
    expect(edited.status).toBe("broken");
    const dup = readRoundChain([c(1, "<!-- ugcportal-review-round: 1 -->\nx"), c(2, "<!-- ugcportal-review-round: 1 -->\ny")], "a", me);
    expect(dup.status).toBe("broken");
    const foreign = readRoundChain([c(1, "<!-- ugcportal-review-round: 1 -->\nx", { login: "mallory" })], "a", me);
    expect(foreign.status).toBe("broken");
    const huge = readRoundChain([c(1, "<!-- ugcportal-review-round: 1 -->\nx"), c(2, "<!-- ugcportal-review-round: 100000000000 -->\ny")], "a", me);
    expect(huge.status).toBe("broken");
  });

  it("honours a chain reset: markers at or below the reset are ignored and the chain restarts at reset + 1 as approx", () => {
    const chain = readRoundChain(
      [c(1, "<!-- ugcportal-review-round: 1 -->\nx"), c(2, "<!-- ugcportal-review-chain-reset: 7 -->\nhuman"), c(3, "<!-- ugcportal-review-round: 8 -->\ny")],
      "a",
      me,
    );
    expect(chain).toMatchObject({ highest: 8, status: "approx", ns: [8], reset: 7 });
  });

  it("collects non-counting stop markers without counting them", () => {
    const chain = readRoundChain([c(1, "<!-- ugcportal-review-stop: ci -->\nred CI"), c(2, "<!-- ugcportal-review-round: 1 approx -->\nx")], me, me);
    expect(chain.stops.map((s) => s.reason)).toEqual(["ci"]);
    expect(chain.ns).toEqual([1]);
  });
});

describe("classifySeverity (severity is read from the reviewer's words, never guessed)", () => {
  it("counts numbered upper-case labels and ignores the summary line that repeats the count", () => {
    const body = [
      "<!-- ugcportal-review-round: 1 approx -->",
      "Review round 1 (chain approx). Blocking: one MEDIUM and four LOW. CI green, no sensitive paths.",
      "",
      "1. MEDIUM (K1/K3, verified with the repo's own contrast helper): the mobile menu toggle is invisible.",
      "2. LOW (family 4): the home page renders two descriptions.",
      "3. LOW (coverage): e2e covers 375, 768 and 1440 but not 320.",
      "4. LOW (reuse): primary-nav-link.tsx duplicates upload-link.tsx.",
      "5. LOW: the dual-meaning audit is a four-token allowlist.",
      "",
      "Recurring-family sweep. Family 1: finding 1. Family 2: nothing found. Family 4: findings 2 and 4.",
    ].join("\n");
    expect(classifySeverity(body)).toMatchObject({ medium: 1, low: 4, stated: true });
  });

  it("deduplicates 'MEDIUM 1' / 'MEDIUM 2' labels that the sweep line repeats", () => {
    const body = "MEDIUM 1, configured-user-link.ts: linkAccount left unwrapped.\nMEDIUM 2, createUser: array problems only logged.\nLOW: six small things; another; a third.\n\nRecurring-family sweep. Family 4: MEDIUM 1.";
    expect(classifySeverity(body)).toMatchObject({ medium: 2, low: 1 });
  });

  it("reads the bold lower-case list style used on PR #75", () => {
    const body = "- **low** — `GalleryEmpty` repeated a className.\n- **medium** — `route.ts`'s new `console.error` fires unconditionally.\n- **low** (reiterated) — HTTP 200 on a failed render.\n- **medium*** — answers HTTP 200; filed as ugcportal-ipmz.";
    expect(classifySeverity(body)).toMatchObject({ medium: 2, low: 2, stated: true });
  });

  it("reads '[Medium]' and '[code-review, medium]' bracket styles", () => {
    expect(classifySeverity("**[Medium] The sibling call site still logs nothing.**\n\nbody")).toMatchObject({ medium: 1 });
    expect(classifySeverity("**[code-review, medium]** `route.ts:110` returns rows without toGalleryItems.")).toMatchObject({ medium: 1 });
  });

  it("counts 'MEDIUM-OR-ABOVE, CONFIRMED.' as a label on a list item but not as a heading", () => {
    const items = "1. **MEDIUM-OR-ABOVE, CONFIRMED.** `--muted-foreground` was repointed.\n2. **MEDIUM-OR-ABOVE, CONFIRMED.** Fraunces weight 500 only.\n3. **MEDIUM, CONFIRMED.** docs/design/tokens.css did not exist on any pushed ref.";
    expect(classifySeverity(items)).toMatchObject({ medium: 3 });
    const heading = "**Medium-or-above findings — all now resolved:**\n\n1. **Medium, CONFIRMED** — the backfill stamped the identical string.\n2. **Medium, PLAUSIBLE** — nothing stopped an uploader.";
    expect(classifySeverity(heading)).toMatchObject({ medium: 2 });
  });

  it("does not read gate prose, negations, counts or back-references as findings", () => {
    const body = [
      "Review round 2. Round-1 mediums verified closed by execution. Blocks under the rounds 1-3 rule; two LOWS, both in the guard.",
      "From this round, only medium-or-above blocks; a medium at round 6 goes to Eirik. No medium-or-above found.",
      "Same MEDIUM class, same decision.",
      "LOW, motion-reduce-pairing.test.ts:172: the rule requires motion-safe: as the OUTERMOST variant.",
      "LOW, :99 and :109 (family 4): the trigger list covers hover but not focus-visible.",
    ].join("\n");
    expect(classifySeverity(body)).toMatchObject({ medium: 0, low: 2, stated: true });
  });

  it("reads 'One **MEDIUM**, fixed' as a single medium and 'two CONFIRMED MEDIUM findings' as a count, not three labels", () => {
    expect(classifySeverity("Round 4 (chain exact).\n\nOne **MEDIUM**, fixed: `_ugcportal_has_env_var` treated any `VAR=` line as a real value.\n\nEverything else was **LOW**; fixed in d625af9.")).toMatchObject({ medium: 1 });
    const two = "Blocks: two CONFIRMED MEDIUM findings, both by execution.\n\nMEDIUM (1), scan-source.ts:150: every file is parsed as TSX.\nMEDIUM (2), scan-source.ts:156: an unterminated `/*` erases the rest of the file.";
    expect(classifySeverity(two)).toMatchObject({ medium: 2 });
  });

  it("reads 'Finding — Medium, CONFIRMED' after an em dash", () => {
    expect(classifySeverity("**Finding — Medium, CONFIRMED, fixed this round.** `attemptedFilenames` was only ever written by the refusal branch.")).toMatchObject({ medium: 1 });
  });

  it("reports a verdict that states no severity as unstated rather than as zero", () => {
    const implementerReport = "<!-- ugcportal-review-round: 1 -->\nReview round 1 (stamped retroactively). All eight findings addressed in 9ebc598.\n\n- **over-counts by one on every live run** — fallback deleted.\n- **`--paginate --jq` filters per page** — fixed.";
    const r = classifySeverity(implementerReport);
    expect(r.stated).toBe(false);
    expect(r.findings).toBe(8);
  });

  it("treats an explicit 'zero findings' verdict as stated with no mediums", () => {
    expect(classifySeverity("Round 1 (chain approx). code-review found zero findings; all four families swept and reported. Merging.")).toMatchObject({ medium: 0, low: 0, stated: true });
  });
});

describe("addendumRound", () => {
  it("attaches an addendum to the round it names and returns null for other unmarked comments", () => {
    expect(addendumRound("Addendum to round 4 (no new round): a late finder angle added three points.")).toBe(4);
    expect(addendumRound("Round 4 addendum (no marker; the round-4 marker above is the one that counts).")).toBe(4);
    expect(addendumRound("Merge note, not a counted round (no marker).")).toBeNull();
  });
});

describe("tailRounds", () => {
  it("counts the lows-only rounds after the last round that found a medium", () => {
    const rounds = [
      { n: 1, medium: 1, stated: true },
      { n: 2, medium: 1, stated: true },
      { n: 3, medium: 0, stated: true },
      { n: 4, medium: 0, stated: true },
      { n: 5, medium: 0, stated: true },
      { n: 6, medium: 0, stated: true },
    ];
    expect(tailRounds(rounds)).toBe(4);
    expect(tailRounds([{ n: 1, medium: 0, stated: true }])).toBe(1);
    expect(tailRounds([{ n: 1, medium: 0, stated: false }])).toBeNull();
  });
});

describe("clusterByTime", () => {
  it("groups inline comments into bursts separated by more than the gap", () => {
    const ts = ["2026-09-24T17:52:47Z", "2026-09-24T17:52:52Z", "2026-09-24T18:18:03Z", "2026-09-24T19:02:53Z", "2026-09-24T19:03:00Z"];
    expect(clusterByTime(ts, 20).map((c) => c.length)).toEqual([2, 1, 2]);
    expect(clusterByTime([], 20)).toEqual([]);
  });
});

describe("beadsAndPrsFromGitLog", () => {
  it("pulls bead ids and PR numbers out of commit subjects, including direct-to-main commits with no PR", () => {
    const log = "chore(release): v0.5.0\nfix(gallery): honour prefers-reduced-motion (ugcportal-ig4g)\nfeat(design): site footer (ugcportal-akv6) (#96)\n";
    const { ids, prs, commits } = beadsAndPrsFromGitLog(log);
    expect([...ids]).toEqual(["ugcportal-ig4g", "ugcportal-akv6"]);
    expect([...prs]).toEqual([96]);
    expect(commits).toHaveLength(3);
  });
});

describe("spliceGenerated", () => {
  it("replaces only the block between the markers and appends one when the file has none", () => {
    const existing = `# Title\n\nprose\n\n${GENERATED_START}\nold\n${GENERATED_END}\n\nmore prose\n`;
    const out = spliceGenerated(existing, `${GENERATED_START}\nnew\n${GENERATED_END}`);
    expect(out).toBe(`# Title\n\nprose\n\n${GENERATED_START}\nnew\n${GENERATED_END}\n\nmore prose\n`);
    expect(spliceGenerated("# Title\n", `${GENERATED_START}\nnew\n${GENERATED_END}`)).toBe(`# Title\n\n${GENERATED_START}\nnew\n${GENERATED_END}\n`);
  });
});
