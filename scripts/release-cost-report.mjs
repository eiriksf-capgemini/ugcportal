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
 * Severity per round is read from the orchestrator-written `findings_r<N>`
 * keys on the bead where they exist and parse (ugcportal-2jvh; see
 * withFindingsKeys), and otherwise from the reviewer's own words in each
 * round's verdict comment -- `MEDIUM`, `**medium**`, `[Medium]`, `LOW:` and so
 * on -- never inferred from the finding's content. A verdict that states no
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
 * Cost unit (ugcportal-cii0): a bead is read in exactly one unit, transcript
 * cost (cost_ite_*) when it has an accepted one, else the old tokens_*
 * context-size figures, labelled "context-size, not cost": a bead with no
 * accepted cost_ite_* figure (absent, 0, malformed, or on a side marked incomplete) is read in context size; see costUnitOf.
 *
 * Per-round review figures: tokens_qa_rN holds round N's reviewer figure
 * (context size, not cost) on many beads and this report does not read it;
 * cost_ite_qa_rN (ugcportal-gmzi) holds round N's transcript cost and is
 * read by perRoundCost below. The qa/round column is still the bead's QA
 * figure / rounds, a crude mean, and is labelled as such. The per-round
 * keys are never summed into cost_ite_qa (that total is recomputed whole
 * from the agent list).
 *
 * Controls table (ugcportal-md4c): with `--transcripts <dir>` (or alone with
 * `--controls-only`), a section prices each process control in the fixed
 * CONTROLS list below -- runs, cost in input-token equivalents (ITE), wall
 * clock, the orchestrator's share, catches, and "files examined / files
 * matched" -- by running agent-pass-cost.mjs's scanTool (the engine of its
 * `--tool` mode, unedited) once per control with the command pattern
 * docs/process/cost-performance-claims-v0.7.0-2026-10-16.md Appendix A used.
 * Examined/matched come straight from scanTool's reach fields, not recomputed.
 * A control whose pattern matched no call prints "0 of N files matched", not
 * a bare 0 (review-standards section 6; asserted by the "guardrail" test).
 * Windowing: agent-pass-cost has an upper bound only, so `--before <iso>` ends the window and there is NO lower
 * bound; the table says so. Orchestrator share = ITE of calls the parent
 * sessions ran / ITE of all matching calls.
 *
 * Catches: the one convention is the bead metadata key `caught_by=<control>`,
 * set on the bead of a finding the control surfaced (value from the fixed
 * CONTROLS list; several controls comma-separated; optional `caught_by_note`
 * free text). The table counts, per control, the beads carrying it among all
 * beads read (not only the release's); a value outside the list is listed
 * under the table, not dropped (asserted by the K2 test). Record one with
 *   bd update <id> --set-metadata caught_by=<control>
 *   node scripts/bd-verify-metadata.mjs <id> caught_by=<control>
 * Controls with no command pattern (premise-audit: agents, not commands) show
 * catches only.
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
 *     --json <out.json>          also dump the computed dataset (the `prs` export is the
 *                                prose parse only; bead rows carry the keyed readings as
 *                                `roundDetail` and `families`)
 *     --transcripts <dir>        add the controls table, pricing transcripts in <dir>
 *     --controls-only            print only the controls table (needs bd, or --beads)
 *     --before <iso>             end of the controls window (no lower bound exists)
 *     --allow-unmerged           report instead of exit 2 on an unmerged `prs` entry
 *
 * Self-test: npm test -- runs scripts/release-cost-report.test.mjs (vitest)
 * against the pure functions exported below.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import os from "node:os";

import { scanTool } from "./agent-pass-cost.mjs";
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

/** `NN%`, or `—` when the denominator is zero or not a number. */
export function pct(part, whole) {
  return Number.isFinite(whole) && whole > 0 ? `${Math.round((100 * part) / whole)}%` : "—";
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
 * The five characters that actually end a line, as a closed whitelist
 * (ugcportal-zo8n round 4): LF, CR (and CRLF, which is just CR then LF),
 * U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR and U+0085 NEL.
 * Everything else -- NBSP, the U+2002/U+3000/U+2007/U+202F/U+180E/U+2060
 * family, \f, \v -- is an ordinary character that keeps the line going.
 * Built with String.fromCodePoint rather than written as \u escapes so this
 * file's own source encoding cannot decide what the set contains.
 */
const LINE_TERMINATORS = new Set(["\n", "\r", String.fromCodePoint(0x2028), String.fromCodePoint(0x2029), String.fromCodePoint(0x0085)]);

/** Splits into lines, keeping each line's own terminator so text round-trips. */
function splitLinesKeepingTerminators(src) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (!LINE_TERMINATORS.has(src[i])) continue;
    const term = src[i] === "\r" && src[i + 1] === "\n" ? "\r\n" : src[i];
    lines.push({ text: src.slice(start, i), term });
    i += term.length - 1;
    start = i + 1;
  }
  lines.push({ text: src.slice(start), term: "" });
  return lines;
}

/**
 * Strips markdown emphasis and code markers ( * _ ` ) exactly as a plain
 * `.replace(/[*`_]/g, "")` would, while recording which markdown CODE SPAN
 * each surviving character came from. The "exactly" is pinned by a test
 * ("is a drop-in for the old `.replace(/[*`_]/g, '')`"), not just asserted
 * here, and was additionally checked against all 1316 non-empty review
 * comments in this repo when it was written (ugcportal-x9c7).
 *
 * Three span forms are recognised:
 *   - a fenced block, a line whose first non-blank characters are a run of
 *     three or more backticks, closed by a later line opening a run at least
 *     as long. The whole block, across lines, is ONE span.
 *   - a double-backtick inline span (``…``), which may contain lone backticks.
 *   - a single-backtick inline span (`…`).
 * An inline span is LINE-LOCAL: it is opened and closed within one line, and
 * backtick runs are paired left to right inside that line. This deliberately
 * diverges from CommonMark, where an inline code span may contain a newline
 * (rendered as a space). The divergence is load-bearing and is the safe way
 * round: see classifySeverity's exclusion comment.
 *
 * UNBALANCED backticks -- an inline run with no partner on its line, or a
 * fence that is never closed -- open NO span. The characters are still
 * stripped (so the returned text is unchanged), but nothing is marked as
 * code. This is the deliberate fail-open direction: an unterminated span can
 * only ever cause a severity count to be COUNTED, never silently zeroed.
 *
 * @param {string} src
 * @returns {{ text: string, spanIds: number[], spanText: Map<number, string> }}
 *   `spanIds[i]` is the id of the code span containing `text[i]`, or 0 for a
 *   character outside every span; `spanText` maps an id to that span's full
 *   stripped content.
 */
export function readCodeSpans(src) {
  const chars = [];
  const spanIds = [];
  const spanText = new Map();
  let nextId = 1;

  const emit = (s, id) => {
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === "*" || c === "_" || c === "`") continue;
      chars.push(c);
      spanIds.push(id);
    }
  };
  const openSpan = () => {
    const id = nextId++;
    spanText.set(id, "");
    return id;
  };
  const emitInto = (s, id) => {
    const before = chars.length;
    emit(s, id);
    if (id !== 0) spanText.set(id, spanText.get(id) + chars.slice(before).join(""));
  };

  const emitLine = (line) => {
    let p = 0;
    while (p < line.length) {
      if (line[p] !== "`") {
        emit(line[p], 0);
        p++;
        continue;
      }
      let run = 0;
      while (p + run < line.length && line[p + run] === "`") run++;
      // A closing run of EXACTLY the same length, later on this same line.
      let q = p + run;
      let close = -1;
      while (q < line.length) {
        if (line[q] !== "`") {
          q++;
          continue;
        }
        let r = 0;
        while (q + r < line.length && line[q + r] === "`") r++;
        if (r === run) {
          close = q;
          break;
        }
        q += r;
      }
      if (close === -1) {
        // Unbalanced: no span. The backticks are dropped, as before.
        p += run;
        continue;
      }
      emitInto(line.slice(p + run, close), openSpan());
      p = close + run;
    }
  };

  const lines = splitLinesKeepingTerminators(src);
  const fenceOpener = /^[ \t]*(`{3,})/;
  for (let i = 0; i < lines.length; i++) {
    const opener = fenceOpener.exec(lines[i].text);
    if (opener) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const m = fenceOpener.exec(lines[j].text);
        if (m && m[1].length >= opener[1].length) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        const id = openSpan();
        for (let k = i; k <= close; k++) {
          emitInto(lines[k].text, id);
          emitInto(lines[k].term, id);
        }
        i = close;
        continue;
      }
      // Unclosed fence: fall through and read the line as ordinary prose.
    }
    emitLine(lines[i].text);
    emit(lines[i].term, 0);
  }

  return { text: chars.join(""), spanIds, spanText };
}

/**
 * Applies a regex replacement to a `readCodeSpans` result, keeping `spanIds`
 * aligned with the rewritten text (replacement characters inherit the span of
 * the position the match started at).
 */
function replaceKeepingSpans(lexed, re, build) {
  const out = [];
  const ids = [];
  let last = 0;
  const copy = (from, to) => {
    for (let k = from; k < to; k++) {
      out.push(lexed.text[k]);
      ids.push(lexed.spanIds[k]);
    }
  };
  for (const m of lexed.text.matchAll(re)) {
    copy(last, m.index);
    const rep = build(m);
    for (let k = 0; k < rep.length; k++) {
      out.push(rep[k]);
      ids.push(lexed.spanIds[m.index]);
    }
    last = m.index + m[0].length;
  }
  copy(last, lexed.text.length);
  return { text: out.join(""), spanIds: ids, spanText: lexed.spanText };
}

/** A stated findings count ("3 findings"); "round-2 findings" is a back-reference, not a count. */
const FINDINGS_COUNT_RE =
  /(?<![\w-])(?<!round\s)\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:candidate\s+|surviving\s+|new\s+|further\s+)?findings?\b/i;

const STRONG_NONE_RE = /\b(no|zero)\s+(blocking\s+|code\s+)?findings?\b/i;

const NONE_RE =
  /\b(no|zero)\s+(blocking\s+|code\s+)?findings?\b|\bno medium(-or-above| or above)?\s+(found|anywhere|outstanding)|\bnone stands as a defect\b|\bdiff is clean\b|\bnothing to fix\b|\bfound nothing\b/i;

/**
 * A line whose no-findings phrase is not the round's verdict: a sub-heading
 * ("Verified, no finding:", "Family 3 -- checked, nothing found:": the line
 * ends with a colon) or a tool-output line (the line opens
 * with the name of a script or command whose output it quotes, as in
 * "claims-audit --pr 285: zero findings"). Markdown emphasis is already
 * stripped from the text it reads.
 */
function isSubHeadingOrToolOutput(line, isVerdictLine = false) {
  const l = line.trim();
  if (!isVerdictLine && /:\s*$/.test(l)) return true;
  return /^(?:[-*>\s]*)(?:\$\s*|npx\s+|node\s+)?(?:scripts\/)?(?:claims-audit|sweep-candidates|check-[\w-]+|release-cost-report|vitest|eslint)\b/i.test(l);
}

/** A quoted phrase ("Auto-approved... no blocking findings") is cited, not said. */
function stripQuoted(line) {
  return line.replace(/"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g, " ");
}

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
 * rather than a number. "Says it found nothing" is read over the whole
 * comment, minus sub-heading lines (ending with a colon, the first line
 * excepted), tool-output lines
 * (opening with a script name), double-quoted phrases, and, off the first
 * line, the weaker phrases (see the comment at `statedNone`); a verdict that
 * sits lower in the body therefore counts (ugcportal-to7b).
 *
 * Two specific non-findings contexts are excluded from the count
 * (ugcportal-zo8n), however close a severity word sits next to the number:
 * a number glued to a `#` (an issue/PR reference) and a number that shares a
 * markdown CODE SPAN with a `--flag` (a quoted CLI invocation, e.g. PR #121's
 * own round-1 body quoting `121 high --comment` as the code-review args).
 * This is not an exhaustive findings-context check -- only the two shapes
 * this repo's own review bodies are known to produce.
 *
 * @param {string} body
 */
export function classifySeverity(body) {
  const raw = String(body ?? "");
  // Drop the marker line and strip markdown emphasis / code / brackets so
  // "**MEDIUM**" and "`MEDIUM`" read like "MEDIUM". readCodeSpans strips
  // exactly the same characters as the old `.replace(/[*`_]/g, "")` did, but
  // also records which code span each surviving character came from.
  const lexed = replaceKeepingSpans(
    readCodeSpans(
      raw
        .split("\n")
        .filter((l) => !/^<!--/.test(l.trim()))
        .join("\n"),
    ),
    /\[(code-review|conventions|recall)[^\]]*,\s*(medium|low|high|critical)\]/gi,
    (m) => `[${m[2]}]`,
  );
  const text = lexed.text;

  const result = { medium: 0, low: 0, stated: false, findings: null, clean: false, mediumLabels: [], lowLabels: [] };

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
  const CLI_FLAG = /--[A-Za-z]/;
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
    // A flag is a CLI echo only when it shares a markdown CODE SPAN with the
    // count. That is the condition itself, not a stand-in for it: the house
    // style quotes the whole invocation inside one span -- `121 high
    // --comment` -- so count and flag are code TOGETHER, and that is what
    // makes the number an argument rather than a verdict.
    //
    // Six earlier rounds each tested a PROXY for this -- "no line terminator
    // between the count and the flag", narrowed from any "--", to \s, to
    // [ \t], to a five-terminator whitelist, to that whitelist plus an
    // 8-character window, to that whitelist with the window removed. Every
    // one of them answered a question about DISTANCE, and distance is not
    // the thing: round 6 (whitelist, no window) read PR #131's "two lows
    // fixed" as zero because an unrelated `--since 2026-09-29` sat 273
    // characters later in the same unbroken paragraph, and PR #193's "one
    // CONFIRMED low" as zero because a CSS custom property,
    // `--color-petrol-deep`, sat 58 characters later (ugcportal-x9c7). In
    // both, the flag-shaped token was in its OWN span and the count was in
    // plain prose -- different contexts, which a distance test cannot see
    // and a span test reads directly.
    //
    // The whole span is searched, not just the part after the count:
    // `code-review --comment 121 high` is the same echo with the arguments
    // reordered. A count outside every span is never an echo, however near a
    // flag sits; a count inside a span whose own text carries no flag is
    // never an echo either.
    //
    // The five line terminators from round 4 survive, moved from "where the
    // proximity window stops" to "where an inline code span ends": an inline
    // span is line-local, so `121 high<NBSP>--comment` is one span and is
    // excluded, while `121 high\n--comment` is two unterminated runs, no
    // span at all, and counts. See readCodeSpans.
    const spanId = lexed.spanIds[m.index] ?? 0;
    if (spanId !== 0 && CLI_FLAG.test(lexed.spanText.get(spanId) ?? "")) continue;
    if (/^low/i.test(m[2])) summaryLow = Math.max(summaryLow, n);
    else summaryMedium = Math.max(summaryMedium, n);
  }
  const allLow = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+findings?,?\s+(?:all|both)\s+(?:severity\s+)?low\b/i.exec(text);
  if (allLow) summaryLow = Math.max(summaryLow, wordToNumber(allLow[1]) ?? 0);

  result.medium = itemMedium > 0 ? itemMedium : summaryMedium;
  result.low = Math.max(itemLow, summaryLow);
  result.mediumLabels = [...sevItems.medium.values()];
  result.lowLabels = [...sevItems.low.values()];

  // "Both round-2 findings are fixed" is a back-reference to an earlier
  // round, not a count of this one: the same exclusion as the summary
  // regex above (no hyphen or "round " before the number).
  const findings = FINDINGS_COUNT_RE.exec(text);
  if (findings) result.findings = wordToNumber(findings[1]);
  // Stated means the reviewer put a severity on at least one finding, or
  // said in so many words that nothing (or nothing above low) was found.
  // Prose that merely mentions "medium-or-above blocks" does not count.
  // The no-findings phrase is read over the whole comment, not only the
  // first line: a round's verdict can sit in the body ("... zero findings
  // this round. Round 1-3 gate: merges only with zero findings -- met." on
  // #194 r2; "Verdict: ..." / "Zero findings. Merging." lower down on #151
  // r3, #152 r1, #154 r3, #155 r2, #165 r2, #185 r1, #206 r3, #219 r2). It
  // skips what is not the verdict (ugcportal-45bh, narrowed in
  // ugcportal-to7b):
  //  - a sub-heading line, one that ends with a colon ("Verified, no
  //    finding:"), except the first line, which is the verdict line even when
  //    it introduces a list ("... after verification none stands as a
  //    defect:", #83 r5), and a verdict on a "## ..." heading line (#271 r3),
  //    both of which are read;
  //  - a tool-output line, one that opens with the name of a script it quotes
  //    ("claims-audit --pr 285: zero findings");
  //  - a phrase inside double quotes, which is cited, not said; and
  //  - off the first line, the weaker phrases ("found nothing", "nothing to
  //    fix", "diff is clean", "none stands as a defect", "no medium ...
  //    found"): sweep notes say "found nothing elsewhere" about one grep, not
  //    about the round. Only "no/zero [blocking|code] findings" counts there.
  const verdictLine = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const none = NONE_RE.test(verdictLine);
  const statedNone = text.split("\n").some((l) => (l.trim() === verdictLine ? NONE_RE : STRONG_NONE_RE).test(stripQuoted(l)) && !isSubHeadingOrToolOutput(l, l.trim() === verdictLine));
  result.stated = itemMedium + itemLow + summaryMedium + summaryLow > 0 || statedNone;
  // The verdict's own "no findings" form, kept apart from `stated` so a
  // reader can let it outrank a bare findings count (withFindingsKeys). It is
  // true only for an approval-shaped verdict line (the first non-empty line):
  // it opens with Approved / Auto-approved / Clean / No findings / Zero
  // findings / Verified clean, matches NONE_RE, states no findings count
  // ("3 findings", "two findings"), and carries none of "Blocking:", "Not
  // merged", "block(s)", "left for a human". Only that line is read, so:
  //  - a round written in the blocking template ("Review round N (chain
  //    ...). **Blocking ...**", zero-finding rounds on sensitive-path PRs
  //    included) opens with "Review round", does not read clean, and an
  //    all-zero key on it is flagged inconsistent when its prose carries a
  //    bare count (rf5o);
  //  - a blocking line that opens with an approval word does read clean when
  //    it has none of the blocking words ("No findings above low; merge
  //    requires zero findings, so L1 must be fixed first."), so a later bare
  //    count in that body does not flag an all-zero key (peom); and
  //  - "no blocking findings" on a round 2-6 approval does not mean the round
  //    found nothing: deferred lows appear only as a bare count in the body.
  // A quote of the band rule ("merge requires zero findings") after a
  // non-approval opening word, and a sub-heading such as "Verified, no
  // finding:" in a blocking round (#157 r3, #207 r2, #209 r4; #277 r1, #258
  // r1), do not read clean.
  const approvalShaped = /^[*_`\s]*(?:auto-)?approved\b|^[*_`\s]*(?:clean|no findings|zero findings|verified clean)\b/i.test(verdictLine);
  const statesCount = FINDINGS_COUNT_RE.test(verdictLine);
  const blockingWord = /\bblocking\s*:|\bnot merged\b|\bblocks?\b|\bleft for a human\b/i.test(verdictLine);
  result.clean = none && approvalShaped && !statesCount && !blockingWord;
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
      // A bare findings count in the addendum joins the round and clears
      // `clean` (4hsc); an addendum with no count changes neither.
      if (sev.findings != null) {
        r.findings = (r.findings ?? 0) + sev.findings;
        r.clean = false;
      }
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

// --- findings_rN keys (ugcportal-2jvh) --------------------------------------

/**
 * Parses one `findings_rN` value, the per-round record pr-review-merge step
 * 4a has the orchestrator write: `f1:<n> f2:<n> f3:<n> f4:<n> med:<n>
 * low:<n>` with an optional trailing `unstated:<n>`, or else an optional
 * trailing `merged:lows-filed` (ugcportal-kwxh: the round ended by the gate with its lows
 * filed as beads, merged or labelled `needs-human-merge`; read as `mergedLowsFiled`). The tag is accepted only where
 * such a round can exist: `med` is 0, `low` is at least 1 and there is no
 * `unstated` field. Whitespace is normalised the way check-pass-budget's
 * selectRounds normalises it (trimmed, every run collapsed to one space), so
 * the two agree on every value (its test iterates the variants). Returns null
 * for anything else (absent, extra or missing fields, a non-integer, the tag
 * on a round that could not have merged), so a malformed value is never read
 * as zeros.
 *
 * @param {unknown} value
 */
export function parseFindingsKey(value) {
  if (typeof value !== "string") return null;
  const m = /^f1:(\d+) f2:(\d+) f3:(\d+) f4:(\d+) med:(\d+) low:(\d+)(?: unstated:(\d+))?( merged:lows-filed)?$/.exec(value.trim().replace(/\s+/g, " "));
  if (!m) return null;
  const [f1, f2, f3, f4, med, low, unstated] = m.slice(1, 8).map((x) => (x === undefined ? 0 : Number(x)));
  const mergedLowsFiled = m[8] !== undefined;
  if (mergedLowsFiled && (m[7] !== undefined || med !== 0 || low === 0)) return null;
  return { f1, f2, f3, f4, med, low, unstated, mergedLowsFiled };
}

/**
 * Returns a copy of one PR analysis whose per-round severity comes from the
 * bead's `findings_r<N>` keys where they exist and parse, and from the prose
 * parse (classifySeverity, ugcportal-7w83's known faults) otherwise. Every
 * round carries `source` ("keys" or "prose") and, when a key was present but
 * not used, `fallbackReason` ("malformed", "inconsistent" or "multi-pr") with
 * a `fallbackLabel` naming the key. (`no-such-round` and `keyed-conflict` are
 * not set here: the first is found by orphanFindingsKeys, the second by
 * keyedConflicts, and each falls back to the prose figure or to the larger
 * keyed one.) The input is not mutated: a PR can be shared by several beads.
 *
 * Inconsistent: the key records no findings at all (all counts zero) while
 * the verdict's own prose states findings -- labelled severities, or a bare
 * findings count ("three findings") with no severity words. A round that
 * blocked on findings recorded as all zeros is exactly the shape that would
 * make a zero look measured, so the prose figure is kept and the round is
 * flagged. A bare findings count does not make a round inconsistent only when
 * the verdict line itself (the first non-empty line, as classifySeverity
 * reads `clean`) is approval-shaped: it opens with Approved / Auto-approved /
 * Clean / No findings / Zero findings / Verified clean, contains one of
 * NONE_RE's no-findings phrases, states no findings count, and carries none of
 * "Blocking:", "Not merged", "block(s)", "left for a human" (the `clean` rule
 * of classifySeverity, which the comment above `approvalShaped` there states
 * in full). A
 * quote of the band rule ("merge requires zero findings") after a
 * non-approval opening word does not read clean, and neither does a
 * "Verified, no finding:" sub-heading in a blocking round (M1, #285 round 4:
 * #157 r3, #207 r2, #209 r4; P1, round 3: #277 r1, #258 r1); but a blocking
 * line that opens with an approval word and carries none of the blocking
 * words does read clean (peom), so an all-zero key on such a round is not
 * flagged (an addendum comment's bare count still joins the round and clears
 * this, 4hsc). And
 * "round-2 findings" is a back-reference, not a count (N1, #285 round 2).
 *
 * A finding recorded as `unstated:<n>` counts as medium-or-above in the
 * round (pr-review-merge step 4: an unclassified finding counts as medium
 * until someone classifies it) and is carried separately as
 * `unstatedFindings`.
 *
 * Which key a round reads (L4): `findings_pr<number>_r<N>` is the key read for
 * that PR; the bare `findings_r<N>` applies only when `keysApply` (the bead
 * has one PR with marker rounds). A bare key skipped for that reason is
 * reported as `multi-pr`.
 *
 * @param {ReturnType<typeof analysePr>} pr
 * @param {Record<string, unknown>} meta
 * @param {boolean} keysApply
 */
export function withFindingsKeys(pr, meta, keysApply = true) {
  const rounds = pr.rounds.map((r) => {
    const specific = meta?.[`findings_pr${pr.number}_r${r.n}`];
    const bare = meta?.[`findings_r${r.n}`];
    const raw = specific !== undefined && specific !== null ? specific : keysApply ? bare : undefined;
    if (raw === undefined || raw === null) {
      if (!keysApply && bare !== undefined && bare !== null) return { ...r, source: "prose", fallbackReason: "multi-pr", fallbackLabel: `findings_r${r.n}` };
      return { ...r, source: "prose" };
    }
    const k = parseFindingsKey(raw);
    if (!k) return { ...r, source: "prose", fallbackReason: "malformed", fallbackLabel: specific !== undefined && specific !== null ? `pr${pr.number} r${r.n}` : `r${r.n}` };
    const empty = k.f1 + k.f2 + k.f3 + k.f4 + k.med + k.low + k.unstated === 0;
    if (empty && (r.medium + r.low > 0 || ((r.findings ?? 0) > 0 && !r.clean))) return { ...r, source: "prose", fallbackReason: "inconsistent", fallbackLabel: specific !== undefined && specific !== null ? `pr${pr.number} r${r.n}` : `r${r.n}` };
    return { ...r, medium: k.med + k.unstated, low: k.low, stated: true, source: "keys", keyed: k };
  });
  return { ...pr, rounds };
}

/**
 * Keys on a bead that no round used because the round does not exist in the
 * chain (`findings_r3` on a PR with rounds 1-2, or a `findings_pr<n>_r<N>`
 * for a PR not in the bead's `prs`). Returns `["r3", "pr901 r2"]`.
 */
export function orphanFindingsKeys(meta, prAnalyses) {
  const out = [];
  for (const key of Object.keys(meta ?? {})) {
    const bare = /^findings_r(\d+)$/.exec(key);
    if (bare && !prAnalyses.some((p) => p.rounds.some((r) => r.n === Number(bare[1])))) out.push(`r${bare[1]}`);
    const spec = /^findings_pr(\d+)_r(\d+)$/.exec(key);
    if (spec) {
      const p = prAnalyses.find((x) => x.number === Number(spec[1]));
      if (!p || !p.rounds.some((r) => r.n === Number(spec[2]))) out.push(`pr${spec[1]} r${spec[2]}`);
    }
  }
  return out.sort();
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

// --- cost unit (ugcportal-cii0) -------------------------------------------
//
// A bead carries its cost in exactly ONE of two units, and this is the one
// place that decides which (CLAUDE.md > "Token cost metadata"):
//
//   "ite"     transcript-derived cost: cost_ite_impl / cost_ite_qa, input-token
//             equivalents summed over every API call of every agent, from
//             scripts/agent-pass-cost.mjs. Proportional to price only for a
//             model priced at the standard ratios; cost-performance-claims-
//             v0.7.0 section 1.2 names two models where it overstates the
//             cache-read part.
//   "context" no accepted cost_ite_* figure (absent, 0, malformed, or on a
//             side marked incomplete): tokens_impl / tokens_qa, the agent's
//             context size at its last call (same document, section 1.2).
//             Not cost, and printed with CONTEXT_LABEL.
//
// Only a positive integer counts as an ITE figure. A cost_ite_* key that is
// 0, negative, fractional or non-numeric is not one (a 0 is what a transcript
// sum over agents with no transcript yields, and must not print as a measured
// zero cost): it is listed in `iteRejected`, shown under Data gaps, and the
// bead falls back to its context-size figures. Nor is a cost_ite_* on a side
// whose coverage is marked incomplete (coverageIncomplete below): that value
// survives from an earlier complete recording that a later INCOMPLETE one
// left behind, so it misses at least the later agents. It is listed in
// `iteIncomplete` and shown under Data gaps. A bead with at least one
// accepted ITE figure is read in "ite" and its tokens_* are not read at all,
// so no row and no total ever adds one unit to the other.
//
// tokens_impl_convention is normalised (trimmed, lower-cased, `_` read as
// `-`). Absent or `last-per-agent` counts tokens_impl; `summed-snapshots`
// flags a value that added one resumed agent's cumulative snapshots and is
// not counted; any other value is unknown and is not counted either. Both
// exclusions are listed under Data gaps.
//
// tokens_qa_convention (ugcportal-zu0a) reads the same way for tokens_qa:
// absent or `last-per-agent` counts it; ANY other value -- `summed-snapshots`,
// `undeterminable` (the audit could not tie the figure to its reviewer
// agents' transcripts), or one nobody defined -- is not counted and is listed
// under Data gaps with its value. A bead with no tokens_qa_convention is read
// at face value, as before; so does one whose value is blank.

export const CONTEXT_LABEL = "context-size, not cost";
export const SUMMED_SNAPSHOTS = "summed-snapshots";
export const LAST_PER_AGENT = "last-per-agent";

/** A positive integer, or null for anything else (0, "abc", 1.5, absent). */
export function positiveInt(v) {
  const n = toInt(v);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

export function normaliseConvention(v) {
  if (v === null || v === undefined) return null;
  return String(v).trim().toLowerCase().replace(/_/g, "-");
}

export const ALL_PRESENT = "all transcripts present";

/**
 * Whether the bead records that `side`'s cost coverage is incomplete: a
 * `cost_coverage_<side>` key with any non-empty value (the INCOMPLETE
 * recording writes it; only a human who has backfilled every earlier agent
 * id removes it), or a `cost_note_<side>` that does not begin with
 * "all transcripts present" (what a complete recording writes). Returns the
 * key that marks it, or null. This is the state that makes the coverage
 * check hold across recordings (ugcportal-cii0 M3): an INCOMPLETE recording
 * writes the agents it knows of into cost_agents_<side>, which would
 * otherwise read on the next recording as a list covering the whole figure.
 */
export function coverageIncomplete(meta, side) {
  const filled = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  if (filled(meta[`cost_coverage_${side}`])) return `cost_coverage_${side}`;
  const note = meta[`cost_note_${side}`];
  if (filled(note) && !String(note).trim().toLowerCase().startsWith(ALL_PRESENT)) return `cost_note_${side}`;
  return null;
}

/**
 * Per-round transcript cost (ugcportal-gmzi): `cost_ite_qa_rN` beside
 * `tokens_qa_rN`. A round exists when either key does. A round counts as
 * costed only when its cost_ite_qa_rN is a positive integer; a 0 or a
 * non-integer is listed in `rejected` (with its value) and never read as a
 * figure, the same rule costUnitOf applies to cost_ite_qa (a 0 is what an
 * empty transcript sum gives). Nothing here sums the rounds.
 */
export function perRoundCost(meta = {}) {
  const ns = new Set();
  for (const k of Object.keys(meta)) {
    const m = /^(?:tokens_qa|cost_ite_qa)_r(\d+)$/.exec(k);
    if (m) ns.add(Number(m[1]));
  }
  const rounds = [...ns].sort((a, b) => a - b).map((n) => {
    const raw = meta[`cost_ite_qa_r${n}`];
    const present = raw !== undefined && raw !== null && raw !== "";
    const ite = positiveInt(raw);
    return { n, ite, rejected: present && ite === null ? String(raw) : null };
  });
  return {
    rounds,
    withCost: rounds.filter((r) => r.ite !== null).length,
    total: rounds.length,
    without: rounds.filter((r) => r.ite === null && r.rejected === null).map((r) => `r${r.n}`),
    rejected: rounds.filter((r) => r.rejected !== null).map((r) => `r${r.n}=${r.rejected}`),
  };
}

export function costUnitOf(meta = {}) {
  const iteRejected = [];
  const iteIncomplete = [];
  const ite = {};
  for (const side of ["impl", "qa"]) {
    const key = `cost_ite_${side}`;
    const present = meta[key] !== undefined && meta[key] !== null && meta[key] !== "";
    ite[side] = positiveInt(meta[key]);
    if (present && ite[side] === null) iteRejected.push(`${key}=${meta[key]}`);
    const marked = coverageIncomplete(meta, side);
    if (ite[side] !== null && marked) {
      iteIncomplete.push(`${key}=${meta[key]}, ${marked}`);
      ite[side] = null;
    }
  }
  const base = { implSummedExcluded: false, implConventionUnknown: null, qaConventionExcluded: null, iteRejected, iteIncomplete };
  if (ite.impl !== null || ite.qa !== null) return { ...base, unit: "ite", impl: ite.impl, qa: ite.qa };
  const ctxImpl = toInt(meta.tokens_impl);
  const ctxQa = toInt(meta.tokens_qa);
  if (ctxImpl === null && ctxQa === null) return { ...base, unit: null, impl: null, qa: null };
  const conv = normaliseConvention(meta.tokens_impl_convention);
  const summed = ctxImpl !== null && conv === SUMMED_SNAPSHOTS;
  const unknown = ctxImpl !== null && conv !== null && conv !== SUMMED_SNAPSHOTS && conv !== LAST_PER_AGENT ? String(meta.tokens_impl_convention) : null;
  const qaConv = normaliseConvention(meta.tokens_qa_convention);
  const qaExcluded = ctxQa !== null && qaConv !== null && qaConv !== "" && qaConv !== LAST_PER_AGENT ? String(meta.tokens_qa_convention).trim() : null;
  return { ...base, unit: "context", impl: summed || unknown !== null ? null : ctxImpl, qa: qaExcluded !== null ? null : ctxQa, implSummedExcluded: summed, implConventionUnknown: unknown, qaConventionExcluded: qaExcluded };
}

/**
 * The recording rule, applied to scripts/agent-pass-cost.mjs --json rows for
 * a list of agent ids (CLAUDE.md > "Token cost metadata" runs this through a
 * one-liner). Per agent:
 *   ctx  = its LAST notification's figure; when the agent has more passes
 *          than notifications (its final pass got none), the final pass's
 *          ctxEnd from the transcript instead -- the same quantity (section
 *          1.2). Summed over distinct agents: the value for tokens_impl/_qa.
 *   ite, calls = summed over every pass of every agent.
 * `complete` is false when any listed agent has no transcript row, or --
 * given the bead's current metadata and the side -- when the list does not
 * cover what the bead already records (`uncoveredFigures`):
 *   - a side an earlier recording marked incomplete (coverageIncomplete:
 *     "marked incomplete by <key>"), whatever the list now holds;
 *   - an agent already in cost_agents_<side> that the list drops ("dropped <id>");
 *   - for qa, any tokens_qa_rN with no tokens_qa_rN_agent ("rN": a round
 *     recorded before agent ids were kept), or whose agent id is recorded but
 *     not in the list ("rN unlisted");
 *   - a tokens_<side> recorded with no cost_agents_<side> at all.
 * Then ite, calls and ctx are all null: a sum over the agents that have a
 * transcript, or over only the newest agent, is partial, and over none it
 * is a 0 that would read as a measured zero. Write cost_note_* naming
 * `missing` / `uncoveredFigures` and cost_coverage_<side> (`marker`)
 * instead of any cost_ite_* key, unset any cost_ite_* and cost_calls_*
 * already there, and do not overwrite tokens_<side>.
 */
export function agentCostFromPasses(rows, agentIds, { meta = null, side = null } = {}) {
  const want = [...new Set(agentIds.filter(Boolean))];
  const byAgent = new Map(want.map((id) => [id, []]));
  for (const r of rows) if (byAgent.has(r.agentId)) byAgent.get(r.agentId).push(r);
  const missing = want.filter((id) => byAgent.get(id).length === 0);
  const passes = [...byAgent.values()].reduce((a, rs) => a + rs.length, 0);
  const uncoveredFigures = meta ? uncoveredByAgents(meta, side, want) : [];
  const complete = want.length > 0 && missing.length === 0 && uncoveredFigures.length === 0;
  const marker = meta && side ? String(meta[`cost_coverage_${side}`] ?? "").trim() || null : null;
  if (!complete) return { complete, side, marker, agents: want.length, passes, missing, uncoveredFigures, ite: null, calls: null, ctx: null };
  let ite = 0, calls = 0, ctx = 0;
  for (const rs of byAgent.values()) {
    const sorted = rs.slice().sort((a, b) => a.pass - b.pass);
    const notified = sorted[0].notified ?? [];
    ctx += notified.length >= sorted.length ? notified[notified.length - 1] : sorted[sorted.length - 1].ctxEnd;
    for (const r of sorted) { ite += r.ite; calls += r.calls; }
  }
  return { complete, side, marker, agents: want.length, passes, missing, uncoveredFigures, ite, calls, ctx };
}

/** What `meta` already records for `side` that the agent list `ids` does not cover. */
export function uncoveredByAgents(meta, side, ids) {
  if (side !== "impl" && side !== "qa") throw new Error(`side must be impl or qa, got ${side}`);
  const listed = new Set(ids);
  const out = [];
  const marked = coverageIncomplete(meta, side);
  if (marked) out.push(`marked incomplete by ${marked}`);
  const recorded = String(meta[`cost_agents_${side}`] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const id of recorded) if (!listed.has(id)) out.push(`dropped ${id}`);
  let rounds = [];
  if (side === "qa") {
    rounds = Object.keys(meta).map((k) => /^tokens_qa_r(\d+)$/.exec(k)?.[1]).filter(Boolean).sort((x, y) => Number(x) - Number(y));
    for (const n of rounds) {
      const agent = meta[`tokens_qa_r${n}_agent`];
      if (!agent || !String(agent).trim()) out.push(`r${n}`);
      else if (!listed.has(String(agent).trim())) out.push(`r${n} unlisted`);
    }
  }
  // A figure with neither an agent list nor per-round keys to check it against.
  if (toInt(meta[`tokens_${side}`]) !== null && recorded.length === 0 && rounds.length === 0) {
    out.push(`tokens_${side} recorded before cost_agents_${side}`);
  }
  return out;
}

export function formatAgentCost(c) {
  if (!c.complete) {
    const uncovered = c.uncoveredFigures ?? [];
    const dropped = uncovered.filter((u) => u.startsWith("dropped ")).map((u) => u.slice(8));
    const noId = uncovered.filter((u) => /^r\d+$/.test(u));
    const unlisted = uncovered.filter((u) => /^r\d+ unlisted$/.test(u)).map((u) => u.split(" ")[0]);
    const marked = uncovered.filter((u) => u.startsWith("marked incomplete by ")).map((u) => u.slice(21));
    const preRule = uncovered.filter((u) => / recorded before cost_agents_/.test(u));
    const why = [
      c.missing.length ? `missing: ${c.missing.join(",")}` : "",
      marked.length ? `marked incomplete by an earlier recording: ${marked.join(",")}` : "",
      noId.length ? `rounds without agent ids: ${noId.join(", ")}` : "",
      unlisted.length ? `rounds whose agents are not in the list: ${unlisted.join(", ")}` : "",
      dropped.length ? `recorded agents dropped from the list: ${dropped.join(",")}` : "",
      preRule.length ? preRule.join("; ") : "",
    ].filter(Boolean).join("; ") || "no agents listed";
    const s = c.side ?? "<side>";
    // An existing marker is kept as it is: only a human who backfilled clears it.
    const marker = c.marker ?? `incomplete: ${why}`;
    return `INCOMPLETE agents=${c.agents} passes=${c.passes} missing=${c.missing.join(",") || "none"} uncovered=${uncovered.join(",") || "none"} -- write no cost_ite_*/cost_calls_* and unset any already there, do not overwrite tokens_* from this; set cost_note_${s} to "${why}" and cost_coverage_${s} to "${marker}"`;
  }
  return `ite=${c.ite} calls=${c.calls} ctx=${c.ctx} agents=${c.agents} passes=${c.passes} missing=none uncovered=none`;
}

/**
 * What CLAUDE.md's one-liner calls: `passesPath` is agent-pass-cost.mjs
 * --json output, `ids` the comma-separated agent list, `beadPath` a saved
 * `bd show <id> --json`, `side` impl or qa. Every argument is required, so
 * the coverage check above cannot be skipped by leaving one out.
 */
export function runAgentCost(passesPath, ids, beadPath, side) {
  if (!passesPath || !ids || !beadPath || !side) throw new Error("usage: runAgentCost(<passes.json>, <id,id>, <bd show --json file>, impl|qa)");
  const rows = JSON.parse(fs.readFileSync(passesPath, "utf8"));
  const shown = JSON.parse(fs.readFileSync(beadPath, "utf8"));
  const bead = Array.isArray(shown) ? shown[0] : shown;
  if (!bead || typeof bead !== "object") throw new Error(`${beadPath}: no bead in that file`);
  const agentIds = [...new Set(ids.split(",").map((x) => x.trim()).filter(Boolean))];
  const summary = formatAgentCost(agentCostFromPasses(rows, agentIds, { meta: bead.metadata ?? {}, side }));
  return [summary, ...agentCostLines(rows, agentIds)].join("\n");
}

/**
 * One line per listed agent, after the summary: `agent=<id> ite=<n> calls=<n>
 * passes=<n>` (that agent's figures summed over its passes), so a round's
 * cost_ite_qa_r<N> / cost_calls_qa_r<N> is copied from the command already
 * run (ugcportal-gmzi). An agent with no transcript prints `agent=<id>
 * missing`, never an ite= of 0.
 */
export function agentCostLines(rows, agentIds) {
  return agentIds.map((id) => {
    const mine = rows.filter((r) => r.agentId === id);
    if (mine.length === 0) return `agent=${id} missing`;
    return `agent=${id} ite=${mine.reduce((a, r) => a + r.ite, 0)} calls=${mine.reduce((a, r) => a + r.calls, 0)} passes=${mine.length}`;
  });
}

/** The unit label printed beside a bead's figures. */
export function unitLabel(unit) {
  if (unit === "ite") return "ITE (cost)";
  if (unit === "context") return CONTEXT_LABEL;
  return "—";
}

export function buildRows(release, beadsById, prAnalysesByNumber) {
  const rows = [];
  for (const id of release.ids) {
    const bead = beadsById.get(id);
    const entry = release.entries.get(id);
    const meta = bead?.metadata ?? {};
    const prs = parsePrs(meta.prs);
    const rawAnalyses = prs.map((n) => prAnalysesByNumber.get(n)).filter(Boolean);
    const keysApply = rawAnalyses.filter((p) => p.rounds.length > 0).length <= 1;
    const prAnalyses = rawAnalyses.map((p) => withFindingsKeys(p, meta, keysApply));
    const est = estimateFlags(`${bead?.notes ?? ""}\n${bead?.close_reason ?? ""}`);
    // One unit per bead: `impl`/`qa` hold the context-size figures and
    // `iteImpl`/`iteQa` the transcript cost, and a row fills only one pair,
    // so every existing sum below stays within its unit by construction.
    const cost = costUnitOf(meta);
    const impl = cost.unit === "context" ? cost.impl : null;
    const qa = cost.unit === "context" ? cost.qa : null;
    const iteImpl = cost.unit === "ite" ? cost.impl : null;
    const iteQa = cost.unit === "ite" ? cost.qa : null;
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
      unit: cost.unit,
      implSummedExcluded: cost.implSummedExcluded,
      implConventionUnknown: cost.implConventionUnknown,
      qaConventionExcluded: cost.qaConventionExcluded,
      iteRejected: cost.iteRejected,
      iteIncomplete: cost.iteIncomplete,
      impl,
      qa,
      iteImpl,
      iteQa,
      roundCost: perRoundCost(meta),
      iteTotal: iteImpl === null && iteQa === null ? null : (iteImpl ?? 0) + (iteQa ?? 0),
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
      prKeyed: Object.fromEntries(prAnalyses.map((p) => [p.number, p.rounds.some((r) => r.source === "keys")])),
      prRounds: Object.fromEntries(prAnalyses.map((p) => [p.number, p.chain.status === "broken" ? p.chain.highest : p.chain.ns.length])),
      lowsLabelled: allRounds.reduce((a, r) => a + (r.stated ? r.low : 0), 0),
      unstatedRounds: allRounds.filter((r) => !r.stated).length,
      // Per PR, so a PR shared by two beads is counted once (roundsSplit).
      prRoundSplit: Object.fromEntries(prAnalyses.map((p) => [p.number, { keys: p.rounds.filter((r) => r.source === "keys").length, prose: p.rounds.filter((r) => r.source !== "keys").length }])),
      roundsFromKeys: allRounds.filter((r) => r.source === "keys").length,
      roundsFromProse: allRounds.filter((r) => r.source !== "keys").length,
      // One entry per key, deduped: a bare key skipped on a two-PR bead is
      // the same key for both PRs, and prints once.
      keyFallbacks: [
        ...new Set([
          ...allRounds.filter((r) => r.fallbackReason).map((r) => `${r.fallbackLabel ?? `r${r.n}`} ${r.fallbackReason}`),
          ...orphanFindingsKeys(meta, prAnalyses).map((k) => `${k} no-such-round`),
        ]),
      ],
      // `findings_unstamped`: findings of review passes that stamped no round
      // marker. Not matched to a marker; only counted.
      unstampedPasses: typeof meta.findings_unstamped === "string" ? meta.findings_unstamped.split(",").filter((x) => x.trim()).length : 0,
      // Findings a key recorded with no severity; counted in `mediums` above.
      unstatedFindings: allRounds.reduce((a, r) => a + (r.keyed?.unstated ?? 0), 0),
      // Keyed severity and family counts per round, for the --json export
      // (the raw `prs` export is the prose parse only).
      roundDetail: prAnalyses.flatMap((p) =>
        p.rounds.map((r) => ({ pr: p.number, n: r.n, source: r.source, medium: r.medium, low: r.low, stated: r.stated, fallbackReason: r.fallbackReason ?? null, families: r.keyed ? { f1: r.keyed.f1, f2: r.keyed.f2, f3: r.keyed.f3, f4: r.keyed.f4 } : null, unstated: r.keyed?.unstated ?? 0, mergedLowsFiled: r.keyed?.mergedLowsFiled === true })),
      ),
      families: allRounds.reduce((a, r) => (r.keyed ? { f1: a.f1 + r.keyed.f1, f2: a.f2 + r.keyed.f2, f3: a.f3 + r.keyed.f3, f4: a.f4 + r.keyed.f4 } : a), { f1: 0, f2: 0, f3: 0, f4: 0 }),
      tail: markerRounds.length ? tailRounds(allRounds) : null,
      // Rounds whose key carries `merged:lows-filed` (ugcportal-kwxh): the round
      // ended by the gate with its lows filed (the PR merged, or carries
      // `needs-human-merge` for a human to merge), not a blocked lows round. Counted inside `tail` all the same.
      mergedLowsFiled: prAnalyses.flatMap((p) => p.rounds.filter((r) => r.keyed?.mergedLowsFiled).map((r) => `#${p.number} r${r.n}`)),
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

/**
 * PRs on which two beads both carry keys and read different medium counts.
 * Only the PR-title bead is meant to receive keys (step 4a item 2), so this is
 * a recording error; `aggregate` keeps the larger figure (an order-independent
 * choice) and this names the disagreement. Returns `["gh-906 (a 3 vs c 0; larger kept)"]` (ids without the `ugcportal-` prefix).
 */
export function keyedConflicts(rows) {
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    for (const [n, m] of Object.entries(r.prMediums ?? {})) {
      if (!r.prKeyed?.[n]) continue;
      const first = seen.get(n);
      if (!first) seen.set(n, { id: r.id, m });
      else if (first.m !== m) out.push(`gh-${n} (${first.id.replace("ugcportal-", "")} ${first.m} vs ${r.id.replace("ugcportal-", "")} ${m}; larger kept)`);
    }
  }
  return out;
}

/**
 * How many marker rounds read from `findings_rN` keys and how many fell back
 * to the prose parse, counting each PR once like `aggregate`'s mediums (L2,
 * #285 round 3): a PR shared by two beads reports the reading of the bead
 * that carries the most keyed rounds for it (the PR-title bead, step 4a item
 * 2), so the sibling's prose reading of the same rounds is not a second,
 * fallen-back count. `fellBack` lists the beads whose reading was counted;
 * `siblings` lists the other beads on those PRs, as `id (gh-N)`.
 */
export function roundsSplit(rows) {
  const best = new Map();
  for (const r of rows) {
    for (const [n, sp] of Object.entries(r.prRoundSplit ?? {})) {
      if (sp.keys + sp.prose === 0) continue; // a PR with no marker rounds has none to count (zu69)
      const cur = best.get(n);
      if (!cur || sp.keys > cur.sp.keys) best.set(n, { id: r.id, sp });
    }
  }
  const short = (id) => id.replace("ugcportal-", "");
  const fellBack = new Map();
  for (const { id, sp } of best.values()) if (sp.prose > 0) fellBack.set(id, (fellBack.get(id) ?? 0) + sp.prose);
  const siblings = [];
  for (const r of rows) for (const n of Object.keys(r.prRoundSplit ?? {})) if (best.has(n) && best.get(n).id !== r.id) siblings.push(`${short(r.id)} (gh-${n})`);
  return {
    fromKeys: sum([...best.values()].map((v) => v.sp.keys)),
    fromProse: sum([...best.values()].map((v) => v.sp.prose)),
    fellBack: [...fellBack].map(([id, c]) => `${short(id)} (${c})`),
    siblings,
  };
}

export function aggregate(rows) {
  const impl = rows.map((r) => r.impl).filter((v) => v !== null);
  const qa = rows.map((r) => r.qa).filter((v) => v !== null);
  const total = rows.map((r) => r.total).filter((v) => v !== null);
  // Count each PR once even when several beads share it (gh-59, gh-60,
  // gh-101). Beads on one PR read the same prose but may carry different
  // keys, so the figure is chosen without regard to row order: a keyed
  // reading beats a prose one, and among readings of the same kind the
  // larger wins. The rounds median stays per bead, since a bead is the unit
  // the budget applies to.
  const prMediums = new Map();
  for (const r of rows) {
    for (const [n, m] of Object.entries(r.prMediums ?? {})) {
      const keyed = Boolean(r.prKeyed?.[n]);
      const cur = prMediums.get(n);
      if (!cur || (keyed && !cur.keyed) || (keyed === cur.keyed && m > cur.m)) prMediums.set(n, { m, keyed });
    }
  }
  const rounds = rows.map((r) => r.rounds).filter((v) => v !== null);
  return {
    n: rows.length,
    nImpl: impl.length,
    nQa: qa.length,
    nAny: rows.filter((r) => r.impl !== null || r.qa !== null || r.iteTotal != null).length,
    // Transcript cost (ITE), summed only over rows read in that unit; the
    // impl/qa/grand totals above and below are context-size only (cii0).
    nIte: rows.filter((r) => r.iteTotal != null).length,
    iteImplTotal: sum(rows.map((r) => r.iteImpl ?? null)),
    iteQaTotal: sum(rows.map((r) => r.iteQa ?? null)),
    iteGrandTotal: sum(rows.map((r) => r.iteImpl ?? null)) + sum(rows.map((r) => r.iteQa ?? null)),
    nContext: rows.filter((r) => r.unit === "context").length,
    nSummedExcluded: rows.filter((r) => r.implSummedExcluded).length,
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
    mediums: sum([...prMediums.values()].map((v) => v.m)),
    unstated: sum(rows.map((r) => r.unstatedRounds)),
    roundsFromKeys: roundsSplit(rows).fromKeys,
    roundsFromProse: roundsSplit(rows).fromProse,
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
      // The calibration signal (CLAUDE.md > "Model-fit metadata"), in its own
      // columns: never added to the context-size columns above.
      nIte: group.filter((r) => r.iteTotal != null).length,
      iteTotal: sum(group.map((r) => r.iteTotal ?? null)),
      iteMedian: median(group.map((r) => r.iteTotal).filter((v) => v != null)),
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
  const headers = ["Bead", "Type", "Scope", "Tier/effort", "Impl", "QA", "Total", "Unit", "PRs", "Rounds", "Chain", "Mediums by round", "Lows (labels)", "qa/round", "QA ITE by round (rounds with cost n/m)", "Outcome (heuristic)"];
  // Rows are ranked within their unit (ITE first), never across units.
  const unitRank = (r) => (r.unit === "ite" ? 0 : r.unit === "context" ? 1 : 2);
  const body = rows
    .slice()
    .sort((a, b) => unitRank(a) - unitRank(b) || ((b.unit === "ite" ? b.iteTotal : b.total) ?? -1) - ((a.unit === "ite" ? a.iteTotal : a.total) ?? -1))
    .map((r) => [
      `\`${r.id.replace("ugcportal-", "")}\``,
      r.ccType ?? "—",
      r.scope ?? "—",
      r.tier ? `${r.tier}/${r.effort ?? "?"}` : "—",
      r.unit === "ite" ? fmt(r.iteImpl) : r.implSummedExcluded ? "excluded (summed snapshots)" : fmtTokens(r.impl, r.implEstimated),
      r.unit === "ite" ? fmt(r.iteQa) : r.qaConventionExcluded ? `excluded (${r.qaConventionExcluded})` : fmtTokens(r.qa, r.qaEstimated),
      // The total is marked as an estimate only by a side that contributes to it (not excluded, not absent).
      r.unit === "ite" ? fmt(r.iteTotal) : fmtTokens(r.total, (r.impl !== null && r.implEstimated) || (r.qa !== null && r.qaEstimated)),
      unitLabel(r.unit),
      r.prs.length ? r.prs.map((n) => `#${n}`).join(", ") : "—",
      r.rounds === null ? "—" : `${r.rounds}${r.roundsSource === "close reason" ? " (cr)" : r.roundsSource.startsWith("markers (") ? " (!)" : ""}`,
      r.chain,
      r.rounds !== null && r.roundsSource === "close reason" ? `n/a (${r.inlineLabelled.medium} labelled medium, ${r.inlineLabelled.unstated} unlabelled, ~${r.inlineBursts} bursts)` : r.mediumsByRound,
      r.rounds !== null && r.roundsSource === "close reason" ? `${r.inlineLabelled.low}` : String(r.lowsLabelled),
      r.perRound === null ? "—" : fmtTokens(r.perRound, r.qaEstimated || r.roundsSource !== "markers"),
      r.roundCost.total === 0 ? "—" : `${r.roundCost.rounds.map((x) => `r${x.n} ${x.ite === null ? "?" : fmt(x.ite)}`).join("; ")} (${r.roundCost.withCost}/${r.roundCost.total})`,
      r.outcome,
    ]);
  return mdTable(headers, body);
}

function renderAggregateTable(name, rows) {
  const headers = ["Group", "Beads", "with impl", "with qa", "impl total", "qa total", "Total", "impl median", "qa median", "ITE total (beads)", "Rounds median (n)", "At cap", "Mediums (keys, else verdict labels)"];
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
    agg.nIte ? `${fmt(agg.iteGrandTotal)} (${agg.nIte})` : "—",
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
  const headers = ["Tier", "Beads", "with rounds", "Passed in ≤2 rounds", "Reached cap (≥6)", "Rounds median", "qa total", "qa median", "impl total", "impl median", "Mediums (keys, else verdict labels)", "qa/round median", "ITE beads", "ITE total", "ITE median"];
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
    String(t.nIte),
    t.nIte ? fmt(t.iteTotal) : "—",
    t.nIte ? fmt(t.iteMedian) : "—",
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
    r.tail === null ? "—" : `${r.tail}${r.mergedLowsFiled?.length ? ` (${r.mergedLowsFiled.join(", ")} ended by the gate, lows filed)` : ""}`,
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
    // "In the bead's unit": an ITE bead with tokens_qa but no cost_ite_qa has
    // no QA figure here, and is listed with its unit so that reads right.
    const unitOf = (r) => `${r.id.replace("ugcportal-", "")} (${r.unit ?? "none"})`;
    const noImpl = rows.filter((r) => r.impl === null && r.iteImpl == null && !r.implSummedExcluded && !r.implConventionUnknown).map(unitOf);
    const noQa = rows.filter((r) => r.qa === null && r.iteQa == null && !r.qaConventionExcluded).map(unitOf);
    const noRounds = rows.filter((r) => r.prs.length && r.rounds === null).map((r) => r.id.replace("ugcportal-", ""));
    const noPr = rows.filter((r) => !r.prs.length).map((r) => r.id.replace("ugcportal-", ""));
    const crRounds = rows.filter((r) => r.roundsSource === "close reason").map((r) => r.id.replace("ugcportal-", ""));
    const disagree = rows.filter((r) => r.roundsSource.startsWith("markers (")).map((r) => `${r.id.replace("ugcportal-", "")} (${r.roundsSource})`);
    const unstated = rows.filter((r) => r.unstatedRounds > 0).map((r) => `${r.id.replace("ugcportal-", "")} (${r.unstatedRounds})`);
    const broken = rows.filter((r) => /broken/.test(r.chain)).map((r) => `${r.id.replace("ugcportal-", "")} ${r.chain}`);
    const missing = rows.filter((r) => r.missingBead).map((r) => r.id);
    lines.push(`- **${version}**`);
    lines.push(`  - no impl figure in the bead's unit (${noImpl.length}): ${noImpl.join(", ") || "—"}`);
    lines.push(`  - no QA figure in the bead's unit (${noQa.length}): ${noQa.join(", ") || "—"}`);
    const rejected = rows.filter((r) => r.iteRejected?.length).map((r) => `${r.id.replace("ugcportal-", "")} (${r.iteRejected.join(", ")})`);
    if (rejected.length) lines.push(`  - \`cost_ite_*\` not a positive integer, not read as ITE (${rejected.length}): ${rejected.join("; ")}`);
    const stale = rows.filter((r) => r.iteIncomplete?.length).map((r) => `${r.id.replace("ugcportal-", "")} (${r.iteIncomplete.join("; ")})`);
    if (stale.length) lines.push(`  - \`cost_ite_*\` on a side whose coverage is marked incomplete, not read as ITE (${stale.length}): ${stale.join("; ")}`);
    const unknownConv = rows.filter((r) => r.implConventionUnknown).map((r) => `${r.id.replace("ugcportal-", "")} (${r.implConventionUnknown})`);
    if (unknownConv.length) lines.push(`  - \`tokens_impl\` not counted, unknown \`tokens_impl_convention\` (${unknownConv.length}): ${unknownConv.join("; ")}`);
    const summedOut = rows.filter((r) => r.implSummedExcluded).map((r) => r.id.replace("ugcportal-", ""));
    if (summedOut.length) lines.push(`  - \`tokens_impl\` not counted, flagged \`tokens_impl_convention=${SUMMED_SNAPSHOTS}\` (${summedOut.length}): ${summedOut.join(", ")}`);
    const qaOut = rows.filter((r) => r.qaConventionExcluded).map((r) => `${r.id.replace("ugcportal-", "")} (${r.qaConventionExcluded})`);
    if (qaOut.length) lines.push(`  - \`tokens_qa\` not counted, flagged \`tokens_qa_convention\` (${qaOut.length}): ${qaOut.join("; ")}`);
    lines.push(`  - no PR in \`prs\` (${noPr.length}): ${noPr.join(", ") || "—"}`);
    lines.push(`  - PR but no round count from markers or close reason (${noRounds.length}): ${noRounds.join(", ") || "—"}`);
    lines.push(`  - round count from the close reason, not markers (${crRounds.length}): ${crRounds.join(", ") || "—"}`);
    if (disagree.length) lines.push(`  - markers and close reason disagree: ${disagree.join("; ")}`);
    const noRoundCost = rows.filter((r) => r.roundCost.without.length).map((r) => `${r.id.replace("ugcportal-", "")} (${r.roundCost.without.join(", ")})`);
    lines.push(`  - rounds with \`tokens_qa_rN\` but no \`cost_ite_qa_rN\` (${noRoundCost.length} beads): ${noRoundCost.join("; ") || "—"}`);
    const badRoundCost = rows.filter((r) => r.roundCost.rejected.length).map((r) => `${r.id.replace("ugcportal-", "")} (${r.roundCost.rejected.join(", ")})`);
    if (badRoundCost.length) lines.push(`  - \`cost_ite_qa_rN\` not a positive integer, not read as a round's cost (${badRoundCost.length}): ${badRoundCost.join("; ")}`);
    if (unstated.length) lines.push(`  - rounds whose verdict states no severity: ${unstated.join(", ")}`);
    const split = roundsSplit(rows);
    lines.push(`  - rounds whose severity came from \`findings_rN\` keys: ${split.fromKeys}; rounds that fell back to the prose parse: ${split.fromProse}${split.fellBack.length ? ` -- ${split.fellBack.join(", ")}` : ""}`);
    if (split.siblings.length) lines.push(`  - sibling bead, PR counted once (its rounds are counted once, under one other bead on the same PR, not again): ${split.siblings.join(", ")}`);
    const keyProblems = rows.filter((r) => r.keyFallbacks.length).map((r) => `${r.id.replace("ugcportal-", "")} (${r.keyFallbacks.join(", ")})`);
    if (keyProblems.length) lines.push(`  - \`findings_rN\` present but not used, prose kept (${keyProblems.length}): ${keyProblems.join("; ")}`);
    const unstatedF = rows.filter((r) => r.unstatedFindings > 0).map((r) => `${r.id.replace("ugcportal-", "")} (${r.unstatedFindings})`);
    const conflicts = keyedConflicts(rows);
    if (conflicts.length) lines.push(`  - \`findings_rN\` keyed-conflict, two beads on one PR keyed differently (recording error): ${conflicts.join("; ")}`);
    const unstamped = rows.filter((r) => r.unstampedPasses > 0).map((r) => `${r.id.replace("ugcportal-", "")} (${r.unstampedPasses})`);
    if (unstamped.length) lines.push(`  - unstamped review passes (\`findings_unstamped\`, not matched to a marker): ${unstamped.join(", ")}`);
    if (unstatedF.length) lines.push(`  - findings recorded \`unstated:<n>\`, counted as medium-or-above: ${unstatedF.join(", ")}`);
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
  out.push(`_Generated ${generatedAt} by \`node scripts/release-cost-report.mjs\`; reviewer identity \`${reviewer ?? "unknown"}\`; ${prCount} PRs read via \`gh\`. Legend: \`~\` = the bead's own notes call this figure an estimate; \`(cr)\` = round count from the close reason (pre-marker PR); \`(!)\` = markers and close reason disagree, markers shown; \`rN:?\` = that round's verdict states no severity; "Lows (labels)" counts a keyed round's \`low:<n>\` as recorded and an un-keyed round's severity labels, a single \`LOW:\` label often covers several items, so on prose rounds it is a floor; a keyed round's \`unstated:<n>\` is counted as medium, not low. qa/round is the QA figure divided by rounds, a crude mean (\`tokens_qa_rN\` is not read here; the per-round ITE column reads \`cost_ite_qa_rN\` and shows \`?\` for a round without one). Unit (ugcportal-cii0): each bead is read in ONE unit — \`ITE (cost)\` from \`cost_ite_impl\`/\`cost_ite_qa\` (transcript input-token equivalents, scripts/agent-pass-cost.mjs), or \`${CONTEXT_LABEL}\` from \`tokens_impl\`/\`tokens_qa\` when the bead has no accepted \`cost_ite_*\` figure (absent, 0, malformed, or on a side marked incomplete) (the agent's final context size, docs/process/cost-performance-claims-v0.7.0-2026-10-16.md section 1.2); impl/qa totals, medians, and the top-five tables are ${CONTEXT_LABEL}; the tier tables carry both, ITE in its own three columns; ITE is totalled only in its own columns and rows, and the two are never added._`);
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
    ["tokens_impl total (context-size, not cost)", ...aggs.map((a) => fmt(a.implTotal))],
    ["tokens_qa total (context-size, not cost)", ...aggs.map((a) => fmt(a.qaTotal))],
    ["Grand total (context-size, not cost)", ...aggs.map((a) => fmt(a.grandTotal))],
    ["Beads read as transcript cost (ITE) / as context-size", ...aggs.map((a) => `${a.nIte} / ${a.nContext}`)],
    ["ITE total, impl / qa / both (transcript cost)", ...aggs.map((a) => (a.nIte ? `${fmt(a.iteImplTotal)} / ${fmt(a.iteQaTotal)} / ${fmt(a.iteGrandTotal)}` : "—"))],
    ["tokens_impl excluded as summed snapshots", ...aggs.map((a) => String(a.nSummedExcluded))],
    ["tokens_impl median (beads with a figure)", ...aggs.map((a) => fmt(a.implMedian))],
    ["tokens_qa median (beads with a figure)", ...aggs.map((a) => fmt(a.qaMedian))],
    ["Review share of context-size (qa / impl+qa, not cost)", ...aggs.map((a) => pct(a.qaTotal, a.grandTotal))],
    ["Review share of transcript cost (ITE)", ...aggs.map((a) => pct(a.iteQaTotal, a.iteGrandTotal))],
    ["Rounds median (beads with a count)", ...aggs.map((a) => `${fmt(a.roundsMedian)} (n=${a.roundsN})`)],
    ["Beads whose PR reached the cap (≥6 rounds)", ...aggs.map((a) => String(a.capCount))],
    ["Mediums (keys, else verdict labels; marker PRs only, each PR once)", ...aggs.map((a) => String(a.mediums))],
    ["Rounds with no stated severity", ...aggs.map((a) => String(a.unstated))],
    ["Marker rounds read from findings_rN keys / from the prose parse (ugcportal-2jvh)", ...aggs.map((a) => `${a.roundsFromKeys} / ${a.roundsFromProse}`)],
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
    out.push(`### ${version}: five most expensive beads (${CONTEXT_LABEL})`);
    out.push("");
    out.push(renderTopTable(rowsByRelease.get(version)));
    out.push("");
  }
  if (ctx.controls) {
    out.push("### Process controls: runs, cost, wall clock, orchestrator share, catches");
    out.push("");
    out.push(ctx.controls);
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

// --- controls table (ugcportal-md4c) ----------------------------------------

/**
 * The fixed control list. `pattern` is the regex agent-pass-cost's --tool mode
 * is given (docs/process/cost-performance-claims-v0.7.0-2026-10-16.md
 * Appendix A); null = a control with no command to match.
 */
export const CONTROLS = [
  { name: "review-round-markers", pattern: String.raw`^\{"command":.*ugcportal-review-round` },
  { name: "claims-audit", pattern: String.raw`^\{"command":.*node \S*scripts/claims-audit\.mjs` },
  { name: "sweep-candidates", pattern: String.raw`^\{"command":.*node \S*scripts/sweep-candidates\.mjs` },
  { name: "dispatch-gate", pattern: String.raw`^\{"command":.*node \S*scripts/check-bead-dispatch\.mjs` },
  { name: "premise-audit", pattern: null },
];
export const CAUGHT_BY_KEY = "caught_by";

export function defaultTranscriptDir() {
  return path.join(os.homedir(), ".claude/projects/-Users-eiriksf-code-ugcportal");
}

/** Per control name, the beads whose caught_by names it; values outside the list are returned apart. */
export function catchesByControl(beads, controls = CONTROLS) {
  const counts = new Map(controls.map((c) => [c.name, []]));
  const unrecognised = [];
  for (const b of beads) {
    const raw = b?.metadata?.[CAUGHT_BY_KEY];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    for (const v of String(raw).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      if (counts.has(v)) { if (!counts.get(v).includes(b.id)) counts.get(v).push(b.id); }
      else unrecognised.push({ id: b.id, value: v });
    }
  }
  return { counts, unrecognised };
}

/** One control priced: scanTool's rows and reach, summed. `scan` is injectable for tests. */
export function priceControl(control, dir, before = null, scan = scanTool) {
  if (!control.pattern) return { control, priced: false };
  const t = scan(dir, new RegExp(control.pattern), before);
  const sumOf = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  const orch = t.rows.filter((r) => r.who === "orchestrator");
  return {
    control, priced: true,
    runs: sumOf(t.rows, "calls"), ite: sumOf(t.rows, "ite"), seconds: sumOf(t.rows, "seconds"),
    orchRuns: sumOf(orch, "calls"), orchIte: sumOf(orch, "ite"),
    examined: t.filesExamined, matched: t.rows.length,
    skipped: { unreadable: t.unreadable, malformedLines: t.malformedLines, badUsage: t.badUsage, unpriced: t.unpriced },
    lowerBound: t.badUsage > 0 || t.unpriced > 0 || t.unreadable > 0 || t.malformedLines > 0,
  };
}

export function renderControlsTable(priced, catches, { dir, before } = {}) {
  const headers = ["Control", "Runs", "Cost (ITE)", "Wall clock", "Orchestrator share", "Catches", "Files examined / matched"];
  const rows = priced.map((p) => {
    const sk = p.priced && p.lowerBound ? ` (${p.skipped.unreadable} files skipped unreadable, ${p.skipped.malformedLines} malformed lines, ${p.skipped.badUsage} entries with bad usage, ${p.skipped.unpriced} calls unpriced)` : "";
    const nCatch = String(catches.counts.get(p.control.name)?.length ?? 0);
    if (!p.priced) return [p.control.name, "n/a", "n/a", "n/a", "n/a", nCatch, "n/a (no command pattern; agents, not commands)"];
    if (p.matched === 0) {
      return [p.control.name, "0 (pattern matched nothing)", "— (nothing matched)", "—", "—", nCatch, `0 of ${p.examined} files matched${sk}`];
    }
    const lb = p.lowerBound ? ">=" : "";
    return [
      p.control.name, `${lb}${fmt(p.runs)}`, `${lb}${fmt(p.ite)}`, `${lb}${fmt(p.seconds)} s`,
      p.ite > 0 ? `${pct(p.orchIte, p.ite)} of cost (${fmt(p.orchRuns)} of ${fmt(p.runs)} runs)` : `${fmt(p.orchRuns)} of ${fmt(p.runs)} runs`,
      nCatch, `${fmt(p.examined)} examined / ${fmt(p.matched)} matched${sk}`,
    ];
  });
  const out = [
    `Transcripts: \`${dir ?? defaultTranscriptDir()}\`. Window: calls before ${before ?? "now"}, NO lower bound (agent-pass-cost offers none). Cost = input-token equivalents of the API turns that issued each call; Catches = beads carrying \`${CAUGHT_BY_KEY}=<control>\` (all beads read, not only the release's).`,
    "",
    mdTable(headers, rows),
  ];
  const lowers = priced.filter((p) => p.priced && p.lowerBound).map((p) => p.control.name);
  if (lowers.length) out.push("", `LOWER BOUND (input was skipped or unpriced; \`>=\`): ${lowers.join(", ")}.`);
  if (catches.unrecognised.length) {
    out.push("", `\`${CAUGHT_BY_KEY}\` values not in the control list, not counted above: ${catches.unrecognised.map((u) => `${u.id}=${u.value}`).join(", ")}.`);
  }
  return out.join("\n");
}

export function controlsSection(beads, dir, before = null, controls = CONTROLS, scan = scanTool) {
  const priced = controls.map((c) => priceControl(c, dir, before, scan));
  return renderControlsTable(priced, catchesByControl(beads, controls), { dir, before });
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
    else if (a === "--transcripts") opts.transcripts = next();
    else if (a === "--controls-only") opts.controlsOnly = true;
    else if (a === "--before") opts.before = next();
    else if (a === "--allow-unmerged") opts.allowUnmerged = true;
    else if (a === "--repo") opts.repo = next();
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.controlsOnly) {
    console.log(controlsSection(loadBeads(opts), opts.transcripts ?? defaultTranscriptDir(), opts.before ?? null));
    return;
  }
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
  const report = renderReport({ releases: opts.releases, rowsByRelease, membershipChecks, unmerged, generatedAt, reviewer, prCount: prNumbers.size, controls: opts.transcripts ? controlsSection(beads, opts.transcripts, opts.before ?? null) : null });

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
