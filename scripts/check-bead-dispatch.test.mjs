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
  CC_TYPES,
  EXAMINED_FIELDS,
  MODEL_EFFORTS,
  MODEL_TIERS,
  SUBSTANCE_CHECKS_NOT_MADE,
  USER_STORY_WINDOW,
  findPremiseLines,
  formatReport,
  invokedDirectly,
  makeGitContext,
  parseArgs,
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
    notes: `Premise verified 2026-10-12 at origin/main ${HEAD()} by running the fixture through the CLI.`,
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

describe("K2: premise freshness against origin/main's current HEAD", { timeout: 30_000 }, () => {
  it("fails and prints how many commits stale when the premise names an older commit", () => {
    const bead = completeBead({
      notes: `Premise verified 2026-10-12 at origin/main ${OLDEST()} by reading the fixture.`,
    });
    const res = runFixture(bead);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("premise is 2 commit(s) stale");
    expect(res.stdout).toContain(OLDEST().slice(0, 7));
    expect(res.stdout).toContain(HEAD().slice(0, 7));
  });

  it("passes when the premise names the current HEAD", () => {
    const res = runFixture(completeBead());
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("that premise commit is origin/main's current HEAD");
  });

  it("accepts an abbreviated sha for the current HEAD", () => {
    const bead = completeBead({
      notes: `Premise verified 2026-10-12 at origin/main ${HEAD().slice(0, 8)}.`,
    });
    expect(runFixture(bead).status).toBe(0);
  });

  it("the staleness count is the real distance, not a constant", () => {
    // Mutation guard: a hard-coded "1 commit(s) stale" would pass the first
    // test above only by luck, so assert a second, different distance.
    const bead = completeBead({
      notes: `Premise verified 2026-10-12 at origin/main ${shas[1]}.`,
    });
    const res = runFixture(bead);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("premise is 1 commit(s) stale");
  });

  it("the freshest premise on a bead wins when several are recorded", () => {
    // A bead re-verified today still carries yesterday's line in its log.
    const bead = completeBead({
      notes: [
        `Premise verified 2026-10-10 at origin/main ${OLDEST()}.`,
        `PREMISE CORRECTED 2026-10-12 at origin/main ${HEAD()}, before dispatch.`,
      ].join("\n"),
    });
    expect(runFixture(bead).status).toBe(0);
  });

  it("reads a premise statement whose sha wrapped onto the next line", () => {
    const bead = completeBead({
      notes: `Premise verified 2026-10-12 at origin/main\n${HEAD()} by reading the fixture.`,
    });
    expect(runFixture(bead).status).toBe(0);
  });

  it("accepts a premise carried in the description instead of the notes", () => {
    const base = completeBead();
    const bead = {
      ...base,
      notes: "",
      description: `${base.description}\n\nPremise verified 2026-10-12 at origin/main ${HEAD()}.`,
    };
    expect(runFixture(bead).status).toBe(0);
  });

  // --- identity, not one-directional distance ---
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
      const notes = (sha) => `Premise verified 2026-10-14 at feature-branch commit ${sha} (not on main).`;
      const off = runFixture(completeBead({ notes: notes(c.sha()) }));
      expect(off.status).toBe(1);
      expect(failedChecks(off.stdout)).toEqual(["premise-fresh"]);
      expect(off.stdout).toContain(`premise commit ${c.sha()} is not on origin/main: 1 commit(s)`);
      // The usual off-main commit is a branch commit
      // whose PR was squash-merged, so main HAS its change; the message must
      // not claim otherwise.
      expect(off.stdout).toContain("usually a branch commit whose PR was since squash-merged");
      expect(off.stdout).not.toContain("main does not have");
      expect(off.stdout).not.toContain("that premise commit is origin/main's current HEAD");

      // the same text naming a commit that IS main's HEAD passes
      const on = runFixture(completeBead({ notes: notes(HEAD()) }));
      expect(on.status).toBe(0);
      expect(on.stdout).toContain("that premise commit is origin/main's current HEAD");
    });
  }

  it("an off-main premise does not rescue a bead whose on-main premise is stale", () => {
    // The old freshest-wins reduction picked the descendant (0 behind) over
    // the stale main commit and passed the bead.
    const bead = completeBead({
      notes: [
        `Premise verified 2026-10-10 at origin/main ${OLDEST()}.`,
        `Premise re-verified 2026-10-14 on the feature branch at ${descendant}.`,
      ].join("\n"),
    });
    const res = runFixture(bead);
    expect(res.status).toBe(1);
    expect(failedChecks(res.stdout)).toEqual(["premise-fresh"]);
    expect(res.stdout).toContain("premise is 2 commit(s) stale");
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
    // Each statement is its line plus the following one (bd hard-wraps), so
    // consecutive premise lines overlap by design; what matters is that all
    // three shas are found, since freshness takes the best across the bead.
    expect([...new Set(found.flatMap((l) => l.shas))].sort()).toEqual(["9abcdef", "abc1234", "def5678"]);
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
  };
  const ctx = { git: stubGit, headShort: "fffffff" };

  it("reports per-check results, a pass flag, and the counts", () => {
    const result = validateBead(completeBead(), ctx);
    expect(result.checksRun).toBe(CHECKS.length);
    expect(result.fieldsExamined).toBe(EXAMINED_FIELDS.length);
    // the stub reports every premise as 7 commits behind, so this bead fails
    // on freshness alone -- which is itself the assertion
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
