#!/usr/bin/env node
/**
 * Release cost report: what each bead in a release cost to build and to
 * review, how many review rounds its PRs took, which severities the
 * reviewer stated per round, and how the planned model tier performed
 * (ugcportal-apsq).
 *
 * Reproduces the tables in docs/process/release-cost-v0.4.0-vs-v0.5.0.md
 * from four sources, none of them this file's own memory:
 *
 *   1. `bd list --all --json` (or --beads <file> for an offline re-run) --
 *      tokens_impl / tokens_qa / model / model_effort / cc_type / cc_scope /
 *      prs metadata plus notes and close_reason. A bead the list omits
 *      (bd list --all skipped the `gate`-typed ugcportal-alg on 2026-10-05)
 *      is fetched with `bd show <id> --json` as a fallback.
 *   2. CHANGELOG.md -- release MEMBERSHIP. The `metadata.release` field is
 *      set on only a minority of beads, so it is deliberately not used for
 *      membership; a release is the set of bead ids listed under its `## vX`
 *      heading in CHANGELOG.md, which is what cut-release wrote from the
 *      closed beads at the time of the cut.
 *   3. `git log <from>..<to>` between the release tags, as a CROSS-CHECK of
 *      membership: bead ids and PR numbers in the commit subjects that are
 *      not in the CHANGELOG section (and vice versa) are reported, not
 *      silently reconciled. A tag pair with no merge base (v0.3.0..v0.4.0 on
 *      2026-10-05: v0.4.0's ancestry is a six-commit re-rooted history) is
 *      reported and the PR merge-date window is used instead.
 *   4. `gh` -- for every PR in a bead's `prs`: `gh pr view --json
 *      state,mergedAt,author` (K3: every listed PR must actually be MERGED,
 *      otherwise the script exits non-zero), and `gh api --paginate` over
 *      issue comments and review bodies for the round markers, reusing the
 *      pr-review-merge step 4b rules verbatim: the marker must be the FIRST
 *      line of the body, the match is anchored (`^...$`), the trailing CR is
 *      stripped before matching, aggregation happens once downstream of
 *      pagination (never inside a per-page filter), and the chain's
 *      exact / approx / broken status is derived from author, edit,
 *      duplicate, contiguity and ceiling checks.
 *
 * Severity per round is read from the reviewer's own words in each round's
 * verdict comment -- `MEDIUM`, `**medium**`, `[Medium]`, `LOW:` and so on --
 * never inferred from the finding's content. A verdict that states no
 * severity is reported as "unstated", not guessed. Marker-less PRs (every
 * v0.4.0 PR before the stopping rule, gh-43) get their round count from the
 * bead's own close reason ("seven review passes") and their findings from
 * the inline review comments, most of which carry no severity label; those
 * rows say so.
 *
 * Estimated figures: a bead whose notes or close reason say a figure is an
 * estimate (the words "estimate", "rough" or "approx" in a sentence that
 * also names tokens / a figure / a cost) gets a `~` in front of that figure.
 * The sentence decides WHICH figure: one naming tokens_qa marks the QA
 * figure, one naming tokens_impl marks the build figure, an ambiguous one
 * marks both. Plain "chain approx" sentences do not mark anything -- they
 * are about the round chain, not a cost.
 *
 * Per-round review cost is NOT recorded anywhere: tokens_qa accumulates
 * across rounds on the bead. The per-round column is tokens_qa / rounds, a
 * crude mean, and is labelled as such.
 *
 * Usage:
 *   node scripts/release-cost-report.mjs [options]
 *     --releases v0.4.0,v0.5.0   releases to compare (CHANGELOG headings)
 *     --changelog <path>         default CHANGELOG.md
 *     --beads <file.json>        use a saved `bd list --all --json` instead of running bd
 *     --bd-cwd <dir>             where to run bd (default: cwd)
 *     --cache <dir>              cache gh responses as <dir>/<pr>.json (read if present)
 *     --offline                  never call gh/git/bd; fail if a cache entry is missing
 *     --write <report.md>        replace the block between the generated markers in that file
 *     --json <out.json>          also dump the computed dataset
 *     --allow-unmerged           report instead of exit 2 on an unmerged `prs` entry
 *
 * Self-test: npm test -- runs scripts/release-cost-report.test.mjs (vitest)
 * against the pure functions exported below.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";

// --- constants -------------------------------------------------------------

export const GENERATED_START = "<!-- release-cost-report:generated:start -->";
export const GENERATED_END = "<!-- release-cost-report:generated:end -->";

/** pr-review-merge step 4b: the marker is the whole first line, anchored. */
export const ROUND_MARKER_RE = /^<!-- ugcportal-review-round: (?<r>[0-9]+)(?<a> approx)? -->$/;
export const CHAIN_RESET_RE = /^<!-- ugcportal-review-chain-reset: (?<r>[0-9]+) -->$/;
export const STOP_MARKER_RE = /^<!-- ugcportal-review-stop: (?<reason>[a-z-]+) -->$/;
/** step 4b's sanity ceiling: no honest process gets near it against a cap of 6. */
export const MARKER_CEILING = 100;

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// --- small pure helpers ----------------------------------------------------

/** @param {number[]} values */
export function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** @param {number[]} values */
export function sum(values) {
  return values.filter((v) => Number.isFinite(v)).reduce((a, b) => a + b, 0);
}

export function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** `~1,234` when estimated, `1,234` when exact, `—` when absent. */
export function fmtTokens(n, estimated) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${estimated ? "~" : ""}${fmt(n)}`;
}

function toInt(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,_\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function wordToNumber(w) {
  const lower = String(w).toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  return NUMBER_WORDS[lower] ?? null;
}

/** `gh-94,gh-96` / `#94` / `94` -> [94, 96] */
export function parsePrs(metaPrs) {
  if (!metaPrs) return [];
  return String(metaPrs)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s.replace(/^(gh-|#)/i, "")))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// --- CHANGELOG membership --------------------------------------------------

/**
 * Parses CHANGELOG.md into release sections. Each section lists its beads
 * as `- **title** (\`ugcportal-xxx\`, scope: foo) — [#94](...), [#96](...)`
 * under a `### <emoji> Type` heading. Returns, per version, the ordered
 * unique bead ids, the per-bead type heading / scope / PR numbers, and the
 * date from the `## vX.Y.Z - YYYY-MM-DD` heading.
 *
 * @param {string} markdown
 * @returns {Map<string, {version: string, date: string|null, ids: string[], entries: Map<string, {type: string, scope: string|null, prs: number[], title: string}>}>}
 */
export function parseChangelogMembership(markdown) {
  const releases = new Map();
  const text = markdown.replace(/\r\n/g, "\n");
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const [headingLine, ...rest] = part.split("\n");
    const heading = /^(v\d+\.\d+\.\d+)(?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/.exec(headingLine.trim());
    if (!heading) continue;
    const version = heading[1];
    const date = heading[2] ?? null;
    const ids = [];
    const entries = new Map();
    let currentType = null;
    for (const line of rest) {
      const typeHeading = /^### \S+\s+(.+?)\s*$/.exec(line);
      if (typeHeading) {
        currentType = typeHeading[1];
        continue;
      }
      const entry = /^- \*\*(?<title>.+?)\*\* \(`(?<id>ugcportal-[a-z0-9.]+)`(?:, scope: (?<scope>[^)]+))?\)(?<rest>.*)$/.exec(line);
      if (!entry) continue;
      const { id, scope, title } = entry.groups;
      const prs = [...entry.groups.rest.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
      if (!entries.has(id)) {
        ids.push(id);
        entries.set(id, { type: currentType ?? "Unknown", scope: scope ?? null, prs, title });
      }
    }
    releases.set(version, { version, date, ids, entries });
  }
  return releases;
}

/** Map the CHANGELOG's `### <emoji> Type` heading text to a cc_type. */
export function changelogTypeToCcType(heading) {
  const h = String(heading).toLowerCase();
  if (h.startsWith("feature")) return "feat";
  if (h.startsWith("fix")) return "fix";
  if (h.startsWith("perf")) return "perf";
  if (h.startsWith("doc")) return "docs";
  if (h.startsWith("refactor")) return "refactor";
  if (h.startsWith("test")) return "test";
  if (h.startsWith("build")) return "build"; // "Build & CI" groups build+ci
  if (h.startsWith("chore")) return "chore";
  return h;
}

// --- git cross-check -------------------------------------------------------

/**
 * Pulls `(ugcportal-xxx)` bead ids and `(#n)` PR numbers out of commit
 * subjects. A subject can carry both; a direct-to-main commit carries only
 * the bead id.
 *
 * @param {string} gitLogSubjects one subject per line
 */
export function beadsAndPrsFromGitLog(gitLogSubjects) {
  const ids = new Set();
  const prs = new Set();
  const commits = [];
  for (const raw of gitLogSubjects.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const foundIds = [...line.matchAll(/\((ugcportal-[a-z0-9.]+)\)/g)].map((m) => m[1]);
    const foundPrs = [...line.matchAll(/\(#(\d+)\)/g)].map((m) => Number(m[1]));
    foundIds.forEach((i) => ids.add(i));
    foundPrs.forEach((p) => prs.add(p));
    commits.push({ subject: line, ids: foundIds, prs: foundPrs });
  }
  return { ids, prs, commits };
}

// --- estimate detection ----------------------------------------------------

/**
 * Which cost figures a bead's own prose calls an estimate.
 *
 * Splits notes + close_reason into sentences; a sentence containing
 * estimate / rough / approx AND naming a figure (tokens, token, figure,
 * cost, tokens_impl, tokens_qa) marks a figure. "tokens_qa ... estimate"
 * marks QA, "tokens_impl ... rough" marks build, a sentence naming both or
 * neither explicitly marks both. "chain approx" sentences never mark
 * anything (they are about the round chain). Returns the matched sentences
 * so the report can quote why.
 *
 * @param {string} text
 * @returns {{impl: boolean, qa: boolean, reasons: string[]}}
 */
export function estimateFlags(text) {
  const out = { impl: false, qa: false, reasons: [] };
  if (!text) return out;
  const sentences = String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.;:!?])\s+|\s*\n+\s*/);
  for (const s of sentences) {
    if (!/\b(estimat\w*|rough\w*|approx\w*)\b/i.test(s)) continue;
    if (!/\b(tokens?_?(impl|qa)?|figures?|costs?)\b/i.test(s)) continue;
    const namesImpl = /tokens?_impl|build (cost|figure)|implementation (cost|figure)/i.test(s);
    const namesQa = /tokens?_qa|review (cost|figure)|qa (cost|figure)/i.test(s);
    if (namesImpl && !namesQa) out.impl = true;
    else if (namesQa && !namesImpl) out.qa = true;
    else {
      out.impl = true;
      out.qa = true;
    }
    out.reasons.push(s.trim());
  }
  return out;
}

// --- close-reason round count ---------------------------------------------

/**
 * Round count from a bead's own close reason, for PRs that predate round
 * markers. Understands "seven review passes", "SIX ... FIVE independent
 * code-review passes", "Six review rounds", "6 review rounds", "4 real
 * review rounds", "Three rounds.", "merged round 1", "Review: round 1".
 * Returns null when nothing matches -- never guesses.
 *
 * @param {string} text
 * @returns {{rounds: number, phrase: string}|null}
 */
export function parseRoundsFromCloseReason(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, " ");
  const num = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const patterns = [
    new RegExp(`\\b${num}\\s+(?:independent\\s+|real\\s+)?(?:code-)?review\\s+(?:passes|rounds)`, "i"),
    new RegExp(`\\b${num}\\s+review\\s+rounds?\\b`, "i"),
    new RegExp(`\\b(?:after|in)\\s+${num}\\s+rounds\\b`, "i"),
    new RegExp(`(?:^|[.;:]\\s*)${num}\\s+rounds\\.`, "i"),
    /\bmerged\s+round\s+(\d+)\b/i,
    /\bReview:\s+round\s+(\d+)\b/i,
    /\bround\s+(\d+),\s+(?:approx|exact)\s+chain/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) {
      const n = wordToNumber(m[1]);
      if (n !== null) return { rounds: n, phrase: m[0].trim() };
    }
  }
  return null;
}

// --- round markers (pr-review-merge step 4b) --------------------------------

/**
 * @typedef {{kind: "comment"|"review", login: string, at: string, edited: boolean, body: string}} ChainItem
 */

/** First line of a body with the trailing CR stripped (step 4b: strip upstream, before matching). */
export function firstLine(body) {
  return String(body ?? "").split("\n")[0].replace(/\r$/, "");
}

/**
 * Reads the round chain from issue comments and review bodies the way
 * pr-review-merge step 4b does, and reports the same three statuses.
 *
 * @param {ChainItem[]} items
 * @param {string} prAuthor
 * @param {string} reviewer the account the reviewing skill authenticates as
 */
export function readRoundChain(items, prAuthor, reviewer) {
  const all = items.map((it) => ({ ...it, line: firstLine(it.body) }));
  const resets = all
    .map((it) => CHAIN_RESET_RE.exec(it.line))
    .filter(Boolean)
    .map((m) => Number(m.groups.r));
  const reset = resets.length ? Math.max(...resets) : 0;
  const markers = [];
  const stops = [];
  for (const it of all) {
    const stop = STOP_MARKER_RE.exec(it.line);
    if (stop) stops.push({ reason: stop.groups.reason, at: it.at, body: it.body });
    const m = ROUND_MARKER_RE.exec(it.line);
    if (!m) continue;
    const n = Number(m.groups.r);
    if (n <= reset) continue;
    markers.push({ n, approx: Boolean(m.groups.a), login: it.login, at: it.at, edited: it.edited, body: it.body, kind: it.kind });
  }
  markers.sort((a, b) => a.n - b.n || a.at.localeCompare(b.at));
  const ns = [...new Set(markers.map((m) => m.n))].sort((a, b) => a - b);
  const self = String(reviewer ?? "").toLowerCase() === String(prAuthor ?? "").toLowerCase();
  let status;
  let highest;
  if (reset > MARKER_CEILING) {
    status = "broken";
    highest = reset;
  } else if (ns.some((n) => n > MARKER_CEILING)) {
    status = "broken";
    highest = ns[ns.length - 1];
  } else if (ns.length === 0) {
    highest = reset;
    status = reset > 0 || self ? "approx" : "exact";
  } else {
    highest = ns[ns.length - 1];
    const startsWrong = reset > 0 ? ns[0] !== reset + 1 : ns[0] !== 1 && !markers.filter((m) => m.n === ns[0]).some((m) => m.approx);
    const broken =
      markers.some((m) => m.login.toLowerCase() !== String(reviewer ?? "").toLowerCase()) ||
      markers.some((m) => m.edited) ||
      markers.length !== ns.length ||
      ns[ns.length - 1] - ns[0] + 1 !== ns.length ||
      startsWrong;
    if (broken) status = "broken";
    else if (reset > 0 || self || markers.some((m) => m.approx)) status = "approx";
    else status = "exact";
  }
  return { highest, status, markers, ns, stops, reset, self };
}

// --- severity classification -----------------------------------------------

/**
 * Counts the severities the reviewer STATED in one verdict comment.
 *
 * Two readings are combined. Item labels: a severity word that opens a
 * finding -- `1. MEDIUM (…)`, `MEDIUM 1,`, `**medium** —`, `[Medium]`,
 * `**[code-review, medium]**`, `Medium 1 (`:144`)`, `LOW:`, `- **low** —`,
 * or an upper-case MEDIUM / HIGH / CRITICAL / LOW anywhere that is not a
 * count ("one MEDIUM"), not gate prose ("medium-or-above", "No medium")
 * and not a back-reference ("Same MEDIUM class"). Labels carrying a number
 * (`MEDIUM 1`) are deduplicated by number, so a sweep line that repeats
 * `Family 4: MEDIUM 1` does not double-count. Summary counts: "one MEDIUM
 * and four LOW", "two of them medium", "all LOW severity", "Two LOWS filed".
 * Mediums = item labels when any exist, else the summary count. Lows =
 * the larger of the two, reported as a LABEL count: a single `LOW:` label
 * often introduces several semicolon-separated items, so it is a floor.
 *
 * `stated` is false when the comment names no severity at all and does not
 * say it found nothing -- the report prints "unstated" for that round
 * rather than a number.
 *
 * Two specific non-findings contexts are excluded from the count
 * (ugcportal-zo8n), however close a severity word sits next to the number:
 * a number glued to a `#` (an issue/PR reference) and a number immediately
 * followed by a `--flag` (a quoted CLI invocation, e.g. PR #121's own
 * round-1 body quoting `121 high --comment` as the code-review args). This
 * is not an exhaustive findings-context check -- only the two shapes this
 * repo's own review bodies are known to produce.
 *
 * @param {string} body
 */
export function classifySeverity(body) {
  const raw = String(body ?? "");
  // Drop the marker line and strip markdown emphasis / code / brackets so
  // "**MEDIUM**" and "`MEDIUM`" read like "MEDIUM".
  const text = raw
    .split("\n")
    .filter((l) => !/^<!--/.test(l.trim()))
    .join("\n")
    .replace(/[*`_]/g, "")
    .replace(/\[(code-review|conventions|recall)[^\]]*,\s*(medium|low|high|critical)\]/gi, "[$2]");

  const result = { medium: 0, low: 0, stated: false, findings: null, mediumLabels: [], lowLabels: [] };

  const sevItems = { medium: new Map(), low: new Map() };
  const addItem = (bucket, label, idx) => {
    const numbered = /^(?:MEDIUM|HIGH|CRITICAL|LOW|Medium|High|Low)\s+(\d+)/.exec(label);
    const key = numbered ? `#${numbered[1]}` : `@${idx}`;
    sevItems[bucket].set(key, label);
  };

  // (a) line-start labels, any case. A "-or-above" suffix is a label only
  // on a list item ("1. MEDIUM-OR-ABOVE, CONFIRMED."); on a bare line it is
  // a heading ("Medium-or-above findings — all now resolved:").
  const lineStart = /^\s*(?<marker>[-•]\s*|\d+[.)]\s*|\(\d+\)\s*)?(?<bracket>\[)?(?<sev>medium|high|critical|low)(?<orAbove>-or-above|\s+or\s+above)?\]?(\*)?(?:\s*(?:\d+\b|(?!-or-above)[—–:(,-])|\s*$|(?<=\])\s)/gim;
  for (const m of text.matchAll(lineStart)) {
    if (m.groups.orAbove && !m.groups.marker) continue;
    const sev = m.groups.sev.toLowerCase();
    const bucket = sev === "low" ? "low" : "medium";
    addItem(bucket, m[0].trim(), m.index);
  }
  // (a2) a capitalised severity after an em dash: "Finding — Medium, CONFIRMED".
  const afterDash = /\s[—–]\s(Medium|High|Critical|Low)(?=[,:(]|\s[—–(-])/g;
  for (const m of text.matchAll(afterDash)) {
    addItem(m[1] === "Low" ? "low" : "medium", m[0].trim(), m.index + m[0].length - m[1].length);
  }
  // (b) upper-case labels anywhere, with the exclusions above.
  const anywhere = /\b(MEDIUM|HIGH|CRITICAL|LOW|LOWS)\b/g;
  for (const m of text.matchAll(anywhere)) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if (/(-or-above|\s+or\s+above)/i.test(after)) continue; // gate prose
    if (/\b(no|zero|any|same|every|only|a|an|non)\s*\W*$/i.test(before)) continue; // negation / back-reference / gate prose
    if (/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|all|both)\s*(?:further|more|new|post-cap|comment|cap|confirmed|plausible)?\s*\W*$/i.test(before)) continue; // summary count
    if (m[1] === "LOWS") continue;
    const bucket = m[1] === "LOW" ? "low" : "medium";
    const labelText = text.slice(m.index, m.index + 12);
    addItem(bucket, labelText, m.index);
  }
  // Merge keys from (a) and (b) that point at the same position.
  const dedupe = (map) => {
    const positions = new Set();
    let count = 0;
    for (const [key, label] of map) {
      if (key.startsWith("#")) {
        count++;
        continue;
      }
      const pos = Number(key.slice(1));
      if ([...positions].some((p) => Math.abs(p - pos) < 12)) continue;
      positions.add(pos);
      // A label whose text also carries a number was already counted via '#'.
      if (/^(MEDIUM|HIGH|CRITICAL|LOW|Medium|High|Low)\s+\d+/.test(label) && map.has(`#${/\d+/.exec(label)[0]}`)) continue;
      count++;
    }
    return count;
  };
  const itemMedium = dedupe(sevItems.medium);
  const itemLow = dedupe(sevItems.low);

  // (c) summary counts.
  let summaryMedium = 0;
  let summaryLow = 0;
  // "Round-1 mediums verified fixed" is a back-reference, not a count: the
  // number must not be glued to a hyphen or follow the word "round".
  const summary = /(?<![\w-])(?<!round\s)(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:of them\s+|further\s+|more\s+|new\s+|post-cap\s+|comment\s+|cap\s+|confirmed\s+|plausible\s+)?(mediums?|highs?|lows?)\b(?!-or-above)(?!\s+or\s+above)/gi;
  for (const m of text.matchAll(summary)) {
    const n = wordToNumber(m[1]);
    if (n === null) continue;
    if (/\bround[- ]?$/i.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
    // Not a findings-context count: `#121 high` (an issue/PR reference, not
    // a severity count) or `121 high --comment` (a quoted CLI invocation --
    // the exact text of PR #121's own round-1 body, which named the
    // code-review args verbatim and was read as 121 mediums before this fix).
    // The exclusion must recognise a *flag* -- "--" glued to a letter with no
    // space, as in `--comment`/`--base`/`--pr` -- not just any two dashes: a
    // bare "N medium -- prose" uses "--" as a plain separator (this project's
    // own prose does this constantly, including in this PR's own body) and
    // must still count.
    if (text[m.index - 1] === "#") continue;
    if (/^\s*--[A-Za-z]/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 8))) continue;
    if (/^low/i.test(m[2])) summaryLow = Math.max(summaryLow, n);
    else summaryMedium = Math.max(summaryMedium, n);
  }
  const allLow = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+findings?,?\s+(?:all|both)\s+(?:severity\s+)?low\b/i.exec(text);
  if (allLow) summaryLow = Math.max(summaryLow, wordToNumber(allLow[1]) ?? 0);

  result.medium = itemMedium > 0 ? itemMedium : summaryMedium;
  result.low = Math.max(itemLow, summaryLow);
  result.mediumLabels = [...sevItems.medium.values()];
  result.lowLabels = [...sevItems.low.values()];

  const findings = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:candidate\s+|surviving\s+|new\s+|further\s+)?findings?\b/i.exec(text);
  if (findings) result.findings = wordToNumber(findings[1]);
  // Stated means the reviewer put a severity on at least one finding, or
  // said in so many words that nothing (or nothing above low) was found.
  // Prose that merely mentions "medium-or-above blocks" does not count.
  // "Family 3 — checked, nothing found" is about one family, not the
  // verdict, so the bare phrase does not count; the verdict-level forms do.
  const none =
    /\b(no|zero)\s+(blocking\s+|code\s+)?findings?\b|\bno medium(-or-above| or above)?\s+(found|anywhere|outstanding)|\bnone stands as a defect\b|\bdiff is clean\b|\bnothing to fix\b|\bfound nothing\b/i.test(text);
  result.stated = itemMedium + itemLow + summaryMedium + summaryLow > 0 || none;
  return result;
}

/**
 * Attaches addendum comments ("Addendum to round 4", "Round 4 addendum") to
 * the round they extend; returns null for any other unmarked comment.
 */
export function addendumRound(body) {
  const head = String(body ?? "").slice(0, 160);
  const m = /addendum to round (\d+)|round[- ](\d+) addendum/i.exec(head);
  return m ? Number(m[1] ?? m[2]) : null;
}

/**
 * Groups timestamps into bursts separated by more than `gapMinutes`. Used
 * only for marker-less PRs, to show how many review bursts the inline
 * comments fall into; the report marks that figure as an estimate.
 *
 * @param {string[]} isoTimestamps
 */
export function clusterByTime(isoTimestamps, gapMinutes = 20) {
  const ts = isoTimestamps.map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
  const clusters = [];
  for (const t of ts) {
    const last = clusters[clusters.length - 1];
    if (last && t - last[last.length - 1] <= gapMinutes * 60_000) last.push(t);
    else clusters.push([t]);
  }
  return clusters;
}

// --- data access (not unit-tested: shells out to bd / gh / git) -------------

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function loadBeads(opts) {
  if (opts.beads) return JSON.parse(fs.readFileSync(opts.beads, "utf8"));
  if (opts.offline) throw new Error("--offline needs --beads <file>");
  return JSON.parse(run("bd", ["list", "--all", "--json"], { cwd: opts.bdCwd }));
}

function showBead(id, opts) {
  if (opts.offline) return null;
  try {
    const out = JSON.parse(run("bd", ["show", id, "--json"], { cwd: opts.bdCwd }));
    return Array.isArray(out) ? out[0] : out;
  } catch {
    return null;
  }
}

function gitLogSubjects(range, opts) {
  if (opts.offline) return null;
  try {
    return run("git", ["log", "--format=%s", range], { cwd: opts.repo });
  } catch (err) {
    return { error: String(err.stderr || err.message).trim() };
  }
}

function gitTagDate(tag, opts) {
  if (opts.offline) return null;
  try {
    return run("git", ["log", "-1", "--format=%cI", tag], { cwd: opts.repo }).trim();
  } catch {
    return null;
  }
}

/**
 * One PR's view + issue comments + review bodies + inline comments, from
 * the cache when present. `--paginate --slurp` returns one array per page;
 * the pages are flattened HERE, once, downstream of pagination -- never
 * aggregated inside a per-page filter (step 4b's first load-bearing rule).
 */
function fetchPr(n, opts) {
  const cacheFile = opts.cache ? path.join(opts.cache, `${n}.json`) : null;
  if (cacheFile && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  if (opts.offline) throw new Error(`--offline and no cache entry for PR #${n}`);
  const gh = (args) => JSON.parse(run("gh", args, { cwd: opts.repo }));
  const out = {
    pr: gh(["pr", "view", String(n), "--json", "number,state,mergedAt,author,title,createdAt,closedAt"]),
    comments: gh(["api", `repos/:owner/:repo/issues/${n}/comments`, "--paginate", "--slurp"]).flat(),
    reviews: gh(["api", `repos/:owner/:repo/pulls/${n}/reviews`, "--paginate", "--slurp"]).flat(),
    inline: gh(["api", `repos/:owner/:repo/pulls/${n}/comments`, "--paginate", "--slurp"]).flat(),
  };
  if (cacheFile) {
    fs.mkdirSync(opts.cache, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(out));
  }
  return out;
}

function reviewerLogin(opts) {
  if (opts.offline) return opts.reviewer ?? null;
  try {
    return run("gh", ["api", "user", "--jq", ".login"], { cwd: opts.repo }).trim();
  } catch {
    return opts.reviewer ?? null;
  }
}

// --- per-PR analysis -------------------------------------------------------

/**
 * @param {ReturnType<typeof fetchPr>} data
 * @param {string|null} reviewer
 */
export function analysePr(data, reviewer) {
  const prAuthor = data.pr?.author?.login ?? null;
  const items = [
    ...data.comments.map((c) => ({ kind: "comment", login: c.user?.login ?? "", at: c.created_at, edited: c.updated_at !== c.created_at, body: c.body ?? "" })),
    ...data.reviews.map((r) => ({ kind: "review", login: r.user?.login ?? "", at: r.submitted_at, edited: false, body: r.body ?? "" })),
  ];
  const chain = readRoundChain(items, prAuthor, reviewer ?? prAuthor);
  const rounds = new Map();
  for (const m of chain.markers) {
    const sev = classifySeverity(m.body);
    rounds.set(m.n, { n: m.n, at: m.at, ...sev, addenda: 0 });
  }
  const extras = [];
  for (const it of items) {
    if (it.kind !== "comment" || !it.body.trim()) continue;
    const line = firstLine(it.body);
    if (ROUND_MARKER_RE.test(line) || STOP_MARKER_RE.test(line) || CHAIN_RESET_RE.test(line)) continue;
    const add = addendumRound(it.body);
    if (add !== null && rounds.has(add)) {
      const sev = classifySeverity(it.body);
      const r = rounds.get(add);
      r.medium += sev.medium;
      r.low += sev.low;
      r.stated = r.stated || sev.stated;
      r.addenda += 1;
      continue;
    }
    extras.push({ at: it.at, head: it.body.replace(/\s+/g, " ").slice(0, 110) });
  }
  // Marker-less fallback: severity labels on inline review comments, and bursts.
  const inline = data.inline.map((c) => ({ at: c.created_at, ...classifySeverity(c.body ?? "") }));
  const inlineLabelled = { medium: 0, low: 0, unstated: 0 };
  for (const c of inline) {
    if (c.medium > 0) inlineLabelled.medium += c.medium;
    else if (c.low > 0) inlineLabelled.low += c.low;
    else inlineLabelled.unstated += 1;
  }
  const bursts = clusterByTime(data.inline.map((c) => c.created_at));
  return {
    number: data.pr.number,
    title: data.pr.title,
    state: data.pr.state,
    mergedAt: data.pr.mergedAt ?? null,
    author: prAuthor,
    chain: { status: chain.status, highest: chain.highest, ns: chain.ns, stops: chain.stops.map((s) => s.reason), self: chain.self },
    rounds: [...rounds.values()].sort((a, b) => a.n - b.n),
    lastRoundBody: chain.markers.length ? chain.markers[chain.markers.length - 1].body : null,
    extras,
    inlineCount: data.inline.length,
    inlineLabelled,
    inlineBursts: bursts.length,
  };
}

// --- bead rows -------------------------------------------------------------

function tierOf(bead) {
  return bead.metadata?.model ?? null;
}

/** `r1:2 r3:1` for mediums per round; `unstated` rounds marked with `?`. */
export function mediumsByRound(prAnalyses) {
  const parts = [];
  for (const pr of prAnalyses) {
    for (const r of pr.rounds) {
      if (!r.stated) parts.push(`r${r.n}:?`);
      else if (r.medium > 0) parts.push(`r${r.n}:${r.medium}`);
    }
  }
  return parts.length ? parts.join(" ") : "0";
}

/** Rounds after the last round that found a medium, i.e. the lows-only tail. */
export function tailRounds(rounds) {
  const stated = rounds.filter((r) => r.stated);
  if (stated.length === 0) return null;
  let lastMedium = 0;
  for (const r of stated) if (r.medium > 0) lastMedium = r.n;
  const maxN = Math.max(...rounds.map((r) => r.n));
  return Math.max(0, maxN - lastMedium);
}

/** A negation cue that, inside the clause around a "sensitive path(s)"
 * mention, means the mention is saying the PR did NOT touch one -- "no
 * sensitive paths touched", "none touch a sensitive path", "zero sensitive
 * paths", "doesn't touch a sensitive path" -- rather than stating the reason
 * it was held for a human. */
const SENSITIVE_PATH_NEGATION_RE = /\b(no|none|zero|not|never|nothing|without|free of|clear of|clean of)\b|n['’]t\b/i;

/**
 * Whether text contains a GENUINE "this touches/touched a sensitive path"
 * statement, as opposed to a negated aside that only mentions the phrase to
 * rule it out (ugcportal-577s: "no sensitive paths touched" on an
 * auto-approval matched the old plain `/sensitive path/i` test). Looks at
 * the clause immediately before each mention -- back to the nearest
 * sentence boundary, or 60 characters, whichever is closer -- for a
 * negation cue; a mention with no negation cue in that lead-in is genuine.
 * Deliberately a clause-local check, not whole-sentence: a sentence can
 * carry an unrelated negation after the mention (PR #185's round-1 body
 * reads "...this PR touches a sensitive path** (...), so this run does not
 * approve or merge..." -- the "does not" there is about merging, not about
 * whether the path is sensitive, and must not flip this to negated).
 *
 * Known blind spot (ugcportal-zo8n), left deliberately unhandled rather than
 * papered over: this is backward-only. A FORWARD negation -- the cue coming
 * after the mention instead of before it, as in "Sensitive path check: none
 * found." or a quoted CLI invocation like `grep "sensitive path" src/` whose
 * surrounding prose later says "found zero real hits" -- reads as genuine
 * (`true`) when a human would read it as a clean check. Across all 77 cached
 * v0.6.0 PR bodies plus this file's own fixtures, this blind spot never
 * actually misclassified anything (nobody in that corpus phrases a negation
 * forward), so this is a latent risk, not a live bug; see
 * `release-cost-report.test.mjs`'s "known forward-negation blind spot"
 * cases for inputs pinned to today's (wrong) answer rather than silently
 * left untested. If real review prose starts using a forward phrasing,
 * extend this function rather than re-widening the backward check -- a
 * whole-sentence negation check was tried and rejected above for flipping
 * genuine mentions that carry an unrelated negation later in the sentence.
 *
 * @param {string} text
 */
export function hasGenuineSensitivePathMention(text) {
  const s = String(text ?? "");
  const mentionRe = /sensitive paths?/gi;
  let m;
  while ((m = mentionRe.exec(s))) {
    const boundary = Math.max(s.lastIndexOf(".", m.index), s.lastIndexOf(";", m.index), s.lastIndexOf(":", m.index), s.lastIndexOf("\n", m.index), m.index - 60);
    const before = s.slice(Math.max(0, boundary + 1), m.index);
    if (!SENSITIVE_PATH_NEGATION_RE.test(before)) return true;
  }
  return false;
}

/**
 * How the PR got over the line, read from the close reason and the PR's
 * own final comments. Heuristic: the close reason is free text, so this is
 * labelled as such in the report and the close reason is the source of truth.
 */
export function outcomeOf(bead, prAnalyses, rounds) {
  const cr = bead.close_reason ?? "";
  if (prAnalyses.length === 0) return "no PR";
  if (/withdrawn|premise was wrong/i.test(cr)) return "withdrawn";
  const lastBodies = prAnalyses.map((p) => (p.lastRoundBody ?? "") + " " + p.extras.map((e) => e.head).join(" ")).join(" ");
  if (/round-6 cap|\bthe cap\b|cap escalation|after the cap|at the cap/i.test(cr) || (rounds !== null && rounds >= 6)) return "cap → human";
  if (hasGenuineSensitivePathMention(cr) || hasGenuineSensitivePathMention(lastBodies)) return "human (sensitive path)";
  if (/\bby Eirik\b|Eirik's (decision|instruction)|human merge|Eirik (approved|merged)/i.test(cr) || /Eirik('s)? (decision|instruction|merge)/i.test(lastBodies)) return "human";
  if (/\bMerging\b|auto-merge|merged round 1|squash-merged by pr-review-merge/i.test(cr + " " + lastBodies)) return "auto-merged";
  if (!cr || cr.trim() === "Closed") return "merged (no close reason)";
  return "merged";
}

export function buildRows(release, beadsById, prAnalysesByNumber) {
  const rows = [];
  for (const id of release.ids) {
    const bead = beadsById.get(id);
    const entry = release.entries.get(id);
    const meta = bead?.metadata ?? {};
    const prs = parsePrs(meta.prs);
    const prAnalyses = prs.map((n) => prAnalysesByNumber.get(n)).filter(Boolean);
    const est = estimateFlags(`${bead?.notes ?? ""}\n${bead?.close_reason ?? ""}`);
    const impl = toInt(meta.tokens_impl);
    const qa = toInt(meta.tokens_qa);
    const markerRounds = prAnalyses.filter((p) => p.rounds.length > 0);
    const closeRounds = parseRoundsFromCloseReason(bead?.close_reason ?? "");
    let rounds = null;
    let roundsSource = "none";
    if (markerRounds.length > 0) {
      // A broken chain (a gap such as {1,4,5,6}) under-counts by its missing
      // markers; the highest marker is the better floor there.
      rounds = markerRounds.reduce((acc, p) => acc + (p.chain.status === "broken" ? p.chain.highest : p.chain.ns.length), 0);
      roundsSource = "markers";
      if (closeRounds && closeRounds.rounds !== rounds) roundsSource = `markers (close reason says ${closeRounds.rounds})`;
    } else if (closeRounds) {
      rounds = closeRounds.rounds;
      roundsSource = "close reason";
    }
    const allRounds = prAnalyses.flatMap((p) => p.rounds);
    const total = (impl ?? 0) + (qa ?? 0);
    rows.push({
      id,
      title: entry?.title ?? bead?.title ?? "",
      release: release.version,
      issueType: bead?.issue_type ?? null,
      ccType: meta.cc_type ?? changelogTypeToCcType(entry?.type ?? ""),
      changelogType: entry?.type ?? null,
      scope: meta.cc_scope ?? entry?.scope ?? null,
      tier: tierOf(bead ?? {}),
      effort: meta.model_effort ?? null,
      modelWhy: meta.model_why ?? null,
      impl,
      qa,
      implEstimated: est.impl,
      qaEstimated: est.qa,
      estimateReasons: est.reasons,
      total: impl === null && qa === null ? null : total,
      prs,
      prStates: prAnalyses.map((p) => ({ number: p.number, state: p.state, mergedAt: p.mergedAt })),
      rounds,
      roundsSource,
      chain: prAnalyses.map((p) => `#${p.number} ${p.chain.status}${p.chain.ns.length ? ` {${p.chain.ns.join(",")}}` : ""}`).join("; ") || "—",
      mediumsByRound: mediumsByRound(prAnalyses),
      mediums: allRounds.reduce((a, r) => a + (r.stated ? r.medium : 0), 0),
      // Per PR, so aggregates can count a PR shared by several beads once.
      prMediums: Object.fromEntries(prAnalyses.map((p) => [p.number, p.rounds.reduce((a, r) => a + (r.stated ? r.medium : 0), 0)])),
      prRounds: Object.fromEntries(prAnalyses.map((p) => [p.number, p.chain.status === "broken" ? p.chain.highest : p.chain.ns.length])),
      lowsLabelled: allRounds.reduce((a, r) => a + (r.stated ? r.low : 0), 0),
      unstatedRounds: allRounds.filter((r) => !r.stated).length,
      tail: markerRounds.length ? tailRounds(allRounds) : null,
      inline: prAnalyses.reduce((a, p) => a + p.inlineCount, 0),
      inlineLabelled: prAnalyses.reduce(
        (a, p) => ({ medium: a.medium + p.inlineLabelled.medium, low: a.low + p.inlineLabelled.low, unstated: a.unstated + p.inlineLabelled.unstated }),
        { medium: 0, low: 0, unstated: 0 },
      ),
      inlineBursts: prAnalyses.reduce((a, p) => a + p.inlineBursts, 0),
      perRound: qa !== null && rounds ? qa / rounds : null,
      outcome: outcomeOf(bead ?? {}, prAnalyses, rounds),
      closeReason: bead?.close_reason ?? "",
      missingBead: !bead,
    });
  }
  return rows;
}

// --- aggregates -----------------------------------------------------------

export function aggregate(rows) {
  const impl = rows.map((r) => r.impl).filter((v) => v !== null);
  const qa = rows.map((r) => r.qa).filter((v) => v !== null);
  const total = rows.map((r) => r.total).filter((v) => v !== null);
  // Mediums are a PR property; count each PR once even when several beads
  // share it (gh-59, gh-60, gh-101). The rounds median stays per bead, since
  // a bead is the unit the budget applies to.
  const prMediums = new Map();
  for (const r of rows) for (const [n, m] of Object.entries(r.prMediums ?? {})) prMediums.set(n, m);
  const rounds = rows.map((r) => r.rounds).filter((v) => v !== null);
  return {
    n: rows.length,
    nImpl: impl.length,
    nQa: qa.length,
    nAny: rows.filter((r) => r.impl !== null || r.qa !== null).length,
    implTotal: sum(impl),
    qaTotal: sum(qa),
    grandTotal: sum(impl) + sum(qa),
    implMedian: median(impl),
    qaMedian: median(qa),
    totalMedian: median(total),
    roundsMedian: median(rounds),
    roundsN: rounds.length,
    capCount: rows.filter((r) => r.rounds !== null && r.rounds >= 6 && r.prs.length).length,
    estImpl: rows.filter((r) => r.impl !== null && r.implEstimated).length,
    estQa: rows.filter((r) => r.qa !== null && r.qaEstimated).length,
    mediums: sum([...prMediums.values()]),
    unstated: sum(rows.map((r) => r.unstatedRounds)),
  };
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] ?? "(none)";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/**
 * Tier performance: for the beads that carry a tier and a round count,
 * how often they passed in one or two rounds, how often they reached the
 * cap, and what review they generated.
 */
export function tierPerformance(rows) {
  const out = [];
  for (const [tier, group] of groupBy(rows, "tier")) {
    const withRounds = group.filter((r) => r.rounds !== null && r.prs.length > 0);
    const qa = group.map((r) => r.qa).filter((v) => v !== null);
    const impl = group.map((r) => r.impl).filter((v) => v !== null);
    out.push({
      tier,
      n: group.length,
      nRounds: withRounds.length,
      passIn2: withRounds.filter((r) => r.rounds <= 2).length,
      cap: withRounds.filter((r) => r.rounds >= 6).length,
      roundsMedian: median(withRounds.map((r) => r.rounds)),
      qaTotal: sum(qa),
      qaMedian: median(qa),
      implTotal: sum(impl),
      implMedian: median(impl),
      mediums: sum(group.map((r) => r.mediums)),
      perRoundMedian: median(group.map((r) => r.perRound).filter((v) => v !== null)),
    });
  }
  const order = ["haiku", "sonnet", "opus", "fable", "(none)"];
  return out.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
}

// --- rendering -------------------------------------------------------------

function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function renderReleaseTable(rows) {
  const headers = ["Bead", "Type", "Scope", "Tier/effort", "tokens_impl", "tokens_qa", "Total", "PRs", "Rounds", "Chain", "Mediums by round", "Lows (labels)", "qa/round", "Outcome (heuristic)"];
  const body = rows
    .slice()
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1))
    .map((r) => [
      `\`${r.id.replace("ugcportal-", "")}\``,
      r.ccType ?? "—",
      r.scope ?? "—",
      r.tier ? `${r.tier}/${r.effort ?? "?"}` : "—",
      fmtTokens(r.impl, r.implEstimated),
      fmtTokens(r.qa, r.qaEstimated),
      fmtTokens(r.total, r.implEstimated || r.qaEstimated),
      r.prs.length ? r.prs.map((n) => `#${n}`).join(", ") : "—",
      r.rounds === null ? "—" : `${r.rounds}${r.roundsSource === "close reason" ? " (cr)" : r.roundsSource.startsWith("markers (") ? " (!)" : ""}`,
      r.chain,
      r.rounds !== null && r.roundsSource === "close reason" ? `n/a (${r.inlineLabelled.medium} labelled medium, ${r.inlineLabelled.unstated} unlabelled, ~${r.inlineBursts} bursts)` : r.mediumsByRound,
      r.rounds !== null && r.roundsSource === "close reason" ? `${r.inlineLabelled.low}` : String(r.lowsLabelled),
      r.perRound === null ? "—" : fmtTokens(r.perRound, r.qaEstimated || r.roundsSource !== "markers"),
      r.outcome,
    ]);
  return mdTable(headers, body);
}

function renderAggregateTable(name, rows) {
  const headers = ["Group", "Beads", "with impl", "with qa", "impl total", "qa total", "Total", "impl median", "qa median", "Rounds median (n)", "At cap", "Mediums stated"];
  const line = (label, agg) => [
    label,
    String(agg.n),
    String(agg.nImpl),
    String(agg.nQa),
    fmt(agg.implTotal),
    fmt(agg.qaTotal),
    fmt(agg.grandTotal),
    fmt(agg.implMedian),
    fmt(agg.qaMedian),
    `${fmt(agg.roundsMedian)} (${agg.roundsN})`,
    String(agg.capCount),
    String(agg.mediums),
  ];
  const groups = groupBy(rows, "ccType");
  const order = ["feat", "fix", "perf", "docs", "refactor", "test", "build", "ci", "chore"];
  const body = [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([type, group]) => line(type, aggregate(group)));
  body.push(line(`**${name} total**`, aggregate(rows)));
  return mdTable(headers, body);
}

function renderTierTable(rows) {
  const headers = ["Tier", "Beads", "with rounds", "Passed in ≤2 rounds", "Reached cap (≥6)", "Rounds median", "qa total", "qa median", "impl total", "impl median", "Mediums stated", "qa/round median"];
  const body = tierPerformance(rows).map((t) => [
    t.tier,
    String(t.n),
    String(t.nRounds),
    t.nRounds ? `${t.passIn2} (${Math.round((100 * t.passIn2) / t.nRounds)}%)` : "—",
    t.nRounds ? `${t.cap} (${Math.round((100 * t.cap) / t.nRounds)}%)` : "—",
    fmt(t.roundsMedian),
    fmt(t.qaTotal),
    fmt(t.qaMedian),
    fmt(t.implTotal),
    fmt(t.implMedian),
    String(t.mediums),
    fmt(t.perRoundMedian),
  ]);
  return mdTable(headers, body);
}

function renderTopTable(rows, k = 5) {
  const headers = ["Rank", "Bead", "Type", "Tier", "Build (tokens_impl)", "Review (tokens_qa)", "Rounds", "Mediums by round", "Lows-only tail rounds", "Crude qa/round", "First-round review (crude)", "Tail review (crude)"];
  const top = rows
    .filter((r) => r.total !== null)
    .sort((a, b) => b.total - a.total)
    .slice(0, k);
  const body = top.map((r, i) => [
    String(i + 1),
    `\`${r.id.replace("ugcportal-", "")}\` ${r.prs.map((n) => `#${n}`).join(", ")}`,
    r.ccType ?? "—",
    r.tier ? `${r.tier}/${r.effort ?? "?"}` : "—",
    fmtTokens(r.impl, r.implEstimated),
    fmtTokens(r.qa, r.qaEstimated),
    r.rounds === null ? "—" : String(r.rounds),
    r.mediumsByRound,
    r.tail === null ? "—" : String(r.tail),
    r.perRound === null ? "—" : fmtTokens(r.perRound, true),
    r.perRound === null ? "—" : fmtTokens(r.perRound, true),
    r.perRound === null || r.tail === null ? "—" : fmtTokens(r.perRound * r.tail, true),
  ]);
  return mdTable(headers, body);
}

function renderMembershipChecks(checks) {
  const lines = [];
  for (const c of checks) {
    lines.push(`- **${c.version}** (${c.range}): ${c.note}`);
    if (c.inGitNotChangelog.length) lines.push(`  - in the git range but not in the CHANGELOG section: ${c.inGitNotChangelog.map((x) => `\`${x}\``).join(", ")}`);
    if (c.inChangelogNotGit.length) lines.push(`  - in the CHANGELOG section but not in the git range: ${c.inChangelogNotGit.map((x) => `\`${x}\``).join(", ")}`);
    if (c.prsInGitNotChangelog.length) lines.push(`  - PR numbers in the git range that no CHANGELOG bead lists in \`prs\`: ${c.prsInGitNotChangelog.map((x) => `#${x}`).join(", ")}`);
  }
  return lines.join("\n");
}

function renderDataGaps(rowsByRelease, prAnalysesByNumber, unmerged) {
  const lines = [];
  for (const [version, rows] of rowsByRelease) {
    const noImpl = rows.filter((r) => r.impl === null).map((r) => r.id.replace("ugcportal-", ""));
    const noQa = rows.filter((r) => r.qa === null).map((r) => r.id.replace("ugcportal-", ""));
    const noRounds = rows.filter((r) => r.prs.length && r.rounds === null).map((r) => r.id.replace("ugcportal-", ""));
    const noPr = rows.filter((r) => !r.prs.length).map((r) => r.id.replace("ugcportal-", ""));
    const crRounds = rows.filter((r) => r.roundsSource === "close reason").map((r) => r.id.replace("ugcportal-", ""));
    const disagree = rows.filter((r) => r.roundsSource.startsWith("markers (")).map((r) => `${r.id.replace("ugcportal-", "")} (${r.roundsSource})`);
    const unstated = rows.filter((r) => r.unstatedRounds > 0).map((r) => `${r.id.replace("ugcportal-", "")} (${r.unstatedRounds})`);
    const broken = rows.filter((r) => /broken/.test(r.chain)).map((r) => `${r.id.replace("ugcportal-", "")} ${r.chain}`);
    const missing = rows.filter((r) => r.missingBead).map((r) => r.id);
    lines.push(`- **${version}**`);
    lines.push(`  - no \`tokens_impl\` (${noImpl.length}): ${noImpl.join(", ") || "—"}`);
    lines.push(`  - no \`tokens_qa\` (${noQa.length}): ${noQa.join(", ") || "—"}`);
    lines.push(`  - no PR in \`prs\` (${noPr.length}): ${noPr.join(", ") || "—"}`);
    lines.push(`  - PR but no round count from markers or close reason (${noRounds.length}): ${noRounds.join(", ") || "—"}`);
    lines.push(`  - round count from the close reason, not markers (${crRounds.length}): ${crRounds.join(", ") || "—"}`);
    if (disagree.length) lines.push(`  - markers and close reason disagree: ${disagree.join("; ")}`);
    if (unstated.length) lines.push(`  - rounds whose verdict states no severity: ${unstated.join(", ")}`);
    if (broken.length) lines.push(`  - marker chains reading \`broken\` under step 4b: ${broken.join("; ")}`);
    if (missing.length) lines.push(`  - bead ids in the CHANGELOG that \`bd\` could not return: ${missing.join(", ")}`);
  }
  if (unmerged.length) lines.push(`- **Unmerged \`prs\` entries (K3 violation):** ${unmerged.map((u) => `${u.id} -> #${u.number} ${u.state}`).join("; ")}`);
  else lines.push("- **K3:** every `prs` entry on every bead in both releases is `MERGED` (verified by `gh pr view --json state,mergedAt`).");
  return lines.join("\n");
}

export function renderReport(ctx) {
  const { releases, rowsByRelease, membershipChecks, unmerged, generatedAt, reviewer, prCount } = ctx;
  const out = [];
  out.push(GENERATED_START);
  out.push("");
  out.push(`_Generated ${generatedAt} by \`node scripts/release-cost-report.mjs\`; reviewer identity \`${reviewer ?? "unknown"}\`; ${prCount} PRs read via \`gh\`. Legend: \`~\` = the bead's own notes call this figure an estimate; \`(cr)\` = round count from the close reason (pre-marker PR); \`(!)\` = markers and close reason disagree, markers shown; \`rN:?\` = that round's verdict states no severity; "Lows (labels)" counts severity labels, a single \`LOW:\` label often covers several items, so it is a floor. qa/round is tokens_qa divided by rounds, a crude mean, because per-round cost is not recorded._`);
  out.push("");
  for (const version of releases) {
    const rows = rowsByRelease.get(version);
    out.push(`### ${version}: per-bead table`);
    out.push("");
    out.push(renderReleaseTable(rows));
    out.push("");
    out.push(`### ${version}: totals and medians per bead type`);
    out.push("");
    out.push(renderAggregateTable(version, rows));
    out.push("");
  }
  out.push("### Side by side");
  out.push("");
  const sideHeaders = ["Measure", ...releases];
  const aggs = releases.map((v) => aggregate(rowsByRelease.get(v)));
  const sideRows = [
    ["Beads in the CHANGELOG section", ...aggs.map((a) => String(a.n))],
    ["Beads with any token figure", ...aggs.map((a) => `${a.nAny} (${Math.round((100 * a.nAny) / a.n)}%)`)],
    ["Beads with tokens_impl / tokens_qa", ...aggs.map((a) => `${a.nImpl} / ${a.nQa}`)],
    ["tokens_impl total (lower bound)", ...aggs.map((a) => fmt(a.implTotal))],
    ["tokens_qa total (lower bound)", ...aggs.map((a) => fmt(a.qaTotal))],
    ["Grand total (lower bound)", ...aggs.map((a) => fmt(a.grandTotal))],
    ["tokens_impl median (beads with a figure)", ...aggs.map((a) => fmt(a.implMedian))],
    ["tokens_qa median (beads with a figure)", ...aggs.map((a) => fmt(a.qaMedian))],
    ["Review share of recorded cost", ...aggs.map((a) => `${Math.round((100 * a.qaTotal) / a.grandTotal)}%`)],
    ["Rounds median (beads with a count)", ...aggs.map((a) => `${fmt(a.roundsMedian)} (n=${a.roundsN})`)],
    ["Beads whose PR reached the cap (≥6 rounds)", ...aggs.map((a) => String(a.capCount))],
    ["Mediums stated in verdicts (marker PRs only, each PR once)", ...aggs.map((a) => String(a.mediums))],
    ["Rounds with no stated severity", ...aggs.map((a) => String(a.unstated))],
    ["Figures marked ~ (impl / qa)", ...aggs.map((a) => `${a.estImpl} / ${a.estQa}`)],
  ];
  out.push(mdTable(sideHeaders, sideRows));
  out.push("");
  for (const version of releases) {
    out.push(`### ${version}: model tier performance`);
    out.push("");
    out.push(renderTierTable(rowsByRelease.get(version)));
    out.push("");
  }
  out.push("### Both releases: model tier performance");
  out.push("");
  out.push(renderTierTable(releases.flatMap((v) => rowsByRelease.get(v))));
  out.push("");
  for (const version of releases) {
    out.push(`### ${version}: five most expensive beads (recorded cost, lower bound)`);
    out.push("");
    out.push(renderTopTable(rowsByRelease.get(version)));
    out.push("");
  }
  out.push("### Membership cross-check (CHANGELOG section vs git tag range)");
  out.push("");
  out.push(renderMembershipChecks(membershipChecks));
  out.push("");
  out.push("### Data gaps");
  out.push("");
  out.push(renderDataGaps(rowsByRelease, null, unmerged));
  out.push("");
  out.push(GENERATED_END);
  return out.join("\n");
}

/** Replace the generated block in an existing report, or append one. */
export function spliceGenerated(existing, generated) {
  const start = existing.indexOf(GENERATED_START);
  const end = existing.indexOf(GENERATED_END);
  if (start === -1 || end === -1 || end < start) return `${existing.trimEnd()}\n\n${generated}\n`;
  return existing.slice(0, start) + generated + existing.slice(end + GENERATED_END.length);
}

// --- main ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { releases: ["v0.4.0", "v0.5.0"], changelog: "CHANGELOG.md", repo: process.cwd(), bdCwd: process.cwd(), offline: false, allowUnmerged: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--releases") opts.releases = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--changelog") opts.changelog = next();
    else if (a === "--beads") opts.beads = next();
    else if (a === "--bd-cwd") opts.bdCwd = next();
    else if (a === "--cache") opts.cache = next();
    else if (a === "--offline") opts.offline = true;
    else if (a === "--write") opts.write = next();
    else if (a === "--json") opts.json = next();
    else if (a === "--reviewer") opts.reviewer = next();
    else if (a === "--allow-unmerged") opts.allowUnmerged = true;
    else if (a === "--repo") opts.repo = next();
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const changelog = parseChangelogMembership(fs.readFileSync(path.resolve(opts.repo, opts.changelog), "utf8"));
  for (const v of opts.releases) if (!changelog.has(v)) throw new Error(`CHANGELOG has no section for ${v}`);

  const beads = loadBeads(opts);
  const beadsById = new Map(beads.map((b) => [b.id, b]));
  for (const v of opts.releases) {
    for (const id of changelog.get(v).ids) {
      if (!beadsById.has(id)) {
        const shown = showBead(id, opts);
        if (shown) beadsById.set(id, shown);
      }
    }
  }

  const reviewer = reviewerLogin(opts);
  const prNumbers = new Set();
  for (const v of opts.releases) for (const id of changelog.get(v).ids) parsePrs(beadsById.get(id)?.metadata?.prs).forEach((n) => prNumbers.add(n));
  const prAnalysesByNumber = new Map();
  const unmerged = [];
  for (const n of [...prNumbers].sort((a, b) => a - b)) {
    const data = fetchPr(n, opts);
    const analysis = analysePr(data, reviewer);
    prAnalysesByNumber.set(n, analysis);
  }
  for (const v of opts.releases) {
    for (const id of changelog.get(v).ids) {
      for (const n of parsePrs(beadsById.get(id)?.metadata?.prs)) {
        const a = prAnalysesByNumber.get(n);
        if (!a || a.state !== "MERGED" || !a.mergedAt) unmerged.push({ id, number: n, state: a?.state ?? "unknown" });
      }
    }
  }
  if (unmerged.length && !opts.allowUnmerged) {
    console.error(`K3 violation: ${unmerged.length} prs entr${unmerged.length === 1 ? "y is" : "ies are"} not MERGED:`);
    for (const u of unmerged) console.error(`  ${u.id} -> #${u.number} (${u.state})`);
    process.exit(2);
  }

  // Membership cross-check against the git tag ranges.
  const membershipChecks = [];
  const tagDates = new Map();
  for (let i = 0; i < opts.releases.length; i++) {
    const to = opts.releases[i];
    const from = i === 0 ? previousTag(to) : opts.releases[i - 1];
    const range = `${from}..${to}`;
    const log = gitLogSubjects(range, opts);
    const section = changelog.get(to);
    const changelogPrs = new Set(section.ids.flatMap((id) => parsePrs(beadsById.get(id)?.metadata?.prs)));
    if (log === null) {
      membershipChecks.push({ version: to, range, note: "offline: git range not checked", inGitNotChangelog: [], inChangelogNotGit: [], prsInGitNotChangelog: [] });
      continue;
    }
    if (typeof log === "object" && log.error) {
      membershipChecks.push({ version: to, range, note: `git failed (${log.error}); membership taken from the CHANGELOG section alone`, inGitNotChangelog: [], inChangelogNotGit: [], prsInGitNotChangelog: [] });
      continue;
    }
    const git = beadsAndPrsFromGitLog(log);
    const toDate = gitTagDate(to, opts);
    const fromDate = gitTagDate(from, opts);
    tagDates.set(to, { from: fromDate, to: toDate });
    const gitIds = [...git.ids];
    const sectionIds = new Set(section.ids);
    // A git subject may name the epic (ugcportal-qnq9) while the CHANGELOG lists its child (ugcportal-qnq9.7).
    const coveredByChild = (gid) => [...sectionIds].some((sid) => sid.startsWith(`${gid}.`));
    const inGitNotChangelog = gitIds.filter((gid) => !sectionIds.has(gid) && !coveredByChild(gid));
    const inChangelogNotGit = [...sectionIds].filter((sid) => !git.ids.has(sid) && !git.ids.has(sid.replace(/\.\d+$/, "")));
    const prsInGitNotChangelog = [...git.prs].filter((p) => !changelogPrs.has(p));
    let note = `${git.commits.length} commits`;
    if (git.commits.length < 10 && fromDate && toDate) {
      // Likely no merge base (re-rooted history); say so and show the merge-date window used instead.
      note += `; the tag pair has a suspiciously short history (no shared merge base?), so membership was NOT derived from git here — PRs merged between ${fromDate} and ${toDate} are the fallback window`;
    }
    membershipChecks.push({ version: to, range, note, inGitNotChangelog, inChangelogNotGit, prsInGitNotChangelog });
  }

  const rowsByRelease = new Map();
  for (const v of opts.releases) rowsByRelease.set(v, buildRows(changelog.get(v), beadsById, prAnalysesByNumber));

  const generatedAt = new Date().toISOString().slice(0, 10);
  const report = renderReport({ releases: opts.releases, rowsByRelease, membershipChecks, unmerged, generatedAt, reviewer, prCount: prNumbers.size });

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify({ generatedAt, reviewer, rows: Object.fromEntries(rowsByRelease), prs: Object.fromEntries(prAnalysesByNumber), membershipChecks, tagDates: Object.fromEntries(tagDates) }, null, 2));
  }
  if (opts.write) {
    const target = path.resolve(opts.repo, opts.write);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    fs.writeFileSync(target, spliceGenerated(existing, report));
    console.error(`wrote generated block to ${opts.write}`);
  } else {
    console.log(report);
  }
}

function previousTag(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return tag;
  const minor = Number(m[2]);
  return minor > 0 ? `v${m[1]}.${minor - 1}.0` : tag;
}

if (isMainModule(import.meta.url)) {
  main();
}
