/**
 * Tests for the pure parts of the release cost report (ugcportal-apsq):
 * CHANGELOG membership parsing, estimate (~) marking, median, the step-4b
 * round-chain reader, the stated-severity classifier, the close-reason
 * round parser and the merge-outcome heuristic. The bd / gh / git plumbing
 * is not exercised here; most fixtures below are shaped like the real
 * comments and notes in this repo (quoted from PRs #75, #79, #94, #95,
 * #98). Five are real bodies fetched once with `gh api` and committed
 * under scripts/fixtures/ (ugcportal-577s, ugcportal-zo8n, ugcportal-x9c7)
 * rather than hit over the network from a test: PR #121's round-1 body (a
 * zero-finding approval that reproduces both of the original defects at
 * once), PR #173's round-2 body (an auto-merge whose body says "no
 * sensitive paths touched"), PR #185's round-1 body (a genuine
 * sensitive-path hold, the control case), and the two bodies the round-6
 * proximity-only flag exclusion silently zeroed -- PR #131's round-1 reply
 * ("two lows fixed", with an unrelated `--since` flag later in the same
 * paragraph) and PR #193's round-1 review ("one CONFIRMED low", with the
 * CSS custom property `--color-petrol-deep` later on the same line).
 *
 * Two suites at the end cover the cost unit and recording helper
 * (ugcportal-cii0), with inline fixtures. "cost unit" tests costUnitOf
 * (one unit per bead; a cost_ite_* is accepted only as a positive integer
 * on a side not marked incomplete), the tokens_impl_convention flag,
 * buildRows, aggregate, the per-unit review shares (pct), the tier table
 * and the report's unit labels and Data gaps lines.
 * "agentCostFromPasses" tests the recording rule CLAUDE.md's one-liner
 * runs: the last notification per agent, the un-notified final pass,
 * INCOMPLETE when a transcript is missing, the coverage checks
 * (uncoveredByAgents, coverageIncomplete across two recordings), the
 * INCOMPLETE note forms (formatAgentCost) and runAgentCost's arguments.
 * "findings_rN keys" (ugcportal-2jvh) covers the keyed
 * severity reader (parseFindingsKey, withFindingsKeys, the `clean` verdict
 * read from an approval-shaped verdict line only, keyedConflicts, roundsSplit, and the
 * orphan/unstamped key reports), with fixtures from real review comments.
 * "tokens_qa_convention" (ugcportal-zu0a) covers how excluded tokens_qa
 * (flagged with tokens_qa_convention) are handled in the report.
 * "an excluded tokens_impl the notes call an estimate does not mark the total" (ugcportal-zu0a)
 * covers when tokens_impl is excluded and notes call it an estimate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTEXT_LABEL,
  GENERATED_END,
  GENERATED_START,
  SUMMED_SNAPSHOTS,
  addendumRound,
  agentCostFromPasses,
  aggregate,
  keyedConflicts,
  roundsSplit,
  orphanFindingsKeys,
  CONTROLS,
  buildRows,
  catchesByControl,
  controlsSection,
  priceControl,
  renderControlsTable,
  costUnitOf,
  fmt,
  formatAgentCost,
  pct,
  renderReport,
  runAgentCost,
  tierPerformance,
  uncoveredByAgents,
  beadsAndPrsFromGitLog,
  classifySeverity,
  clusterByTime,
  estimateFlags,
  firstLine,
  fmtTokens,
  hasGenuineSensitivePathMention,
  median,
  outcomeOf,
  parseChangelogMembership,
  parseFindingsKey,
  parsePrs,
  parseRoundsFromCloseReason,
  readCodeSpans,
  readRoundChain,
  spliceGenerated,
  tailRounds,
  withFindingsKeys,
} from "./release-cost-report.mjs";

const loadFixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const pr121 = loadFixture("pr-121-round1.json");
const pr173 = loadFixture("pr-173-round2.json");
const pr277 = loadFixture("pr-277-round1.json");
const pr258 = loadFixture("pr-258-round1.json");
const pr185 = loadFixture("pr-185-round1.json");
const pr131 = loadFixture("pr-131-round1-reply.json");
const pr193 = loadFixture("pr-193-round1.json");

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

  describe("ugcportal-zo8n: a bare number is only a count beside a severity word in a findings context", () => {
    it("does not read PR #121's own round-1 body (which quotes its code-review invocation as '121 high --comment') as 121 mediums", () => {
      // #121 was a zero-finding approval. The old parser took '121' from the
      // quoted CLI args -- `121 high --comment` -- immediately preceding
      // '--comment', not from any stated finding.
      expect(classifySeverity(pr121.round1Body)).toMatchObject({ medium: 0, low: 0, stated: true, findings: 0 });
    });

    it("does not read a PR-number reference glued to a severity word as a count", () => {
      expect(classifySeverity("See #121 high priority backlog for context; unrelated to this review.")).toMatchObject({ medium: 0, low: 0 });
    });

    it("still reads a genuine 'N <severity>' summary count that is not a PR reference or a CLI invocation", () => {
      // Control: a weaker "fix" that always returns 0 would also pass the
      // #121 assertion above. This case checks the opposite failure mode on
      // one concrete input: a real stated count still comes through here.
      expect(classifySeverity("Review round 1. Found 2 medium findings and 1 low finding, both confirmed.")).toMatchObject({ medium: 2, low: 1 });
    });

    it("mutating the committed #121 fixture to genuinely state a medium count changes the classification", () => {
      // Fixture mutation control: the real zero-finding body parses to 0;
      // swapping in matching finding-labelled text for the same code-review
      // line must parse to a real count, proving the fix discriminates on
      // context rather than on this specific body's text.
      const mutated = pr121.round1Body.replace("`121 high --comment`): 0 findings (`[]`)", "`121 high --comment`): 2 medium findings");
      expect(classifySeverity(mutated)).toMatchObject({ medium: 2 });
    });

    it("distinguishes a flag (no space before the following letter) from a plain '--' separator (ugcportal-577s)", () => {
      // A bare "N <severity> -- prose" must still count: this project's own
      // prose uses "--" as a plain separator constantly (including in PR
      // #201's own body and in the pr-review-merge skill doc), and the
      // original #121 fix over-corrected to treat ANY two-dash run after a
      // severity word as a CLI invocation, silently zeroing a real verdict.
      expect(classifySeverity("Found 2 medium -- will fix in next round.")).toMatchObject({ medium: 2, low: 0 });
      expect(classifySeverity("Found 1 low -- filed as a followup bead.")).toMatchObject({ medium: 0, low: 1 });
      // A real flag -- glued directly to the dashes, no space -- is still
      // excluded, on more than just the committed #121 fixture's `--comment`.
      expect(classifySeverity("`121 high --base main`: 0 findings.")).toMatchObject({ medium: 0 });
      expect(classifySeverity("`121 high --pr 201`: 0 findings.")).toMatchObject({ medium: 0 });
    });

    it("requires the flag to be on the same line as the count: a line break before '--word' is not a CLI invocation (ugcportal-zo8n round 2)", () => {
      // \s in the flag-exclusion regex also matches "\n", so a severity count
      // followed by a line break and then a flag-shaped token on the NEXT
      // line was wrongly excluded as if it were `121 high --comment` glued
      // to the same line. A real verdict followed by an unrelated
      // "--comment"-shaped note on its own line must still count.
      expect(classifySeverity("Found 2 medium\n--comment next round")).toMatchObject({ medium: 2, low: 0, stated: true });
      // Round 7 (ugcportal-x9c7) narrowed what the exclusion is testing: a
      // flag is a CLI echo only when it shares a CODE SPAN with the count,
      // so the quoted house style stays excluded while the same words in
      // bare prose now count. Both forms are asserted here; the bare-prose
      // one changed in round 7 and the quoted one did not.
      expect(classifySeverity("Found 2 medium `--comment` next round")).toMatchObject({ medium: 2 });
      expect(classifySeverity("Found `2 medium --comment` next round")).toMatchObject({ medium: 0 });
      expect(classifySeverity("Found 2 medium --comment next round")).toMatchObject({ medium: 2 });
    });

    describe("same-line flag exclusion is a closed whitelist of line terminators, not a blacklist of whitespace (ugcportal-zo8n round 4)", () => {
      // Round 2 excluded a flag glued to the count after any `\s` (which
      // also matches "\n"); round 3 narrowed that to `[ \t]` to stop
      // matching "\n", but `[ \t]` only recognises two ASCII characters as
      // "same line" -- every OTHER whitespace character (NBSP, the
      // U+2002/U+3000 family, \f, \v) was then misread as if it were a line
      // break, which wrongly took a quoted CLI invocation like
      // "121 high<NBSP>--comment" back OUT of the exclusion and counted it
      // as a real finding again -- the original bug's exact shape, just
      // with a different character in the gap. This enumerates the actual
      // line terminators instead -- \n, \r (and \r\n), U+2028 LINE
      // SEPARATOR, U+2029 PARAGRAPH SEPARATOR, U+0085 NEL -- so "same line"
      // means "not one of these five characters", a closed set that a
      // whitespace character nobody thought of cannot defeat.
      //
      // Characters are built with String.fromCodePoint rather than typed as
      // literal \u escapes in this file's own source, so nothing here
      // depends on how this file's text happens to get encoded.
      const bodyWithGap = (gap) => `\`121 high${gap}--comment\`): 0 findings.`;

      it.each([
        ["LF", "\n"],
        ["CR", "\r"],
        ["CRLF", "\r\n"],
        ["LINE SEPARATOR (U+2028)", String.fromCodePoint(0x2028)],
        ["PARAGRAPH SEPARATOR (U+2029)", String.fromCodePoint(0x2029)],
        ["NEL (U+0085)", String.fromCodePoint(0x0085)],
      ])("counts the flag as a real finding across a genuine line terminator: %s", (_name, gap) => {
        // These separate the count from the flag onto a different line, so
        // this is no longer the glued quoted-CLI shape -- it must count.
        expect(classifySeverity(bodyWithGap(gap))).toMatchObject({ medium: 121 });
      });

      it.each([
        ["SPACE (U+0020)", " "],
        ["TAB (U+0009)", "\t"],
        ["NBSP (U+00A0) -- reachable: leaks in from rich-text copy-paste", String.fromCodePoint(0x00a0)],
        ["EN SPACE (U+2002)", String.fromCodePoint(0x2002)],
        ["IDEOGRAPHIC SPACE (U+3000)", String.fromCodePoint(0x3000)],
        ["FIGURE SPACE (U+2007)", String.fromCodePoint(0x2007)],
        ["NARROW NO-BREAK SPACE (U+202F)", String.fromCodePoint(0x202f)],
        ["MONGOLIAN VOWEL SEPARATOR (U+180E)", String.fromCodePoint(0x180e)],
        ["WORD JOINER (U+2060)", String.fromCodePoint(0x2060)],
        ["FORM FEED (\\f) -- unreachable in practice, wrong in principle under round 3", "\f"],
        ["VERTICAL TAB (\\v) -- unreachable in practice, wrong in principle under round 3", "\v"],
      ])("excludes the flag as same-line across a non-terminator space: %s", (_name, gap) => {
        // None of these is a line terminator, so the flag is still "on the
        // same line" as the count -- this is still the quoted-CLI shape
        // and must not count.
        expect(classifySeverity(bodyWithGap(gap))).toMatchObject({ medium: 0 });
      });
    });

    describe("readCodeSpans is a drop-in for the old `.replace(/[*`_]/g, '')` (ugcportal-x9c7)", () => {
      // classifySeverity's item-label and summary regexes all run over the
      // stripped text, so the lexer is only safe to substitute for the old
      // one-line strip if it removes exactly the same characters and
      // nothing else. Every committed real body is checked, plus the
      // shapes the lexer has branches for.
      const SHAPES = [
        pr121.round1Body,
        pr173.round2Body,
        pr185.round1Body,
        pr131.round1ReplyBody,
        pr193.round1Body,
        "plain prose, no markup at all",
        "`one` span and `another`",
        "``a `nested` backtick``",
        "unbalanced ` backtick",
        "```\nfenced\n--flag\n```\nafter",
        "````\nunclosed fence\n",
        "**bold** _em_ `code` ***both***",
        `a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x2029)}c${String.fromCodePoint(0x85)}d\r\ne\rf`,
        "",
      ];
      it.each(SHAPES.map((s, i) => [i, s]))("strips identically on shape %d", (_i, s) => {
        const lexed = readCodeSpans(s);
        expect(lexed.text).toBe(s.replace(/[*`_]/g, ""));
        // ...and the span map stays aligned with the text it describes.
        expect(lexed.spanIds).toHaveLength(lexed.text.length);
        for (const id of lexed.spanIds) if (id !== 0) expect(lexed.spanText.has(id)).toBe(true);
      });
    });

    describe("the flag exclusion tests SAME CODE SPAN, not proximity (ugcportal-x9c7, round 7)", () => {
      // Rounds 1-6 all tested a proxy -- "how far is the flag from the
      // count, and is there a line break in between". Round 4 settled on a
      // five-terminator whitelist plus an 8-character window; round 5
      // removed the window; round 6 shipped that and regressed on real
      // data, because with no window the whole of a long soft-wrapped
      // paragraph counts as "near".
      //
      // The condition the exclusion actually wants is the house style
      // itself: the count and the flag are quoted TOGETHER inside one
      // markdown code span (`121 high --comment`), which is what makes the
      // number an argument rather than a verdict. That is what is tested
      // now. Distance no longer appears in the predicate at all.

      describe("the two real bodies round 6 zeroed, as committed fixtures", () => {
        it("PR #131's round-1 reply states two lows and is read as two, not zero", () => {
          // "Round 1's two lows fixed in 51be7e9: ... with a one-off
          // `--since 2026-09-29` re-run ...". The flag sits 273 characters
          // after the count in the same unbroken paragraph, so every
          // distance-based rule zeroed it; it is in its own code span while
          // the count is in plain prose, so the span rule counts it.
          expect(pr131.round1ReplyBody).toContain("two lows fixed");
          expect(pr131.round1ReplyBody).toContain("`--since 2026-09-29`");
          expect(classifySeverity(pr131.round1ReplyBody)).toMatchObject({ low: 2, stated: true });
        });

        it("PR #193's round-1 review states one CONFIRMED low and is read as one, not zero", () => {
          // "... on the one CONFIRMED low-severity finding above. Please fix
          // the `--color-petrol-deep` doc comment ...". Not a CLI flag at
          // all -- a CSS custom property, 58 characters later, in its own
          // span.
          expect(pr193.round1Body).toContain("one CONFIRMED low-severity finding");
          expect(pr193.round1Body).toContain("`--color-petrol-deep`");
          expect(classifySeverity(pr193.round1Body)).toMatchObject({ low: 1, stated: true });
        });
      });

      it("still excludes the house style: count and flag inside ONE span", () => {
        expect(classifySeverity("Found `121 high --comment`: 0 findings.")).toMatchObject({ medium: 0 });
        expect(classifySeverity(pr121.round1Body)).toMatchObject({ medium: 0 });
      });

      it("excludes a double-backtick span the same way, and a fenced block the same way", () => {
        expect(classifySeverity("House style, doubled: ``121 high --comment``: 0 findings.")).toMatchObject({ medium: 0 });
        const fenced = ["Invocation and its output:", "", "```", "code-review --comment --pr 201", "3 medium reported", "```", "", "Nothing else."].join("\n");
        expect(classifySeverity(fenced)).toMatchObject({ medium: 0 });
      });

      it("counts the same fenced block once the flag is removed (control: the fence is not what excludes it)", () => {
        const fenced = ["Invocation and its output:", "", "```", "code-review run", "3 medium reported", "```", "", "Nothing else."].join("\n");
        expect(classifySeverity(fenced)).toMatchObject({ medium: 3 });
      });

      it("counts a count and a flag in DIFFERENT adjacent spans", () => {
        expect(classifySeverity("Fixed `2 medium` findings; re-ran with `--comment`.")).toMatchObject({ medium: 2 });
      });

      it("counts a count in prose with the flag in a span (both regression shapes, reduced)", () => {
        expect(classifySeverity("Found 2 medium findings; the CSS token `--color-petrol-deep` is unrelated.")).toMatchObject({ medium: 2 });
        expect(classifySeverity("Two lows fixed; re-ran with `--since 2026-09-29` for comparison.")).toMatchObject({ low: 2 });
      });

      it("counts a count in prose with a bare flag anywhere after it, at any distance", () => {
        // Round 5's own cases, re-decided. These are NOT quoted
        // invocations -- nothing is in a code span -- so under the span
        // rule they count. Round 6 read all three as zero.
        expect(classifySeverity("Found 121 high with the --comment flag.")).toMatchObject({ medium: 121 });
        expect(classifySeverity(`Found 121 high ${"filler ".repeat(40)}with the --comment flag.`)).toMatchObject({ medium: 121 });
        expect(classifySeverity("Found 121 high severity findings in this round.")).toMatchObject({ medium: 121 });
      });

      it("has no window INSIDE a span either: an arbitrarily long quoted invocation still excludes", () => {
        const long = `Quoted: \`code-review --base origin/main --pr 201 ${"x".repeat(400)} 121 high\`.`;
        expect(long.indexOf(" 121 high") - long.indexOf("--base")).toBeGreaterThan(400);
        expect(classifySeverity(long)).toMatchObject({ medium: 0 });
      });

      it("excludes a flag that precedes the count in the same span (argument order is not the point)", () => {
        expect(classifySeverity("Ran `code-review --comment 121 high` and it reported nothing.")).toMatchObject({ medium: 0 });
      });

      it("counts across an UNBALANCED backtick, inline and fenced: an unterminated span opens no span at all", () => {
        // Deliberate fail-open direction. Seven rounds of this defect have
        // all erred the same way -- silently zeroing a stated verdict --
        // and under-counting is the dangerous direction for this report,
        // so an ambiguous span is resolved as "no span", which can only
        // ever cause a count to be COUNTED.
        expect(classifySeverity("Found 2 medium `--comment")).toMatchObject({ medium: 2 });
        expect(classifySeverity("Found 2 medium --comment`")).toMatchObject({ medium: 2 });
        expect(classifySeverity("Found ``2 medium --comment` next round")).toMatchObject({ medium: 2 });
        expect(classifySeverity("```\nFound 2 medium --comment\nstill inside an unclosed fence\n")).toMatchObject({ medium: 2 });
      });

      it("MUTATION: ignoring span boundaries (round 6's proximity-only gate) re-breaks both regression fixtures", async () => {
        // The strongest available form of this check: take the shipped
        // module's own source, swap ONLY the same-span gate for round 6's
        // proximity gate, import the result, and confirm the two fixtures
        // above go back to zero. If they did not, the two assertions above
        // would not be load-bearing -- they would pass with or without the
        // span boundary.
        const src = fs.readFileSync(new URL("./release-cost-report.mjs", import.meta.url), "utf8");
        const SPAN_GATE = 'const spanId = lexed.spanIds[m.index] ?? 0;\n    if (spanId !== 0 && CLI_FLAG.test(lexed.spanText.get(spanId) ?? "")) continue;';
        expect(src).toContain(SPAN_GATE);
        const PROXIMITY_GATE = [
          'const terminators = ["\\\\n", "\\\\r", String.fromCodePoint(0x2028), String.fromCodePoint(0x2029), String.fromCodePoint(0x85)].join("");',
          '    if (new RegExp("^[^" + terminators + "]*--[A-Za-z]").test(text.slice(m.index + m[0].length))) continue;',
        ].join("\n");
        const mutatedSrc = src
          .replace('from "./lib/is-main.mjs"', `from ${JSON.stringify(new URL("./lib/is-main.mjs", import.meta.url).href)}`)
          .replace('from "./agent-pass-cost.mjs"', `from ${JSON.stringify(new URL("./agent-pass-cost.mjs", import.meta.url).href)}`)
          .replace(SPAN_GATE, PROXIMITY_GATE);
        expect(mutatedSrc).not.toContain(SPAN_GATE);
        const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutatedSrc, "utf8").toString("base64")}`);

        // The mutant reproduces round 6's two real regressions exactly...
        expect(mutant.classifySeverity(pr131.round1ReplyBody)).toMatchObject({ low: 0 });
        expect(mutant.classifySeverity(pr193.round1Body)).toMatchObject({ low: 0 });
        // ...while the shipped predicate reads both correctly...
        expect(classifySeverity(pr131.round1ReplyBody)).toMatchObject({ low: 2 });
        expect(classifySeverity(pr193.round1Body)).toMatchObject({ low: 1 });
        // ...and the mutant still agrees on the case the exclusion exists
        // for, so the mutation isolates the span boundary and nothing else.
        expect(mutant.classifySeverity(pr121.round1Body)).toMatchObject({ medium: 0 });
      });
    });
  });
});

describe("hasGenuineSensitivePathMention (ugcportal-577s)", () => {
  it("reads a genuine 'touches a sensitive path' statement as genuine", () => {
    expect(hasGenuineSensitivePathMention("Requires human approval and merge: this PR touches a sensitive path.")).toBe(true);
    expect(hasGenuineSensitivePathMention(pr185.round1Body)).toBe(true);
  });

  it("does not read a negated mention as genuine, in several phrasings a reviewer actually uses", () => {
    expect(hasGenuineSensitivePathMention("CI green, no sensitive paths touched, no blocking findings.")).toBe(false);
    expect(hasGenuineSensitivePathMention("none of the changed files touch a sensitive path.")).toBe(false);
    expect(hasGenuineSensitivePathMention("zero sensitive paths in this diff.")).toBe(false);
    expect(hasGenuineSensitivePathMention("the diff doesn't touch a sensitive path.")).toBe(false);
    expect(hasGenuineSensitivePathMention(pr121.round1Body)).toBe(false);
    expect(hasGenuineSensitivePathMention(pr173.round2Body)).toBe(false);
  });

  it("is not fooled by an unrelated negation elsewhere in the same sentence (PR #185's own 'does not approve or merge' follows its genuine mention)", () => {
    // Control: a naive whole-sentence negation check would see "does not"
    // later in this same sentence and misread the genuine mention as
    // negated. The clause-local check must not do that.
    expect(hasGenuineSensitivePathMention("this PR touches a sensitive path (docker-compose.yml), so this run does not approve or merge regardless of outcome.")).toBe(true);
  });

  it("returns false when the phrase never appears at all", () => {
    expect(hasGenuineSensitivePathMention("CI green, zero findings, merging.")).toBe(false);
    expect(hasGenuineSensitivePathMention("")).toBe(false);
  });

  describe("known forward-negation blind spot (ugcportal-zo8n): pinned, not fixed", () => {
    // This function is deliberately backward-only (see its docstring): it
    // only looks at the clause *before* a "sensitive path(s)" mention for a
    // negation cue. A negation stated *after* the mention reads as genuine
    // today, which is the wrong answer for a human reader. The reviewer
    // checked all 77 cached v0.6.0 PR bodies plus this file's fixtures and
    // found zero real occurrences of this phrasing -- latent, not manifest
    // -- so these cases pin today's (known-wrong) behaviour rather than
    // silently going untested, per the docstring's own instruction not to
    // re-widen the backward check to cover this.
    it("reads a forward 'none found' as genuine (wrong, but pinned)", () => {
      expect(hasGenuineSensitivePathMention("Sensitive path check: none found.")).toBe(true);
    });

    it("reads a quoted CLI mention followed by a forward negation as genuine (wrong, but pinned)", () => {
      expect(hasGenuineSensitivePathMention('Ran `grep -rn "sensitive path" src/` and found zero real hits.')).toBe(true);
    });
  });
});

describe("outcomeOf (ugcportal-577s: the outcome heuristic)", () => {
  const mkAnalysis = (body, extras = []) => ({ number: 1, state: "MERGED", mergedAt: "2026-10-06T00:00:00Z", lastRoundBody: body, extras });

  it("K1: an auto-merge whose body reads 'no sensitive paths touched' classifies as auto-merged, not sensitive-path", () => {
    expect(outcomeOf({ close_reason: "" }, [mkAnalysis(pr173.round2Body)], 2)).toBe("auto-merged");
  });

  it("K2 (control): a genuine sensitive-path hold still classifies as human (sensitive path)", () => {
    // This is what distinguishes a real fix from simply deleting the
    // heuristic: a PR that really was held for a human for this reason
    // must still be labelled as such.
    expect(outcomeOf({ close_reason: "" }, [mkAnalysis(pr185.round1Body)], 1)).toBe("human (sensitive path)");
  });

  it("the shared PR #121 fixture (zero-finding approval, also mentions 'no sensitive paths touched') classifies as auto-merged", () => {
    expect(outcomeOf({ close_reason: "" }, [mkAnalysis(pr121.round1Body)], 1)).toBe("auto-merged");
  });

  it("Never: a body containing 'no sensitive paths' classifies as sensitive-path", () => {
    expect(outcomeOf({ close_reason: "" }, [mkAnalysis("Auto-approved: CI green, no sensitive paths touched, no blocking findings. Merging.")], 1)).not.toBe("human (sensitive path)");
  });

  it("mutating the committed #173 fixture to a genuine sensitive-path hold changes the classification", () => {
    // Fixture mutation control: swap the negated mention for a genuine one
    // in the same real body and confirm the label flips.
    const mutated = pr173.round2Body.replace("CI green, no sensitive paths touched, no blocking findings.", "Requires human approval and merge: this PR touches a sensitive path.");
    expect(outcomeOf({ close_reason: "" }, [mkAnalysis(mutated)], 2)).toBe("human (sensitive path)");
  });

  it("still reports 'no PR' and 'withdrawn' as before (unaffected by this fix)", () => {
    expect(outcomeOf({ close_reason: "" }, [], null)).toBe("no PR");
    expect(outcomeOf({ close_reason: "Withdrawn: premise was wrong." }, [mkAnalysis("x")], 1)).toBe("withdrawn");
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

describe("cost unit (ugcportal-cii0): one unit per bead, context-size never added to transcript cost", () => {
  // Fixture beads, one of each kind. The ITE bead also carries the old
  // fields (as ugcportal-6uc2 does after its re-tag), so a reader that mixed
  // units would have something to mix. Figures are 6uc2's and ei7's own.
  const ite = { id: "ugcportal-aaa1", title: "ITE bead", metadata: { cc_type: "feat", model: "sonnet", cost_ite_impl: 30018329, cost_calls_impl: 530, cost_ite_qa: 11063233, cost_calls_qa: 471, tokens_impl: 744413, tokens_qa: 1450244 } };
  const ctx = { id: "ugcportal-aaa2", title: "context-only bead", metadata: { cc_type: "feat", model: "sonnet", tokens_impl: 222680, tokens_qa: 521004 } };
  const summed = { id: "ugcportal-aaa3", title: "flagged summed bead", metadata: { cc_type: "fix", tokens_impl: 4410532, tokens_impl_convention: SUMMED_SNAPSHOTS, tokens_qa: 1000 } };
  // M1: a cost_ite_* of 0 is what a transcript sum over agents with no
  // transcript gives; it must fall back to the bead's context-size figures.
  const zeroIte = { id: "ugcportal-aaa4", title: "zero ITE bead", metadata: { cc_type: "fix", cost_ite_impl: 0, cost_calls_impl: 0, tokens_impl: 333111, tokens_qa: 222333 } };
  const beads = [ite, ctx, summed, zeroIte];
  const release = { version: "v9.9.9", ids: beads.map((b) => b.id), entries: new Map(beads.map((b) => [b.id, { title: b.title, type: "Features" }])) };
  const rows = buildRows(release, new Map(beads.map((b) => [b.id, b])), new Map());
  const row = (id) => rows.find((r) => r.id === id);
  const render = (rs) => renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rs]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-16", reviewer: "x", prCount: 0 });
  const report = render(rows);
  const tableLine = (short, text = report) => text.split("\n").find((l) => l.startsWith(`| \`${short}\` |`));

  it("costUnitOf reads cost_ite_* when present and ignores tokens_* on that bead", () => {
    expect(costUnitOf(ite.metadata)).toMatchObject({ unit: "ite", impl: 30018329, qa: 11063233, iteRejected: [] });
    expect(costUnitOf(ctx.metadata)).toMatchObject({ unit: "context", impl: 222680, qa: 521004, implSummedExcluded: false, implConventionUnknown: null });
    expect(costUnitOf({})).toMatchObject({ unit: null, impl: null, qa: null });
  });

  describe("M1: a cost_ite_* that is 0, non-numeric or absent is no ITE figure", () => {
    for (const [label, value] of [["0", 0], ['"0"', "0"], ['"abc"', "abc"], ["negative", -5], ["fractional", 1.5]]) {
      it(`cost_ite_impl=${label} falls back to the context-size unit and is listed`, () => {
        const c = costUnitOf({ cost_ite_impl: value, tokens_impl: 744413, tokens_qa: 500000 });
        expect(c).toMatchObject({ unit: "context", impl: 744413, qa: 500000 });
        expect(c.iteRejected).toEqual([`cost_ite_impl=${value}`]);
      });
    }
    it("an absent cost_ite_* is not rejected, it is simply not there", () => {
      expect(costUnitOf({ tokens_impl: 744413 })).toMatchObject({ unit: "context", impl: 744413, iteRejected: [] });
    });
    it("one valid side keeps the bead in ITE; the invalid side is listed and reads as no figure", () => {
      expect(costUnitOf({ cost_ite_impl: 100, cost_ite_qa: "abc", tokens_qa: 9 })).toMatchObject({ unit: "ite", impl: 100, qa: null, iteRejected: ["cost_ite_qa=abc"] });
    });
    it("the zero-ITE bead prints its context-size figures, not a 0, and Data gaps names it", () => {
      expect(tableLine("aaa4")).toContain(`| ${fmt(333111)} | ${fmt(222333)} | ${fmt(555444)} | ${CONTEXT_LABEL} |`);
      const cells = tableLine("aaa4").split(" | ");
      expect(cells.slice(4, 7)).toEqual([fmt(333111), fmt(222333), fmt(555444)]); // Impl, QA, Total: never a printed 0
      expect(report).toContain("`cost_ite_*` not a positive integer, not read as ITE (1): aaa4 (cost_ite_impl=0)");
    });
  });

  describe("L1: tokens_impl_convention is normalised; an unknown value is counted at neither value", () => {
    for (const v of ["summed_snapshots", "Summed-Snapshots", " summed-snapshots "]) {
      it(`${JSON.stringify(v)} reads as summed-snapshots`, () => {
        expect(costUnitOf({ tokens_impl: 4410532, tokens_impl_convention: v })).toMatchObject({ impl: null, implSummedExcluded: true, implConventionUnknown: null });
      });
    }
    it("LAST_PER_AGENT in any case counts the figure", () => {
      expect(costUnitOf({ tokens_impl: 180000, tokens_impl_convention: "Last_Per_Agent" })).toMatchObject({ impl: 180000, implSummedExcluded: false, implConventionUnknown: null });
    });
    it("an unknown value is not counted and is listed under Data gaps", () => {
      const odd = { id: "ugcportal-aaa5", metadata: { tokens_impl: 777000, tokens_impl_convention: "summed" } };
      const rs = buildRows({ version: "v9.9.9", ids: [odd.id], entries: new Map() }, new Map([[odd.id, odd]]), new Map());
      expect(rs[0]).toMatchObject({ impl: null, implConventionUnknown: "summed" });
      const out = render(rs);
      expect(out).not.toContain(fmt(777000));
      expect(out).toContain("`tokens_impl` not counted, unknown `tokens_impl_convention` (1): aaa5 (summed)");
    });
  });

  it("K3: a bead flagged summed-snapshots is not counted at its summed tokens_impl", () => {
    expect(costUnitOf(summed.metadata)).toMatchObject({ unit: "context", impl: null, qa: 1000, implSummedExcluded: true });
    expect(row("ugcportal-aaa3").impl).toBeNull();
    expect(report).not.toContain(fmt(4410532));
    expect(tableLine("aaa3")).toContain("excluded (summed snapshots)");
    expect(report).toContain(`\`tokens_impl_convention=${SUMMED_SNAPSHOTS}\` (1): aaa3`);
  });

  it("buildRows fills exactly one unit's pair per row", () => {
    expect(row("ugcportal-aaa1")).toMatchObject({ unit: "ite", impl: null, qa: null, iteImpl: 30018329, iteQa: 11063233, iteTotal: 41081562 });
    expect(row("ugcportal-aaa2")).toMatchObject({ unit: "context", impl: 222680, qa: 521004, iteImpl: null, iteQa: null, iteTotal: null });
    expect(row("ugcportal-aaa4")).toMatchObject({ unit: "context", impl: 333111, iteTotal: null });
  });

  it("aggregate sums each unit separately: context totals exclude the ITE bead's old fields, ITE totals exclude context beads", () => {
    const a = aggregate(rows);
    expect(a.implTotal).toBe(222680 + 333111);
    expect(a.qaTotal).toBe(521004 + 1000 + 222333);
    expect(a.grandTotal).toBe(222680 + 333111 + 521004 + 1000 + 222333);
    expect(a.iteGrandTotal).toBe(30018329 + 11063233);
    expect(a).toMatchObject({ nIte: 1, nContext: 3, nSummedExcluded: 1, nAny: 4 });
  });

  it("guardrail: the old-field bead is labelled context-size, not cost; the ITE bead is not", () => {
    expect(tableLine("aaa2")).toContain(`| ${CONTEXT_LABEL} |`);
    expect(tableLine("aaa1")).toContain("| ITE (cost) |");
    expect(tableLine("aaa1")).not.toContain(CONTEXT_LABEL);
    // The ITE bead's own tokens_* were never read, and no printed figure is a cross-unit sum.
    expect(report).not.toContain(fmt(744413));
    expect(report).not.toContain(fmt(1450244));
    const ctxGrand = 222680 + 333111 + 521004 + 1000 + 222333;
    expect(report).not.toContain(fmt(30018329 + 11063233 + ctxGrand));
    expect(report).toContain(`| Grand total (context-size, not cost) | ${fmt(ctxGrand)} |`);
    expect(report).toContain(`| ITE total, impl / qa / both (transcript cost) | ${fmt(30018329)} / ${fmt(11063233)} / ${fmt(41081562)} |`);
  });

  it("L3: Data gaps name the missing figure by the bead's unit", () => {
    const halfIte = { id: "ugcportal-aaa6", metadata: { cost_ite_impl: 5000, tokens_qa: 900 } };
    const out = render(buildRows({ version: "v9.9.9", ids: [halfIte.id], entries: new Map() }, new Map([[halfIte.id, halfIte]]), new Map()));
    expect(out).toContain("no QA figure in the bead's unit (1): aaa6 (ite)");
    expect(out).toContain("no impl figure in the bead's unit (0): —");
  });

  it("L4: review shares are per unit and print — rather than NaN% when a unit has no figures", () => {
    expect(pct(1, 0)).toBe("—");
    expect(pct(1, NaN)).toBe("—");
    expect(pct(1, 4)).toBe("25%");
    const out = render([row("ugcportal-aaa1")]);
    expect(out).not.toContain("NaN");
    expect(out).toContain("| Review share of context-size (qa / impl+qa, not cost) | — |");
    expect(out).toContain(`| Review share of transcript cost (ITE) | ${pct(11063233, 41081562)} |`);
  });

  it("L10: the tier table carries ITE beads in their own columns", () => {
    const sonnet = tierPerformance(rows).find((t) => t.tier === "sonnet");
    expect(sonnet).toMatchObject({ n: 2, nIte: 1, iteTotal: 41081562, implTotal: 222680, qaTotal: 521004 });
  });
});

describe("agentCostFromPasses (ugcportal-cii0): the recording rule CLAUDE.md's one-liner runs", () => {
  // agent-pass-cost.mjs --json rows: one per pass, `notified` is the agent's whole list.
  const pass = (agentId, n, ctxEnd, notified, ite = 10, calls = 1) => ({ agentId, pass: n, ctxEnd, notified, ite, calls });

  it("K1: a resumed agent notified 100k, 150k, 180k over three passes records 180k, not 430k", () => {
    const notified = [100000, 150000, 180000];
    const rows = [pass("a1", 1, 100100, notified), pass("a1", 2, 150100, notified), pass("a1", 3, 180100, notified)];
    const c = agentCostFromPasses(rows, ["a1"]);
    expect(c.ctx).toBe(180000);
    expect(c.ctx).not.toBe(notified.reduce((a, b) => a + b, 0));
    expect(c).toMatchObject({ complete: true, ite: 30, calls: 3, passes: 3, missing: [] });
  });

  it("L6: a final pass with no notification takes that pass's ctxEnd (ugcportal-bdh's shape)", () => {
    const notified = [84495, 129467, 150052, 158394];
    const rows = [1, 2, 3, 4].map((n) => pass("b", n, notified[n - 1], notified)).concat(pass("b", 5, 260896, notified));
    expect(agentCostFromPasses(rows, ["b"]).ctx).toBe(260896);
  });

  it("distinct agents are summed, each at its own last figure", () => {
    const rows = [pass("r1", 1, 231000, [231225]), pass("r2", 1, 289000, [289552])];
    expect(agentCostFromPasses(rows, ["r1", "r2"]).ctx).toBe(231225 + 289552);
  });

  it("M1: any agent without a transcript makes the result incomplete, with no ITE, calls or ctx to write", () => {
    const none = agentCostFromPasses([], ["gone1", "gone2"]);
    expect(none).toMatchObject({ complete: false, passes: 0, missing: ["gone1", "gone2"], ite: null, calls: null, ctx: null });
    const part = agentCostFromPasses([pass("a1", 1, 5, [5])], ["a1", "gone"]);
    expect(part).toMatchObject({ complete: false, missing: ["gone"], ite: null });
    expect(formatAgentCost(none)).toMatch(/^INCOMPLETE .*missing=gone1,gone2 uncovered=none -- write no cost_ite_\*/);
    expect(formatAgentCost(none)).not.toMatch(/ite=0/);
    expect(agentCostFromPasses([], [])).toMatchObject({ complete: false });
  });

  describe("M2: the list must cover what the bead already records", () => {
    const r2 = [pass("rev2", 1, 289000, [289552], 2511477, 101)];
    it("a pre-rule tokens_qa_r1 with no agent id plus the current reviewer is INCOMPLETE, so tokens_qa is not overwritten", () => {
      const meta = { tokens_qa: 231225, tokens_qa_r1: 231225 };
      const c = agentCostFromPasses(r2, ["rev2"], { meta, side: "qa" });
      expect(c).toMatchObject({ complete: false, missing: [], uncoveredFigures: ["r1"], ite: null, calls: null, ctx: null });
      const line = formatAgentCost(c);
      expect(line).toMatch(/^INCOMPLETE .*uncovered=r1 -- write no cost_ite_\*\/cost_calls_\* and unset any already there, do not overwrite tokens_\*/);
      expect(line).toContain('"rounds without agent ids: r1"');
      expect(line).not.toMatch(/ctx=/);
    });
    it("6uc2's shape: six pre-rule rounds and only the newest reviewer listed is INCOMPLETE, not ctx=262550", () => {
      const meta = { tokens_qa: 1450244, ...Object.fromEntries([231225, 289552, 261101, 179537, 226279, 262550].map((v, i) => [`tokens_qa_r${i + 1}`, v])) };
      const c = agentCostFromPasses([pass("rev6", 1, 262000, [262550])], ["rev6"], { meta, side: "qa" });
      expect(c).toMatchObject({ complete: false, ctx: null, uncoveredFigures: ["r1", "r2", "r3", "r4", "r5", "r6"] });
    });
    it("rounds whose agent ids are recorded and listed are covered", () => {
      const meta = { tokens_qa: 231225, tokens_qa_r1: 231225, tokens_qa_r1_agent: "rev1", cost_agents_qa: "rev1" };
      const rows = [pass("rev1", 1, 231000, [231225]), ...r2];
      expect(agentCostFromPasses(rows, ["rev1", "rev2"], { meta, side: "qa" })).toMatchObject({ complete: true, ctx: 231225 + 289552, uncoveredFigures: [] });
    });
    it("dropping an agent cost_agents_* already lists is INCOMPLETE", () => {
      expect(uncoveredByAgents({ cost_agents_qa: "rev1,rev2" }, "qa", ["rev2"])).toEqual(["dropped rev1"]);
      expect(formatAgentCost(agentCostFromPasses(r2, ["rev2"], { meta: { cost_agents_qa: "rev1,rev2" }, side: "qa" }))).toContain('"recorded agents dropped from the list: rev1"');
    });
    it("impl side: a tokens_impl recorded before cost_agents_impl is INCOMPLETE; one with a covering list is not", () => {
      expect(uncoveredByAgents({ tokens_impl: 437394 }, "impl", ["a1"])).toEqual(["tokens_impl recorded before cost_agents_impl"]);
      expect(uncoveredByAgents({ tokens_impl: 437394, cost_agents_impl: "a1" }, "impl", ["a1"])).toEqual([]);
      expect(uncoveredByAgents({}, "impl", ["a1"])).toEqual([]);
      expect(() => uncoveredByAgents({}, "both", ["a1"])).toThrow(/side/);
    });
    it("runAgentCost (the CLAUDE.md one-liner) reads the bead file and applies the check; every argument is required", () => {
      const dir = fs.mkdtempSync(`${os.tmpdir()}/cii0-`);
      const passes = `${dir}/passes.json`, bead = `${dir}/bead.json`;
      fs.writeFileSync(passes, JSON.stringify(r2));
      fs.writeFileSync(bead, JSON.stringify([{ id: "x", metadata: { tokens_qa: 231225, tokens_qa_r1: 231225 } }]));
      expect(runAgentCost(passes, "rev2", bead, "qa")).toMatch(/^INCOMPLETE .*uncovered=r1/);
      fs.writeFileSync(bead, JSON.stringify([{ id: "x", metadata: {} }]));
      expect(runAgentCost(passes, "rev2", bead, "qa")).toBe("ite=2511477 calls=101 ctx=289552 agents=1 passes=1 missing=none uncovered=none");
      expect(() => runAgentCost(passes, "rev2")).toThrow(/usage/);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("M3: an INCOMPLETE recording keeps the next recording INCOMPLETE", () => {
    // The reviewer's repro: real figures of two agents A and B, a pre-rule tokens_impl of 300000.
    const A = pass("A", 1, 262000, [262550], 1000, 10);
    const B = pass("B", 1, 226000, [226279], 2000, 20);
    const P = pass("P", 1, 299000, [300000], 3000, 30); // the pre-rule pass's agent, once a human has found it
    const quoted = (line, key) => new RegExp(`${key} to "([^"]*)"`).exec(line)?.[1];
    // What the INCOMPLETE template in CLAUDE.md / step 4a writes, applied to `meta`.
    const incompleteWrite = (meta, side, line, extra) => {
      const next = { ...meta, ...extra, [`cost_note_${side}`]: quoted(line, `cost_note_${side}`), [`cost_coverage_${side}`]: quoted(line, `cost_coverage_${side}`) };
      delete next[`cost_ite_${side}`];
      delete next[`cost_calls_${side}`];
      return next;
    };

    it("impl: pre-rule tokens_impl -> INCOMPLETE write -> the next pass with A,B is still INCOMPLETE, not ctx=488829", () => {
      const meta0 = { tokens_impl: 300000 };
      const first = formatAgentCost(agentCostFromPasses([A], ["A"], { meta: meta0, side: "impl" }));
      expect(first).toMatch(/^INCOMPLETE .*uncovered=tokens_impl recorded before cost_agents_impl /);
      expect(quoted(first, "cost_coverage_impl")).toBe("incomplete: tokens_impl recorded before cost_agents_impl");
      const meta1 = incompleteWrite(meta0, "impl", first, { tokens_impl: 300000 + 262550, cost_agents_impl: "A" });
      const second = agentCostFromPasses([A, B], ["A", "B"], { meta: meta1, side: "impl" });
      expect(second).toMatchObject({ complete: false, ctx: null, ite: null });
      expect(second.uncoveredFigures).toEqual(["marked incomplete by cost_coverage_impl"]);
      const line = formatAgentCost(second);
      expect(line).not.toMatch(/ctx=488829/);
      // The marker an earlier recording wrote is passed on unchanged, not rewritten or nested.
      expect(quoted(line, "cost_coverage_impl")).toBe("incomplete: tokens_impl recorded before cost_agents_impl");
      expect(quoted(line, "cost_note_impl")).toBe("marked incomplete by an earlier recording: cost_coverage_impl");
    });

    it("impl: the cost_note_* alone (no marker key) keeps it INCOMPLETE too", () => {
      const meta = { tokens_impl: 562550, cost_agents_impl: "A", cost_note_impl: "tokens_impl recorded before cost_agents_impl" };
      expect(uncoveredByAgents(meta, "impl", ["A", "B"])).toEqual(["marked incomplete by cost_note_impl"]);
      expect(uncoveredByAgents({ ...meta, cost_note_impl: "All transcripts present (1 agent)" }, "impl", ["A", "B"])).toEqual([]);
    });

    it("qa: pre-rule tokens_qa -> INCOMPLETE write with round agent ids -> the next round is still INCOMPLETE", () => {
      const meta0 = { tokens_qa: 400000 };
      const first = formatAgentCost(agentCostFromPasses([A], ["A"], { meta: meta0, side: "qa" }));
      expect(first).toMatch(/^INCOMPLETE .*uncovered=tokens_qa recorded before cost_agents_qa /);
      const meta1 = incompleteWrite(meta0, "qa", first, { tokens_qa: 400000 + 262550, tokens_qa_r1: 262550, tokens_qa_r1_agent: "A", cost_agents_qa: "A" });
      const second = agentCostFromPasses([A, B], ["A", "B"], { meta: { ...meta1, tokens_qa_r2: 226279, tokens_qa_r2_agent: "B" }, side: "qa" });
      expect(second).toMatchObject({ complete: false, ctx: null, uncoveredFigures: ["marked incomplete by cost_coverage_qa"] });
    });

    it("once a human has backfilled the pre-rule agent and removed the marker and note, the figure is complete", () => {
      const meta = { tokens_impl: 562550, cost_agents_impl: "P,A" };
      expect(agentCostFromPasses([P, A, B], ["P", "A", "B"], { meta, side: "impl" })).toMatchObject({ complete: true, ctx: 300000 + 262550 + 226279 });
    });
  });

  describe("M4: a cost_ite_* left on a side later marked incomplete is not read as ITE", () => {
    const stale = { cost_ite_qa: 11063233, cost_calls_qa: 471, tokens_qa: 1700000, tokens_qa_r7: 250000, tokens_impl: 744413 };
    it("the marker key alone, or the note alone, demotes it; the bead falls back to context size", () => {
      for (const mark of [{ cost_coverage_qa: "incomplete: missing: a0" }, { cost_note_qa: "missing: a0" }]) {
        const c = costUnitOf({ ...stale, ...mark });
        expect(c).toMatchObject({ unit: "context", impl: 744413, qa: 1700000 });
        expect(c.iteIncomplete).toEqual([`cost_ite_qa=11063233, ${Object.keys(mark)[0]}`]);
      }
    });
    it("a note that begins all transcripts present (6uc2's form) leaves the figure in ITE", () => {
      expect(costUnitOf({ ...stale, cost_note_qa: "all transcripts present (6 reviewer agents)" })).toMatchObject({ unit: "ite", qa: 11063233, iteIncomplete: [] });
    });
    it("the stale side prints no ITE figure and Data gaps names it", () => {
      const b = { id: "ugcportal-aaa7", metadata: { ...stale, cost_coverage_qa: "incomplete: missing: a0" } };
      const rs = buildRows({ version: "v9.9.9", ids: [b.id], entries: new Map() }, new Map([[b.id, b]]), new Map());
      expect(rs[0]).toMatchObject({ unit: "context", iteQa: null, qa: 1700000 });
      const out = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rs]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-16", reviewer: "x", prCount: 0 });
      expect(out).not.toContain("11,063,233");
      expect(out).toContain("`cost_ite_*` on a side whose coverage is marked incomplete, not read as ITE (1): aaa7 (cost_ite_qa=11063233, cost_coverage_qa)");
    });
  });

  describe("L13/L14: a round's agent id must be in the list, and the note says which way a round is uncovered", () => {
    it("a round whose agent id is recorded but in neither list is INCOMPLETE", () => {
      const meta = { tokens_qa: 231225, tokens_qa_r1: 231225, tokens_qa_r1_agent: "revX" };
      expect(uncoveredByAgents(meta, "qa", ["rev2"])).toEqual(["r1 unlisted"]);
      const c = agentCostFromPasses([pass("rev2", 1, 289000, [289552])], ["rev2"], { meta, side: "qa" });
      expect(c).toMatchObject({ complete: false, ctx: null });
      expect(formatAgentCost(c)).toContain('cost_note_qa to "rounds whose agents are not in the list: r1"');
    });
    it("rounds without ids and rounds with unlisted ids get two different messages", () => {
      const meta = { tokens_qa_r1: 1, tokens_qa_r2: 2, tokens_qa_r2_agent: "revX" };
      const line = formatAgentCost(agentCostFromPasses([pass("rev3", 1, 3, [3])], ["rev3"], { meta, side: "qa" }));
      expect(line).toContain('"rounds without agent ids: r1; rounds whose agents are not in the list: r2"');
      expect(line).not.toMatch(/pre-rule rounds/);
    });
  });

  it("a complete result prints every figure", () => {
    expect(formatAgentCost(agentCostFromPasses([pass("a1", 1, 5, [7], 12, 3)], ["a1"]))).toBe("ite=12 calls=3 ctx=7 agents=1 passes=1 missing=none uncovered=none");
  });
});

// ugcportal-md4c: the controls table, over a fixture transcript directory that
// does not depend on this machine's transcripts.
describe("controls table (ugcportal-md4c)", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const usage = (input) => ({ input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
  const turn = (id, ts, input, command) => ({ type: "assistant", timestamp: ts, message: { id, usage: usage(input), content: [{ type: "tool_use", id: `u-${id}`, input: { command } }] } });
  const result = (id, ts) => ({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: `u-${id}` }] } });
  const jsonl = (...es) => es.map((e) => JSON.stringify(e)).join("\n");
  /** 4 files: an orchestrator with 1 claims-audit + 1 dispatch-gate call, a subagent with 2 claims-audit calls, an empty session, and one more orchestrator file with nothing. */
  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "controls-test-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "s1.jsonl"), jsonl(
      turn("m1", "2026-10-10T10:00:00Z", 1000, "node scripts/claims-audit.mjs --pr 5"), result("m1", "2026-10-10T10:00:10Z"),
      turn("m2", "2026-10-10T10:01:00Z", 2000, "node scripts/check-bead-dispatch.mjs ugcportal-x"), result("m2", "2026-10-10T10:01:04Z"),
    ));
    fs.mkdirSync(path.join(dir, "s1", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "s1", "subagents", "agent-a1.jsonl"), jsonl(
      turn("n1", "2026-10-10T11:00:00Z", 3000, "node scripts/claims-audit.mjs --base origin/main"), result("n1", "2026-10-10T11:00:20Z"),
      turn("n2", "2026-10-10T11:05:00Z", 5000, "node /tmp/wt/scripts/claims-audit.mjs"), result("n2", "2026-10-10T11:05:30Z"),
    ));
    fs.writeFileSync(path.join(dir, "s2.jsonl"), jsonl(turn("k1", "2026-10-10T12:00:00Z", 7, "ls")));
    fs.writeFileSync(path.join(dir, "s3.jsonl"), jsonl(turn("k2", "2026-10-10T12:00:00Z", 7, "git status")));
    return dir;
  }
  const controls = [
    { name: "claims-audit", pattern: CONTROLS.find((c) => c.name === "claims-audit").pattern },
    { name: "dispatch-gate", pattern: CONTROLS.find((c) => c.name === "dispatch-gate").pattern },
    { name: "sweep-candidates", pattern: CONTROLS.find((c) => c.name === "sweep-candidates").pattern },
  ];
  const beads = [
    { id: "ugcportal-a1", metadata: { caught_by: "claims-audit" } },
    { id: "ugcportal-a2", metadata: { caught_by: "claims-audit, dispatch-gate", caught_by_note: "x" } },
    { id: "ugcportal-a3", metadata: { caught_by: "bogus-control" } },
    { id: "ugcportal-a4", metadata: { cc_type: "fix" } },
    { id: "ugcportal-a5" },
    { id: "ugcportal-a6", metadata: { caught_by: "claims-audit,claims-audit" } },
    { id: "ugcportal-a7", metadata: { caught_by: "Dispatch-Gate" } },
  ];

  it("K1: each control's runs, cost, wall clock, orchestrator share and examined/matched pair", () => {
    const dir = fixture();
    const [ca, dg] = controls.map((c) => priceControl(c, dir));
    expect(ca).toMatchObject({ runs: 3, ite: 9000, seconds: 60, orchRuns: 1, orchIte: 1000, examined: 4, matched: 2, lowerBound: false });
    expect(dg).toMatchObject({ runs: 1, ite: 2000, seconds: 4, orchRuns: 1, orchIte: 2000, examined: 4, matched: 1 });
    const out = controlsSection(beads, dir, null, controls);
    expect(out).toContain("| claims-audit | 3 | 9,000 | 60 s | 11% of cost (1 of 3 runs) | 3 | 4 examined / 2 matched |");
    expect(out).toContain("| dispatch-gate | 1 | 2,000 | 4 s | 100% of cost (1 of 1 runs) | 2 | 4 examined / 1 matched |");
  });

  it("the --before window ends the control's window", () => {
    const c = priceControl(controls[0], fixture(), "2026-10-10T10:30:00Z");
    expect(c).toMatchObject({ runs: 1, ite: 1000, matched: 1 });
  });

  it("K2: catches are counted per control from caught_by, several values allowed, unknown values reported", () => {
    const { counts, unrecognised } = catchesByControl(beads, controls);
    expect(counts.get("claims-audit")).toEqual(["ugcportal-a1", "ugcportal-a2", "ugcportal-a6"]); // a6 names it twice, counted once
    expect(counts.get("dispatch-gate")).toEqual(["ugcportal-a2", "ugcportal-a7"]); // a7 is written Dispatch-Gate
    expect(counts.get("sweep-candidates")).toEqual([]);
    expect(unrecognised).toEqual([{ id: "ugcportal-a3", value: "bogus-control" }]);
    const out = controlsSection(beads, fixture(), null, controls);
    expect(out).toContain("values not in the control list, not counted above: ugcportal-a3=bogus-control");
  });

  it("guardrail: a control whose pattern matches no call prints '0 of N files matched', not a bare 0", () => {
    const out = controlsSection(beads, fixture(), null, controls);
    const row = out.split("\n").find((l) => l.startsWith("| sweep-candidates"));
    expect(row).toBe("| sweep-candidates | 0 (pattern matched nothing) | — (nothing matched) | — | — | 0 | 0 of 4 files matched |");
  });

  it("a control with no command pattern shows catches only and says why", () => {
    const out = controlsSection([{ id: "ugcportal-p", metadata: { caught_by: "premise-audit" } }], fixture(), null, [{ name: "premise-audit", pattern: null }]);
    expect(out).toContain("| premise-audit | n/a | n/a | n/a | n/a | 1 | n/a (no command pattern; agents, not commands) |");
  });

  it("skipped input marks the row a lower bound and the table says so", () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, "s4.jsonl"), `${jsonl(turn("z1", "2026-10-10T13:00:00Z", 10, "node scripts/claims-audit.mjs"))}\n{"type":"assis`);
    const out = controlsSection([], dir, null, controls.slice(0, 1));
    expect(out).toMatch(/\| claims-audit \| >=4 \| >=9,010 \|/);
    expect(out).toContain("LOWER BOUND");
  });

  it("a matching call with missing usage is counted as bad usage and marks every control scanned over that input a lower bound", () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, "s5.jsonl"), jsonl({ type: "assistant", timestamp: "2026-10-10T13:00:00Z", message: { id: "b1", usage: {}, content: [{ type: "tool_use", id: "u-b1", input: { command: "node scripts/claims-audit.mjs" } }] } }));
    const c = priceControl(controls[0], dir);
    expect(c).toMatchObject({ lowerBound: true, runs: 4, ite: 9000, skipped: { badUsage: 1, unpriced: 1, unreadable: 0, malformedLines: 0 } });
    const out = controlsSection([], dir, null, controls);
    expect(out).toMatch(/\| claims-audit \| >=4 \| >=9,000 \| >=60 s \|/);
    expect(out).toContain("LOWER BOUND (input was skipped or unpriced; `>=`): claims-audit, dispatch-gate, sweep-candidates.");
    expect(out).toMatch(/\| dispatch-gate \| >=1 \| >=2,000 \|/);
  });

  it("a matching call whose turn has no message id is unpriced, and that alone marks the lower bound", () => {
    // scanTool counts an id-less entry as bad usage too; the unpriced branch is tested directly with an injected scan result
    const scan = () => ({ rows: [{ who: "a1", calls: 1, ite: 0, seconds: 0 }], filesExamined: 2, unreadable: 0, malformedLines: 0, badUsage: 0, unpriced: 1 });
    const c = priceControl(controls[0], "/unused", null, scan);
    expect(c.lowerBound).toBe(true);
    const out = renderControlsTable([c], catchesByControl([], controls));
    expect(out).toMatch(/\| claims-audit \| >=1 \| >=0 \| >=0 s \|/);
    expect(out).toContain("LOWER BOUND");
    const bad = priceControl(controls[0], "/unused", null, () => ({ rows: [{ who: "a1", calls: 1, ite: 5, seconds: 0 }], filesExamined: 2, unreadable: 0, malformedLines: 0, badUsage: 1, unpriced: 0 }));
    expect(bad.lowerBound).toBe(true);
  });

  it("a zero-match row with skipped input prints the skipped counts, not only a boolean", () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, "s6.jsonl"), `${jsonl(turn("z", "2026-10-10T13:00:00Z", 1, "ls"))}\n{"type":"assis`);
    const out = controlsSection([], dir, null, controls.slice(2));
    expect(out).toContain("0 of 5 files matched (0 files skipped unreadable, 1 malformed lines, 0 entries with bad usage, 0 calls unpriced)");
    expect(out).toContain("LOWER BOUND");
  });

  it("every control in the fixed list is named in renderControlsTable's input order", () => {
    const priced = CONTROLS.map((c) => ({ control: c, priced: false }));
    const out = renderControlsTable(priced, catchesByControl([]), { dir: "/d" });
    expect(CONTROLS.map((c) => c.name)).toEqual(["review-round-markers", "claims-audit", "sweep-candidates", "dispatch-gate", "premise-audit"]);
    for (const c of CONTROLS) expect(out).toContain(`| ${c.name} |`);
  });
});

describe("findings_rN keys (ugcportal-2jvh)", () => {
  const round = (n, medium, low, stated = true) => ({ n, at: "2026-10-16T00:00:00Z", medium, low, stated, findings: null, mediumLabels: [], lowLabels: [], addenda: 0 });
  const pr = (number, rounds) => ({
    number,
    title: "t",
    state: "MERGED",
    mergedAt: "2026-10-16T00:00:00Z",
    author: "bot",
    chain: { status: "exact", highest: rounds.length, ns: rounds.map((r) => r.n), stops: [], self: false },
    rounds,
    lastRoundBody: "",
    extras: [],
    inlineCount: 0,
    inlineLabelled: { medium: 0, low: 0, unstated: 0 },
    inlineBursts: 0,
  });
  // Prose says r1 = 1 medium + 1 low, r2 = clean. Keys (bead A) say r1 = 3 medium + 2 low.
  const keyed = { id: "ugcportal-kkk1", title: "keyed", metadata: { cc_type: "feat", prs: "gh-901", findings_r1: "f1:2 f2:0 f3:3 f4:0 med:3 low:2", findings_r2: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" } };
  const prosy = { id: "ugcportal-kkk2", title: "prose", metadata: { cc_type: "feat", prs: "gh-902" } };
  const analyses = () => new Map([[901, pr(901, [round(1, 1, 1), round(2, 0, 0)])], [902, pr(902, [round(1, 1, 1), round(2, 0, 0)])]]);
  const beads = [keyed, prosy];
  const release = { version: "v9.9.9", ids: beads.map((b) => b.id), entries: new Map(beads.map((b) => [b.id, { title: b.title, type: "Features" }])) };
  const rows = buildRows(release, new Map(beads.map((b) => [b.id, b])), analyses());
  const row = (id) => rows.find((r) => r.id === id);

  it("parseFindingsKey reads the six fields, the optional unstated, and rejects everything else as null", () => {
    expect(parseFindingsKey("f1:2 f2:0 f3:1 f4:0 med:1 low:2")).toEqual({ f1: 2, f2: 0, f3: 1, f4: 0, med: 1, low: 2, unstated: 0 });
    expect(parseFindingsKey("f1:0 f2:0 f3:0 f4:0 med:0 low:0 unstated:2")).toMatchObject({ unstated: 2 });
    for (const bad of [undefined, null, 3, "", "f1:2 f3:1 med:1 low:2", "f1:a f2:0 f3:0 f4:0 med:0 low:0", "f1:1 f2:0 f3:0 f4:0 med:0 low:0 extra:1"]) expect(parseFindingsKey(bad)).toBeNull();
  });

  it("a bead carrying keys reports per-round severity from the keys, not the prose parse", () => {
    const r = row("ugcportal-kkk1");
    expect(r.mediumsByRound).toBe("r1:3");
    expect(r.mediums).toBe(3);
    expect(r.lowsLabelled).toBe(2);
    expect(r.roundsFromKeys).toBe(2);
    expect(r.roundsFromProse).toBe(0);
  });

  it("a bead without keys keeps the prose figures and counts its rounds as fallbacks", () => {
    const r = row("ugcportal-kkk2");
    expect(r.mediumsByRound).toBe("r1:1");
    expect(r.mediums).toBe(1);
    expect(r.roundsFromKeys).toBe(0);
    expect(r.roundsFromProse).toBe(2);
  });

  it("the report says how many rounds came from keys and which beads fell back, so a zero is visible", () => {
    const report = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rows]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-16", reviewer: "x", prCount: 0 });
    expect(report).toContain("rounds whose severity came from `findings_rN` keys: 2; rounds that fell back to the prose parse: 2 -- kkk2 (2)");
    expect(report).toContain("| 2 / 2 |");
  });

  it("does not mutate the shared PR analysis (a PR can belong to two beads)", () => {
    const shared = analyses();
    buildRows(release, new Map(beads.map((b) => [b.id, b])), shared);
    expect(shared.get(901).rounds[0]).toMatchObject({ medium: 1, low: 1 });
    expect(shared.get(901).rounds[0].source).toBeUndefined();
  });

  it("a malformed key falls back to the prose figure and is listed, never read as zeros", () => {
    const out = withFindingsKeys(pr(1, [round(1, 2, 0)]), { findings_r1: "med:2" });
    expect(out.rounds[0]).toMatchObject({ source: "prose", fallbackReason: "malformed", medium: 2 });
  });

  it("guardrail: an all-zero key on a round whose verdict states findings is inconsistent, not clean", () => {
    const out = withFindingsKeys(pr(1, [round(1, 1, 2)]), { findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" });
    expect(out.rounds[0]).toMatchObject({ source: "prose", fallbackReason: "inconsistent", medium: 1, low: 2 });
    const b = { id: "ugcportal-kkk3", title: "x", metadata: { prs: "gh-903", findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" } };
    const rel = { version: "v9.9.9", ids: [b.id], entries: new Map([[b.id, { title: "x", type: "Features" }]]) };
    const rs = buildRows(rel, new Map([[b.id, b]]), new Map([[903, pr(903, [round(1, 1, 2)])]]));
    expect(rs[0].keyFallbacks).toEqual(["r1 inconsistent"]);
    const report = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rs]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-16", reviewer: "x", prCount: 0 });
    expect(report).toContain("present but not used, prose kept (1): kkk3 (r1 inconsistent)");
  });

  it("an all-zero key on a clean round is trusted", () => {
    const out = withFindingsKeys(pr(1, [round(1, 0, 0)]), { findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" });
    expect(out.rounds[0]).toMatchObject({ source: "keys", medium: 0, low: 0, stated: true });
  });

  it("M1: an all-zero key on a round whose prose states a bare findings count (no severity words) is inconsistent", () => {
    const unlabelled = { ...round(1, 0, 0, false), findings: 3 };
    const out = withFindingsKeys(pr(1, [unlabelled]), { findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" });
    expect(out.rounds[0]).toMatchObject({ source: "prose", fallbackReason: "inconsistent", stated: false });
  });

  it("M2: a key with unstated:1 counts that finding as medium-or-above in the row and exposes it", () => {
    const b = { id: "ugcportal-kkk5", title: "x", metadata: { prs: "gh-905", findings_r1: "f1:1 f2:0 f3:0 f4:0 med:0 low:0 unstated:1" } };
    const rel = { version: "v9.9.9", ids: [b.id], entries: new Map([[b.id, { title: "x", type: "Features" }]]) };
    const rs = buildRows(rel, new Map([[b.id, b]]), new Map([[905, pr(905, [round(1, 0, 0)])]]));
    expect(rs[0]).toMatchObject({ mediums: 1, mediumsByRound: "r1:1", unstatedFindings: 1, roundsFromKeys: 1 });
    const report = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rs]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-16", reviewer: "x", prCount: 0 });
    expect(report).toContain("counted as medium-or-above: kkk5 (1)");
  });

  it("M3: two beads on one PR, one keyed (med:3) and one not, give the same mediums in either order", () => {
    const a = { id: "ugcportal-kkk6", title: "a", metadata: { prs: "gh-906", findings_r1: "f1:0 f2:0 f3:3 f4:0 med:3 low:0" } };
    const c = { id: "ugcportal-kkk7", title: "c", metadata: { prs: "gh-906" } };
    const mk = (ids) => {
      const rel = { version: "v9.9.9", ids, entries: new Map(ids.map((i) => [i, { title: "x", type: "Features" }])) };
      return aggregate(buildRows(rel, new Map([[a.id, a], [c.id, c]]), new Map([[906, pr(906, [round(1, 1, 0)])]]))).mediums;
    };
    expect(mk([a.id, c.id])).toBe(3);
    expect(mk([c.id, a.id])).toBe(3);
  });

  it("L3: keys discarded for a second PR (multi-pr) and keys for a round the chain lacks are listed as not used", () => {
    const b = { id: "ugcportal-kkk8", title: "x", metadata: { prs: "gh-901,gh-902", findings_r1: "f1:0 f2:0 f3:0 f4:0 med:9 low:0" } };
    const c = { id: "ugcportal-kkk9", title: "x", metadata: { prs: "gh-901", findings_r3: "f1:0 f2:0 f3:0 f4:0 med:1 low:0" } };
    const rel = { version: "v9.9.9", ids: [b.id, c.id], entries: new Map([[b.id, { title: "x", type: "Features" }], [c.id, { title: "x", type: "Features" }]]) };
    const rs = buildRows(rel, new Map([[b.id, b], [c.id, c]]), analyses());
    expect(rs[0].keyFallbacks).toEqual(["findings_r1 multi-pr"]); // L4: one key, one entry, not once per PR
    expect(rs[1].keyFallbacks).toEqual(["r3 no-such-round"]);
  });

  it("L4: a PR-specific findings_pr<n>_r<N> key is read on a bead with two reviewed PRs", () => {
    const b = { id: "ugcportal-kkk10", title: "x", metadata: { prs: "gh-901,gh-902", findings_pr901_r1: "f1:1 f2:0 f3:0 f4:0 med:4 low:0", findings_pr902_r1: "f1:0 f2:1 f3:0 f4:0 med:1 low:0" } };
    const rel = { version: "v9.9.9", ids: [b.id], entries: new Map([[b.id, { title: "x", type: "Features" }]]) };
    const rs = buildRows(rel, new Map([[b.id, b]]), analyses());
    expect(rs[0]).toMatchObject({ mediums: 5, mediumsByRound: "r1:4 r1:1", roundsFromKeys: 2 });
  });

  it("L5: row carries keyed severity and family counts per round for the --json export", () => {
    const r = row("ugcportal-kkk1");
    expect(r.families).toEqual({ f1: 2, f2: 0, f3: 3, f4: 0 });
    expect(r.roundDetail[0]).toMatchObject({ pr: 901, n: 1, source: "keys", medium: 3, low: 2, families: { f1: 2, f2: 0, f3: 3, f4: 0 } });
  });

  it("N1: a clean round that mentions earlier rounds' findings reads from its all-zero key, not as inconsistent", () => {
    const clean = classifySeverity("No findings this round (chain exact); both round-2 findings are fixed, and the sweep is clean.");
    expect(clean).toMatchObject({ findings: null, stated: true, clean: true });
    expect(classifySeverity("Both round 2 findings are fixed.").findings).toBeNull();
    const out = withFindingsKeys(pr(1, [{ ...round(1, 0, 0), ...clean }]), { findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" });
    expect(out.rounds[0]).toMatchObject({ source: "keys", stated: true, medium: 0, low: 0 });
    expect(out.rounds[0].fallbackReason).toBeUndefined();
  });

  it("N1: an explicit clean statement outranks a bare findings count, but not labelled severities, and a real bare count still blocks", () => {
    const zero = { findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" };
    const bareClean = { ...round(1, 0, 0), findings: 2, clean: true };
    expect(withFindingsKeys(pr(1, [bareClean]), zero).rounds[0].source).toBe("keys");
    const labelled = { ...round(1, 1, 0), findings: 2, clean: true };
    expect(withFindingsKeys(pr(1, [labelled]), zero).rounds[0].fallbackReason).toBe("inconsistent");
    const real = classifySeverity("Blocking: three findings.");
    expect(real.findings).toBe(3);
    expect(withFindingsKeys(pr(1, [{ ...round(1, 0, 0), ...real }]), zero).rounds[0].fallbackReason).toBe("inconsistent");
  });

  it("P1: a blocking verdict with a 'Verified, no finding:' sub-heading is never clean, so an all-zero key on it is inconsistent (#277 r1, #258 r1 verbatim)", () => {
    const zero = { findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" };
    for (const [fx, count] of [[pr277, 4], [pr258, 1]]) {
      const c = classifySeverity(fx.round1Body);
      expect(c).toMatchObject({ findings: count, clean: false });
      // the sub-heading is really in the body, so the fixture exercises the shape
      expect(fx.round1Body).toMatch(/Verified, no finding/);
      const out = withFindingsKeys(pr(fx.pr.number, [{ ...round(1, 0, 0), ...c }]), zero);
      expect(out.rounds[0]).toMatchObject({ source: "prose", fallbackReason: "inconsistent" });
    }
  });

  it("P1: clean is read from the verdict line: genuine first-line approvals are clean, 'Blocking:' never is, a later sentence never is", () => {
    expect(classifySeverity("Auto-approved (review round 1, chain approx): CI green, no sensitive paths touched, no blocking findings.\n\nReviewed inline.").clean).toBe(true);
    expect(classifySeverity("Zero findings.\n\nFigures re-derived.").clean).toBe(true);
    expect(classifySeverity("Review round 2. Blocking: no findings left, but CI is red.").clean).toBe(false);
    expect(classifySeverity("Review round 2. Blocking: 2 findings.\n\nNo findings in family 3.").clean).toBe(false);
    expect(classifySeverity("Review round 2 (chain exact).\n\nNo findings this round.").clean).toBe(false);
  });

  it("M1: a blocking verdict line that states the band rule is never clean, so an all-zero key on it is inconsistent (#157 r3 severity word removed, #207 r2, #209 r4)", () => {
    const zero = { findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" };
    const lines = [
      ["#157 r3", "Review round 3 (chain `approx` \u2014 self-asserted; head `2f0ca8a`, unchanged since round 2). **Not merged: 1 finding, CONFIRMED.** Strict band (rounds 1-3, and an `approx` chain runs these rules at every round), so zero findings is the only merging state.", 1],
      ["#207 r2", "Review round 2 (chain approx -- reviewer and PR author are the same account, step 4b). CI green, no sensitive paths, mergeable against main. Per the severity gate, an approx chain always runs the strict rounds-1-3 rule regardless of round number: any finding blocks, merges only with zero findings.", null],
      ["#209 r4", "Review round 4 (chain **approx** \u2014 self-asserted: reviewer and PR author are both `eiriksf-capgemini`; per step 4b this never reaches the lenient round-4/5 band, so any finding at any severity blocks, and merge requires zero findings). Two findings remain.", null],
    ];
    for (const [name, line, count] of lines) {
      const c = classifySeverity(line);
      expect(c.clean, name).toBe(false);
      if (count !== null) expect(c.findings, name).toBe(count);
      const out = withFindingsKeys(pr(1, [{ ...round(1, 0, 0), ...c, findings: count ?? 2 }]), zero);
      expect(out.rounds[0], name).toMatchObject({ source: "prose", fallbackReason: "inconsistent" });
    }
  });

  it("M1: each part of the approval shape is needed: opening word, no findings count, none of the blocking words", () => {
    // not approval-shaped (no blocking word, no count): only the opening-word check rejects it
    expect(classifySeverity("Review round 2 (chain approx). Merge requires zero findings.").clean).toBe(false);
    // approval-shaped opening, but states a count and no blocking word
    expect(classifySeverity("Clean on family 3, but 2 findings remain; zero findings is the only merging state.").clean).toBe(false);
    // approval-shaped, no count, one blocking word each
    for (const w of ["Blocking: nothing else", "Not merged", "any finding blocks", "left for a human"]) {
      expect(classifySeverity(`No findings in the diff, ${w}.`).clean, w).toBe(false);
    }
    // the genuine approvals (#156 r4, #186 r1, #202 r1) stay clean
    for (const l of [
      "Auto-approved (review round 4, chain `approx`, head `f560cf9`): CI green, no sensitive paths touched, **no findings**. Merging.",
      "Auto-approved (review round 1, chain approx \u2014 self-asserted, reviewer is the PR's author; head ea9ee12): CI green, no sensitive paths touched, no blocking findings.",
      "Auto-approved (review round 1, chain approx): CI green, no sensitive paths touched, no blocking findings.",
    ]) expect(classifySeverity(l).clean, l).toBe(true);
  });

  it("L2: a PR shared by a keyed bead and a prose sibling counts its rounds once, as keyed, and names the sibling separately", () => {
    const a = { id: "ugcportal-kkk16", title: "a", metadata: { prs: "gh-907", findings_r1: "f1:0 f2:0 f3:3 f4:0 med:3 low:0" } };
    const sib = { id: "ugcportal-kkk17", title: "s", metadata: { prs: "gh-907" } };
    const rel = { version: "v9.9.9", ids: [a.id, sib.id], entries: new Map([a, sib].map((b) => [b.id, { title: "x", type: "Features" }])) };
    const rows2 = buildRows(rel, new Map([[a.id, a], [sib.id, sib]]), new Map([[907, pr(907, [round(1, 1, 0)])]]));
    expect(aggregate(rows2)).toMatchObject({ roundsFromKeys: 1, roundsFromProse: 0, mediums: 3 });
    expect(aggregate([...rows2].reverse())).toMatchObject({ roundsFromKeys: 1, roundsFromProse: 0 });
    const split = roundsSplit(rows2);
    expect(split.fellBack).toEqual([]);
    expect(split.siblings).toEqual(["kkk17 (gh-907)"]);
    const report = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rows2]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-16", reviewer: "x", prCount: 0 });
    expect(report).toContain("rounds whose severity came from `findings_rN` keys: 1; rounds that fell back to the prose parse: 0");
    expect(report).toContain("sibling bead, PR counted once");
    expect(report).toContain("kkk17 (gh-907)");
    expect(report).not.toContain("fell back to the prose parse: 1");
  });

  it("L1: keyedConflicts reports a disagreement in the smaller-first order, and never reports a keyed bead beside a prose sibling", () => {
    const keyedRow = (id, m) => ({ id, prMediums: { 906: m }, prKeyed: { 906: true } });
    expect(keyedConflicts([keyedRow("ugcportal-a", 0), keyedRow("ugcportal-c", 3)])).toEqual(["gh-906 (a 0 vs c 3; larger kept)"]);
    expect(keyedConflicts([keyedRow("ugcportal-a", 3), keyedRow("ugcportal-c", 0)])).toEqual(["gh-906 (a 3 vs c 0; larger kept)"]);
    const prose = { id: "ugcportal-s", prMediums: { 906: 1 }, prKeyed: { 906: false } };
    expect(keyedConflicts([keyedRow("ugcportal-a", 3), prose])).toEqual([]);
    expect(keyedConflicts([prose, keyedRow("ugcportal-a", 3)])).toEqual([]);
  });

  it("N2: findings_unstamped is counted and listed under Data gaps, and is never matched to a marker", () => {
    const b = { id: "ugcportal-kkk11", title: "x", metadata: { prs: "gh-901", findings_unstamped: "f1:0 f2:0 f3:0 f4:0 med:3 low:0,f1:0 f2:0 f3:0 f4:0 med:1 low:0", findings_r2: "f1:0 f2:0 f3:0 f4:0 med:0 low:0" } };
    const rel = { version: "v9.9.9", ids: [b.id], entries: new Map([[b.id, { title: "x", type: "Features" }]]) };
    const rs = buildRows(rel, new Map([[b.id, b]]), analyses());
    expect(rs[0]).toMatchObject({ unstampedPasses: 2, roundsFromKeys: 1, mediums: 1, keyFallbacks: [] });
    const report = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rs]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-16", reviewer: "x", prCount: 0 });
    expect(report).toContain("unstamped review passes (`findings_unstamped`, not matched to a marker): kkk11 (2)");
  });

  it("L1: two keyed beads on one PR that disagree are listed as keyed-conflict, and the larger figure is kept in either order", () => {
    const a = { id: "ugcportal-kkk12", title: "a", metadata: { prs: "gh-906", findings_r1: "f1:0 f2:0 f3:3 f4:0 med:3 low:0" } };
    const c = { id: "ugcportal-kkk13", title: "c", metadata: { prs: "gh-906", findings_r1: "f1:0 f2:0 f3:0 f4:0 med:0 low:1" } };
    const d = { id: "ugcportal-kkk14", title: "d", metadata: { prs: "gh-906", findings_r1: "f1:0 f2:0 f3:3 f4:0 med:3 low:0" } };
    const mk = (ids) => {
      const rel = { version: "v9.9.9", ids, entries: new Map(ids.map((i) => [i, { title: "x", type: "Features" }])) };
      return buildRows(rel, new Map([[a.id, a], [c.id, c], [d.id, d]]), new Map([[906, pr(906, [round(1, 1, 0)])]]));
    };
    expect(aggregate(mk([a.id, c.id])).mediums).toBe(3);
    expect(aggregate(mk([c.id, a.id])).mediums).toBe(3);
    expect(keyedConflicts(mk([a.id, c.id]))).toEqual(["gh-906 (kkk12 3 vs kkk13 0; larger kept)"]);
    expect(keyedConflicts(mk([a.id, d.id]))).toEqual([]); // agreeing keys are not a conflict
    const report = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", mk([a.id, c.id])]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-16", reviewer: "x", prCount: 0 });
    expect(report).toContain("keyed-conflict");
    expect(report).toContain("gh-906 (kkk12 3 vs kkk13 0; larger kept)");
  });

  it("L2: a findings_pr<n>_r<N> key for a PR not in prs, or a round the PR lacks, is listed as no-such-round", () => {
    const b = { id: "ugcportal-kkk15", title: "x", metadata: { prs: "gh-901", findings_pr999_r1: "f1:0 f2:0 f3:0 f4:0 med:1 low:0", findings_pr901_r7: "f1:0 f2:0 f3:0 f4:0 med:1 low:0", findings_pr901_r1: "f1:0 f2:0 f3:0 f4:0 med:2 low:0" } };
    expect(orphanFindingsKeys(b.metadata, [pr(901, [round(1, 0, 0)])])).toEqual(["pr901 r7", "pr999 r1"]);
    const rel = { version: "v9.9.9", ids: [b.id], entries: new Map([[b.id, { title: "x", type: "Features" }]]) };
    expect(buildRows(rel, new Map([[b.id, b]]), analyses())[0].keyFallbacks).toEqual(["pr901 r7 no-such-round", "pr999 r1 no-such-round"]);
  });

  it("a bead with two PRs that both have rounds cannot be keyed by round number, so it stays on prose", () => {
    const b = { id: "ugcportal-kkk4", title: "x", metadata: { prs: "gh-901,gh-902", findings_r1: "f1:0 f2:0 f3:0 f4:0 med:9 low:0" } };
    const rel = { version: "v9.9.9", ids: [b.id], entries: new Map([[b.id, { title: "x", type: "Features" }]]) };
    const rs = buildRows(rel, new Map([[b.id, b]]), analyses());
    expect(rs[0].roundsFromKeys).toBe(0);
    expect(rs[0].mediums).toBe(2);
  });
});

describe("tokens_qa_convention (ugcportal-zu0a): a flagged tokens_qa is not counted at face value", () => {
  const plain = { id: "ugcportal-qaa1", title: "unflagged qa bead", metadata: { cc_type: "fix", tokens_impl: 100000, tokens_qa: 250000 } };
  const lastPer = { id: "ugcportal-qaa2", title: "last-per-agent qa bead", metadata: { cc_type: "fix", tokens_impl: 100000, tokens_qa: 249220, tokens_qa_convention: "Last_Per_Agent" } };
  const undet = { id: "ugcportal-qaa3", title: "undeterminable qa bead", metadata: { cc_type: "fix", tokens_impl: 100000, tokens_qa: 663731, tokens_qa_convention: "undeterminable" } };
  const summedQa = { id: "ugcportal-qaa4", title: "summed qa bead", metadata: { cc_type: "fix", tokens_impl: 100000, tokens_qa: 877777, tokens_qa_convention: " Summed_Snapshots " } };
  const iteBead = { id: "ugcportal-qaa5", title: "ITE bead keeps its ITE qa", metadata: { cc_type: "fix", cost_ite_impl: 5000000, cost_ite_qa: 3000000, tokens_qa: 999999, tokens_qa_convention: "undeterminable" } };
  // Notes call tokens_qa an estimate, and tokens_qa is then excluded: the total is tokens_impl alone, exact.
  const undetEst = { id: "ugcportal-qaa6", title: "excluded estimated qa", notes: "tokens_qa is a rough estimate.", metadata: { cc_type: "fix", tokens_impl: 105359, tokens_qa: 470587, tokens_qa_convention: "undeterminable" } };
  const beads = [plain, lastPer, undet, summedQa, iteBead, undetEst];
  const release = { version: "v9.9.9", ids: beads.map((b) => b.id), entries: new Map(beads.map((b) => [b.id, { title: b.title, type: "Fixes" }])) };
  const rows = buildRows(release, new Map(beads.map((b) => [b.id, b])), new Map());
  const row = (id) => rows.find((r) => r.id === id);
  const report = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rows]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-17", reviewer: "x", prCount: 0 });
  const tableLine = (short) => report.split("\n").find((l) => l.startsWith(`| \`${short}\` |`));

  it("costUnitOf: absent and last-per-agent (any case) count; undeterminable, summed-snapshots and unknown values do not", () => {
    expect(costUnitOf(plain.metadata)).toMatchObject({ unit: "context", qa: 250000, qaConventionExcluded: null });
    expect(costUnitOf(lastPer.metadata)).toMatchObject({ qa: 249220, qaConventionExcluded: null });
    expect(costUnitOf(undet.metadata)).toMatchObject({ unit: "context", impl: 100000, qa: null, qaConventionExcluded: "undeterminable" });
    expect(costUnitOf(summedQa.metadata)).toMatchObject({ qa: null, qaConventionExcluded: "Summed_Snapshots" });
    expect(costUnitOf({ tokens_qa: 5, tokens_qa_convention: "mixed" })).toMatchObject({ qa: null, qaConventionExcluded: "mixed" });
  });

  it("a blank flag is no flag: the figure counts and nothing is listed", () => {
    for (const v of ["", "   "]) expect(costUnitOf({ tokens_qa: 5, tokens_qa_convention: v })).toMatchObject({ qa: 5, qaConventionExcluded: null });
  });

  it("a flag on a bead with no tokens_qa excludes nothing and is not listed", () => {
    expect(costUnitOf({ tokens_impl: 7, tokens_qa_convention: "undeterminable" })).toMatchObject({ qa: null, qaConventionExcluded: null });
  });

  it("an ITE bead is read in ITE and its tokens_qa flag is irrelevant", () => {
    expect(row("ugcportal-qaa5")).toMatchObject({ unit: "ite", iteQa: 3000000, qaConventionExcluded: null });
  });

  it("the flagged figures appear nowhere in the report, are marked excluded, and are named under Data gaps", () => {
    expect(report).not.toContain(fmt(663731));
    expect(report).not.toContain(fmt(877777));
    expect(report).not.toContain(fmt(999999));
    expect(tableLine("qaa3")).toContain("excluded (undeterminable)");
    expect(report).toContain("`tokens_qa` not counted, flagged `tokens_qa_convention` (3): qaa3 (undeterminable); qaa4 (Summed_Snapshots); qaa6 (undeterminable)");
    // The flagged beads are not also listed as "no QA figure".
    expect(report).toMatch(/no QA figure in the bead's unit \(0\): —/);
  });

  it("an excluded tokens_qa the notes call an estimate does not mark the total, which is tokens_impl alone", () => {
    expect(row("ugcportal-qaa6")).toMatchObject({ qa: null, qaEstimated: true, implEstimated: false, total: 105359 });
    const cells = tableLine("qaa6").split("|").map((c) => c.trim());
    expect(cells).toContain("excluded (undeterminable)");
    expect(cells).toContain(fmt(105359));
    expect(cells).not.toContain(`~${fmt(105359)}`);
  });

  it("the unflagged beads keep their figure and the QA total sums only them", () => {
    expect(row("ugcportal-qaa1").qa).toBe(250000);
    expect(row("ugcportal-qaa2").qa).toBe(249220);
    expect(aggregate(rows).qaTotal).toBe(250000 + 249220);
  });
});

describe("an excluded tokens_impl the notes call an estimate does not mark the total (ugcportal-zu0a)", () => {
  // tokens_impl is flagged summed-snapshots, so it is excluded; the notes call it an estimate.
  // tokens_qa is counted and exact: the total is tokens_qa alone and carries no tilde.
  const bead = { id: "ugcportal-impl1", title: "excluded estimated impl", notes: "tokens_impl is a rough estimate.", metadata: { cc_type: "fix", tokens_impl: 480000, tokens_impl_convention: "summed-snapshots", tokens_qa: 120000 } };
  const release = { version: "v9.9.9", ids: [bead.id], entries: new Map([[bead.id, { title: bead.title, type: "Fixes" }]]) };
  const rows = buildRows(release, new Map([[bead.id, bead]]), new Map());
  const report = renderReport({ releases: ["v9.9.9"], rowsByRelease: new Map([["v9.9.9", rows]]), membershipChecks: [], unmerged: [], generatedAt: "2026-10-17", reviewer: "x", prCount: 0 });

  it("the total is tokens_qa alone and no cell of the bead's row carries a tilde on it", () => {
    expect(rows[0]).toMatchObject({ impl: null, implEstimated: true, qa: 120000, qaEstimated: false, total: 120000 });
    const cells = report.split("\n").find((l) => l.startsWith("| `impl1` |")).split("|").map((c) => c.trim());
    expect(cells).toContain(fmt(120000));
    expect(cells).not.toContain(`~${fmt(120000)}`);
  });
});
