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
 * three-commit history and the CLI is pointed at it with `--repo`, so the
 * staleness counts asserted here are exact and do not depend on this repo
 * having fetched `origin/main`.
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
/** @type {string[]} full shas, oldest first */
let shas;

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
  return { dir, made };
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
      const failed = res.stdout
        .split("\n")
        .filter((l) => l.trim().startsWith("FAIL "))
        .map((l) => l.trim().split(/\s+/)[1]);
      expect(failed).toContain(fixture.check);
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
    expect(runFixture(completeBead({ notes: "" })).status).toBe(1);
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
  it("the user-story window is bounded, so background prose cannot supply the story", () => {
    expect(USER_STORY_WINDOW).toBeGreaterThan(0);
    const base = completeBead();
    const bead = {
      ...base,
      description: `In scope: x.\nOut of scope: y, owned by fixture-other.\n${"filler. ".repeat(200)}As a reader, I want a story, so that it counts.`,
    };
    expect(runFixture(bead).status).toBe(1);
  });
});
