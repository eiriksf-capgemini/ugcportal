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
 */
import fs from "node:fs";
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
  hasGenuineSensitivePathMention,
  median,
  outcomeOf,
  parseChangelogMembership,
  parsePrs,
  parseRoundsFromCloseReason,
  readCodeSpans,
  readRoundChain,
  spliceGenerated,
  tailRounds,
} from "./release-cost-report.mjs";

const loadFixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const pr121 = loadFixture("pr-121-round1.json");
const pr173 = loadFixture("pr-173-round2.json");
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
