/**
 * Tests for the dispatch gate (ugcportal-kt3k).
 *
 * Shape, and why it is this shape: every check gets a PAIR -- a fixture
 * missing exactly that one element, asserting a non-zero exit AND that the
 * element is named in the output, plus the complete fixture asserting exit
 * zero. A suite that only proves failure leaves the pass path unverified
 * (an `exit(1)` hard-coded at the top would satisfy it), and one that only
 * proves success leaves the failure path unverified (a `return {ok:true}`
 * in every check would satisfy that). Both halves run against the real CLI,
 * not just the exported functions.
 *
 * Git: `makeTempRepo` below builds a throwaway repository with a known
 * history -- three commits on `main`, plus one commit on a branch built on
 * top of `main`'s HEAD and one on a branch forked from the middle commit --
 * and the CLI is pointed at it with `--repo`, so the staleness counts
 * asserted here are exact and do not depend on this repo having fetched
 * `origin/main`. The two branch commits are what a premise verified in a
 * branch names -- whether that branch's PR is still open or was since
 * squash-merged, the commit itself is not on `main`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BD_LIST_ARGS,
  CHECKS,
  PREMISE_DEPENDS_FORM,
  CC_TYPES,
  EXAMINED_FIELDS,
  MODEL_EFFORTS,
  MODEL_TIERS,
  SUBSTANCE_CHECKS_NOT_MADE,
  USER_STORY_WINDOW,
  combineDeclarations,
  findDeclaration,
  findPremiseLines,
  formatReport,
  invokedDirectly,
  makeGitContext,
  parseArgs,
  parseDeclaration,
  splitCriteria,
  validateBead,
  validateBeads,
} from "./check-bead-dispatch.mjs";

const SCRIPT = fileURLToPath(new URL("./check-bead-dispatch.mjs", import.meta.url));

// --- a throwaway repo with a known history ----------------------------------

let repo;
/** @type {string[]} full shas of the three `main` commits, oldest first */
let shas;
/** full sha of a commit on a branch built ON TOP of HEAD: a descendant, not on main */
let descendant;
/** full sha of a commit on a branch forked from shas[1]: neither ancestor nor descendant of HEAD */
let sideBranch;

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kt3k-repo-"));
  const run = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  const made = [];
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(dir, `f${n}.txt`), `commit ${n}\n`);
    run(["add", "."]);
    run(["commit", "-q", "-m", `commit ${n}`]);
    made.push(run(["rev-parse", "HEAD"]));
  }
  const branchCommit = (branch, from, file) => {
    run(["checkout", "-q", "-b", branch, from]);
    fs.writeFileSync(path.join(dir, file), `${branch}\n`);
    run(["add", "."]);
    run(["commit", "-q", "-m", branch]);
    const sha = run(["rev-parse", "HEAD"]);
    run(["checkout", "-q", "main"]);
    return sha;
  };
  const desc = branchCommit("feature-on-head", made[2], "feature.txt");
  const side = branchCommit("side-from-middle", made[1], "side.txt");
  return { dir, made, desc, side };
}

// Every block below spawns real `git` and a real `node` subprocess per
// assertion -- that is the point, since the exit status is what is under
// test -- so each declares an explicit timeout (ugcportal-9faa). The cost
// is inherent: the throwaway repo is built once in `beforeAll`, but each
// CLI run is its own process.
beforeAll(() => {
  const made = makeTempRepo();
  repo = made.dir;
  shas = made.made;
  descendant = made.desc;
  sideBranch = made.side;
}, 30_000);

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

const HEAD = () => shas[2];
const OLDEST = () => shas[0];

// --- fixtures ----------------------------------------------------------------

/**
 * A bead that passes every check. Every single-element fixture below is this
 * object with exactly one thing removed or broken, so a failure can only be
 * attributed to the element under test.
 */
function completeBead(overrides = {}) {
  return {
    id: "fixture-complete",
    title: "A complete fixture bead",
    status: "open",
    description: `As the person dispatching work, I want a bead to fail a mechanical check before anyone starts on it, so that a malformed bead is caught in seconds.

In scope: the fixture itself.
Out of scope: everything else, which belongs to fixture-other.`,
    acceptance_criteria: `K1: Given a complete bead, when the script runs, it exits zero.
Verified by: a test running the CLI against this fixture and asserting exit 0.

K2: Following should never happen: a malformed bead is dispatched silently.
Verified by: a test asserting a non-zero exit for every single-element fixture.`,
    notes: `Premise verified 2026-10-12 at origin/main ${HEAD()} by running the fixture through the CLI.\nPremise depends on: f3.txt`,
    metadata: {
      cc_type: "feat",
      cc_scope: "process",
      model: "opus",
      model_effort: "high",
    },
    ...overrides,
  };
}

function writeBeads(beads) {
  const file = path.join(repo, `beads-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(Array.isArray(beads) ? beads : [beads]));
  return file;
}

/**
 * Run the real CLI and return `{status, stdout, stderr}` instead of throwing.
 * A non-zero exit is the thing under test (K5), not an error, so it has to
 * be observable rather than fatal.
 */
function runCliAllowFail(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout || ""), stderr: String(err.stderr || "") };
  }
}

function runFixture(bead) {
  const file = writeBeads(bead);
  return runCliAllowFail(["--beads", file, "--repo", repo, "--head", HEAD()]);
}

/**
 * The check ids the report attributed a failure to, in report order.
 *
 * Every failure assertion in this file goes through here rather than
 * stopping at `status === 1`. `status === 1` is satisfied by a mutation
 * that broke some OTHER check: it proves that something failed, not that
 * the check under test is the one that noticed. That is the same shape the
 * gate's own SUBSTANCE_CHECKS_NOT_MADE warns about -- "a `Verified by` that
 * restates the criterion ... passes this script and cannot be honestly
 * closed" -- applied to this suite.
 */
function failedChecks(stdout) {
  return stdout
    .split("\n")
    .filter((l) => l.trim().startsWith("FAIL "))
    .map((l) => l.trim().split(/\s+/)[1]);
}

/**
 * The checks that read `description`, derived from each check's declared
 * `fields` rather than counted by hand. Comments below refer to this list
 * instead of carrying a number, because a hand count drifted twice: once to
 * "four" (the number that FAIL when the field is emptied) and once to
 * "three", both written while more checks than that read it.
 */
const DESCRIPTION_READERS = CHECKS.filter((c) => c.fields.includes("description")).map((c) => c.id);

// --- the pass path -----------------------------------------------------------

describe("the complete fixture (K1, pass half)", { timeout: 30_000 }, () => {
  it("exits zero and reports every check as ok", () => {
    const res = runFixture(completeBead());
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("-- PASS");
    expect(res.stdout).not.toContain("FAIL ");
    // every check actually ran against it, rather than the report being empty
    for (const c of CHECKS) expect(res.stdout).toContain(c.id);
  });

  it("the complete fixture is only complete because of what it contains (fixture mutation)", () => {
    // Guard against the fixture drifting into something that passes for the
    // wrong reason: strip the whole description and it must stop passing.
    const res = runFixture(completeBead({ description: "" }));
    expect(res.status).toBe(1);
    // Named, not just non-zero: every check in DESCRIPTION_READERS reads the
    // description, so a status-only assertion here would survive the fixture
    // coming to carry its scope lines or its story somewhere else entirely.
    // Not every reader FAILS on an empty one -- `no-placeholder` finds no
    // marker in nothing, and the premise checks find this fixture's premise
    // in its notes -- so the list below is the readers that should, by name.
    const failed = failedChecks(res.stdout);
    expect(failed.filter((id) => !DESCRIPTION_READERS.includes(id))).toEqual([]);
    expect(failed).toEqual([
      "description",
      "user-story",
      "in-scope",
      "out-of-scope",
    ]);
  });
});

// --- K1: one fixture per element, each missing exactly that element ----------

/**
 * `mutate` removes or breaks exactly one element; `expectNamed` is a string
 * the output must contain, so the test proves the element was NAMED and not
 * merely that something somewhere failed (K1 requires naming).
 */
const SINGLE_ELEMENT_FIXTURES = [
  {
    check: "description",
    mutate: () => ({ description: "" }),
    expectNamed: "description is empty",
  },
  {
    check: "user-story",
    mutate: () => ({
      description: "In scope: a thing.\nOut of scope: another thing, owned by fixture-other.",
    }),
    expectNamed: 'user story is missing "As <role>"',
  },
  {
    check: "in-scope",
    mutate: (b) => ({ description: b.description.replace(/In scope: .*\n/, "") }),
    expectNamed: "no `In scope:` line",
  },
  {
    check: "out-of-scope",
    mutate: (b) => ({ description: b.description.replace(/Out of scope: .*/, "") }),
    expectNamed: "no `Out of scope:` line",
  },
  {
    check: "criteria",
    mutate: () => ({ acceptance_criteria: "" }),
    expectNamed: "acceptance criteria are empty",
  },
  {
    check: "criteria",
    label: "criteria present but not K-numbered",
    mutate: () => ({
      acceptance_criteria:
        "It should work properly and be reviewed by someone before it is merged into main, with care.",
    }),
    expectNamed: "no `K<n>:` criterion",
  },
  {
    check: "verified-by",
    mutate: (b) => ({ acceptance_criteria: b.acceptance_criteria.replace(/Verified by: a test running[^\n]*\n/, "") }),
    expectNamed: "no `Verified by:` on K1",
  },
  {
    check: "guardrail",
    mutate: (b) => ({ acceptance_criteria: b.acceptance_criteria.replace("Following should never happen: ", "") }),
    expectNamed: "no `Following should never happen:` guardrail",
  },
  {
    check: "no-placeholder",
    mutate: (b) => ({ acceptance_criteria: `(replace K1) ${b.acceptance_criteria}` }),
    expectNamed: '"(replace K1)"',
  },
  {
    check: "premise-present",
    label: "no premise line at all",
    mutate: () => ({ notes: "Some notes with no verification statement in them." }),
    expectNamed: "no `Premise verified` line in the notes or the description",
  },
  {
    check: "premise-present",
    label: "premise line naming no commit",
    mutate: () => ({ notes: "Premise verified 2026-10-12 by reading the schema." }),
    expectNamed: "the premise line names no commit",
  },
  {
    check: "premise-present",
    label: "premise line naming a commit git does not know",
    mutate: () => ({ notes: "Premise verified 2026-10-12 at origin/main deadbeefcafe1234." }),
    expectNamed: "which git cannot resolve to a commit in this repo",
  },
  {
    check: "metadata-model",
    mutate: (b) => ({ metadata: { ...b.metadata, model: undefined } }),
    expectNamed: "`model` is not set",
  },
  {
    check: "metadata-model",
    label: "model set to a value outside the tier vocabulary",
    mutate: (b) => ({ metadata: { ...b.metadata, model: "claude-opus-5" } }),
    expectNamed: "not one of haiku|sonnet|opus|fable",
  },
  {
    check: "metadata-model",
    label: "model_effort missing",
    mutate: (b) => ({ metadata: { ...b.metadata, model_effort: undefined } }),
    expectNamed: "`model_effort` is not set",
  },
  {
    check: "metadata-cc",
    mutate: (b) => ({ metadata: { ...b.metadata, cc_type: undefined } }),
    expectNamed: "`cc_type` is not set",
  },
  {
    check: "metadata-cc",
    label: "cc_scope missing",
    mutate: (b) => ({ metadata: { ...b.metadata, cc_scope: undefined } }),
    expectNamed: "`cc_scope` is not set",
  },
  {
    check: "metadata-cc",
    label: "cc_scope not kebab-case",
    mutate: (b) => ({ metadata: { ...b.metadata, cc_scope: "Rights System" } }),
    expectNamed: "not kebab-case",
  },
];

describe("K1: a bead missing one required element fails and the element is named", { timeout: 30_000 }, () => {
  for (const fixture of SINGLE_ELEMENT_FIXTURES) {
    const name = fixture.label ? `${fixture.check} (${fixture.label})` : fixture.check;
    it(`fails on ${name}`, () => {
      const base = completeBead();
      const bead = { ...base, ...fixture.mutate(base) };
      const res = runFixture(bead);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain(fixture.expectNamed);
      // and the failure is attributed to the check under test, not a
      // neighbouring one that the mutation broke by accident
      expect(failedChecks(res.stdout)).toContain(fixture.check);
    });
  }

  it("covers every check in CHECKS", () => {
    // Without this, adding a check and forgetting its fixture would leave a
    // gate element with no failure test and nothing would say so.
    const covered = new Set(SINGLE_ELEMENT_FIXTURES.map((f) => f.check));
    covered.add("premise-fresh"); // has its own describe block below (K2)
    expect([...new Set(CHECKS.map((c) => c.id))].filter((id) => !covered.has(id))).toEqual([]);
  });

  it("names EVERY missing element, not just the first", () => {
    const bead = completeBead({ description: "", acceptance_criteria: "", metadata: {} });
    const res = runFixture(bead);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("description is empty");
    expect(res.stdout).toContain("acceptance criteria are empty");
    expect(res.stdout).toContain("`cc_type` is not set");
    expect(res.stdout).toContain("`model` is not set");
  });
});

// --- K2: premise freshness ---------------------------------------------------

describe("K2: premise freshness against origin/main (kt3k's cases, under ul2j's path-scoped rule)", { timeout: 30_000 }, () => {
  it("fails when a commit since an older premise touched a declared path, and names how far behind it is", () => {
    // f3.txt is added by the third commit, HEAD; the premise is at the first.
    const bead = completeBead({
      notes: `Premise verified 2026-10-12 at origin/main ${OLDEST()} by reading the fixture.\nPremise depends on: f3.txt`,
    });
    const res = runFixture(bead);
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    expect(res.stdout).toContain(`premise verified at ${OLDEST().slice(0, 7)} (2 commit(s) behind origin/main ${HEAD().slice(0, 7)}) is stale`);
    expect(res.stdout).toContain(`1 of those commit(s) touched a declared path -- ${HEAD().slice(0, 7)} touched f3.txt`);
  });

  it("passes when the premise names the current HEAD", () => {
    const res = runFixture(completeBead());
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("no main commit since the premise touched a path it depends on");
    expect(res.stdout).toContain("(origin/main's current HEAD); no commits since, and its declared path(s) all exist: f3.txt");
  });

  it("accepts an abbreviated sha for the current HEAD", () => {
    const bead = completeBead({
      notes: `Premise verified 2026-10-12 at origin/main ${HEAD().slice(0, 8)}.\nPremise depends on: f3.txt`,
    });
    expect(runFixture(bead).status).toBe(0);
  });

  it("the touching-commit count and distance are real, not constants", () => {
    // Mutation guard: a hard-coded "1 of those" or "2 commit(s) behind" would
    // pass the first test above only by luck, so assert different figures.
    const two = runFixture(
      completeBead({ notes: `Premise verified 2026-10-12 at origin/main ${OLDEST()}.\nPremise depends on: f2.txt, f3.txt` }),
    );
    expect(two.status).toBe(1);
    expect(two.stdout).toContain(
      `2 of those commit(s) touched a declared path -- ${shas[1].slice(0, 7)} touched f2.txt; ${HEAD().slice(0, 7)} touched f3.txt`,
    );
    const one = runFixture(completeBead({ notes: `Premise verified 2026-10-12 at origin/main ${shas[1]}.\nPremise depends on: f3.txt` }));
    expect(one.status).toBe(1);
    expect(one.stdout).toContain(`(1 commit(s) behind origin/main ${HEAD().slice(0, 7)}) is stale`);
  });

  it("the freshest premise on a bead wins when several are recorded", () => {
    // A bead re-verified today still carries yesterday's line in its log.
    const bead = completeBead({
      notes: [
        `Premise verified 2026-10-10 at origin/main ${OLDEST()}.`,
        "Premise depends on: f3.txt",
        `PREMISE CORRECTED 2026-10-12 at origin/main ${HEAD()}, before dispatch.`,
        "Premise depends on: f3.txt",
      ].join("\n"),
    });
    expect(runFixture(bead).status).toBe(0);
  });

  it("reads a premise statement whose sha wrapped onto the next line", () => {
    const bead = completeBead({
      notes: `Premise verified 2026-10-12 at origin/main\n${HEAD()} by reading the fixture.\nPremise depends on: f3.txt`,
    });
    expect(runFixture(bead).status).toBe(0);
  });

  it("accepts a premise carried in the description instead of the notes", () => {
    const base = completeBead();
    const bead = {
      ...base,
      notes: "",
      description: `${base.description}\n\nPremise verified 2026-10-12 at origin/main ${HEAD()}.\nPremise depends on: f3.txt`,
    };
    expect(runFixture(bead).status).toBe(0);
  });

  // --- on main, not one-directional distance (rule 1) ---
  //
  // `<premise>..<head>` is 0 for HEAD and for every commit built on top of
  // HEAD, so a premise verified inside a branch used to PASS with
  // the report printing "that premise commit is origin/main's current HEAD".
  // Each case below runs the same fixture text twice, once naming the
  // off-main commit and once naming a commit that is on main, so the
  // assertion is shown to flip on the commit and nothing else.
  const OFF_MAIN = [
    { what: "a descendant of HEAD (a branch built on top of main)", sha: () => descendant },
    { what: "a commit on a branch forked from an older main commit", sha: () => sideBranch },
  ];
  for (const c of OFF_MAIN) {
    it(`fails a premise naming ${c.what}, and says it is not on origin/main`, () => {
      const notes = (sha) => `Premise verified 2026-10-14 at feature-branch commit ${sha} (not on main).\nPremise depends on: f3.txt`;
      const off = runFixture(completeBead({ notes: notes(c.sha()) }));
      expect(off.status).toBe(1);
      expect(failedChecks(off.stdout)).toEqual(["premise-fresh"]);
      expect(off.stdout).toContain(`premise commit ${c.sha()} is not on origin/main: 1 commit(s)`);
      // The usual off-main commit is a branch commit
      // whose PR was squash-merged, so main HAS its change; the message must
      // not claim otherwise.
      expect(off.stdout).toContain("usually a branch commit whose PR was since squash-merged");
      expect(off.stdout).not.toContain("main does not have");
      expect(off.stdout).not.toContain("no main commit since the premise touched a path it depends on");

      // the same text naming a commit that IS main's HEAD passes
      const on = runFixture(completeBead({ notes: notes(HEAD()) }));
      expect(on.status).toBe(0);
      expect(on.stdout).toContain("no main commit since the premise touched a path it depends on");
    });
  }

  it("an off-main premise does not rescue a bead whose on-main premise is stale", () => {
    // The old freshest-wins reduction picked the descendant (0 behind) over
    // the stale main commit and passed the bead.
    const bead = completeBead({
      notes: [
        `Premise verified 2026-10-10 at origin/main ${OLDEST()}.`,
        "Premise depends on: f3.txt",
        `Premise re-verified 2026-10-14 on the feature branch at ${descendant}.`,
        "Premise depends on: f3.txt",
      ].join("\n"),
    });
    const res = runFixture(bead);
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    expect(res.stdout).toContain(`premise verified at ${OLDEST().slice(0, 7)} (2 commit(s) behind origin/main ${HEAD().slice(0, 7)}) is stale`);
  });

  it("M1 round 2: a statement verified at an off-main commit is not rescued by an on-main commit later on its line", () => {
    // Dated by the first commit after the label: the branch commit. The HEAD
    // sha named afterwards is a different note on the same bd line.
    const notes = `Premise verified 2026-10-14 at feature-branch commit ${descendant}. Dispatched from origin/main ${HEAD()}.\nPremise depends on: f3.txt`;
    const res = runFixture(completeBead({ notes }));
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    expect(res.stdout).toContain(`premise commit ${descendant} is not on origin/main`);
  });

  it("says the comparison could not be made, not an Infinity count, when git rev-list fails", () => {
    // --head names a ref git cannot resolve, so both rev-list calls fail.
    const file = writeBeads(completeBead({ notes: `Premise verified 2026-10-14 at origin/main ${HEAD()}.` }));
    const res = runCliAllowFail(["--beads", file, "--repo", repo, "--head", "deadbeef1234"]);
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    expect(res.stdout).toContain("could not be compared with head ref deadbeef1234");
    expect(res.stdout).toContain("git rev-list");
    expect(res.stdout).not.toContain("Infinity");
  });

  it("says no count was measured, not an Infinity count, when only the behind count is unanswerable", () => {
    const git = {
      head: "f".repeat(40),
      headShort: "fffffff",
      resolveCommit: (sha) => sha.padEnd(40, "0"),
      commitsAhead: () => Infinity,
      commitsNotOnMain: () => 0,
    };
    const result = validateBead(
      completeBead({ notes: `Premise verified 2026-10-14 at origin/main ${HEAD()}.` }),
      { git, headShort: "fffffff" },
    );
    const fresh = result.results.find((r) => r.id === "premise-fresh");
    expect(fresh.ok).toBe(false);
    expect(fresh.detail).toContain("could not be compared");
    expect(fresh.detail).toContain("no commit count was measured");
    expect(fresh.detail).not.toContain("Infinity");
  });

  it("says no count was measured, not an Infinity count, when only the not-on-main count is unanswerable", () => {
    const git = {
      head: "f".repeat(40),
      headShort: "fffffff",
      resolveCommit: (sha) => sha.padEnd(40, "0"),
      commitsAhead: () => 0,
      commitsNotOnMain: () => Infinity,
    };
    const result = validateBead(
      completeBead({ notes: `Premise verified 2026-10-14 at origin/main ${HEAD()}.` }),
      { git, headShort: "fffffff" },
    );
    const fresh = result.results.find((r) => r.id === "premise-fresh");
    expect(fresh.ok).toBe(false);
    expect(fresh.detail).toContain("could not be compared");
    expect(fresh.detail).toContain("no commit count was measured");
    expect(fresh.detail).not.toContain("Infinity");
  });
});

// --- ul2j: freshness scoped by declared dependency paths ----------------------

/**
 * A second throwaway repo, built for the path-scoped rule (ugcportal-ul2j):
 * one commit per kind of touch, so each case below can put its premise just
 * before the commit it is about and assert exactly which later commits are
 * named. Kept apart from `makeTempRepo` so kt3k's exact distances above do
 * not move.
 *
 *   c0  base: src/lib/a.ts, src/lib/a.tsx, src/lib/b.ts, docs/x.md,
 *       src/app/[id]/route.ts, src/app/d, README.md
 *   c1  modifies src/lib/a.ts
 *   c2  modifies docs/x.md
 *   c3  modifies src/app/d      -- a file the GLOB `src/app/[id]` matches
 *   c4  modifies src/app/[id]/route.ts
 *   c5  modifies src/lib/a.tsx  -- a longer name than a.ts, not under it
 *   c6  renames src/lib/b.ts -> src/lib/c.ts          (HEAD)
 */
function makePathRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ul2j-repo-"));
  const run = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  const commit = (msg) => {
    run(["add", "-A"]);
    run(["commit", "-q", "-m", msg]);
    return run(["rev-parse", "HEAD"]);
  };
  for (const f of ["src/lib/a.ts", "src/lib/a.tsx", "src/lib/b.ts", "docs/x.md", "src/app/[id]/route.ts", "src/app/d", "README.md"]) {
    write(f, `${f} v0\n`);
  }
  const c = [commit("c0 base")];
  write("src/lib/a.ts", "a v1\n");
  c.push(commit("c1 a.ts"));
  write("docs/x.md", "x v1\n");
  c.push(commit("c2 docs"));
  write("src/app/d", "d v1\n");
  c.push(commit("c3 app/d"));
  write("src/app/[id]/route.ts", "route v1\n");
  c.push(commit("c4 [id] route"));
  write("src/lib/a.tsx", "a.tsx v1\n");
  c.push(commit("c5 a.tsx"));
  run(["mv", "src/lib/b.ts", "src/lib/c.ts"]);
  c.push(commit("c6 rename b -> c"));
  return { dir, c };
}

describe("ul2j: premise freshness is scoped by the paths the premise declares", { timeout: 60_000 }, () => {
  let pr;
  let c;
  beforeAll(() => {
    const made = makePathRepo();
    pr = made.dir;
    c = made.c;
  }, 30_000);
  afterAll(() => {
    if (pr) fs.rmSync(pr, { recursive: true, force: true });
  });
  const short = (sha) => sha.slice(0, 7);
  /** Run the CLI over one bead whose notes are `notes`, in the path repo at HEAD c6. */
  const runNotes = (notes) => {
    const file = path.join(pr, `beads-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify([completeBead({ notes })]));
    return runCliAllowFail(["--beads", file, "--repo", pr, "--head", c[6]]);
  };
  const premise = (i, decl) =>
    `Premise verified 2026-10-17 at origin/main ${c[i]} by reading the code.${decl === undefined ? "" : `\nPremise depends on: ${decl}`}`;
  /** The premise-fresh report line, whatever it says. */
  const freshLine = (stdout) => stdout.split("\n").find((l) => /^\s+(ok|FAIL)\s+premise-fresh\b/.test(l)) || "";

  // --- K1 and K2: the pair the bead asks for -- the same declaration, one
  // premise before a commit that touched it and one after it.
  it("K1: passes when main moved but no commit since the premise touched a declared path", () => {
    // c2..c6 touch docs, app/d, app/[id], a.tsx and b.ts/c.ts -- never a.ts.
    const res = runNotes(premise(1, "src/lib/a.ts"));
    expect(res.status).toBe(0);
    expect(failedChecks(res.stdout)).toEqual([]);
    expect(freshLine(res.stdout)).toContain(
      `premise verified at ${short(c[1])} (5 commit(s) behind origin/main ${short(c[6])}); none of those commits touched its declared path(s): src/lib/a.ts`,
    );
  });

  it("K2: fails when a commit since the premise touched a declared path, and names that commit and that path", () => {
    const res = runNotes(premise(0, "src/lib/a.ts"));
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    const line = freshLine(res.stdout);
    expect(line).toContain(`premise verified at ${short(c[0])} (6 commit(s) behind origin/main ${short(c[6])}) is stale`);
    expect(line).toContain(`1 of those commit(s) touched a declared path -- ${short(c[1])} touched src/lib/a.ts.`);
    // and ONLY that commit: the five that touched other paths are not named
    for (const i of [2, 3, 4, 5, 6]) expect(line).not.toContain(`${short(c[i])} touched`);
  });

  it("K2: names every touching commit with its own path, oldest first", () => {
    const line = freshLine(runNotes(premise(0, "src/lib/a.ts, docs/x.md")).stdout);
    expect(line).toContain(`2 of those commit(s) touched a declared path -- ${short(c[1])} touched src/lib/a.ts; ${short(c[2])} touched docs/x.md.`);
  });

  it("a declared directory covers everything under it, with or without a trailing slash", () => {
    for (const decl of ["src/lib/", "src/lib"]) {
      const res = runNotes(premise(0, decl));
      expect(res.status).toBe(1);
      expect(freshLine(res.stdout)).toContain(
        `3 of those commit(s) touched a declared path -- ${short(c[1])} touched src/lib/a.ts; ${short(c[5])} touched src/lib/a.tsx; ${short(c[6])} touched src/lib/b.ts, src/lib/c.ts.`,
      );
    }
  });

  it("matches a declared path literally: `[id]` is a directory name, not a glob", () => {
    // As a glob, `src/app/[id]` matches `src/app/d` (c3) and not the real
    // `[id]` directory (c4) -- the stale commit would be the wrong one.
    const res = runNotes(premise(2, "src/app/[id]/"));
    expect(res.status).toBe(1);
    const line = freshLine(res.stdout);
    expect(line).toContain(`1 of those commit(s) touched a declared path -- ${short(c[4])} touched src/app/[id]/route.ts.`);
    expect(line).not.toContain(`${short(c[3])} touched`);
  });

  it("a file path does not cover a longer name that starts with it (a.ts is not a.tsx)", () => {
    const res = runNotes(premise(4, "src/lib/a.ts"));
    expect(res.status).toBe(0);
    expect(freshLine(res.stdout)).toContain("none of those commits touched its declared path(s): src/lib/a.ts");
  });

  it("a rename touches the old name, so a premise about the old file goes stale", () => {
    const res = runNotes(premise(5, "src/lib/b.ts"));
    expect(res.status).toBe(1);
    expect(freshLine(res.stdout)).toContain(`${short(c[6])} touched src/lib/b.ts.`);
  });

  it("a declared path that does not exist at HEAD fails, even when nothing touched it", () => {
    // `src/lib/a.t` is a typo: it matches no file, so only a commit creating
    // it would touch it, and without this it would pass on every merge.
    for (const [i, decl] of [
      [1, "src/lib/a.t"], // behind HEAD, and no commit since touched it
      [6, "src/lib/typo.ts"], // at HEAD itself
    ]) {
      const res = runNotes(premise(i, `README.md, ${decl}`));
      expect(res.status, decl).toBe(1);
      expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
      expect(freshLine(res.stdout)).toContain(`declares "${decl}", which does not exist at origin/main ${short(c[6])}`);
      expect(freshLine(res.stdout)).toContain("declare the nearest existing parent directory");
      // and the real path beside it is not what was reported
      expect(freshLine(res.stdout)).not.toContain('"README.md"');
    }
  });

  // --- K3: none, and absent
  it("K3: an explicit `none` declaration does not go stale on merge movement", () => {
    const res = runNotes(premise(0, "none (GitHub's API returns 422 for this; an external fact)"));
    expect(res.status).toBe(0);
    expect(freshLine(res.stdout)).toContain(
      `premise verified at ${short(c[0])} (6 commit(s) behind origin/main ${short(c[6])}) declares \`Premise depends on: none\` (GitHub's API returns 422 for this; an external fact); no merge makes it stale`,
    );
  });

  it("K3: a premise with NO `Premise depends on:` line fails -- absent is not read as none", () => {
    const res = runNotes(premise(0));
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    const line = freshLine(res.stdout);
    expect(line).toContain("has no `Premise depends on:` line");
    expect(line).toContain("absent is not read as `none`");
    // and it tells the author what to write -- once (PR #289 review round 2, L2)
    expect(line).toContain(PREMISE_DEPENDS_FORM);
    expect(line.split("on the premise line or the line right after it").length - 1).toBe(1);
  });

  it("K3: absent fails even for a premise verified at origin/main's current HEAD", () => {
    const res = runNotes(premise(6));
    expect(res.status).toBe(1);
    expect(freshLine(res.stdout)).toContain(`premise verified at ${short(c[6])} (origin/main's current HEAD) has no \`Premise depends on:\` line`);
    // the same premise with a declaration passes, so the failure is the declaration's absence and nothing else
    expect(runNotes(premise(6, "src/lib/a.ts")).status).toBe(0);
  });

  it("K3: the freshest premise is the one judged, so an older declaration does not cover a newer premise", () => {
    const res = runNotes([premise(0, "none (an external fact)"), premise(3)].join("\n"));
    expect(res.status).toBe(1);
    expect(freshLine(res.stdout)).toContain(`premise verified at ${short(c[3])} (3 commit(s) behind`);
    expect(freshLine(res.stdout)).toContain("has no `Premise depends on:` line");
  });

  it("a declaration that cannot be checked fails and says why", () => {
    for (const [decl, expected] of [
      ["", "the declaration lists nothing"],
      ["none, src/lib/a.ts", "`none` must stand alone"],
      ["none (an external fact), src/lib/a.ts", "`none` must stand alone"],
      ["none because GitHub says so", "`none` must stand alone"],
      ["src/lib/a.ts and docs/x.md", "is not a path (it contains whitespace"],
      ["src/lib/*.ts", "is a glob"],
      ["/abs/path.ts", "is absolute"],
      ["../outside.ts", "has a `..` segment"],
    ]) {
      const res = runNotes(premise(6, decl));
      expect(res.status, decl).toBe(1);
      expect(freshLine(res.stdout), decl).toContain("its `Premise depends on:` line cannot be checked");
      expect(freshLine(res.stdout), decl).toContain(expected);
    }
  });

  it("finds the declaration on the premise's own line, on the next line, and across a trailing-comma wrap", () => {
    const sameLine = `Premise verified 2026-10-17 at origin/main ${c[0]} by grep. Premise depends on: src/lib/a.ts`;
    const wrapped = `Premise verified 2026-10-17 at origin/main ${c[0]}.\nPremise depends on: docs/x.md,\nsrc/lib/a.ts`;
    for (const notes of [sameLine, premise(0, "src/lib/a.ts"), wrapped]) {
      const line = freshLine(runNotes(notes).stdout);
      expect(line).toContain(`${short(c[1])} touched src/lib/a.ts`);
    }
  });

  it("does not borrow a declaration across a blank line or from another premise statement", () => {
    const acrossBlank = `${premise(0)}\n\nPremise depends on: none (an external fact)`;
    const fromAnother = `${premise(0)}\n${premise(1, "none (an external fact)")}`;
    expect(freshLine(runNotes(acrossBlank).stdout)).toContain("has no `Premise depends on:` line");
    // in the second, c1 is the freshest and carries its own none -- so the
    // OLDER c0 statement is not what is judged; assert the c1 one was.
    expect(freshLine(runNotes(fromAnother).stdout)).toContain(`premise verified at ${short(c[1])}`);
    const olderOnly = `${premise(1)}\nPremise measured 2026-10-01 at ${c[0]}.\nPremise depends on: none (an external fact)`;
    // c1 is freshest; the declaration two lines down belongs to the c0 statement, not to it
    expect(freshLine(runNotes(olderOnly).stdout)).toContain(`premise verified at ${short(c[1])} (5 commit(s) behind origin/main ${short(c[6])}) has no`);
  });

  // --- PR #289 review, M1: a premise is dated by its OWN commit, never by a
  // neighbouring line's. Each layout below puts a newer commit (c2) on a line
  // between the premise (c0) and its declaration; c1 touched the declared
  // path, so only a check that dates the premise from c0 sees the touch.
  const STALE_AT_C0 = (stdout) => {
    const line = freshLine(stdout);
    expect(line).toContain(`premise verified at ${short(c[0])} (6 commit(s) behind origin/main ${short(c[6])}) is stale`);
    expect(line).toContain(`${short(c[1])} touched src/lib/a.ts`);
    expect(line).not.toContain(`premise verified at ${short(c[2])}`);
  };
  const ABOUT_C0 = () => `Premise verified 2026-10-13 at origin/main ${c[0]}: src/lib/a.ts exports v0.`;

  it("M1: a dispatch log line between the premise and its declaration does not lend the premise its newer commit", () => {
    const notes = [ABOUT_C0(), `Dispatched 2026-10-15 by the orchestrator from origin/main ${c[2]}.`, "Premise depends on: src/lib/a.ts"].join("\n");
    const res = runNotes(notes);
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    STALE_AT_C0(res.stdout);
    // the same bead with the declaration directly under the premise reads the same
    STALE_AT_C0(runNotes([ABOUT_C0(), "Premise depends on: src/lib/a.ts"].join("\n")).stdout);
  });

  it("M1: a log line that only mentions the word premise is not a premise statement, and takes neither the date nor the declaration", () => {
    const notes = [
      ABOUT_C0(),
      `2026-10-15 orchestrator: the premise-fresh gate run at origin/main ${c[2]} was green`,
      "Premise depends on: src/lib/a.ts",
    ].join("\n");
    const res = runNotes(notes);
    expect(res.status).toBe(1);
    STALE_AT_C0(res.stdout);
  });

  it("M1: a premise line naming no commit does not take one from the note under it (ugcportal-5x8 / ugcportal-rma's shape)", () => {
    // 5x8 and rma: a premise statement with no sha, then a SCOPE EXTENDED
    // note naming d23add1, which the old line-pair join read as the premise's
    // commit -- the freshest one on the bead, so the one judged.
    const notes = [
      `${ABOUT_C0()}\nPremise depends on: src/lib/a.ts`,
      'Premise re-verified 2026-10-12: "the review scope names none of these."',
      `SCOPE EXTENDED 2026-10-12 (ugcportal-l9qx K1): re-derived at origin/main ${c[2]}.`,
    ].join("\n");
    const res = runNotes(notes);
    expect(res.status).toBe(1);
    STALE_AT_C0(res.stdout);
    expect(findPremiseLines(notes).map((s) => s.shas)).toEqual([[c[0]], []]);
  });

  // --- PR #289 review round 2, M1: the same LINE can name a newer commit
  // too (bd stores each appended note as one line), and a later line can use
  // the label form mid-sentence. A statement is dated by the first commit
  // after its label, and only a label that opens a clause starts one.
  it("M1 round 2: a newer commit named later on the premise's own line does not date it", () => {
    const notes = `${ABOUT_C0()} Dispatched 2026-10-15 by the orchestrator from origin/main ${c[2]}. Premise depends on: src/lib/a.ts`;
    const res = runNotes(notes);
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    STALE_AT_C0(res.stdout);
  });

  it("M1 round 2: a later line using `premise:` mid-sentence is not a premise statement", () => {
    const notes = [
      ABOUT_C0(),
      `2026-10-15 orchestrator, on the premise: the dispatch gate at origin/main ${c[2]} was green.`,
      "Premise depends on: src/lib/a.ts",
    ].join("\n");
    const res = runNotes(notes);
    expect(res.status).toBe(1);
    STALE_AT_C0(res.stdout);
    expect(findPremiseLines(notes).map((st) => st.shas)).toEqual([[c[0]]]);
  });

  it("M1 round 2: ugcportal-vl32's live line is dated by the commit it was verified at, not the later merge it mentions", () => {
    // vl32's 2026-10-08 note, verbatim but for the two shas: 54d88ca -> c0
    // (verified at) and a532388 -> c2 (a merge it mentions). The live bead
    // declares nothing; a declaration is added so the dating is observable.
    const vl32 = (verified, merged) =>
      `Premise verified 2026-10-08 at ${verified} (v0.7.0 line-up audit, ugcportal-j5fl): HOLDS. Checked: git show origin/main:CLAUDE.md | grep -c retro_source (returns 0); bd show on bc04/mftd/co9g, which today carry metadata.retro_source = release-cost-v0.5.0-vs-v0.6.0.md#4/#3/#6 respectively. Observed: retro_source is in active use on real bead metadata right now (confirming the bead's point is still live, not moot), and is documented in .claude/skills/cut-release/SKILL.md (step 3, merged via PR #189/ugcportal-p7x7 just before this check) but still nowhere in CLAUDE.md. Note for the orchestrator: PR #189 (ugcportal-p7x7) merged to origin/main at commit ${merged} during this audit window but local main in this checkout is still at ${verified} and the bead ugcportal-p7x7 is still shown OPEN in bd — a gap worth closing out separately, not something this bead needs to act on since it only touches CLAUDE.md.`;
    const res = runNotes(`${vl32(c[0], c[2])}\nPremise depends on: src/lib/a.ts`);
    expect(res.status).toBe(1);
    STALE_AT_C0(res.stdout);
  });

  it("M1 round 2: a statement whose own commit is the newest on its line is still dated by it", () => {
    // The 7 live multi-commit statements have this shape: the verified-at
    // commit first, older ones after it ("(was <older>)").
    const notes = `Premise re-verified 2026-10-17 at origin/main ${c[2]} (was ${c[0]}; the first touch was ${c[1]}). Premise depends on: src/lib/a.ts`;
    const res = runNotes(notes);
    expect(res.status).toBe(0);
    expect(freshLine(res.stdout)).toContain(
      `premise verified at ${short(c[2])} (4 commit(s) behind origin/main ${short(c[6])}); none of those commits touched its declared path(s): src/lib/a.ts`,
    );
  });

  it("names the first five touching commits and up to five files each, then counts the rest", () => {
    const files = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
    const touched = Array.from({ length: 7 }, (_, i) => ({ sha: `${i + 1}`.repeat(40), files: i === 0 ? files : [`f${i + 1}`] }));
    const git = {
      head: "f".repeat(40),
      headShort: "fffffff",
      resolveCommit: (sha) => sha.padEnd(40, "0"),
      commitsAhead: () => 9,
      commitsNotOnMain: () => 0,
      commitsTouching: () => touched,
      pathExists: () => true,
    };
    const result = validateBead(completeBead({ notes: premise(0, files.join(", ")) }), { git, headShort: "fffffff" });
    const detail = result.results.find((r) => r.id === "premise-fresh").detail;
    expect(detail).toContain("7 of those commit(s) touched a declared path");
    expect(detail).toContain("1111111 touched f1, f2, f3, f4, f5 and 2 more file(s)");
    for (const n of [2, 3, 4, 5]) expect(detail).toContain(`${String(n).repeat(7)} touched f${n}`);
    for (const n of [6, 7]) expect(detail).not.toContain(`${String(n).repeat(7)} touched`);
    expect(detail).toContain("; and 2 more commit(s).");
  });

  it("L1: the bold label form, accepted as a declaration line, also parses as one", () => {
    const res = runNotes(`${premise(1)}\n**Premise depends on:** src/lib/a.ts`);
    expect(res.status).toBe(0);
    expect(freshLine(res.stdout)).toContain("none of those commits touched its declared path(s): src/lib/a.ts");
  });

  // --- K5: the blind spot, demonstrated rather than claimed away
  it("K5: an understated declaration passes", () => {
    // This premise is ABOUT src/lib/a.ts, which c1 changed. Its author
    // declared only README.md. The check cannot know the declaration is
    // short: it trusts it, and the bead passes. This is the mechanism's
    // stated blind spot (PREMISE_FRESHNESS_COST, "WHAT THIS TRUSTS"; and
    // SUBSTANCE_CHECKS_NOT_MADE), not a defect this test is waiting on.
    const about = `Premise verified 2026-10-17 at origin/main ${c[0]}: src/lib/a.ts still exports v0.`;
    const understated = runNotes(`${about}\nPremise depends on: README.md`);
    expect(understated.status).toBe(0);
    // The same premise with the file it rests on declared fails -- so the
    // pass above is the declaration's doing and nothing else.
    const honest = runNotes(`${about}\nPremise depends on: README.md, src/lib/a.ts`);
    expect(honest.status).toBe(1);
    expect(freshLine(honest.stdout)).toContain(`${short(c[1])} touched src/lib/a.ts`);
    // And the run says, every time, that the list's completeness was not checked.
    expect(understated.stdout).toContain("Whether the DEPENDENCY PATHS are complete");
  });

  it("fails closed, saying nothing was measured, when the path comparison itself fails", () => {
    const git = {
      head: "f".repeat(40),
      headShort: "fffffff",
      resolveCommit: (sha) => sha.padEnd(40, "0"),
      commitsAhead: () => 3,
      commitsNotOnMain: () => 0,
      commitsTouching: () => null,
      pathExists: () => true,
    };
    const result = validateBead(completeBead({ notes: premise(0, "src/lib/a.ts") }), { git, headShort: "fffffff" });
    const fresh = result.results.find((r) => r.id === "premise-fresh");
    expect(fresh.ok).toBe(false);
    expect(fresh.detail).toContain("`git log` over");
    expect(fresh.detail).toContain("was not measured");
  });

  it("makeGitContext.commitsTouching returns null, not an empty list, when git fails", () => {
    const ctx = makeGitContext(c[6], pr);
    expect(ctx.commitsTouching("deadbeef".repeat(5), ["src/lib/a.ts"])).toBeNull();
    expect(ctx.commitsTouching(c[0], ["src/lib/a.ts"])).toEqual([{ sha: c[1], files: ["src/lib/a.ts"] }]);
    expect(ctx.pathExists("src/app/[id]")).toBe(true);
    expect(ctx.pathExists("src/lib/b.ts")).toBe(false);
  });
});

describe("parseDeclaration / findDeclaration / combineDeclarations", { timeout: 30_000 }, () => {
  it("parses a path list, stripping quoting, ./ and trailing punctuation", () => {
    expect(parseDeclaration("`src/a.ts`, ./docs/b.md, 'c/'.")).toEqual({
      kind: "paths",
      paths: ["src/a.ts", "docs/b.md", "c"],
      problems: [],
      raw: "`src/a.ts`, ./docs/b.md, 'c/'.",
    });
  });

  it("reads `none` only as the first word, and keeps its reason", () => {
    expect(parseDeclaration("none (external fact)")).toMatchObject({ kind: "none", reason: "(external fact)" });
    expect(parseDeclaration("none")).toMatchObject({ kind: "none", reason: "" });
    // a path that merely starts with the letters is a path
    expect(parseDeclaration("nonexistent/x.ts")).toMatchObject({ kind: "paths", paths: ["nonexistent/x.ts"] });
  });

  it("reads the live shapes on origin/main's tracker (ugcportal-ul2j's description and notes)", () => {
    const description = [
      "Out of scope: the other eleven checks.",
      "",
      "Premise verified 2026-10-13 at origin/main 4c8584e58430f1c42d9a50966821ec0eb7047c7f",
      "Premise depends on: scripts/check-bead-dispatch.mjs",
    ].join("\n");
    const notes =
      "Premise verified 2026-10-17 at origin/main 3aa650846057e2d4ea2dc02c7e26da33d6dfc312 by the orchestrator: sed -n 563,583p scripts/check-bead-dispatch.mjs -- HOLDS. Premise depends on: scripts/check-bead-dispatch.mjs, scripts/check-bead-dispatch.test.mjs, .claude/skills/dispatch-bead/SKILL.md\nDispatched 2026-10-17 by the orchestrator.";
    const found = findPremiseLines(notes, description);
    expect(found.map((f) => [f.shas, f.depends.kind === "paths" ? f.depends.paths : f.depends.kind])).toEqual([
      [["3aa650846057e2d4ea2dc02c7e26da33d6dfc312"], ["scripts/check-bead-dispatch.mjs", "scripts/check-bead-dispatch.test.mjs", ".claude/skills/dispatch-bead/SKILL.md"]],
      [["4c8584e58430f1c42d9a50966821ec0eb7047c7f"], ["scripts/check-bead-dispatch.mjs"]],
    ]);
  });

  it("a declaration line never starts a premise statement, and a hex-looking path segment is not a commit", () => {
    const found = findPremiseLines("Premise verified at abc1234.\nPremise depends on: src/deadbeef0/x.ts");
    expect(found).toHaveLength(1);
    expect(found[0].shas).toEqual(["abc1234"]);
  });

  it("L1: strips the emphasis a label carried, but not a glob's `**`", () => {
    for (const line of ["**Premise depends on:** src/a.ts", "_Premise depends on:_ src/a.ts", "**Premise depends on: src/a.ts**", "__Premise depends on:__ src/a.ts"]) {
      expect(findDeclaration([line], 0), line).toMatchObject({ kind: "paths", paths: ["src/a.ts"], problems: [] });
    }
    expect(parseDeclaration("src/**").problems).toEqual(['"src/**" is a glob; declare the file or the directory instead']);
    // an underscore that is part of a path is not emphasis
    expect(parseDeclaration("src/__tests__").paths).toEqual(["src/__tests__"]);
  });

  it("L1: `none` quoted in backticks is still `none`", () => {
    expect(parseDeclaration("`none (an external fact)`")).toMatchObject({ kind: "none", reason: "(an external fact)" });
    expect(parseDeclaration("`none` (an external fact)")).toMatchObject({ kind: "none", reason: "(an external fact)" });
    expect(parseDeclaration("`nonexistent/x.ts`")).toMatchObject({ kind: "paths", paths: ["nonexistent/x.ts"] });
  });

  it("L1: a `none` reason may contain balanced nested parentheses, and only one group", () => {
    expect(parseDeclaration("none (GitHub API (observed 2026-10-17))")).toMatchObject({ kind: "none", reason: "(GitHub API (observed 2026-10-17))" });
    expect(parseDeclaration("none (GitHub API (observed 2026-10-17)).")).toMatchObject({ kind: "none" });
    for (const raw of ["none (a) (b)", "none (a))", "none ((a)", "none (a), src/a.ts"]) {
      expect(parseDeclaration(raw).problems, raw).toEqual([expect.stringContaining("`none` must stand alone")]);
    }
  });

  it("findDeclaration reports missing rather than an empty list", () => {
    expect(findDeclaration(["Premise verified at abc1234."], 0)).toEqual({ kind: "missing" });
  });

  it("combineDeclarations fails closed on a tie: paths are unioned, none only without paths, missing only without either", () => {
    const a = parseDeclaration("a.ts");
    const b = parseDeclaration("b.ts");
    const none = parseDeclaration("none (x)");
    expect(combineDeclarations([a, none, b]).paths).toEqual(["a.ts", "b.ts"]);
    expect(combineDeclarations([{ kind: "missing" }, none]).kind).toBe("none");
    expect(combineDeclarations([{ kind: "missing" }])).toEqual({ kind: "missing" });
    expect(combineDeclarations([a, parseDeclaration("")]).problems).toEqual(["the declaration lists nothing"]);
  });
});

// --- K3: the run reports what it examined ------------------------------------

describe("K3: the run reports how much it looked at", { timeout: 30_000 }, () => {
  it("prints the number of checks run and fields examined on a passing run", () => {
    const res = runFixture(completeBead());
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Ran \d+ check\(s\) \(\d+ per bead\) over \d+ bead\(s\)/);
    expect(res.stdout).toMatch(/examining \d+ field\(s\)/);
    for (const field of EXAMINED_FIELDS) expect(res.stdout).toContain(field);
  });

  it("a bead with zero criteria still reports the full number of checks performed (ugcportal-kssp)", () => {
    // The fail-open shape this guards: a script that matched nothing,
    // examined nothing and reported a clean run. An empty acceptance field
    // must not shrink the count of checks or fields.
    const res = runFixture(completeBead({ acceptance_criteria: "" }));
    expect(res.status).toBe(1);
    expect(res.stdout).toContain(`Ran ${CHECKS.length} check(s) (${CHECKS.length} per bead) over 1 bead(s)`);
    expect(res.stdout).toContain(`examining ${EXAMINED_FIELDS.length} field(s)`);
  });

  it("counts scale with the number of beads, so the figure is not a constant", () => {
    const a = completeBead({ id: "fixture-a" });
    const b = completeBead({ id: "fixture-b" });
    const file = writeBeads([a, b]);
    const res = runCliAllowFail(["--beads", file, "--repo", repo, "--head", HEAD()]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`Ran ${CHECKS.length * 2} check(s) (${CHECKS.length} per bead) over 2 bead(s)`);
    expect(res.stdout).toContain(`examining ${EXAMINED_FIELDS.length * 2} field(s)`);
  });

  it("an empty input reports 0 beads and 0 checks rather than a bare all-clear", () => {
    const file = writeBeads([]);
    const res = runCliAllowFail(["--beads", file, "--repo", repo, "--head", HEAD()]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Ran 0 check(s)");
    expect(res.stdout).toContain("over 0 bead(s)");
    expect(res.stdout).toContain("0 bead(s) passed, 0 failed.");
  });
});

// --- K4: the substance checks it did not make --------------------------------

describe("K4: every run names the substance checks it did not make", { timeout: 30_000 }, () => {
  it("prints them on a PASSING run", () => {
    const res = runFixture(completeBead());
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("SUBSTANCE CHECKS NOT MADE");
    for (const item of SUBSTANCE_CHECKS_NOT_MADE) expect(res.stdout).toContain(item);
  });

  it("prints them on a FAILING run too", () => {
    const res = runFixture(completeBead({ acceptance_criteria: "" }));
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("SUBSTANCE CHECKS NOT MADE");
    for (const item of SUBSTANCE_CHECKS_NOT_MADE) expect(res.stdout).toContain(item);
  });

  it("names each of the three unmade checks the bead calls out, individually", () => {
    const res = runFixture(completeBead());
    const text = res.stdout;
    expect(text).toContain("Whether the premise is TRUE");
    expect(text).toContain("Whether each criterion is SATISFIABLE");
    expect(text).toContain("Whether the MODEL TIER fits the work");
    // and the standing counter-example, so a green run cannot be read as
    // "this is a good bead"
    expect(text).toContain("ugcportal-p3v");
    expect(text).toContain("ugcportal-zbcs");
  });

  it("carries them in --json output as well, so a machine consumer cannot drop them", () => {
    const file = writeBeads(completeBead());
    const res = runCliAllowFail(["--beads", file, "--repo", repo, "--head", HEAD(), "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.substanceChecksNotMade).toEqual(SUBSTANCE_CHECKS_NOT_MADE);
  });

  it("the list is not empty and each entry names something concrete", () => {
    expect(SUBSTANCE_CHECKS_NOT_MADE.length).toBeGreaterThanOrEqual(4);
    for (const item of SUBSTANCE_CHECKS_NOT_MADE) expect(item.length).toBeGreaterThan(80);
  });
});

// --- K5: the exit status is the gate -----------------------------------------

describe("K5: the decision is an exit status", { timeout: 30_000 }, () => {
  it("exits 0 on pass and 1 on fail, so `&&` in a dispatch step blocks", () => {
    expect(runFixture(completeBead()).status).toBe(0);
    const failing = runFixture(completeBead({ notes: "" }));
    expect(failing.status).toBe(1);
    // The fixture's premise lives in its notes, so emptying them is a
    // premise failure and nothing else. Saying which keeps this from being
    // a bare "something went wrong".
    expect(failedChecks(failing.stdout)).toEqual(["premise-present", "premise-fresh"]);
  });

  it("exits 2 on a usage error, which is distinguishable from a failing bead", () => {
    const res = runCliAllowFail([]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage:");
  });

  it("exits 2 on an unknown argument rather than ignoring it", () => {
    const res = runCliAllowFail(["--nope", "--beads", writeBeads(completeBead()), "--repo", repo]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("unknown argument: --nope");
  });

  it("exits 2 when a requested bead id is not present, rather than reporting a clean run over nothing", () => {
    const file = writeBeads(completeBead());
    const res = runCliAllowFail(["ugcportal-nosuch", "--beads", file, "--repo", repo, "--head", HEAD()]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("ugcportal-nosuch");
  });

  it("one failing bead among several fails the whole run", () => {
    const file = writeBeads([completeBead({ id: "fixture-ok" }), completeBead({ id: "fixture-bad", notes: "" })]);
    const res = runCliAllowFail(["--beads", file, "--repo", repo, "--head", HEAD()]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("fixture-bad");
  });
});

// --- exported pure functions --------------------------------------------------

describe("splitCriteria", { timeout: 30_000 }, () => {
  it("splits on K markers and keeps each criterion's Verified by with it", () => {
    const parsed = splitCriteria("K1: a thing.\nVerified by: a test.\n\nK2: another.\nVerified by: a command.");
    expect(parsed.map((c) => c.label)).toEqual(["K1", "K2"]);
    expect(parsed[0].body).toContain("Verified by: a test.");
    expect(parsed[1].body).toContain("Verified by: a command.");
  });

  it("finds a marker that follows an editing instruction mid-line (ugcportal-p3v's shape)", () => {
    const parsed = splitCriteria("(replace K1) K1: Given a buyer selects a sellable item, ...");
    expect(parsed.map((c) => c.label)).toEqual(["K1"]);
  });

  it("returns an empty array for prose with no markers", () => {
    expect(splitCriteria("it should work")).toEqual([]);
    expect(splitCriteria("")).toEqual([]);
    expect(splitCriteria(undefined)).toEqual([]);
  });
});

describe("findPremiseLines", { timeout: 30_000 }, () => {
  it("matches verified / measured / corrected, not only the literal form", () => {
    const notes = "Premise verified at abc1234.\nPremise measured at def5678.\nPREMISE CORRECTED at 9abcdef.";
    const found = findPremiseLines(notes);
    expect(found).toHaveLength(3);
    // each statement carries its own line's sha, and only that one
    expect(found.map((l) => l.shas)).toEqual([["abc1234"], ["def5678"], ["9abcdef"]]);
  });

  it("reads a statement's commits from its label on, in order, so the first one is the verified-at commit", () => {
    // a commit named before the label belongs to another note on the same line
    expect(findPremiseLines("2026-10-15 merged def5678. Premise verified at abc1234.")[0].shas).toEqual(["abc1234"]);
    // order is kept: premiseCommits dates the statement by the first resolving one
    expect(findPremiseLines("Premise verified at abc1234. Dispatched from origin/main def5678.")[0].shas).toEqual(["abc1234", "def5678"]);
  });

  it("counts `premise` as a label, not as a word mentioned in passing", () => {
    for (const line of [
      "Premise re-verified 2026-10-06 on main at abc1234.",
      "Premise re-checked at abc1234.",
      "premise (verified 2026-10-08 at abc1234)",
      "Premise: found at abc1234.",
      "Premise confirmed at abc1234.",
      // after a clause boundary: live shapes (ugcportal-paa, -pmb, -a9no, -6do8)
      "2026-10-06 audit: premise re-verified on main at abc1234.",
      "K4-K6 added. Premise verified 2026-10-15 at origin/main abc1234.",
      "on-main value. Premise (verified 2026-10-07 at abc1234)",
      "- **Premise verified** at abc1234.",
      "(premise re-verified live at abc1234)",
    ]) {
      expect(findPremiseLines(line).map((l) => l.shas), line).toEqual([["abc1234"]]);
    }
    for (const line of [
      "the premise-fresh gate run at origin/main abc1234 was green",
      "docs/process/premise-audit-v0.7.0-2026-10-08.md at abc1234",
      "the premise of this bead is at abc1234",
      // the label form mid-sentence (PR #289 review round 2, M1 (b))
      "2026-10-15 orchestrator, on the premise: the dispatch gate at origin/main abc1234 was green.",
      "the premise, verified at abc1234, holds",
      "a re-verified `Premise verified` line at abc1234",
    ]) {
      expect(findPremiseLines(line), line).toEqual([]);
    }
  });

  it("takes a commit from the next line only when it is the hard-wrapped sha opening that line", () => {
    // ugcportal-48zb's live shape: the sha opens the continuation line
    expect(findPremiseLines("Premise verified 2026-10-10 against fix/x at\n6da3675: read the test.")[0].shas).toEqual(["6da3675"]);
    // the premise line names its own commit, so the next line's is not read
    expect(findPremiseLines("Premise verified at abc1234.\nDispatched from def5678.")[0].shas).toEqual(["abc1234"]);
    // the next line names a commit, but not as its opening token: not a wrap
    expect(findPremiseLines("Premise verified 2026-10-13 at origin/main\nDispatched from origin/main def5678.")[0].shas).toEqual([]);
    // the next line is itself a premise statement: it keeps its own commit
    expect(findPremiseLines("## Premise:\nPremise verified at def5678.").map((l) => l.shas)).toEqual([[], ["def5678"]]);
  });

  it("does not invent a premise statement where there is none", () => {
    expect(findPremiseLines("Delivery log.\nShipped at abc1234.", "")).toEqual([]);
  });

  it("ignores a notes line that does not mention a premise", () => {
    expect(findPremiseLines("Delivery log: shipped at abc1234.")).toEqual([]);
  });

  it("reads the description too", () => {
    expect(findPremiseLines("", "Premise verified at abc1234.")).toHaveLength(1);
  });

  it("does not treat a short hex-looking word as a commit", () => {
    // six chars: below the 7-char minimum, so not a candidate at all
    expect(findPremiseLines("Premise verified against deface.")[0].shas).toEqual([]);
  });
});

describe("validateBead / validateBeads with a stubbed git context", { timeout: 30_000 }, () => {
  const stubGit = {
    head: "f".repeat(40),
    headShort: "fffffff",
    resolveCommit: (sha) => (/^[0-9a-f]{7,40}$/.test(sha) ? sha.padEnd(40, "0") : null),
    commitsAhead: () => 7,
    commitsNotOnMain: () => 0,
    commitsTouching: () => [{ sha: "a".repeat(40), files: ["f3.txt"] }],
    pathExists: () => true,
  };
  const ctx = { git: stubGit, headShort: "fffffff" };

  it("reports per-check results, a pass flag, and the counts", () => {
    const result = validateBead(completeBead(), ctx);
    expect(result.checksRun).toBe(CHECKS.length);
    expect(result.fieldsExamined).toBe(EXAMINED_FIELDS.length);
    // the stub reports every premise as 7 commits behind with one of them
    // touching the declared f3.txt, so this bead fails on freshness alone --
    // which is itself the assertion
    expect(result.failures).toEqual(["premise-fresh"]);
  });

  it("validateBeads totals across beads and lists the failing ids", () => {
    const result = validateBeads([completeBead({ id: "a" }), completeBead({ id: "b" })], ctx);
    expect(result.beadsExamined).toBe(2);
    expect(result.checksRun).toBe(CHECKS.length * 2);
    expect(result.failingBeads).toEqual(["a", "b"]);
  });

  it("formatReport always ends with the substance section", () => {
    const text = formatReport(validateBeads([completeBead()], ctx));
    expect(text).toContain("SUBSTANCE CHECKS NOT MADE");
  });
});

describe("makeGitContext", { timeout: 30_000 }, () => {
  it("counts the real distance between two commits in the repo", () => {
    const ctx = makeGitContext(HEAD(), repo);
    expect(ctx.commitsAhead(OLDEST())).toBe(2);
    expect(ctx.commitsAhead(HEAD())).toBe(0);
  });

  it("counts the premise's own commits that are not on main, in the other direction", () => {
    const ctx = makeGitContext(HEAD(), repo);
    // a descendant is 0 behind -- which is exactly why `behind` alone is not freshness
    expect(ctx.commitsAhead(descendant)).toBe(0);
    expect(ctx.commitsNotOnMain(descendant)).toBe(1);
    expect(ctx.commitsNotOnMain(sideBranch)).toBe(1);
    expect(ctx.commitsNotOnMain(HEAD())).toBe(0);
    expect(ctx.commitsNotOnMain(OLDEST())).toBe(0);
  });

  it("returns null for a token git does not know as a commit", () => {
    const ctx = makeGitContext(HEAD(), repo);
    expect(ctx.resolveCommit("deadbeefcafe1234")).toBeNull();
  });

  it("resolves an abbreviated sha to its full form", () => {
    const ctx = makeGitContext(HEAD(), repo);
    expect(ctx.resolveCommit(HEAD().slice(0, 7))).toBe(HEAD());
  });
});

describe("invoked through a symlinked path", { timeout: 30_000 }, () => {
  // Regression: `isMainModule` compares import.meta.url against
  // pathToFileURL(argv[1]) with ===, so running this script by an absolute
  // path that traverses a symlink (/tmp -> /private/tmp on macOS) made
  // `main()` not run at all. The process then printed nothing and EXITED
  // ZERO -- a gate silently approving a bead it never looked at.
  it("still runs, and still fails a bad bead", () => {
    const link = path.join(repo, "linked-scripts");
    fs.symlinkSync(path.dirname(SCRIPT), link);
    const viaLink = path.join(link, path.basename(SCRIPT));
    const file = writeBeads(completeBead({ notes: "" }));
    const res = runCliAllowFail([]); // sanity: direct invocation still errors on usage
    expect(res.status).toBe(2);

    const linked = (() => {
      try {
        const stdout = execFileSync(process.execPath, [viaLink, "--beads", file, "--repo", repo, "--head", HEAD()], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, stdout };
      } catch (err) {
        return { status: err.status, stdout: String(err.stdout || "") };
      }
    })();
    expect(linked.stdout).toContain("SUBSTANCE CHECKS NOT MADE");
    expect(linked.status).toBe(1);
  });

  it("invokedDirectly reports false for a module that is merely imported", () => {
    // This test file imported the script; argv[1] is vitest's entry, not it.
    expect(invokedDirectly(new URL("./check-bead-dispatch.mjs", import.meta.url).href)).toBe(false);
  });
});

describe("parseArgs", { timeout: 30_000 }, () => {
  it("collects ids and flags", () => {
    const opts = parseArgs(["ugcportal-a", "ugcportal-b", "--json", "--head", "abc1234"]);
    expect(opts.ids).toEqual(["ugcportal-a", "ugcportal-b"]);
    expect(opts.json).toBe(true);
    expect(opts.head).toBe("abc1234");
  });

  it("rejects an empty invocation", () => {
    expect(() => parseArgs([])).toThrow(/usage:/);
  });
});

describe("BD_LIST_ARGS", { timeout: 30_000 }, () => {
  // Asserted literally rather than by invoking `bd`, because each element is
  // a way this sweep could silently examine fewer beads than it claims.
  it("uses the comma form of --status, which is the only one bd does not overwrite", () => {
    expect(BD_LIST_ARGS).toContain("open,in_progress");
    expect(BD_LIST_ARGS.filter((a) => a === "--status")).toHaveLength(1);
  });

  it("passes --limit 0, because bd list defaults to 50", () => {
    const i = BD_LIST_ARGS.indexOf("--limit");
    expect(i).toBeGreaterThan(-1);
    expect(BD_LIST_ARGS[i + 1]).toBe("0");
  });

  it("does not pass --brief, which would blank the very fields this checks", () => {
    expect(BD_LIST_ARGS).not.toContain("--brief");
  });
});

describe("vocabularies match CLAUDE.md", { timeout: 30_000 }, () => {
  it("model tiers", () => {
    expect(MODEL_TIERS).toEqual(["haiku", "sonnet", "opus", "fable"]);
  });
  it("effort levels", () => {
    expect(MODEL_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  it("conventional-commit types", () => {
    expect(CC_TYPES).toEqual([
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
    ]);
  });
});

describe("the checks are bounded where they claim to be", { timeout: 30_000 }, () => {
  it("the user-story window is bounded, so background prose cannot supply the story", () => {
    expect(USER_STORY_WINDOW).toBeGreaterThan(0);
    const base = completeBead();
    const bead = {
      ...base,
      description: `In scope: x.\nOut of scope: y, owned by fixture-other.\n${"filler. ".repeat(200)}As a reader, I want a story, so that it counts.`,
    };
    const res = runFixture(bead);
    expect(res.status).toBe(1);
    // `status === 1` alone would also pass if the window were unbounded and
    // some unrelated check had broken instead -- the fixture's description
    // is rewritten wholesale here, and every check in DESCRIPTION_READERS
    // reads it. Name the one
    // under test, and require it to be the ONLY failure, which is what says
    // the two scope lines in that same description were still found.
    expect(failedChecks(res.stdout)).toEqual(["user-story"]);
    expect(res.stdout).toContain('user story is missing "As <role>"');
  });

  // --- F3: the scope checks are LINE checks, and say so in their detail ---
  //
  // Before this, both ran against the whitespace-flattened description, so
  // the `\n` in `[^:\n]{0,40}` had nothing left to exclude and the
  // 40-character tolerance ran across sentence and paragraph breaks. Every
  // description below passed the check it names.
  //
  // Two exclusions do the work and each gets its OWN case, because either
  // one alone leaves the other's cases passing: with `.` excluded but the
  // text still flattened, a scope statement with no full stop still reaches
  // the next paragraph's colon; with the line structure kept but `.`
  // allowed, "Nothing is out of scope. Rationale:" is one line and still
  // passes. `blocks` names which exclusion each case is here to guard, so
  // reverting one of them reds a case that names it.
  const SCOPE_FALSE_PASSES = [
    {
      blocks: "the line break",
      what: "a paragraph break with no full stop to stop it (out-of-scope)",
      check: "out-of-scope",
      description:
        "As a reader, I want a story, so that it counts.\n\nIn scope: the thing.\n\nCaching is out of scope\n\nNotes: see fixture-other",
    },
    {
      blocks: "the sentence break",
      what: "a sentence break on one line (out-of-scope) -- the inverse of a scope boundary",
      check: "out-of-scope",
      description:
        "As a reader, I want a story, so that it counts.\n\nIn scope: the thing.\n\nNothing is out of scope. Rationale: all of it ships.",
    },
    {
      blocks: "the line break",
      what: "a single line break with no full stop (in-scope)",
      check: "in-scope",
      description:
        "As a reader, I want a story, so that it counts.\n\nEverything in scope here is fine\nSee also: something\n\nOut of scope: nothing, owned by fixture-other.",
    },
    {
      blocks: "the sentence break",
      what: "a sentence break on one line (in-scope)",
      check: "in-scope",
      description:
        "As a reader, I want a story, so that it counts.\n\nNot everything in scope is listed. Rationale: it is obvious.\n\nOut of scope: nothing, owned by fixture-other.",
    },
  ];

  for (const c of SCOPE_FALSE_PASSES) {
    it(`a scope statement does not reach across ${c.what}`, () => {
      const res = runFixture(completeBead({ description: c.description }));
      expect(res.status, `${c.blocks} did not stop the match`).toBe(1);
      expect(failedChecks(res.stdout), `${c.blocks} did not stop the match`).toEqual([c.check]);
    });
  }

  it("the tolerance and the non-anchoring the 40 characters buy are both kept", () => {
    // Guards the other direction: these are real forms in the backlog and a
    // narrower fix (anchor to line start, or drop the tolerance) fails them.
    // `ugcportal-6zdu` writes the qualifier; `e95r`, `a9no` and `uwh1` put
    // the line mid-paragraph.
    const res = runFixture(
      completeBead({
        description:
          "As a reader, I want a story, so that it counts. In scope, and deliberately: the thing. Out of scope, and deliberately: everything else, owned by fixture-other.",
      }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("FAIL ");
  });

  // --- F2: `no-placeholder` fires on a marker CARRIED, not one QUOTED ---
  it("a placeholder quoted in a code span is not a placeholder carried", () => {
    // `ugcportal-zbcs`, the P1 whose whole job is removing p3v's
    // `(replace K1)`, was the check's only live hit before this.
    const res = runFixture(
      completeBead({
        description:
          "As the operator, I want the marker gone, so that the bead can be closed.\n\n`ugcportal-p3v`'s acceptance field opens with the literal text `(replace K1)`, an editing instruction never carried out.\n\nIn scope: resolving the stray `(replace K1)` marker.\nOut of scope: implementing checkout, owned by fixture-other.",
      }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("FAIL ");
  });

  // The failure half of that pair is the `no-placeholder` single-element
  // fixture above, which puts the same `(replace K1)` at the head of the
  // acceptance field as BARE text -- exactly where p3v's real one is -- and
  // asserts exit 1 with the marker named and the failure attributed to
  // `no-placeholder`. Without it, blanking too much in stripQuotedMarkers
  // would go unnoticed.

  // --- the negated label is not an In-scope line ---
  it("`Not in scope:` does not satisfy the in-scope check", () => {
    // "in scope" is a substring of "Not in scope:"; with only that and an
    // Out-of-scope line, the bead states nothing that IS in scope.
    const res = runFixture(
      completeBead({
        description:
          "As a reader, I want a story, so that it counts.\n\nNot in scope: everything.\nOut of scope: y, owned by fixture-other.",
      }),
    );
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["in-scope"]);
    // and a real In-scope line beside the negated one still passes
    const both = runFixture(
      completeBead({
        description:
          "As a reader, I want a story, so that it counts.\n\nIn scope: the thing.\nNot in scope: everything.\nOut of scope: y, owned by fixture-other.",
      }),
    );
    expect(both.status).toBe(0);
  });

  it("a `not` ending the previous line does not negate an `In scope:` line that starts the next", () => {
    // The lookbehind must not cross a newline: "do not\nIn scope: x" is a
    // real In-scope line preceded by an unrelated sentence.
    const res = runFixture(
      completeBead({
        description:
          "As a reader, I want a story, so that it counts. Mind the gap, do not\nIn scope: the thing.\nOut of scope: y, owned by fixture-other.",
      }),
    );
    expect(res.status).toBe(0);
    expect(failedChecks(res.stdout)).toEqual([]);
  });

  // --- emphasis around the negation does not hide it ---
  const EMPHASISED_NOT = ["**Not** in scope:", "_not_ in scope:", "*not* in scope:", "Not **in scope**:"];
  for (const label of EMPHASISED_NOT) {
    it(`\`${label}\` does not satisfy the in-scope check`, () => {
      const description = (scope) =>
        `As a reader, I want a story, so that it counts.\n\n${scope}${label} everything.\nOut of scope: y, owned by fixture-other.`;
      const res = runFixture(completeBead({ description: description("") }));
      expect(res.status).toBe(1);
      expect(failedChecks(res.stdout)).toEqual(["in-scope"]);
      // the same text with an emphasised real In-scope line beside it passes
      const both = runFixture(completeBead({ description: description("**In scope:** the thing.\n") }));
      expect(both.status).toBe(0);
    });
  }

  // --- a stray backtick does not hide the bare markers after it ---
  const STRAY_BACKTICK = [
    {
      // The stray ends the description and the marker opens the criteria,
      // so the only thing between them is the boundary between the fields:
      // scanned joined, they were one paragraph and the marker was hidden.
      what: "at the end of the description, with the marker at the start of the acceptance criteria",
      field: "acceptance_criteria",
      overrides: (b) => ({
        description: `${b.description} See \`foo.`,
        acceptance_criteria: `K0: TODO write this criterion.\nVerified by: a test, and \`bar\`.\n\n${b.acceptance_criteria}`,
      }),
    },
    {
      what: "in one paragraph, with the marker in a later paragraph of the same field",
      field: "description",
      overrides: (b) => ({
        description: `${b.description}\n\nSee \`foo for the background.\n\nTODO: say what the background is, per \`bar\`.`,
      }),
    },
    {
      // Fences were blanked before the paragraph split,
      // so a stray ``` paired with a real fence two paragraphs down.
      what: "fence (```) in one paragraph, with the marker before a real fence in a later paragraph",
      field: "description",
      overrides: (b) => ({
        description: `${b.description}\n\nWrap code in \`\`\` marks.\n\nTODO: write the story.\n\nExample: \`\`\`js\nx\n\`\`\``,
      }),
    },
  ];
  for (const c of STRAY_BACKTICK) {
    it(`a stray backtick ${c.what} does not hide the marker`, () => {
      const base = completeBead();
      const res = runFixture({ ...base, ...c.overrides(base) });
      expect(res.status).toBe(1);
      expect(failedChecks(res.stdout)).toEqual(["no-placeholder"]);
      expect(res.stdout).toContain(`an unfinished-editing marker is still in the ${c.field}: "TODO"`);
    });
  }

  // --- a marker QUOTED in plain quotation marks is quoted, not carried ---
  it("a placeholder quoted in single, double or curly quotes is not a placeholder carried", () => {
    // `ugcportal-c20m`'s own wording: "leaving the marker '(replace K1)'"
    // and "editing instructions such as ... 'TODO' in the field".
    const res = runFixture(
      completeBead({
        description:
          "As the auditor, I want lost criteria found, so that none ship missing.\n\nOne bead was cut down, leaving the marker '(replace K1)', and others carry editing instructions such as 'TODO', \"TBD\" or \u201cFIXME\u201d in the field.\n\nIn scope: the audit.\nOut of scope: fixing each bead, owned by fixture-other.",
      }),
    );
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("FAIL ");
  });

  it("an apostrophe is not a quotation mark: a bare marker between two still fails", () => {
    // Guards the other direction: blanking from one apostrophe to the next
    // would hide this bare marker.
    const base = completeBead();
    const res = runFixture({
      ...base,
      acceptance_criteria: `${base.acceptance_criteria}\n\nK3: p3v's (replace K1) marker isn't resolved yet.\nVerified by: a test.`,
    });
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["no-placeholder"]);
    expect(res.stdout).toContain('still in the acceptance_criteria: "(replace K1)"');
  });

  // --- only a MATCHING pair of quotation marks quotes ---
  // QUOTED_MARKER_RE matches any opening mark, a marker and any closing mark;
  // the QUOTE_PAIRS lookup is what refuses a mismatched pair. Each case runs
  // the marker between two marks that are NOT a pair (must fail) and the
  // same marker in a matching pair (must pass), so blanking every match
  // regardless of the pair turns the first half red.
  const MISMATCHED_QUOTES = [
    { what: "an apostrophe and a double quote", bare: `'TODO"`, quoted: `'TODO'` },
    { what: "a straight apostrophe and a curly closing quote", bare: "'TODO\u2019", quoted: "\u2018TODO\u2019" },
    { what: "a curly opening double and a straight double", bare: "\u201cTBD\"", quoted: "\u201cTBD\u201d" },
  ];
  for (const c of MISMATCHED_QUOTES) {
    it(`a marker between ${c.what} is not quoted and still fails; in a matching pair it passes`, () => {
      const base = completeBead();
      const withText = (t) => ({ ...base, description: `${base.description}\n\nThe field still says ${t} here.` });
      const bare = runFixture(withText(c.bare));
      expect(bare.status).toBe(1);
      expect(failedChecks(bare.stdout)).toEqual(["no-placeholder"]);
      expect(bare.stdout).toContain("an unfinished-editing marker is still in the description");
      const quoted = runFixture(withText(c.quoted));
      expect(quoted.status).toBe(0);
    });
  }
});

// --- K5: the DOCUMENTED invocation, not just the bare one ------------------

/**
 * The skill file is where the gate is actually invoked from, so it is part
 * of the gate. Every one of its shell lines that runs this script is
 * extracted from the markdown and EXECUTED against a bead that fails, and
 * the status that reaches the shell must be 1.
 *
 * This exists because it did not, and the wiring failed open: step 1 shipped
 * as `node scripts/check-bead-dispatch.mjs <bead-id> | tee /tmp/...`. A
 * pipeline's status is its LAST command's, `tee` always succeeds, and
 * neither bash nor zsh sets `pipefail` by default -- so the documented
 * command reported 0 for a bead failing every check, in both shells, while
 * the next line of the skill read "Exit `0` -- continue to step 2". Asserting
 * the fix as a `toContain("set -o pipefail")` grep over the file would be
 * the weaker shape this suite argues against everywhere else: it would pass
 * on `set -o pipefail` written on a line of its own, which does not survive
 * into the next shell an agent opens. Running the line is the only
 * assertion that can tell those two apart.
 */
describe("the skill file's own invocation does not discard the exit status", { timeout: 60_000 }, () => {
  const SKILL = fileURLToPath(new URL("../.claude/skills/dispatch-bead/SKILL.md", import.meta.url));

  /** Shell lines inside ```bash fences that invoke this script. */
  function documentedInvocations() {
    const text = fs.readFileSync(SKILL, "utf8");
    const out = [];
    const fence = /```bash\n([\s\S]*?)```/g;
    let m;
    while ((m = fence.exec(text)) !== null) {
      for (const line of m[1].split("\n")) {
        if (line.includes("check-bead-dispatch.mjs")) out.push(line.trim());
      }
    }
    return out;
  }

  /**
   * The shells to run each documented line through.
   *
   * `zsh` is the macOS default login shell and bash is what CI has; the
   * ubuntu runner has no zsh, and spawning a missing interpreter yields
   * `err.status === null`, not a number. That must not be mistaken for a
   * pass and must not quietly empty the list either, so a missing shell is
   * dropped HERE, once, with `bash` asserted present below -- rather than
   * being swallowed per-call where an environment with neither shell would
   * leave the whole assertion running over nothing.
   */
  const SHELLS = ["bash", "zsh"].filter((sh) => {
    try {
      execFileSync(sh, ["-c", "exit 0"], { stdio: "ignore", timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  });

  it("finds the documented invocations, and a shell to run them in", () => {
    // Both halves guard the same vacuity: if the skill is reworded so that
    // no fenced line runs the script, or if every shell went missing, the
    // assertions below would pass over an empty loop and prove nothing.
    expect(documentedInvocations().length).toBeGreaterThanOrEqual(2);
    expect(SHELLS).toContain("bash");
  });

  it("every documented invocation reports a failing bead as a failure", () => {
    const failing = writeBeads({
      id: "fixture-fails-everything",
      title: "a bead that fails the gate",
      status: "open",
      description: "",
      acceptance_criteria: "",
      notes: "",
      metadata: {},
    });
    const lines = documentedInvocations();
    expect(lines.length).toBeGreaterThanOrEqual(2);

    for (const line of lines) {
      // Point the documented command at the fixture instead of the live
      // `bd` database, changing nothing else about its shape -- the pipe,
      // the redirection and any shell options stay exactly as written.
      const runnable = line
        .replace(
          "node scripts/check-bead-dispatch.mjs",
          `node ${JSON.stringify(SCRIPT)} --beads ${JSON.stringify(failing)} --repo ${JSON.stringify(repo)} --head ${HEAD()}`,
        )
        .replaceAll("<bead-id>", "fixture-fails-everything");
      expect(runnable).not.toContain("<bead-id>");

      for (const shell of SHELLS) {
        const res = spawnShell(shell, runnable);
        expect(
          res.status,
          `${shell}: \`${line}\` reported ${res.status} for a bead that fails every check`,
        ).toBe(1);
      }
    }
  });

  /** Run one shell line, returning its status rather than throwing. */
  function spawnShell(shell, command) {
    try {
      execFileSync(shell, ["-c", command], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      return { status: 0 };
    } catch (err) {
      return { status: err.status };
    }
  }
});
