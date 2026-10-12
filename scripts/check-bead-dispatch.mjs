#!/usr/bin/env node
/**
 * The dispatch gate: a bead fails a mechanical check BEFORE work starts on
 * it (ugcportal-kt3k). Exits non-zero when a bead is missing any required
 * element of the bead-template form, or when its `Premise verified` line
 * names a commit that is no longer `origin/main`'s HEAD.
 *
 * Why this exists: `~/.claude/skills/bead-template/SKILL.md` has defined the
 * required form -- user story, In/Out of scope, K-numbered Given/When/Then
 * criteria each with a `Verified by`, a "should never happen" guardrail, a
 * `Premise verified` line, and this repo's metadata -- for the whole life of
 * the backlog, and nothing enforced it. Measured 2026-10-12 at origin/main
 * a3d55c9 over the 95 open beads: 12 fail at least one of the eight
 * presence-only elements, and 21 fail at least one check in `CHECKS` below
 * (which is stricter in three places -- see the PR for the breakdown).
 * bead-template records why `bd lint` is not sufficient on its own: it
 * checks that an acceptance-criteria *section* exists, and not the
 * guardrail, the Verified-by clauses, the scope lines, the premise or the
 * metadata.
 *
 * Two decisions by Eirik, both of which cost something and are therefore
 * worth stating rather than inferring from the code:
 *
 *   1. The premise must be FRESH AT DISPATCH, not merely present. A
 *      `Premise verified` line naming any commit other than the current
 *      `origin/main` HEAD fails, and the failure prints how many commits
 *      stale it is. This is strict on purpose. The v0.7.0 premise audit
 *      (docs/process/premise-audit-v0.7.0-2026-10-08.md, ugcportal-j5fl)
 *      found that only 68 of 136 non-closed beads carried a premise line at
 *      all, and those were up to 80 commits stale; ugcportal-kt3k's own
 *      notes record ugcportal-dabx's four-day-old premise being found partly
 *      wrong on 2026-10-12. Seven commits landed on `main` on the day this
 *      was written (`git log origin/main --since=2026-10-12`), so "stale"
 *      here is a matter of hours, not weeks. The cost is a re-verification
 *      pass per
 *      dispatch; see `PREMISE_FRESHNESS_COST` below for what that means in
 *      practice and why a looser rule was rejected.
 *   2. A failing bead is a HARD BLOCK, not a warning. Hence a non-zero exit
 *      rather than this script's sibling `check-unreachable-beads.mjs`,
 *      which is advisory and always exits 0.
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
 * Why the strict "names origin/main's current HEAD" rule, and what it costs.
 * Stated here rather than in a commit message because the cost is paid by
 * every dispatch forever and the next person to find it annoying deserves
 * the reasoning.
 *
 * Cost: a bead that sat in the backlog since yesterday fails on freshness
 * alone, and bringing it back to green means re-running its premise check
 * and writing a new `Premise verified <date> at origin/main <sha>` line.
 * That is the point -- it is the re-verification pass, not a formality.
 * Expect essentially the whole backlog to fail this check at any given
 * moment; the check is scoped to the ONE bead about to be dispatched, not
 * to the backlog as a standing cleanliness metric.
 *
 * Looser rules considered and rejected:
 *   - "within N commits": any N would be invented. The only measured points
 *     are failures -- ugcportal-dabx's premise was partly wrong after four
 *     days, and two beads were re-verified at 54d88ca and dispatched against
 *     77fb833, eighteen commits later (docs/process/development-process.md,
 *     section 9.3). Nothing measured here says how many commits a premise
 *     survives, so a threshold would be a guess presented as a rule.
 *   - "within N days": same problem, plus it passes a bead whose premise
 *     was invalidated by a commit that landed an hour ago.
 *   - "touched no file the bead mentions": would need to know which files a
 *     bead depends on, which is exactly the substance judgement this script
 *     is honest about not making.
 * The strict rule is the only one that is mechanical, so it is the only one
 * implemented here.
 */
export const PREMISE_FRESHNESS_COST =
  "A premise verified against any commit other than origin/main's current HEAD fails. Re-run the premise check and write a new `Premise verified <date> at origin/main <sha>` line; do not copy the date forward.";

/**
 * The substance checks this script does NOT make, printed on EVERY run --
 * passing or failing. K4. Each is named individually rather than summarised,
 * because "this does not check everything" is a sentence a reader skips and
 * "this did not check whether the premise is true" is not.
 */
export const SUBSTANCE_CHECKS_NOT_MADE = [
  "Whether the premise is TRUE. This checked that a premise line exists and names the current origin/main. It did not read the premise, and it did not re-run whatever command the premise claims was run. A premise re-verified against today's HEAD and still wrong passes here.",
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
 *   - A statement is the premise line plus the line after it, joined: `bd`
 *     hard-wraps stored text, so "Premise verified 2026-10-08 at" and its
 *     sha routinely land on different lines.
 *
 * @param {string} notes
 * @param {string} description
 * @returns {Array<{line: string, shas: string[]}>}
 */
export function findPremiseLines(notes, description = "") {
  const out = [];
  for (const field of [String(notes || ""), String(description || "")]) {
    const lines = field.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/\bpremise\b/i.test(lines[i])) continue;
      const statement = [lines[i], lines[i + 1] || ""].join(" ").trim();
      const shas = [...statement.matchAll(SHA_RE)].map((m) => m[1]);
      out.push({ line: statement, shas });
    }
  }
  return out;
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

  check("in-scope", "description has an `In scope:` line", ["description"], (b) =>
    /\bin scope\b[^:\n]{0,40}:/i.test(descFlat(b))
      ? { ok: true }
      : { ok: false, detail: "no `In scope:` line in the description" },
  ),

  check("out-of-scope", "description has an `Out of scope:` line", ["description"], (b) =>
    /\bout of scope\b[^:\n]{0,40}:/i.test(descFlat(b))
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
    const hit = PLACEHOLDER_RE.exec(`${desc(b)}\n${accept(b)}`);
    return hit
      ? { ok: false, detail: `an unfinished-editing marker is still in the text: ${JSON.stringify(hit[0])}` }
      : { ok: true };
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

  check("premise-fresh", "that premise commit is origin/main's current HEAD", ["notes", "description"], (b, ctx) => {
    const resolved = premiseCommits(findPremiseLines(notes(b), desc(b)), ctx);
    if (resolved.length === 0) {
      // premise-present already reported the real problem; do not report it
      // twice under a different name.
      return { ok: false, detail: "no resolvable premise commit to check freshness against" };
    }
    // The freshest premise on the bead wins: a bead re-verified today still
    // carrying yesterday's line in its delivery log is fresh.
    const freshest = resolved.reduce((best, r) => (r.behind < best.behind ? r : best));
    if (freshest.behind === 0) return { ok: true };
    return {
      ok: false,
      detail: `premise is ${freshest.behind} commit(s) stale: verified at ${freshest.short}, origin/main is now ${ctx.headShort}. ${PREMISE_FRESHNESS_COST}`,
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
 * Resolve the commit-ish tokens on premise lines against the repo, keeping
 * only the ones git recognises as commits, each with how many commits
 * `origin/main` is ahead of it.
 */
function premiseCommits(lines, ctx) {
  const out = [];
  for (const { shas } of lines) {
    for (const sha of shas) {
      const full = ctx.git.resolveCommit(sha);
      if (!full) continue;
      out.push({ short: sha, full, behind: ctx.git.commitsAhead(full) });
    }
  }
  return out;
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
      lines.push(`  ${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(16)} ${r.ok ? r.label : r.detail}`);
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
  };
}

/**
 * The exact `bd list` argv the `--all` sweep runs. Exported, and asserted
 * element-by-element in the tests rather than by invoking `bd`, because
 * every part of it is a trap this check would fail open on:
 *
 *   - `--status open,in_progress` must be the COMMA form. `bd list --help`:
 *     "repeating -s/--status silently overwrites the previous value". Two
 *     `--status` flags would sweep only in-progress beads and report a
 *     clean 9-bead run as if it had covered the backlog.
 *   - `--limit 0` is mandatory. `bd list` defaults to `--limit 50`, so a
 *     sweep over a 95-bead backlog would examine 50 and say so in a count
 *     that looks complete.
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
 * `isMainModule` does not have -- and the fallback is load-bearing here in
 * a way it is not for the other scripts that use it.
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
 * unexamined bead -- the fail-open shape ugcportal-kssp is about, in the
 * one place it costs the most. So resolve both sides through `realpath`
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
