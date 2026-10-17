#!/usr/bin/env node
/**
 * The dispatch gate: a bead fails a mechanical check BEFORE work starts on
 * it (ugcportal-kt3k). Exits non-zero when a bead is missing any required
 * element of the bead-template form, or when its premise is stale. Stale
 * means one of: its `Premise verified` line names a commit that is not on
 * `main` at all (not an ancestor of `origin/main`, usually a branch commit
 * whose PR was since squash-merged -- main has the change, under the squash
 * commit's different sha -- and sometimes a branch not yet merged; either
 * way it cannot be path-compared with main's HEAD); or a commit on `main`
 * since the premise touched a path the bead's `Premise depends on:` line
 * declares; or the bead declares no dependency at all -- a premise with no
 * `Premise depends on:` line fails, because absent must not read as `none`;
 * or the declaration cannot be checked (it lists nothing, an item is not
 * a repo-relative path, or `none` is combined with anything but one
 * parenthesised reason); or a declared path does not exist at origin/main's
 * HEAD (ugcportal-ul2j). `PREMISE_FRESHNESS_COST`'s comment gives the rules
 * in the order the check applies them.
 *
 * Why this exists: `~/.claude/skills/bead-template/SKILL.md` has defined the
 * required form -- user story, In/Out of scope, K-numbered Given/When/Then
 * criteria each with a `Verified by`, a "should never happen" guardrail, a
 * `Premise verified` line, and this repo's metadata -- for the whole life of
 * the backlog, and nothing enforced it. Measured 2026-10-12 at origin/main
 * a3d55c9 over the 95 open beads: 12 fail at least one of the eight
 * presence-only elements, and 21 fail at least one check in `CHECKS` below.
 * `CHECKS` differs from those eight elements in five places, not three or
 * four: it is STRICTER on three of them (`criteria` wants `K<n>:` markers
 * and not merely 50 characters; `verified-by` wants one inside EVERY
 * criterion's own span rather than one anywhere in the field;
 * `premise-present` wants a token git resolves to a commit rather than the
 * words) and it adds two elements the audit did not count at all
 * (`user-story`, `no-placeholder`). See the PR for the per-check table.
 * bead-template records why `bd lint` is not sufficient on its own: it
 * checks that an acceptance-criteria *section* exists, and not the
 * guardrail, the Verified-by clauses, the scope lines, the premise or the
 * metadata.
 *
 * Two decisions by Eirik, both of which cost something and are therefore
 * worth stating rather than inferring from the code:
 *
 *   1. The premise must be FRESH AT DISPATCH, not merely present. This was
 *      first written (ugcportal-kt3k) as "names origin/main's current HEAD",
 *      strict on purpose: the v0.7.0 premise audit
 *      (docs/process/premise-audit-v0.7.0-2026-10-08.md, ugcportal-j5fl)
 *      found that only 68 of 136 non-closed beads carried a premise line at
 *      all, and those were up to 80 commits stale; ugcportal-kt3k's own
 *      notes record ugcportal-dabx's four-day-old premise being found partly
 *      wrong on 2026-10-12. Measured 2026-10-13 that identity rule failed
 *      107 of 110 open beads, because every merge invalidated every premise
 *      at once -- and a gate that fires on nearly everything is cleared by
 *      copying the sha forward without re-running the observation, which is
 *      the exact thing it exists to stop. So, by Eirik's decision of
 *      2026-10-13 (ugcportal-ul2j), freshness is now SCOPED BY DEPENDENCY
 *      PATHS: a bead declares the paths its premise rests on, and goes stale
 *      when main's movement since the premise touched one of them. See
 *      `PREMISE_FRESHNESS_COST` below for what that trusts and costs.
 *   2. A failing bead is a HARD BLOCK, not a warning. Hence a non-zero exit
 *      on a finding -- unlike this script's sibling
 *      `check-unreachable-beads.mjs`, which reports what it finds and
 *      deliberately does not fail on it.
 *
 * WHAT THIS SCRIPT CANNOT SEE, and the reason every run prints
 * `SUBSTANCE_CHECKS_NOT_MADE` whether it passed or failed. The standing
 * case is ugcportal-p3v: the criterion that forces checkout to re-evaluate
 * sellability was authored, rewritten and premise-verified across three
 * dated notes in that bead and NEVER REACHED ITS ACCEPTANCE FIELD. It is
 * now ugcportal-zbcs, a P1. Every field this script reads was populated
 * throughout; the missing thing was a requirement, and no check below can
 * see a requirement that is absent.
 *
 * Be exact about what p3v proves, because the shorthand "p3v passes every
 * mechanical check" is no longer literally true and a reader will check:
 * run against p3v on 2026-10-12 at origin/main a3d55c9 this script FAILS it
 * on four checks (guardrail, no-placeholder, premise-present,
 * premise-fresh), because its acceptance field has since been cut down to a
 * single K1 with a leading `(replace K1)` editing instruction and its
 * premise lines name no commit. What p3v
 * proves is the SHAPE, not a live green run -- a bead's populated fields
 * tell you nothing about whether the requirement that matters is among
 * them. bead-template says it in its own words: "the expensive bead
 * failures are substance failures, not format failures." A zero exit from
 * this script means the bead is well-FORMED. It does not mean it is RIGHT.
 *
 * Usage:
 *   node scripts/check-bead-dispatch.mjs <bead-id> [<bead-id> ...]
 *   node scripts/check-bead-dispatch.mjs --all
 *
 *     --all            validate every open and in-progress bead (backlog
 *                      sweep) instead of the ids given on the command line
 *     --beads <file>   read a beads array from a JSON file (a saved
 *                      `bd show --json` / `bd list --json` dump) instead of
 *                      running `bd` live; this is how the tests drive the
 *                      CLI end to end without touching the live database
 *     --head <sha>     treat this commit as `origin/main`'s HEAD instead of
 *                      asking git; for tests and for dry runs
 *     --repo <dir>     run the git lookups in this repository instead of the
 *                      one this script lives in; the tests use it to build a
 *                      throwaway repo with a known history, so the premise
 *                      staleness count they assert does not depend on this
 *                      repo having been fetched
 *     --json           machine-readable output instead of the text report
 *
 * Exit status -- the gate itself, since K5 requires the decision to be an
 * exit code and not a sentence someone may forget to read:
 *     0  every bead examined passed every check
 *     1  at least one bead failed at least one check
 *     2  usage error, or a bead id that `bd` cannot resolve
 *
 * No `--execute` and no `--fix`: this script only reads. It never mutates a
 * bead, because a gate that edits the thing it is grading cannot be trusted
 * to have graded it.
 *
 * Self-test: npm test -- runs scripts/check-bead-dispatch.test.mjs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What "fresh" means, what it trusts, and what it costs (ugcportal-ul2j).
 *
 * The rule, in the order the check applies it:
 *
 *   1. The premise commit must be ON main: an ancestor of `origin/main` (or
 *      HEAD itself). `premiseCommits` counts both directions -- `behind`,
 *      main's commits the premise lacks, and `notOnMain`, the premise's own
 *      commits main lacks. A commit built on top of HEAD (a premise verified
 *      inside a branch) has `behind === 0` and is still not on main; in this
 *      repo's squash-merge flow it STAYS off main after its PR merges. Its
 *      changes cannot be path-compared with main's history, so it fails, and
 *      an off-main premise never rescues a stale on-main one.
 *   2. The FRESHEST on-main premise statement is the one judged -- the one
 *      the fewest main commits have passed. Each statement is dated by the
 *      first commit after its label (the one it was verified at), not by
 *      the newest commit its line happens to name. A bead re-verified today still
 *      carries yesterday's line in its log, and the newer verification and
 *      its declaration supersede the older ones.
 *   3. That statement must carry a `Premise depends on:` declaration
 *      (`PREMISE_DEPENDS_FORM`). Absent is a FAILURE, never read as "none":
 *      a check that matched nothing must not look like one that passed. A
 *      declaration that cannot be checked fails too (`parseDeclaration`:
 *      empty, whitespace inside a path, absolute, a `..` segment, a glob,
 *      or `none` combined with anything but one parenthesised reason).
 *   4. `Premise depends on: none (<why>)` -- an explicit declaration that the
 *      premise rests on no file in this repository (an external fact: an API's
 *      behaviour, a vendor document, a legal rule) -- does not go stale on a
 *      merge at all.
 *   5. Otherwise, any commit in `<premise>..<origin/main>` that touched a
 *      declared path makes it stale. The failure names the first five such
 *      commits, oldest first, each with up to five of the declared files it
 *      touched, and then counts the rest ("and N more commit(s)", "and N
 *      more file(s)"). A declared directory covers
 *      everything under it; matching is literal (`[id]` is a directory name,
 *      not a glob) and renames count as touching both names.
 *   6. A declared path that does not exist at origin/main's HEAD fails,
 *      even when nothing touched it. A typo is otherwise the quietest
 *      possible understatement: a path that matches no file is touched only
 *      by a commit that creates a file there, so a misspelt declaration
 *      would in practice pass on every merge. A premise that
 *      rests on something being ABSENT declares the nearest existing parent
 *      directory, which a commit adding the thing will touch.
 *
 * WHAT THIS TRUSTS. The declaration is author-supplied, and this script
 * does not check it against the premise. A premise that rests on a file its
 * declaration leaves out passes here however much that file has changed --
 * the test "K5: an understated declaration passes" shows exactly that. The
 * old identity rule could not be fooled this way; it was loud about every
 * merge instead. Mitigation, and it is a mitigation, not a guarantee: the
 * declaration is printed with every run (a passing one says which paths it
 * checked, so whoever reads the gate output sees a short list next to a
 * long premise), a declared path that does not exist fails, and
 * `SUBSTANCE_CHECKS_NOT_MADE` names the completeness of the list as a
 * judgement this script does not make.
 *
 * Cost: a bead whose premise rests on code main has touched fails, and
 * bringing it back to green means re-running its premise check against
 * origin/main's HEAD and writing a new `Premise verified` line and
 * declaration. That is the point -- it is the re-verification pass, not a
 * formality. A bead whose declared paths main has not touched does NOT need
 * re-verifying, however many commits have landed: that is the change from
 * the identity rule, which fired on every bead on every merge.
 *
 * Alternatives rejected on 2026-10-13 (ugcportal-ul2j): "within N commits"
 * and "within N days" both need a constant nothing here measured, and the
 * second passes a premise invalidated an hour ago; the status quo fires on
 * nearly every bead and so trains the copy-forward; warn-only gives up the
 * hard block.
 */
export const PREMISE_DEPENDS_FORM =
  "`Premise depends on: <path>, <path>` (repo-relative files or directories, comma-separated, on the premise line or the line right after it), or `Premise depends on: none (<the external fact the premise rests on>)` when no file in this repository can make it false";

export const PREMISE_FRESHNESS_COST = `Re-run the premise check against origin/main's current HEAD and write a new \`Premise verified <date> at origin/main <sha>\` line followed by ${PREMISE_DEPENDS_FORM}; do not copy the sha forward without re-running the observation.`;

/**
 * The substance checks this script does NOT make, printed on EVERY run --
 * passing or failing. K4. Each is named individually rather than summarised,
 * because "this does not check everything" is a sentence a reader skips and
 * "this did not check whether the premise is true" is not.
 */
export const SUBSTANCE_CHECKS_NOT_MADE = [
  "Whether the premise is TRUE. This checked that a premise line names a commit on origin/main and that no commit since touched a path the bead's `Premise depends on:` line declares. It did not read the premise, and it did not re-run whatever command the premise claims was run. A premise that is fresh by this rule -- or re-verified against today's HEAD -- and still wrong passes here.",
  "Whether the DEPENDENCY PATHS are complete. `Premise depends on:` is written by the bead's author and trusted: a premise resting on a file the declaration leaves out passes here however much that file has changed, and `none` passes on every merge. A declared path that does not exist fails; a real path that is missing from the list cannot be seen.",
  "Whether each criterion is SATISFIABLE by whoever finishes this bead, on the day they finish it. A `Verified by` that restates the criterion, or that points at another bead's output, passes this script and cannot be honestly closed (bead-template, substance check 2).",
  "Whether the GUARDRAIL guards anything. A `Following should never happen:` line that is the positive criterion inverted satisfies the grep and can never fail.",
  "Whether the MODEL TIER fits the work. `model` and `model_effort` are checked for presence and for being legal values; nothing here judges whether `sonnet` was the right call for this bead.",
  "Whether a criterion that SHOULD exist is MISSING. This is the expensive one, and it is the reason a zero exit above is not a verdict on the bead. ugcportal-p3v carried the criterion that stops uncleared material being sold through three dated notes and never moved it into its acceptance field; it is now ugcportal-zbcs, a P1. Every field checked above was populated the whole time. A green run here is evidence that the fields are populated, not that the right requirements are in them.",
];

// --- premise parsing ---------------------------------------------------------

/** A git commit-ish token: 7-40 hex characters as a whole word. */
const SHA_RE = /\b([0-9a-f]{7,40})\b/g;

/**
 * Every premise statement in a bead, with any commit-ish tokens found in it.
 *
 * Three deliberate tolerances, each from a real bead that the obvious strict
 * version would have failed for a reason unrelated to its premise:
 *
 *   - Matches `Premise verified`, `Premise measured`, `Premise checked`,
 *     `PREMISE CORRECTED` and a bare `Premise:` alike. ugcportal-ydbi writes
 *     "Premise measured" because its premise was a count rather than a fact;
 *     ugcportal-6zdu writes "PREMISE CORRECTED ... before dispatch". Failing
 *     those would be failing a bead for a synonym.
 *   - Reads `description` as well as `notes`. bead-template puts the line in
 *     notes, but ugcportal-48zb (and others) carry it in the description, and
 *     a premise that was genuinely verified should not fail for sitting one
 *     field over.
 *   - A sha that wrapped onto the next line is still found -- but only that
 *     wrap, narrowly: when the premise line itself names no commit and the
 *     next line OPENS with one ("Premise verified 2026-10-10 against <branch>
 *     at" / "6da3675: read ...", ugcportal-48zb's shape). The next line is
 *     otherwise never read for commits. It used to be joined whole, and a
 *     log line under a premise ("Dispatched ... from origin/main <newer>")
 *     then lent the premise a commit it was never verified at; the freshest
 *     such commit is the one judged, so the premise was compared with main
 *     only from the borrowed commit on, and a touch in between was never
 *     seen (PR #289 review, M1; ugcportal-5x8 and ugcportal-rma carried the
 *     shape on 2026-10-17, borrowing d23add1 from a SCOPE EXTENDED line).
 *
 * A statement whose commit cannot be isolated this way names no commit and
 * is skipped, not failed: `premise-present` fails the bead loudly when NO
 * statement names a commit, and when another statement does, judging that
 * one instead can only examine the same or more of main's history -- an
 * unreadable statement never makes the judged commit fresher.
 *
 * A premise statement is a line where the word `premise` is used as a
 * LABEL: followed by `verified`, `checked`, `measured` or `confirmed`
 * (each also with `re-`), by `corrected`, or by a colon -- after optional
 * `,` or `(` ("premise (verified 2026-10-08 at ...)") -- and where that word
 * opens the line or follows a clause boundary (`.`, `:`, `;`, `!`, `?`, `,`,
 * `(` or `[`, then only whitespace or markup). A line that merely mentions
 * the word ("the premise-fresh gate run at <sha> was green") is not one, and
 * neither is one using the label form mid-sentence ("on the premise: the
 * gate at <sha> was green"): either would otherwise date the premise from
 * that sha and take the declaration under it (PR #289 review, M1's sibling
 * shapes in rounds 1 and 2).
 *
 * A statement's `shas` are the commit tokens after its label, in order;
 * `premiseCommits` dates the statement by the first of them that resolves --
 * the commit it was verified at -- not by the freshest one the line names.
 *
 * A line that OPENS with `Premise depends on:` is a declaration, not a
 * premise statement, and starts none of its own; and on any statement, the
 * text from `Premise depends on:` onwards is cut before commit tokens are
 * looked for, so a hex-looking path segment is not read as a commit. Each statement carries the declaration that
 * belongs to it -- see `findDeclaration`.
 *
 * @param {string} notes
 * @param {string} description
 * @returns {Array<{line: string, shas: string[], depends: Declaration}>}
 */
export function findPremiseLines(notes, description = "") {
  const out = [];
  for (const field of [String(notes || ""), String(description || "")]) {
    const lines = field.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!isPremiseStatementStart(lines[i])) continue;
      const own = shasIn(lines[i]);
      const next = lines[i + 1] || "";
      const wrapped = own.length === 0 && !isPremiseStatementStart(next) && !DEPENDS_LINE_RE.test(next) ? LEADING_SHA_RE.exec(next) : null;
      const statement = wrapped ? `${lines[i].trim()} ${next.trim()}` : lines[i].trim();
      out.push({ line: statement, shas: wrapped ? [wrapped[1]] : own, depends: findDeclaration(lines, i) });
    }
  }
  return out;
}

/**
 * The declaration label, anywhere on a line. Not `\b`: `_` is a word
 * character, so `\b` would miss `_Premise depends on:_`, a line
 * DEPENDS_LINE_RE accepts as a declaration -- the two must agree.
 */
const DEPENDS_RE = /(?<![A-Za-z0-9])premise depends on\s*:/i;
/** A line that IS a declaration: the label opens it, after any list or emphasis markup. */
const DEPENDS_LINE_RE = /^[\s*_>`#-]*premise depends on\s*:/i;

/**
 * `premise` used as a label -- see findPremiseLines. Not `premise-fresh`, not
 * "the premise of", and not mid-sentence: the word must open the line or
 * follow a clause boundary (`.`, `:`, `;`, `!`, `?`, `,`, `(`, `[`), with only
 * whitespace or markup between, so "on the premise: the gate at <sha> was
 * green" is not a statement but "2026-10-06 audit: premise re-verified" is.
 */
const PREMISE_LABEL_RE = /(?:^|[.:;!?,(\[])[\s`*_>#(\[-]*premise(?![\w-])[\s,(]*(?:(?:re-?)?(?:verified|checked|measured|confirmed)\b|corrected\b|:)/i;
/** A line that OPENS with a commit token, after any quoting or list markup: the hard-wrap continuation. */
const LEADING_SHA_RE = /^[\s`*_>(\[-]*([0-9a-f]{7,40})\b/;

function isPremiseStatementStart(line) {
  return PREMISE_LABEL_RE.test(line) && !DEPENDS_LINE_RE.test(line);
}

/**
 * Commit tokens on a premise statement's line, in order, from its label up to
 * any `Premise depends on:` label (a hex-looking path segment is not a
 * commit). Text before the label is a different note and lends nothing.
 */
function shasIn(line) {
  const label = PREMISE_LABEL_RE.exec(line);
  return [...line.slice(label ? label.index : 0).split(DEPENDS_RE)[0].matchAll(SHA_RE)].map((m) => m[1]);
}

/**
 * @typedef {{kind: "missing"} |
 *           {kind: "none", reason: string, raw: string} |
 *           {kind: "paths", paths: string[], problems: string[], raw: string}} Declaration
 */

/**
 * The `Premise depends on:` declaration that belongs to the premise
 * statement starting at `lines[start]`.
 *
 * It is searched for on the statement's own line (after the word "premise",
 * the shape of a one-line note: "Premise verified ... Premise depends on:
 * a, b") and then on the following lines, stopping at a blank line or at the
 * next premise statement -- so one statement can never borrow another's
 * declaration, and a declaration that sits further away than that is not
 * found. A line in between that is not a premise statement (a dispatch log
 * line, say) is passed over: it lends the statement no commit (see
 * findPremiseLines), so the declaration below it is judged against the
 * statement's own commit, not a newer one a log line names. The one
 * exception is the hard wrap: a line that OPENS with a sha, directly under a
 * premise line naming none, is read as that premise's own wrapped commit.
 *
 * Not found is `{kind: "missing"}`, which the check FAILS: absent is never
 * read as none.
 *
 * The list ends at the end of its line unless that line ends with a comma,
 * in which case it continues on the next one. Hard-wrapped text that splits
 * a path mid-word yields a path that does not exist, which fails loudly
 * rather than matching nothing quietly.
 *
 * @returns {Declaration}
 */
export function findDeclaration(lines, start) {
  for (let j = start; j < lines.length; j++) {
    if (j > start && (lines[j].trim() === "" || isPremiseStatementStart(lines[j]))) break;
    const m = DEPENDS_RE.exec(lines[j]);
    if (!m) continue;
    let raw = lines[j].slice(m.index + m[0].length).trim();
    for (let k = j + 1; raw.endsWith(",") && k < lines.length && lines[k].trim() !== ""; k++) {
      raw = `${raw} ${lines[k].trim()}`;
    }
    return parseDeclaration(raw);
  }
  return { kind: "missing" };
}

const NONE_ALONE = "`none` must stand alone, as `none` or `none (<why>)` -- not combined with paths or followed by other text";

/** True when `text` is one parenthesised group, nested parentheses allowed, and nothing after it but a `.` or `;`. */
function isOneParenthesisedGroup(text) {
  const body = text.replace(/[.;]$/, "");
  if (!body.startsWith("(")) return false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")" && --depth === 0) return i === body.length - 1;
    if (depth < 0) return false;
  }
  return false;
}

/**
 * Parse the text after `Premise depends on:`.
 *
 * Emphasis markup the label carried (`**Premise depends on:** x`, which the
 * line classifier `DEPENDS_LINE_RE` accepts) is stripped first: a leading
 * `**`/`__`/`*`/`_` standing alone before the value, and a trailing `**`
 * (not one after a `/`, which is the glob `dir/**` and fails as a glob).
 *
 * `none` as the first word is the explicit no-paths form, alone or followed
 * by one parenthesised reason (nested parentheses inside it are fine),
 * which is kept for the report; backtick quoting is ignored for this test,
 * so `` `none (x)` `` is `none` too. Anything else
 * is a comma-separated path list. Each item has surrounding backticks or
 * quotes, a leading `./`, and trailing sentence punctuation stripped; what remains must be a repo-relative path. Items that
 * are not (an empty list, whitespace inside an item, an absolute path, a
 * `..` segment, a glob character, `none` mixed with paths) are collected as
 * `problems`, and the check fails on any of them rather than guessing.
 *
 * @returns {Declaration}
 */
export function parseDeclaration(raw) {
  const text = String(raw || "")
    .trim()
    .replace(/^(?:\*\*|__|\*|_)(?=\s|$)/, "")
    .replace(/(?<!\/)\*\*$/, "")
    .trim();
  const none = /^none(?=$|\s|\()(.*)$/is.exec(text.replace(/`/g, ""));
  if (none) {
    const reason = none[1].trim();
    // `none` stands alone or with ONE parenthesised reason; anything else
    // after it (`none (x), src/a.ts`) would otherwise be read as a bare none
    // and drop the paths, so it fails instead.
    if (reason === "" || isOneParenthesisedGroup(reason)) return { kind: "none", reason, raw: text };
    return { kind: "paths", paths: [], problems: [NONE_ALONE], raw: text };
  }
  const paths = [];
  const problems = [];
  for (const item of text.split(",")) {
    const p = item
      .trim()
      .replace(/[.;:]+$/, "")
      .replace(/^[`'"\u2018\u201C]+|[`'"\u2019\u201D]+$/g, "")
      .replace(/[.;:]+$/, "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (!p) continue;
    if (/^none$/i.test(p)) problems.push(NONE_ALONE);
    else if (/\s/.test(p)) problems.push(`${JSON.stringify(p)} is not a path (it contains whitespace; separate paths with commas)`);
    else if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) problems.push(`${JSON.stringify(p)} is absolute; write it relative to the repository root`);
    else if (p.split("/").includes("..")) problems.push(`${JSON.stringify(p)} has a \`..\` segment; write it relative to the repository root`);
    else if (/[*?]/.test(p)) problems.push(`${JSON.stringify(p)} is a glob; declare the file or the directory instead`);
    else paths.push(p);
  }
  if (paths.length === 0 && problems.length === 0) problems.push("the declaration lists nothing");
  return { kind: "paths", paths: [...new Set(paths)], problems, raw: text };
}

// --- acceptance-criteria parsing ---------------------------------------------

/**
 * Split an acceptance-criteria blob into its K-numbered criteria. A
 * criterion starts at a `K<n>:` marker and runs to the next one, so its
 * `Verified by:` line -- which the form puts on the NEXT line, and which bd
 * re-wraps -- belongs to the criterion above it.
 *
 * Anything before the first marker is not a criterion and is dropped here;
 * an editing instruction left there (ugcportal-p3v's field opens with the
 * literal `(replace K1)`) is caught separately by the `no-placeholder`
 * check rather than silently absorbed into K1.
 *
 * @param {string} acceptance
 * @returns {Array<{label: string, body: string}>}
 */
export function splitCriteria(acceptance) {
  const text = String(acceptance || "");
  // A marker may start a line or follow whitespace mid-line: ugcportal-p3v's
  // field reads "(replace K1) K1: Given a buyer ...", and anchoring to the
  // line start would report "no K<n>: criterion" about a field that plainly
  // has one -- a true failure reported with a false reason.
  const markers = [...text.matchAll(/(?:^|[\n\s])(K\d+)\s*:/g)];
  const out = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index + markers[i][0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    out.push({ label: markers[i][1], body: text.slice(start, end) });
  }
  return out;
}

// --- metadata vocabularies ---------------------------------------------------

/** Model tier labels from CLAUDE.md "Model-fit metadata". */
export const MODEL_TIERS = ["haiku", "sonnet", "opus", "fable"];
/** Effort levels from CLAUDE.md "Model-fit metadata". */
export const MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Conventional-Commit types from CLAUDE.md's table. */
export const CC_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

/**
 * Editing instructions and placeholders that mean a field was never
 * finished. Scoped to `description` and `acceptance_criteria` only -- notes
 * legitimately carry a running delivery log, and "(fill in as work
 * progresses)" there is a log header rather than an unfinished requirement.
 *
 * This catches a SYMPTOM that ugcportal-p3v happens to have -- its
 * acceptance field opens with the literal string `(replace K1)` -- and it
 * is worth being exact about what that does and does not prove. It does not
 * catch p3v's actual defect, which is a criterion that is absent. A bead can
 * be free of every placeholder below and still be missing the thing that
 * matters. See SUBSTANCE_CHECKS_NOT_MADE.
 */
const PLACEHOLDER_RE = /\(replace\s+K\d+\)|\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b|<fill[^>]*>|\.\.\.TBD/i;

/**
 * Blank out text that QUOTES a placeholder rather than carrying one,
 * preserving length and line structure so nothing else shifts. Run on ONE
 * field at a time (the `no-placeholder` check calls it separately on the
 * description and on the acceptance criteria), so nothing it blanks can
 * reach from one field into the other.
 *
 * A bead that QUOTES a placeholder is not a bead that CARRIES one, and the
 * difference is not academic. Measured 2026-10-13 over the whole
 * open+in_progress backlog (104 beads), the only bead `no-placeholder`
 * fired on was `ugcportal-zbcs` -- the P1 that exists to REMOVE
 * `ugcportal-p3v`'s `(replace K1)` marker, which it names three times in
 * backticks. Unnarrowed, the gate hard-blocks dispatch of the bead whose
 * whole job is clearing the thing it is complaining about. Backticks are not
 * the only way this backlog quotes, though: `ugcportal-c20m`, filed after
 * that measurement, writes "leaving the marker '(replace K1)'" and "'TODO'"
 * in plain single quotes and failed the check for it.
 * So three things are blanked:
 *
 *   1. fenced blocks, ``` to ```, and
 *   2. inline code spans -- a run of backticks to the next run of the same
 *      length -- both only WITHIN ONE PARAGRAPH. An unbalanced backtick used
 *      to pair with the next backtick anywhere later in the text, across
 *      paragraphs and (when the two fields were scanned joined) across the
 *      description/acceptance boundary, blanking every bare marker in
 *      between, and an unbalanced fence did the same until fences were
 *      bounded too. Markdown code spans do not
 *      cross a blank line either;
 *   3. a marker that is the WHOLE content of a quotation: '...', "...",
 *      and their curly forms, opened and closed by a matching pair. Not any
 *      quoted text -- an apostrophe ("p3v's") is not a quotation mark, and
 *      blanking from one apostrophe to the next would hide real markers.
 *
 * Measured 2026-10-14 at about 11:24Z, origin/main 534a2c9, over a dump of
 * the live open+in_progress backlog (`bd list --status open,in_progress
 * --limit 0 --json`, 112 beads): `no-placeholder` fires on 0 of them. That
 * zero is after ugcportal-7sjc's own text was edited to put its two
 * mentions of the TODO marker in backticks; before that edit, on the same
 * day, it fired on 1 (7sjc itself, a bare mention in prose -- the check was
 * right to fire, since an unquoted marker is indistinguishable from a
 * carried one). The script at bcc470e (before fences and code spans were
 * bounded to one paragraph) and the script at this commit give identical
 * per-check counts over the same dump. A
 * figure like this is a snapshot of a moving backlog, not a property of the
 * script; the durable form is the fixtures in the tests. p3v itself is no
 * longer a live example -- it is deferred, outside that population, and its
 * acceptance field no longer opens with the marker -- so the bare-marker
 * case is held by the `no-placeholder` single-element fixture in the tests,
 * which puts `(replace K1)` bare at the head of the acceptance field.
 *
 * Known gap, stated as what is actually still not seen:
 *   - a genuinely unfinished field that writes its marker inside backticks
 *     (`` `TODO` ``) or as the entire content of a quotation ('TODO');
 *   - a bare marker that sits, within the SAME paragraph of the SAME field,
 *     between a stray backtick (or stray fence) and the next backtick (or
 *     fence) in that paragraph -- the pair is read as code and blanked.
 * The opposite error, which fails closed: a fenced block that contains a
 * blank line is cut at that line, which leaves the opening fence unbalanced
 * in its paragraph and the closing fence unbalanced in the next, so a bare
 * marker on EITHER side of the blank line is no longer blanked and is
 * reported as carried.
 * Accepted: the repo's convention is that backticks and quotes mean "this is
 * a literal being referred to", and the alternative -- a check whose only
 * live hits are quotations -- is worse. SUBSTANCE_CHECKS_NOT_MADE already
 * says a zero exit means well-formed, not right.
 */
function stripQuotedMarkers(text) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  // Split on blank lines FIRST, keeping the separators, and blank fences
  // and code spans inside one paragraph at a time, so an unbalanced fence
  // or backtick dies at the end of its paragraph. Removing fences before
  // the split let a stray ``` pair with the next fence anywhere later in
  // the field.
  const noSpans = text
    .split(/(\n[^\S\n]*\n)/)
    .map((para) => para.replace(/```[\s\S]*?```/g, blank).replace(/(`+)(?:[^`]|[^`][\s\S]*?)\1/g, blank))
    .join("");
  return noSpans.replace(QUOTED_MARKER_RE, (m, open, close) => (QUOTE_PAIRS[open] === close ? blank(m) : m));
}

/** Each opening quotation mark and the one that closes it. */
const QUOTE_PAIRS = { "'": "'", '"': '"', "‘": "’", "“": "”" };
/** A placeholder that is the whole content of a quotation; see stripQuotedMarkers. */
const QUOTED_MARKER_RE = new RegExp(`(['"\\u2018\\u201C])(?:${PLACEHOLDER_RE.source})(['"\\u2019\\u201D])`, "gi");

// --- the checks --------------------------------------------------------------

/**
 * One mechanical check. `fields` names the bead fields it reads, so the run
 * can report how many distinct fields it actually examined (K3) -- an
 * instrument that reports "0 failures" over 0 fields examined is the
 * fail-open shape ugcportal-kssp is about, and the counts are what make the
 * two distinguishable.
 *
 * `run` returns `{ok}` or `{ok: false, detail}`. `detail` must name the
 * missing element, because K1 requires the output to name what is missing
 * rather than just that something is.
 */
function check(id, label, fields, run) {
  return { id, label, fields, run };
}

const desc = (b) => String(b.description || "").trim();
/** Description with every run of whitespace collapsed to one space. `bd`
 *  hard-wraps stored text, so "so\nthat" and "I\nwant" are routine -- a
 *  user-story regex run against the raw field fails beads for a line break.
 *  Real case: ugcportal-48zb, whose benefit clause is split as "so\nthat". */
const descFlat = (b) => desc(b).replace(/\s+/g, " ");
/**
 * Description with runs of HORIZONTAL whitespace collapsed to one space and
 * line breaks left intact, for the checks that are about a *line*.
 *
 * `descFlat` is right for the user-story check, which spans sentences by
 * design, and wrong for the scope checks: it deletes every `\n` before the
 * regex runs, so the `\n` in `[^:.\n]{0,40}` below never has anything to
 * exclude and the tolerance silently spans paragraph breaks. Demonstrated
 * false passes against the flattened form:
 *   - "Caching is out of scope.\n\nNotes: see ugcportal-abc." -> passed
 *     `out-of-scope`, pairing a scope sentence with an unrelated
 *     paragraph's colon;
 *   - "Everything in scope here is fine.\nSee also: ..." -> passed
 *     `in-scope` the same way.
 * Both fail here, and the failure detail's word "line" is now accurate.
 */
const descLines = (b) => desc(b).replace(/[^\S\n]+/g, " ");
/** How much of the description the user-story check looks at. The story is
 *  the opening of the description by definition; beyond this the text is
 *  background, and "as" there should not be allowed to pair with an "I
 *  want" from the story above it. */
export const USER_STORY_WINDOW = 1000;
const accept = (b) => String(b.acceptance_criteria || "").trim();
const notes = (b) => String(b.notes || "");
const meta = (b) => b.metadata || {};

export const CHECKS = [
  check("description", "description is non-empty", ["description"], (b) =>
    desc(b) ? { ok: true } : { ok: false, detail: "description is empty" },
  ),

  check("user-story", "description opens with a user story", ["description"], (b) => {
    // The check is the three-part SHAPE IN ORDER -- "As <role> ... I want
    // <capability> ... so that <benefit>" -- inside the opening of the
    // description, and nothing narrower. Two narrower versions were written
    // and both failed well-formed beads in this backlog:
    //   - "As a|an|the": rejects "As Eirik", "As someone running the seeded
    //     Playwright suites by hand", "As the next person to read ...". The
    //     role is prose; enumerating its articles only rejects good stories.
    //   - stopping the span at the first "." : rejects every description
    //     that names a file or a step before its verb --
    //     docs/process/development-process.md (ugcportal-vh3c),
    //     `pr-review-merge` step 4.2 (ugcportal-8d5f, ugcportal-mcmj).
    // This is a HARD BLOCK, so a false failure costs a dispatch; the span
    // bounds are what stop "As" in one paragraph pairing with "I want" four
    // paragraphs down, and they are deliberately generous.
    const head = descFlat(b).slice(0, USER_STORY_WINDOW);
    if (/\bas\b.{0,400}?\bi want\b.{0,400}?\bso that\b/is.test(head)) return { ok: true };
    const missing = [
      !/\bas\b/i.test(head) && '"As <role>"',
      !/\bi want\b/i.test(head) && '"I want <capability>"',
      !/\bso that\b/i.test(head) && '"so that <benefit>"',
    ].filter(Boolean);
    return {
      ok: false,
      detail: missing.length
        ? `user story is missing ${missing.join(" and ")}`
        : `the description's first ${USER_STORY_WINDOW} characters contain "as", "I want" and "so that" but not as one user story in that order`,
    };
  }),

  // The two scope checks. What the 40 characters of tolerance may NOT cross
  // is the point of the character class, and all three exclusions are load
  // bearing:
  //   `:`  -- stop at the first colon, so the tolerance cannot reach past
  //           one label to the next one's colon;
  //   `\n` -- a line break ends the statement. Only live because these run
  //           against `descLines`; under `descFlat` it was dead code.
  //   `.`  -- so does a sentence boundary. Without it "Nothing is out of
  //           scope. Rationale: all of it ships." passes `out-of-scope` --
  //           the exact inverse of a scope boundary, and a single line, so
  //           the `\n` exclusion alone does not catch it.
  // What is deliberately NOT done: anchoring to line start. `ugcportal-e95r`,
  // `ugcportal-a9no` and `ugcportal-uwh1` all carry a genuine mid-paragraph
  // `Out of scope:` that a line-anchored form would fail. The 40-character
  // tolerance is likewise kept and measured: a bare /out of scope:/ reports
  // 3 failures, not 2, the third being `ugcportal-6zdu`'s "Out of scope,
  // and deliberately:" -- the line the form asks for, rejected for a
  // qualifier. Re-measured 2026-10-13 over the live 104-bead
  // open+in_progress backlog: the narrowing adds zero new failures, so no
  // real bead relies on crossing a line or a sentence to pass.
  //
  // `in-scope` also refuses the NEGATED label: "in scope" is a substring of
  // "Not in scope:", so without the lookbehind a description whose only
  // scope lines are "Not in scope: ..." and "Out of scope: ..." passes both
  // checks while stating nothing that IS in scope.
  // The lookbehind also allows markdown emphasis on either side of the
  // space -- `**Not** in scope:`, `_not_ in scope:`, `*not* in scope:`,
  // `Not **in scope**:` -- which a bare `not\s+` let through.
  // `(?:^|[^a-z0-9])` rather than `\b` before `not`,
  // because `_` is a word character and `\b` does not fire in `_not_`.
  // `out-of-scope` has no such twin -- "not out of scope" is not a label
  // anyone writes as one.
  check("in-scope", "description has an `In scope:` line", ["description"], (b) =>
    /(?<!(?:^|[^a-z0-9])not[*_]*[^\S\n]+[*_]*)\bin scope\b[^:.\n]{0,40}:/i.test(descLines(b))
      ? { ok: true }
      : { ok: false, detail: "no `In scope:` line in the description" },
  ),

  check("out-of-scope", "description has an `Out of scope:` line", ["description"], (b) =>
    /\bout of scope\b[^:.\n]{0,40}:/i.test(descLines(b))
      ? { ok: true }
      : { ok: false, detail: "no `Out of scope:` line in the description (bead-template calls this the single most effective line in the form)" },
  ),

  check("criteria", "acceptance criteria are K-numbered and not a stub", ["acceptance_criteria"], (b) => {
    const a = accept(b);
    if (!a) return { ok: false, detail: "acceptance criteria are empty" };
    const criteria = splitCriteria(a);
    if (criteria.length === 0) return { ok: false, detail: "acceptance criteria contain no `K<n>:` criterion" };
    if (a.length < 50) return { ok: false, detail: `acceptance criteria are a stub (${a.length} chars, under 50)` };
    return { ok: true };
  }),

  check("verified-by", "every K-numbered criterion carries a `Verified by:`", ["acceptance_criteria"], (b) => {
    const criteria = splitCriteria(accept(b));
    if (criteria.length === 0) return { ok: false, detail: "no `K<n>:` criterion to carry a `Verified by:`" };
    const without = criteria.filter((c) => !/verified\s+by\s*:/i.test(c.body)).map((c) => c.label);
    return without.length === 0
      ? { ok: true }
      : { ok: false, detail: `no \`Verified by:\` on ${without.join(", ")}` };
  }),

  check("guardrail", "at least one criterion is a `should never happen` guardrail", ["acceptance_criteria"], (b) =>
    /should never happen/i.test(accept(b))
      ? { ok: true }
      : { ok: false, detail: "no `Following should never happen:` guardrail criterion" },
  ),

  check("no-placeholder", "description and criteria carry no unfinished-editing marker", ["description", "acceptance_criteria"], (b) => {
    // Quotations are blanked first: a bead that quotes a marker is talking
    // about one, not carrying one. Each field is scanned on its own, so a
    // stray backtick in one cannot hide a marker in the other. See
    // stripQuotedMarkers.
    for (const [field, text] of [["description", desc(b)], ["acceptance_criteria", accept(b)]]) {
      const hit = PLACEHOLDER_RE.exec(stripQuotedMarkers(text));
      if (hit) return { ok: false, detail: `an unfinished-editing marker is still in the ${field}: ${JSON.stringify(hit[0])}` };
    }
    return { ok: true };
  }),

  check("premise-present", "a premise line names a real commit", ["notes", "description"], (b, ctx) => {
    const lines = findPremiseLines(notes(b), desc(b));
    if (lines.length === 0)
      return { ok: false, detail: "no `Premise verified` line in the notes or the description" };
    const resolved = premiseCommits(lines, ctx);
    if (resolved.length === 0) {
      const withTokens = lines.filter((l) => l.shas.length > 0);
      return {
        ok: false,
        detail:
          withTokens.length === 0
            ? "the premise line names no commit -- the form wants `Premise verified <date> at origin/main <sha>`, so that freshness is checkable"
            : `the premise line names ${withTokens.flatMap((l) => l.shas).join(", ")}, which git cannot resolve to a commit in this repo`,
      };
    }
    return { ok: true };
  }),

  check("premise-fresh", "no main commit since the premise touched a path it depends on", ["notes", "description"], (b, ctx) => {
    const resolved = premiseCommits(findPremiseLines(notes(b), desc(b)), ctx);
    if (resolved.length === 0) {
      // premise-present already reported the real problem; do not report it
      // twice under a different name.
      return { ok: false, detail: "no resolvable premise commit to check freshness against" };
    }
    // An unanswerable count (`git rev-list` failed) is Infinity: the
    // comparison was not made, so say so rather than print a count -- and
    // fail, since a comparison that was not made cannot have found the
    // premise fresh.
    const unmeasured = resolved.find((r) => !Number.isFinite(r.behind) || !Number.isFinite(r.notOnMain));
    if (unmeasured) {
      return {
        ok: false,
        detail: `premise commit ${unmeasured.short} could not be compared with head ref ${ctx.git.head}: \`git rev-list\` failed, so no commit count was measured. ${PREMISE_FRESHNESS_COST}`,
      };
    }
    // Only a premise commit ON main can be path-compared with main's
    // history; an off-main one never rescues a stale on-main one. See
    // PREMISE_FRESHNESS_COST's comment, rule 1.
    const onMain = resolved.filter((r) => r.notOnMain === 0);
    if (onMain.length === 0) {
      const off = resolved[0];
      return {
        ok: false,
        detail: `premise commit ${off.short} is not on origin/main: ${off.notOnMain} commit(s) of its history are not in origin/main ${ctx.headShort}. It is usually a branch commit whose PR was since squash-merged (main then has the change under a different sha), sometimes one not yet merged; either way it is not in main's history, so it cannot be compared with main's HEAD -- re-verify against origin/main's HEAD. ${PREMISE_FRESHNESS_COST}`,
      };
    }
    // Judge the freshest on-main premise (rule 2). Several statements can
    // tie -- the same commit named twice -- and their declarations combine.
    const behind = Math.min(...onMain.map((r) => r.behind));
    const freshest = onMain.filter((r) => r.behind === behind);
    const at = freshest[0];
    const where = `premise verified at ${at.full.slice(0, 7)} (${behind === 0 ? "origin/main's current HEAD" : `${behind} commit(s) behind origin/main ${ctx.headShort}`})`;
    const decl = combineDeclarations(freshest.map((r) => r.depends));
    if (decl.kind === "missing") {
      return {
        ok: false,
        detail: `${where} has no \`Premise depends on:\` line, so there is nothing to scope its freshness by; absent is not read as \`none\`. Add ${PREMISE_DEPENDS_FORM} -- after re-running the premise if it is not at origin/main's HEAD.`,
      };
    }
    if (decl.kind === "none") {
      return { ok: true, detail: `${where} declares \`Premise depends on: none\`${decl.reason ? ` ${decl.reason}` : ""}; no merge makes it stale` };
    }
    if (decl.problems.length > 0) {
      return { ok: false, detail: `${where}: its \`Premise depends on:\` line cannot be checked: ${decl.problems.join("; ")}. Write ${PREMISE_DEPENDS_FORM}.` };
    }
    const touching = behind === 0 ? [] : ctx.git.commitsTouching(at.full, decl.paths);
    if (touching === null) {
      return {
        ok: false,
        detail: `${where}: \`git log\` over ${at.short}..${ctx.headShort} failed, so whether it touched ${decl.paths.join(", ")} was not measured. ${PREMISE_FRESHNESS_COST}`,
      };
    }
    if (touching.length > 0) {
      const SHOWN = 5;
      const listed = touching
        .slice(0, SHOWN)
        .map((c) => `${c.sha.slice(0, 7)} touched ${c.files.slice(0, SHOWN).join(", ")}${c.files.length > SHOWN ? ` and ${c.files.length - SHOWN} more file(s)` : ""}`)
        .join("; ");
      return {
        ok: false,
        detail: `${where} is stale: ${touching.length} of those commit(s) touched a declared path -- ${listed}${touching.length > SHOWN ? `; and ${touching.length - SHOWN} more commit(s)` : ""}. ${PREMISE_FRESHNESS_COST}`,
      };
    }
    const absent = decl.paths.filter((p) => !ctx.git.pathExists(p));
    if (absent.length > 0) {
      return {
        ok: false,
        detail: `${where} declares ${absent.map((p) => JSON.stringify(p)).join(", ")}, which does not exist at origin/main ${ctx.headShort}. A path that matches no file is touched only by a commit that creates it, so a misspelt declaration would in practice pass on every merge; to depend on something being absent, declare the nearest existing parent directory.`,
      };
    }
    return {
      ok: true,
      detail: `${where}; ${behind === 0 ? "no commits since, and its declared path(s) all exist" : "none of those commits touched its declared path(s)"}: ${decl.paths.join(", ")}`,
    };
  }),

  check("metadata-model", "metadata carries a legal `model` and `model_effort`", ["metadata.model", "metadata.model_effort"], (b) => {
    const m = meta(b);
    const problems = [];
    if (!m.model) problems.push("`model` is not set");
    else if (!MODEL_TIERS.includes(m.model))
      problems.push(`\`model\` is ${JSON.stringify(m.model)}, not one of ${MODEL_TIERS.join("|")}`);
    if (!m.model_effort) problems.push("`model_effort` is not set");
    else if (!MODEL_EFFORTS.includes(m.model_effort))
      problems.push(`\`model_effort\` is ${JSON.stringify(m.model_effort)}, not one of ${MODEL_EFFORTS.join("|")}`);
    return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join("; ") };
  }),

  check("metadata-cc", "metadata carries a legal `cc_type` and a `cc_scope`", ["metadata.cc_type", "metadata.cc_scope"], (b) => {
    const m = meta(b);
    const problems = [];
    if (!m.cc_type) problems.push("`cc_type` is not set");
    else if (!CC_TYPES.includes(m.cc_type))
      problems.push(`\`cc_type\` is ${JSON.stringify(m.cc_type)}, not one of ${CC_TYPES.join("|")}`);
    if (!m.cc_scope) problems.push("`cc_scope` is not set");
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.cc_scope))
      problems.push(`\`cc_scope\` is ${JSON.stringify(m.cc_scope)}, not kebab-case`);
    return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join("; ") };
  }),
];

/** The distinct bead fields every check in CHECKS reads, in declaration order. */
export const EXAMINED_FIELDS = [...new Set(CHECKS.flatMap((c) => c.fields))];

/**
 * Resolve each premise statement to ONE commit -- the first token after its
 * label that git recognises as a commit; a statement with none is skipped --
 * each with how many commits
 * `origin/main` is ahead of it (`behind`), how many of its own commits are
 * not on `origin/main` (`notOnMain`), and the declaration of the statement
 * it came from. Both counts are needed: HEAD and every descendant of HEAD
 * have `behind === 0`.
 */
function premiseCommits(lines, ctx) {
  const out = [];
  for (const { shas, depends } of lines) {
    // A statement is dated by the FIRST commit after its label that git
    // resolves -- the one it was verified at -- not by whichever commit on
    // its line is freshest: a bd note is one line, and a later commit mentioned in
    // the same note ("... merged at a532388 during this audit") would
    // otherwise date the premise from there and hide every touch in between
    // (PR #289 review round 2, M1; ugcportal-vl32's live shape). A token that
    // does not resolve (a hex-looking word) is passed over. If the first
    // resolving commit is off main, the statement is off main: a later
    // on-main commit on the same line does not rescue it (ugcportal-y6ol:
    // verified at branch commit 2cd6d60, its line later cites PR #97's
    // 35800c9 as history).
    for (const sha of shas) {
      const full = ctx.git.resolveCommit(sha);
      if (!full) continue;
      out.push({
        short: sha,
        full,
        behind: ctx.git.commitsAhead(full),
        notOnMain: ctx.git.commitsNotOnMain(full),
        depends: depends || { kind: "missing" },
      });
      break;
    }
  }
  return out;
}

/**
 * Combine the declarations of premise statements that tie for freshest.
 * Fails closed: any unparseable declaration wins; otherwise path lists are
 * UNIONED (stricter than either); `none` only when no tied statement lists
 * paths; `missing` only when none of them declares anything.
 *
 * @param {Declaration[]} decls
 * @returns {Declaration}
 */
export function combineDeclarations(decls) {
  const lists = decls.filter((d) => d.kind === "paths");
  if (lists.length > 0) {
    return {
      kind: "paths",
      paths: [...new Set(lists.flatMap((d) => d.paths))],
      problems: [...new Set(lists.flatMap((d) => d.problems))],
      raw: lists.map((d) => d.raw).join(" | "),
    };
  }
  return decls.find((d) => d.kind === "none") || { kind: "missing" };
}

// --- running the checks ------------------------------------------------------

/**
 * Run every check in CHECKS against one bead.
 *
 * @returns {{id: string, title: string, status: string, passed: boolean,
 *            results: Array<{id, label, ok, detail?}>, checksRun: number,
 *            fieldsExamined: number, failures: string[]}}
 */
export function validateBead(bead, ctx) {
  const results = CHECKS.map((c) => {
    const r = c.run(bead, ctx);
    return { id: c.id, label: c.label, ok: Boolean(r.ok), detail: r.detail };
  });
  const failures = results.filter((r) => !r.ok);
  return {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    passed: failures.length === 0,
    results,
    checksRun: results.length,
    fieldsExamined: EXAMINED_FIELDS.length,
    failures: failures.map((f) => f.id),
  };
}

/**
 * Run the checks over a set of beads.
 *
 * `checksRun` and `fieldsExamined` are totals across the whole run, not
 * per-bead, and they are reported even when nothing failed and even when
 * `beads` is empty. That is K3: a clean result has to be distinguishable
 * from an instrument that did not look. An empty input reports
 * `0 beads, 0 checks` rather than a bare "all clear".
 */
export function validateBeads(beads, ctx) {
  const beadResults = beads.map((b) => validateBead(b, ctx));
  return {
    beads: beadResults,
    beadsExamined: beadResults.length,
    checksRun: beadResults.reduce((n, r) => n + r.checksRun, 0),
    checksPerBead: CHECKS.length,
    fieldsExamined: beadResults.length * EXAMINED_FIELDS.length,
    fieldsPerBead: EXAMINED_FIELDS.length,
    failingBeads: beadResults.filter((r) => !r.passed).map((r) => r.id),
    head: ctx.headShort,
  };
}

// --- reporting ---------------------------------------------------------------

export function formatReport(result) {
  const lines = [];
  lines.push(`Dispatch check against origin/main ${result.head}`);
  lines.push("");
  for (const bead of result.beads) {
    lines.push(`${bead.id} [${bead.status}] "${bead.title}" -- ${bead.passed ? "PASS" : "FAIL"}`);
    for (const r of bead.results) {
      // A passing check may still carry a detail -- premise-fresh says which
      // declared paths it compared, so a short list beside a long premise is
      // visible to whoever reads the gate output (see PREMISE_FRESHNESS_COST).
      lines.push(`  ${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(16)} ${r.ok ? (r.detail ? `${r.label} -- ${r.detail}` : r.label) : r.detail}`);
    }
    lines.push("");
  }
  lines.push(
    `Ran ${result.checksRun} check(s) (${result.checksPerBead} per bead) over ${result.beadsExamined} bead(s), ` +
      `examining ${result.fieldsExamined} field(s) (${result.fieldsPerBead} per bead: ${EXAMINED_FIELDS.join(", ")}).`,
  );
  lines.push(
    result.failingBeads.length === 0
      ? `${result.beadsExamined} bead(s) passed, 0 failed.`
      : `${result.failingBeads.length} bead(s) FAILED: ${result.failingBeads.join(", ")}`,
  );
  lines.push("");
  lines.push("SUBSTANCE CHECKS NOT MADE -- a zero exit means well-FORMED, not RIGHT:");
  for (const item of SUBSTANCE_CHECKS_NOT_MADE) lines.push(`  - ${item}`);
  return lines.join("\n");
}

// --- git + data access -------------------------------------------------------

function git(args, repoDir) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The git questions this script asks, behind an interface so the tests can
 * answer them from a fixture instead of needing a repo with a particular
 * history.
 */
export function makeGitContext(headOverride, repoDir = REPO_ROOT) {
  let head = headOverride;
  if (!head) {
    try {
      head = git(["rev-parse", "origin/main"], repoDir);
    } catch {
      throw new Error(
        `git could not resolve origin/main in ${repoDir}. Run \`git fetch origin main\` first, or pass --head <sha>. ` +
          "Premise freshness is measured against origin/main's current HEAD, so a missing or stale remote ref would make this check pass or fail for the wrong reason.",
      );
    }
  }
  const cache = new Map();
  return {
    head,
    headShort: head.slice(0, 7),
    /** full sha, or null when git does not know this token as a commit */
    resolveCommit(sha) {
      if (cache.has(sha)) return cache.get(sha);
      let full = null;
      try {
        full = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], repoDir) || null;
      } catch {
        full = null;
      }
      cache.set(sha, full);
      return full;
    },
    /** how many commits HEAD is ahead of `full`; Infinity when unanswerable */
    commitsAhead(full) {
      if (full === head) return 0;
      try {
        return Number(git(["rev-list", "--count", `${full}..${head}`], repoDir));
      } catch {
        return Infinity;
      }
    },
    /**
     * how many commits reachable from `full` are NOT reachable from HEAD;
     * 0 exactly when `full` is HEAD or an ancestor of it (that is, on main).
     * Infinity when unanswerable, so an error fails closed.
     */
    commitsNotOnMain(full) {
      if (full === head) return 0;
      try {
        return Number(git(["rev-list", "--count", `${head}..${full}`], repoDir));
      } catch {
        return Infinity;
      }
    },
    /**
     * The commits in `full..HEAD` that touched any of `paths`, oldest first,
     * each with the files under those paths it touched; null when git
     * failed, so an error fails closed instead of reading as "touched
     * nothing". `--literal-pathspecs`, because declared paths in this repo
     * carry glob characters (`src/app/api/media/[id]/`) that would otherwise
     * match a different path or none. `--no-renames`, so a rename counts as
     * touching both its old and its new name. A directory pathspec covers
     * everything under it; a file pathspec does not match a longer name
     * (`a.ts` does not cover `a.tsx`).
     */
    commitsTouching(full, paths) {
      if (paths.length === 0) return [];
      try {
        const out = git(
          ["--literal-pathspecs", "log", "--reverse", "--full-history", "--no-renames", "--format=%x00%H", "--name-only", `${full}..${head}`, "--", ...paths],
          repoDir,
        );
        return out
          .split("\0")
          .map((chunk) => chunk.split("\n").map((l) => l.trim()).filter(Boolean))
          .filter((rows) => rows.length > 0)
          .map(([sha, ...files]) => ({ sha, files }));
      } catch {
        return null;
      }
    },
    /** whether `p` names a file or directory in HEAD's tree */
    pathExists(p) {
      try {
        git(["cat-file", "-e", `${head}:${p}`], repoDir);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The exact `bd list` argv the `--all` sweep runs. Exported, and asserted
 * element-by-element in the tests rather than by invoking `bd`, because
 * every part of it is a trap this check would fail open on:
 *
 *   - `--status open,in_progress` must be the COMMA form. `bd list --help`:
 *     "repeating -s/--status silently overwrites the previous value". Run
 *     on 2026-10-12: `--status open --status in_progress` returned 9 beads
 *     (in-progress only) where `--status open,in_progress` returned 104 --
 *     a sweep that covered 9% of the backlog and said nothing about it.
 *   - `--limit 0` is mandatory. `bd list` defaults to `--limit 50`, so a
 *     sweep over the 104 beads the line above measures would examine 50 and
 *     say so in a count that looks complete. (104, not 95: 95 is the
 *     open-only population the audit was taken over, and this sweep is
 *     `open,in_progress`.)
 *   - no `--brief`: it omits description, acceptance criteria and notes,
 *     and `bd list --help` warns that "an omitted field is indistinguishable
 *     from an empty one in --json" -- which would turn every bead into a
 *     false failure.
 */
export const BD_LIST_ARGS = ["list", "--status", "open,in_progress", "--limit", "0", "--json"];

function loadBeads(opts) {
  if (opts.beadsFile) {
    const parsed = JSON.parse(fs.readFileSync(opts.beadsFile, "utf8"));
    const all = Array.isArray(parsed) ? parsed : [parsed];
    if (opts.ids.length === 0) return all;
    return opts.ids.map((id) => {
      const found = all.find((b) => b.id === id);
      if (!found) throw new Error(`bead not found in ${opts.beadsFile}: ${id}`);
      return found;
    });
  }
  if (opts.all) {
    return JSON.parse(execFileSync("bd", BD_LIST_ARGS, { encoding: "utf8", maxBuffer: 1 << 28 }));
  }
  return opts.ids.map((id) => {
    const out = execFileSync("bd", ["show", id, "--json"], { encoding: "utf8", maxBuffer: 1 << 28 });
    const parsed = JSON.parse(out);
    const bead = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!bead || !bead.id) throw new Error(`bd show ${id} returned no bead`);
    return bead;
  });
}

export function parseArgs(argv) {
  const opts = { ids: [], all: false, beadsFile: null, head: null, repo: REPO_ROOT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") opts.all = true;
    else if (arg === "--beads") opts.beadsFile = argv[++i];
    else if (arg === "--head") opts.head = argv[++i];
    else if (arg === "--repo") opts.repo = argv[++i];
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    else opts.ids.push(arg);
  }
  if (!opts.all && opts.ids.length === 0 && !opts.beadsFile) {
    throw new Error(
      "usage: check-bead-dispatch.mjs <bead-id> [<bead-id> ...] | --all  [--beads <file>] [--head <sha>] [--repo <dir>] [--json]",
    );
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message));
    process.exit(2);
  }
  let beads;
  try {
    beads = loadBeads(opts);
  } catch (err) {
    console.error(`could not load bead(s): ${String(err.message)}`);
    process.exit(2);
  }
  let gitCtx;
  try {
    gitCtx = makeGitContext(opts.head, opts.repo);
  } catch (err) {
    console.error(String(err.message));
    process.exit(2);
  }
  const result = validateBeads(beads, { git: gitCtx, headShort: gitCtx.headShort });
  if (opts.json) {
    console.log(JSON.stringify({ ...result, substanceChecksNotMade: SUBSTANCE_CHECKS_NOT_MADE }, null, 2));
  } else {
    console.log(formatReport(result));
  }
  process.exit(result.failingBeads.length === 0 ? 0 : 1);
}

/**
 * Whether this module was invoked directly, with a fallback the shared
 * `isMainModule` does not have.
 *
 * To be exact about what is special here, because the first draft of this
 * comment was not: the fail-open SHAPE is not special at all. Of the eleven
 * other `isMainModule` consumers, two are CI gates invoked directly by
 * `.github/workflows/ci.yml` -- `check-sensitive-files.mjs` and
 * `check-pr-title.mjs` -- and both guard their `main()` call behind the same
 * `isMainModule(import.meta.url)` check (an `if (...) { main(); }` block,
 * not a one-line form), and for both a zero exit means "allowed"; the first
 * is the guard over `CLAUDE.md` and
 * `.claude/settings*.json`. What differs is EXPOSURE, not kind: this script
 * is the one routinely run by absolute path from another checkout, which is
 * how the mismatch below gets triggered, and it was observed here. Widening
 * the fix to the shared helper is `ugcportal-cahr`; it is deferred under the
 * scope freeze, not because the others are safe.
 *
 * `isMainModule` compares `import.meta.url` against `pathToFileURL(argv[1])`.
 * On macOS `/tmp` is a symlink to `/private/tmp`, so running
 * `node /tmp/wt-x/scripts/check-bead-dispatch.mjs <id>` from another
 * directory gives `argv[1] = /tmp/...` while `import.meta.url` is
 * `file:///private/tmp/...`. They do not match, `main()` never runs, and the
 * process prints NOTHING and exits 0. Observed exactly that on 2026-10-12
 * running this script from the main checkout against the worktree copy.
 *
 * For an advisory report that is a confusing no-op. For a gate whose zero
 * exit means "this bead may be dispatched", it is a silent approval of an
 * unexamined bead -- the fail-open shape ugcportal-kssp is about. So
 * resolve both sides through `realpath`
 * before concluding this module is a library import.
 */
export function invokedDirectly(moduleUrl) {
  if (isMainModule(moduleUrl)) return true;
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (invokedDirectly(import.meta.url)) main();
