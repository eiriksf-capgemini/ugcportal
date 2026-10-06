/**
 * Tests for the merged-branch/worktree sweep (ugcportal-nvg0).
 *
 * K2/K3 ask for a test over the pure classification logic, following the
 * scripts/sweep-candidates.mjs convention of exercising the exported
 * functions directly against fixtures rather than a real git remote. A
 * `.map()` over hand-built fixture objects cannot reproduce "git status is
 * clean but the commit was never pushed", or "git itself reports this
 * directory as gone", so the `describe("end-to-end ...")` block below
 * builds real temporary git repositories for exactly those two cases,
 * alongside the pure-fixture tests for everything else.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildOpenPrsByBase,
  buildPrInfoByBranch,
  classifyBranchRetarget,
  classifyGhApiDeleteFailure,
  classifyPreDeleteRecheck,
  classifyRemoteBranch,
  classifyRetargetVerification,
  classifyWorktree,
  deleteLocalBranch,
  deleteRemoteBranch,
  isShaPushedToRemote,
  isWorktreeDirty,
  needsPushedCheck,
  parseBranchFlag,
  parseRemoteHeads,
  parseRetargetFlag,
  parseWorktreeList,
  prListCapWarning,
  pruneRemoteTrackingRefs,
  recheckBeforeDeletingBranch,
  removeWorktree,
  resolveChdirTarget,
  resolveNewBase,
} from "./sweep-merged-branches.mjs";

describe("classifyRemoteBranch", () => {
  it("removes a branch whose PR merged", () => {
    expect(classifyRemoteBranch({ name: "fix/foo", isMainBranch: false, prState: "MERGED" })).toEqual({
      action: "remove",
      reason: "PR merged",
    });
  });

  it("keeps a branch whose PR is still open (K3)", () => {
    expect(classifyRemoteBranch({ name: "fix/foo", isMainBranch: false, prState: "OPEN" })).toEqual({
      action: "keep",
      reason: "PR open",
    });
  });

  it("keeps a branch whose PR was closed without merging (K3)", () => {
    expect(classifyRemoteBranch({ name: "docs/ugcportal-cbtk-ca-env-claim", isMainBranch: false, prState: "CLOSED" })).toEqual({
      action: "keep",
      reason: "PR closed without merge",
    });
  });

  it("keeps a branch with no PR at all, e.g. a non-PR ref like Dolt's (K3, out of scope)", () => {
    expect(classifyRemoteBranch({ name: "__dolt_remote_info__", isMainBranch: false, prState: null })).toEqual({
      action: "keep",
      reason: "no PR found for this branch",
    });
  });

  it("keeps the main branch even if something put a MERGED state behind its name (K3)", () => {
    expect(classifyRemoteBranch({ name: "main", isMainBranch: true, prState: "MERGED" })).toEqual({
      action: "keep",
      reason: "main branch",
    });
  });
});

describe("classifyWorktree", () => {
  const base = {
    path: "/tmp/wt",
    branch: "fix/foo",
    isMainWorktree: false,
    isLocked: false,
    isPrunable: false,
    statusUnknown: false,
    isDirty: false,
    isPushed: true,
    prState: "MERGED",
  };

  it("removes a clean, unlocked, pushed worktree whose branch's PR merged", () => {
    expect(classifyWorktree(base)).toEqual({ action: "remove", reason: "branch's PR merged" });
  });

  it("keeps an unpushed worktree even though its branch's PR merged and it is otherwise clean", () => {
    // Fixture-mutation check: isPushed is the only field that differs from
    // the "removes ..." case above -- flipping it, and nothing else, must
    // flip the verdict.
    expect(classifyWorktree({ ...base, isPushed: false })).toEqual({ action: "keep", reason: "unpushed commits" });
  });

  it("keeps a dirty worktree even though its branch's PR merged (K3)", () => {
    expect(classifyWorktree({ ...base, isDirty: true })).toEqual({
      action: "keep",
      reason: "worktree has uncommitted changes",
    });
  });

  it("keeps a locked worktree even though its branch's PR merged (K3)", () => {
    expect(classifyWorktree({ ...base, isLocked: true })).toEqual({
      action: "keep",
      reason: "worktree is locked",
    });
  });

  it("prunes a worktree git itself reports as prunable, instead of trying (and crashing) a status check", () => {
    expect(classifyWorktree({ ...base, isPrunable: true })).toEqual({
      action: "prune",
      reason: "worktree directory is gone -- git worktree prune will clear it",
    });
  });

  it("keeps a locked-AND-prunable worktree for the lock reason, since git worktree prune will not touch a locked one anyway", () => {
    // Fixture-mutation check: if isLocked were not checked before isPrunable,
    // this would instead report "prune".
    expect(classifyWorktree({ ...base, isLocked: true, isPrunable: true })).toEqual({
      action: "keep",
      reason: "worktree is locked",
    });
  });

  it("keeps a worktree whose dirty/clean status could not be determined, rather than guessing", () => {
    expect(classifyWorktree({ ...base, statusUnknown: true })).toEqual({
      action: "keep",
      reason: "could not determine whether the worktree is dirty",
    });
  });

  it("keeps the main checkout even though it is clean, unlocked and flagged MERGED (K3)", () => {
    expect(classifyWorktree({ ...base, isMainWorktree: true })).toEqual({
      action: "keep",
      reason: "main checkout",
    });
  });

  it("checks main-ness before lock state -- a locked worktree is still reported as the main checkout when isMainWorktree is true", () => {
    // Fixture-mutation check: isMainWorktree is checked FIRST in
    // classifyWorktree, before isLocked -- so a worktree that is both main
    // and locked reports "main checkout", not "worktree is locked".
    expect(classifyWorktree({ ...base, isMainWorktree: true, isLocked: true })).toEqual({
      action: "keep",
      reason: "main checkout",
    });
  });

  it("keeps a worktree whose branch's PR is open", () => {
    expect(classifyWorktree({ ...base, prState: "OPEN" })).toEqual({ action: "keep", reason: "PR open" });
  });

  it("keeps a worktree whose branch's PR closed without merging", () => {
    expect(classifyWorktree({ ...base, prState: "CLOSED" })).toEqual({
      action: "keep",
      reason: "PR closed without merge",
    });
  });

  it("keeps a worktree with no PR for its branch, e.g. an in-progress agent branch", () => {
    expect(classifyWorktree({ ...base, prState: null })).toEqual({
      action: "keep",
      reason: "no PR found for this branch",
    });
  });

  it("keeps a detached-HEAD worktree, which has no branch to look a PR up by", () => {
    expect(classifyWorktree({ ...base, branch: null, prState: null })).toEqual({
      action: "keep",
      reason: "detached HEAD, no branch to check",
    });
  });
});

describe("parseRemoteHeads", () => {
  it("extracts branch names from git ls-remote --heads output", () => {
    const output = [
      "f1cc7e855d569b0c33f80057f935b685356d1ca1\trefs/heads/__dolt_remote_info__",
      "63bd36f51ddbe41435d48c0225506b6f868ff201\trefs/heads/docs/ugcportal-cbtk-ca-env-claim",
      "",
    ].join("\n");
    expect(parseRemoteHeads(output)).toEqual(["__dolt_remote_info__", "docs/ugcportal-cbtk-ca-env-claim"]);
  });

  it("returns an empty list for empty output rather than throwing", () => {
    expect(parseRemoteHeads("")).toEqual([]);
  });
});

describe("parseWorktreeList", () => {
  it("parses the main worktree, a locked agent worktree, the HEAD sha, and strips refs/heads/ from the branch", () => {
    const output = [
      "worktree /Users/eiriksf/code/ugcportal",
      "HEAD 1c022bc52515173474438836845def98ab459575",
      "branch refs/heads/main",
      "",
      "worktree /Users/eiriksf/code/ugcportal/.claude/worktrees/agent-af2371f1a739b2b30",
      "HEAD ab04563ba23516cddb5b47afe88dae26d053786e",
      "branch refs/heads/worktree-agent-af2371f1a739b2b30",
      "locked claude agent agent-af2371f1a739b2b30 (pid 7786 start Tue Oct  6 05:05:06 2026)",
      "",
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      {
        path: "/Users/eiriksf/code/ugcportal",
        branch: "main",
        headSha: "1c022bc52515173474438836845def98ab459575",
        locked: false,
        lockReason: null,
        prunable: false,
      },
      {
        path: "/Users/eiriksf/code/ugcportal/.claude/worktrees/agent-af2371f1a739b2b30",
        branch: "worktree-agent-af2371f1a739b2b30",
        headSha: "ab04563ba23516cddb5b47afe88dae26d053786e",
        locked: true,
        lockReason: "claude agent agent-af2371f1a739b2b30 (pid 7786 start Tue Oct  6 05:05:06 2026)",
        prunable: false,
      },
    ]);
  });

  it("parses a prunable worktree (directory gone, e.g. deleted by hand)", () => {
    const output = [
      "worktree /tmp/gone",
      "HEAD 7b241927efd42ad7f6317669156cf718b16d780c",
      "branch refs/heads/feat/y",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      {
        path: "/tmp/gone",
        branch: "feat/y",
        headSha: "7b241927efd42ad7f6317669156cf718b16d780c",
        locked: false,
        lockReason: null,
        prunable: true,
      },
    ]);
  });

  it("parses a locked worktree with no reason text as locked with a null reason", () => {
    const output = ["worktree /tmp/wt", "HEAD abc123", "branch refs/heads/some-branch", "locked", ""].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/tmp/wt", branch: "some-branch", headSha: "abc123", locked: true, lockReason: null, prunable: false },
    ]);
  });

  it("parses a detached-HEAD worktree as branch: null", () => {
    const output = ["worktree /tmp/wt", "HEAD abc123", "detached", ""].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/tmp/wt", branch: null, headSha: "abc123", locked: false, lockReason: null, prunable: false },
    ]);
  });

  it("returns an empty list for empty output rather than throwing", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("buildPrInfoByBranch", () => {
  it("maps a branch to its PR's state, head commit and base branch", () => {
    const prs = [{ headRefName: "fix/foo", state: "MERGED", headRefOid: "abc123", baseRefName: "main", number: 1 }];
    expect(buildPrInfoByBranch(prs)).toEqual(new Map([["fix/foo", { state: "MERGED", headRefOid: "abc123", baseRefName: "main" }]]));
  });

  it("keeps the first (newest) PR's info when a branch name was reused -- baseRefName included (ugcportal-hvaf)", () => {
    // gh pr list --state all sorts by creation descending, so entry order
    // in the fixture mirrors "newest PR first" -- the case this guards.
    //
    // baseRefName deliberately differs between the two entries (as
    // headRefOid already did) -- both fixture entries
    // shared baseRefName: "main", so this test could not have caught a
    // regression that picked state/headRefOid from the newest entry but
    // baseRefName from the oldest. baseRefName is the field that decides
    // where a stacked PR gets retargeted (ugcportal-hvaf) -- safety-critical
    // input, not an incidental one. Mutation-checked: temporarily reading
    // `prs[prs.length - 1].baseRefName` (the OLDEST entry's value) instead
    // of the newest's made this assertion fail as expected, confirmed before
    // restoring the real implementation.
    const prs = [
      { headRefName: "fix/foo", state: "OPEN", headRefOid: "new111", baseRefName: "feat/new-base", number: 2 },
      { headRefName: "fix/foo", state: "MERGED", headRefOid: "old000", baseRefName: "feat/old-base", number: 1 },
    ];
    expect(buildPrInfoByBranch(prs).get("fix/foo")).toEqual({ state: "OPEN", headRefOid: "new111", baseRefName: "feat/new-base" });
  });

  it("returns an empty map for no PRs rather than throwing", () => {
    expect(buildPrInfoByBranch([])).toEqual(new Map());
  });
});

describe("classifyBranchRetarget (ugcportal-hvaf, K1/K2)", () => {
  it("is a no-op when no open PR is based on this branch", () => {
    expect(classifyBranchRetarget({ openPrsBasedOnBranch: [], retarget: true })).toEqual({ action: "none" });
  });

  it("retargets every open PR based on this branch when retargeting is enabled (K1)", () => {
    expect(classifyBranchRetarget({ openPrsBasedOnBranch: [{ number: 128 }, { number: 139 }], retarget: true })).toEqual({
      action: "retarget",
      prNumbers: [128, 139],
    });
  });

  it("keeps the branch and reports, naming the PR numbers, when retargeting is disabled", () => {
    // Fixture-mutation check: retarget is the only field that differs from
    // the "retargets ..." case above -- flipping it, and nothing else, must
    // flip the verdict from "retarget" to "keep".
    expect(classifyBranchRetarget({ openPrsBasedOnBranch: [{ number: 128 }, { number: 139 }], retarget: false })).toEqual({
      action: "keep",
      reason: "open PR(s) based on this branch, retargeting disabled by --no-retarget-open-prs: #128, #139",
    });
  });

  it("is a no-op even with retargeting disabled, when there is nothing to retarget", () => {
    expect(classifyBranchRetarget({ openPrsBasedOnBranch: [], retarget: false })).toEqual({ action: "none" });
  });
});

describe("classifyRetargetVerification (ugcportal-hvaf, K2)", () => {
  const base = { prNumber: 128, actualBaseRefName: "main", expectedBaseRefName: "main", state: "OPEN" };

  it("is ok when the PR reads back open, with the expected base", () => {
    expect(classifyRetargetVerification(base)).toEqual({ action: "ok" });
  });

  it("fails, naming the PR, when the base did not actually change", () => {
    // Fixture-mutation check: actualBaseRefName is the only field that
    // differs from the "is ok ..." case above.
    expect(classifyRetargetVerification({ ...base, actualBaseRefName: "fix/old-stacked-branch" })).toEqual({
      action: "failed",
      reason: "PR #128 base reads back as fix/old-stacked-branch, expected main",
    });
  });

  it("fails, naming the PR, when the PR is no longer open after the edit (K2: classifies keep-with-reason when retargeting fails)", () => {
    expect(classifyRetargetVerification({ ...base, state: "CLOSED" })).toEqual({
      action: "failed",
      reason: "PR #128 is no longer open after retargeting (state CLOSED)",
    });
  });
});

describe("parseRetargetFlag", () => {
  it("is true (retarget enabled) by default", () => {
    expect(parseRetargetFlag(["--execute"])).toBe(true);
  });

  it("is false when --no-retarget-open-prs is passed", () => {
    expect(parseRetargetFlag(["--execute", "--no-retarget-open-prs"])).toBe(false);
  });
});

describe("buildOpenPrsByBase (ugcportal-hvaf)", () => {
  it("groups open PRs by base branch, one upfront snapshot answering every branch's question at once", () => {
    const prs = [
      { number: 128, baseRefName: "fix/foo" },
      { number: 139, baseRefName: "fix/foo" },
      { number: 7, baseRefName: "fix/bar" },
    ];
    expect(buildOpenPrsByBase(prs)).toEqual(
      new Map([
        ["fix/foo", [{ number: 128 }, { number: 139 }]],
        ["fix/bar", [{ number: 7 }]],
      ]),
    );
  });

  it("returns an empty map for no open PRs rather than throwing", () => {
    expect(buildOpenPrsByBase([])).toEqual(new Map());
  });
});

describe("resolveNewBase (ugcportal-hvaf)", () => {
  const prInfoByBranch = new Map([
    // B's own merged PR had base "main" -- the two-level stack's resolution target.
    ["B", { state: "MERGED", headRefOid: "b1", baseRefName: "main" }],
  ]);

  it("returns the recorded base directly when that branch still exists on origin", () => {
    expect(
      resolveNewBase({ baseRefName: "main", remoteBranchNames: new Set(["main", "B"]), prInfoByBranch, mainBranch: "main" }),
    ).toBe("main");
  });

  it("two-level stack: walks up to B's own base when B (the recorded, intermediate base) no longer exists on origin", () => {
    // Reproduces a concrete scenario: branch A's merged PR recorded
    // base "B"; B's merged PR recorded base "main"; B has since been
    // deleted (this run or an earlier one), so it is no longer in
    // remoteBranchNames. A PR stacked on A must resolve to "main", not to
    // the now-dangling "B".
    expect(
      resolveNewBase({ baseRefName: "B", remoteBranchNames: new Set(["main"]), prInfoByBranch, mainBranch: "main" }),
    ).toBe("main");
  });

  it("falls back to main when the recorded base is gone and has no PR info of its own to walk further", () => {
    expect(
      resolveNewBase({ baseRefName: "ghost", remoteBranchNames: new Set(["main"]), prInfoByBranch: new Map(), mainBranch: "main" }),
    ).toBe("main");
  });

  it("falls back to main rather than looping forever on a cyclic chain", () => {
    const cyclic = new Map([
      ["X", { state: "MERGED", headRefOid: "x1", baseRefName: "Y" }],
      ["Y", { state: "MERGED", headRefOid: "y1", baseRefName: "X" }],
    ]);
    expect(
      resolveNewBase({ baseRefName: "X", remoteBranchNames: new Set(["main"]), prInfoByBranch: cyclic, mainBranch: "main" }),
    ).toBe("main");
  });

  it("fixture-mutation check: a THREE-level stack still resolves, proving this isn't special-cased to exactly two hops", () => {
    // C -> B -> main, with only "main" left on origin (both B and C already
    // swept this run or an earlier one).
    const threeLevel = new Map([
      ["B", { state: "MERGED", headRefOid: "b1", baseRefName: "main" }],
      ["C", { state: "MERGED", headRefOid: "c1", baseRefName: "B" }],
    ]);
    expect(
      resolveNewBase({ baseRefName: "C", remoteBranchNames: new Set(["main"]), prInfoByBranch: threeLevel, mainBranch: "main" }),
    ).toBe("main");
  });
});

describe("classifyPreDeleteRecheck (ugcportal-hvaf)", () => {
  it("allows the delete when nothing is based on this branch right now", () => {
    expect(classifyPreDeleteRecheck({ openPrsBasedOnBranch: [] })).toEqual({ action: "delete" });
  });

  it("keeps the branch, naming the PR(s), when something is based on it at this live, final check", () => {
    // Fixture-mutation check: openPrsBasedOnBranch is the only field that
    // differs from the "allows the delete ..." case above.
    expect(classifyPreDeleteRecheck({ openPrsBasedOnBranch: [{ number: 999 }] })).toEqual({
      action: "keep",
      reason: "open PR(s) appeared based on this branch since the last check, immediately before delete: #999",
    });
  });
});

describe("classifyGhApiDeleteFailure (ugcportal-ix0s)", () => {
  it("is 'unavailable' (fall back to git push --delete) when gh itself could not be spawned", () => {
    // output is deliberately non-empty junk here -- ghMissing must short-circuit
    // past it rather than happening to match one of the patterns below.
    expect(classifyGhApiDeleteFailure({ ghMissing: true, output: "HTTP 404 Not Found" })).toBe("unavailable");
  });

  it("is 'unavailable' (fall back to git push --delete) for a plain HTTP 404 response body -- ugcportal-ix0s: a 404 from this endpoint was verified live to mean the repository couldn't be resolved, not that the branch is already gone, so it is NOT treated as already-gone and must fall back instead", () => {
    expect(
      classifyGhApiDeleteFailure({
        ghMissing: false,
        output: '{"message":"Not Found","status":"404"}\ngh: Not Found (HTTP 404)',
      }),
    ).toBe("unavailable");
  });

  it("is 'unavailable' for gh's own 'HTTP 404' stderr line even without a JSON status field -- same ugcportal-ix0s reasoning", () => {
    expect(classifyGhApiDeleteFailure({ ghMissing: false, output: "gh: Not Found (HTTP 404)" })).toBe("unavailable");
  });

  it("is 'already-gone' for the real shape this endpoint actually returns for an already-gone ref: HTTP 422 'Reference does not exist' -- verified against the live GitHub API (2026-10-06), not simulated", () => {
    expect(
      classifyGhApiDeleteFailure({
        ghMissing: false,
        output:
          '{"message":"Reference does not exist","documentation_url":"https://docs.github.com/rest/git/refs#delete-a-reference","status":"422"}\ngh: Reference does not exist (HTTP 422)',
      }),
    ).toBe("already-gone");
  });

  it("is 'unavailable' for a 422 that is NOT the 'Reference does not exist' shape -- fixture-mutation check against the case above (only the message text differs)", () => {
    expect(
      classifyGhApiDeleteFailure({
        ghMissing: false,
        output: '{"message":"Validation Failed","status":"422"}\ngh: Validation Failed (HTTP 422)',
      }),
    ).toBe("unavailable");
  });

  it("is 'unavailable' for an unrelated server error, so the caller falls back to git push --delete rather than silently doing nothing", () => {
    expect(
      classifyGhApiDeleteFailure({
        ghMissing: false,
        output: '{"message":"Internal Server Error","status":"500"}\ngh: Internal Server Error (HTTP 500)',
      }),
    ).toBe("unavailable");
  });
});

describe("needsPushedCheck", () => {
  it("is true for an ordinary merged, non-prunable worktree with a head sha -- the case that makes the whole isPushed guard reachable", () => {
    expect(needsPushedCheck({ prState: "MERGED", headSha: "abc123", isPrunable: false })).toBe(true);
  });

  it("is false for a prunable worktree, even with a merged PR and a headSha -- its directory is gone, so nothing should -C into it", () => {
    expect(needsPushedCheck({ prState: "MERGED", headSha: "abc123", isPrunable: true })).toBe(false);
  });

  it("is false when the PR isn't MERGED, all else equal", () => {
    expect(needsPushedCheck({ prState: "OPEN", headSha: "abc123", isPrunable: false })).toBe(false);
  });

  it("is false with no headSha, all else equal", () => {
    expect(needsPushedCheck({ prState: "MERGED", headSha: null, isPrunable: false })).toBe(false);
  });
});

describe("prListCapWarning", () => {
  it("warns, naming both numbers, once the count reaches the limit", () => {
    expect(prListCapWarning(1000, 1000)).toBe(
      "gh pr list returned 1000 PRs, at or above the --limit 1000 cap -- the oldest merged PRs may be missing from this sweep.",
    );
  });

  it("is null well under the limit", () => {
    expect(prListCapWarning(5, 1000)).toBeNull();
  });
});

describe("parseBranchFlag", () => {
  it("returns the value when --branch is given one", () => {
    expect(parseBranchFlag(["--branch", "feat/x", "--execute"])).toEqual({ branch: "feat/x" });
  });

  it("returns the value for the --branch=<name> form", () => {
    expect(parseBranchFlag(["--branch=feat/x", "--execute"])).toEqual({ branch: "feat/x" });
  });

  it("is a usage error for an empty value", () => {
    expect(parseBranchFlag(["--branch", "", "--execute"])).toEqual({ error: "--branch requires a non-empty value" });
  });

  it("is a usage error for an empty --branch=<name> value", () => {
    expect(parseBranchFlag(["--branch=", "--execute"])).toEqual({ error: "--branch requires a non-empty value" });
  });

  it("is a usage error when --branch is the last argument", () => {
    expect(parseBranchFlag(["--execute", "--branch"])).toEqual({ error: "--branch requires a non-empty value" });
  });

  it("is a usage error when --branch is immediately followed by another flag, not a name", () => {
    expect(parseBranchFlag(["--branch", "--execute"])).toEqual({ error: "--branch requires a non-empty value" });
  });

  it("is a usage error for a misspelling that still starts with --branch", () => {
    expect(parseBranchFlag(["--branches", "feat/x", "--execute"])).toEqual({ error: "unrecognized form of --branch: --branches" });
  });

  it("is no filter (repo-wide) when --branch is absent entirely", () => {
    expect(parseBranchFlag(["--execute"])).toEqual({ branch: null });
  });

  it("--branch=<name> scopes main()'s own filter to exactly that branch, leaving an unnamed merged branch out", () => {
    const branchFlag = parseBranchFlag(["--branch=feat/alpha", "--execute"]);
    expect(branchFlag).toEqual({ branch: "feat/alpha" });

    // main()'s own filter expression: branchCandidates.filter((c) => c.name === onlyBranch).
    const branchCandidates = ["feat/alpha", "feat/beta"]
      .map((name) => ({ name, ...classifyRemoteBranch({ name, isMainBranch: false, prState: "MERGED" }) }))
      .filter((c) => c.name === branchFlag.branch);

    expect(branchCandidates).toEqual([{ name: "feat/alpha", action: "remove", reason: "PR merged" }]);
  });
});

describe("resolveChdirTarget", () => {
  const worktrees = [
    { path: "/repo/main" },
    { path: "/repo/.claude/worktrees/agent-1" },
  ];

  it("targets the main worktree when cwd is inside a non-main worktree", () => {
    expect(resolveChdirTarget(worktrees, "/repo/.claude/worktrees/agent-1")).toBe("/repo/main");
  });

  it("targets the main worktree when cwd is a subdirectory of a non-main worktree", () => {
    expect(resolveChdirTarget(worktrees, "/repo/.claude/worktrees/agent-1/src")).toBe("/repo/main");
  });

  it("returns null when cwd is already the main worktree", () => {
    expect(resolveChdirTarget(worktrees, "/repo/main")).toBeNull();
  });

  it("returns null when cwd is outside every known worktree", () => {
    expect(resolveChdirTarget(worktrees, "/somewhere/else")).toBeNull();
  });
});

// --- End-to-end: real temporary git repositories --------------------------
//
// The unpushed-commit and deleted-directory cases below only show up against
// real git state: a worktree with an unpushed commit still reports a clean
// `git status`, and a worktree whose directory is gone makes `git status`
// exit non-zero rather than returning a result to assert on -- neither is
// constructible by hand-building a fixture object. These tests rebuild that
// state inside a disposable temp directory via plain git commands, and
// exercise the real (non-pure) git-shelling helpers against it.

// Every fixture git call below is isolated on THREE independent axes, not
// just one, after a real incident: a prior version of this file used `-C
// <tmpdir>` alone (plus the GIT_* stripping in beforeAll below) and still
// corrupted the SHARED repository config that every worktree of this repo
// reads (core.bare flipped true, user.name/user.email overwritten with this
// file's own test identity) during a run where the pre-push hook had
// GIT_DIR/GIT_WORK_TREE set in the environment -- those two variables
// override git's own repository discovery for a call that has neither `-C`
// nor an explicit directory argument of its own, so `-C <tmpdir>` alone is
// not a boundary git itself enforces. The prime suspect, identified after
// the fact: a path-less `git init --bare` (no directory argument at all) or
// a bare `git config` call (no `-C`) is what GIT_DIR actually overrides --
// a call that already names a directory, like `git init -q --bare <path>`,
// is not. The three independent layers now in force:
//
//   1. `cwd` (a real OS working-directory change, Node's guarantee, not
//      git's) on every single invocation -- never a bare positional path.
//   2. GIT_CEILING_DIRECTORIES pinned to `os.tmpdir()` so that even if
//      discovery ever runs, it cannot walk upward past the temp root into
//      a real repository; GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL=/dev/null
//      so no system- or user-level config (which a stray write could also
//      reach) is ever read or considered.
//   3. Identity passed per-invocation as `-c user.name=... -c
//      user.email=...` rather than a persistent `git config` write -- so
//      even a misdirected call has no persistent config file to write the
//      fixture's identity into, anywhere.
//
// None of these three is assumed sufficient alone; together they mean no
// single git behaviour this suite doesn't control has to be trusted.

const FIXTURE_TMP_ROOT = os.tmpdir();
const FIXTURE_IDENTITY_ARGS = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

function fixtureGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CEILING_DIRECTORIES = FIXTURE_TMP_ROOT;
  return env;
}

/** Runs `git <args>` with `cwd` as the real process working directory (never a positional path argument) and the isolation above. */
function fixtureGit(cwd, args, options = {}) {
  return execFileSync("git", [...FIXTURE_IDENTITY_ARGS, ...args], { cwd, env: fixtureGitEnv(), encoding: "utf8", ...options });
}

function makeFixtureRepo(prefix) {
  const root = fs.mkdtempSync(path.join(FIXTURE_TMP_ROOT, prefix));
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(repoDir);
  fixtureGit(repoDir, ["init", "-q"]);
  fixtureGit(repoDir, ["commit", "--allow-empty", "-q", "-m", "init"]);
  return { root, repoDir };
}

// ugcportal-9faa: every case below runs several real `git` subprocesses
// against its own fixture repo (init, commits, a real remote, worktree
// adds/removes) -- there is no shared state to cache, since each case needs
// its own isolated repository on disk, same reasoning as the explicit
// per-test timeout already below on the "stateful fake gh" describe's single
// test. An explicit describe-level timeout, not a bigger global default,
// keeps real subprocess latency under machine load from being mistaken for
// a hang.
describe("end-to-end against real temporary git repositories", { timeout: 20_000 }, () => {
  // `fixtureGit` above isolates every call it makes, but the IMPORTED
  // production functions under test (isWorktreeDirty, isShaPushedToRemote)
  // call `execFileSync` directly with no env override of their own -- by
  // design, since in real use they run against the actual target repo, not
  // an isolated fixture. Under this repo's own pre-push hook (which sets
  // GIT_DIR/GIT_WORK_TREE), those calls would otherwise read the wrong
  // repository for the same reason `fixtureGit` needs isolation at all:
  // reproduced directly -- `isShaPushedToRemote` returned false for a commit
  // this test had just pushed, because it was reading this worktree's
  // branches, not the fixture's. Stripping GIT_* for the lifetime of this
  // describe block (read-only queries only touch the wrong repo here, never
  // write to it) covers those two calls the same way `fixtureGit` covers its
  // own.
  let savedGitEnv;
  beforeAll(() => {
    savedGitEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_")) {
        savedGitEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });
  afterAll(() => {
    Object.assign(process.env, savedGitEnv);
  });

  it("keeps a clean worktree with one committed-but-unpushed commit, instead of handing it to git branch -D", () => {
    const { root, repoDir } = makeFixtureRepo("unpushed-commit-");
    const wtDir = path.join(root, "wt");
    try {
      fixtureGit(repoDir, ["worktree", "add", "-q", wtDir, "-b", "feat/x"]);
      fixtureGit(wtDir, ["commit", "--allow-empty", "-q", "-m", "unpushed follow-up"]);
      const headSha = fixtureGit(wtDir, ["rev-parse", "HEAD"]).trim();

      // Reproduces the bug exactly: working tree is clean...
      expect(isWorktreeDirty(wtDir)).toBe(false);
      // ...but the commit is unreachable from any remote branch -- there is
      // no remote at all in this fixture, which is the realistic case for a
      // squash-merge repo: a branch's own commits are never reachable from
      // `main` even once its PR has merged.
      expect(isShaPushedToRemote(headSha, wtDir)).toBe(false);

      // Fed into the real classifier with the PR already reported MERGED --
      // the worktree must be kept, never force-branch-deleted.
      expect(
        classifyWorktree({
          path: wtDir,
          branch: "feat/x",
          isMainWorktree: false,
          isLocked: false,
          isPrunable: false,
          statusUnknown: false,
          isDirty: isWorktreeDirty(wtDir),
          isPushed: isShaPushedToRemote(headSha, wtDir),
          prState: "MERGED",
        }),
      ).toEqual({ action: "keep", reason: "unpushed commits" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fixture-mutation check: pushing the SAME commit to a real remote flips isShaPushedToRemote, and the worktree becomes removable", () => {
    const { root, repoDir } = makeFixtureRepo("pushed-commit-");
    const wtDir = path.join(root, "wt");
    const remoteDir = path.join(root, "remote.git");
    try {
      fs.mkdirSync(remoteDir);
      fixtureGit(remoteDir, ["init", "-q", "--bare"]); // no positional path -- `cwd` is the only thing naming the target
      fixtureGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fixtureGit(repoDir, ["worktree", "add", "-q", wtDir, "-b", "feat/x"]);
      fixtureGit(wtDir, ["commit", "--allow-empty", "-q", "-m", "now pushed"]);
      const headSha = fixtureGit(wtDir, ["rev-parse", "HEAD"]).trim();

      // Before the push: same unpushed shape as the test above, this time
      // with a real (but not-yet-used) remote configured.
      expect(isShaPushedToRemote(headSha, wtDir)).toBe(false);

      fixtureGit(wtDir, ["push", "-q", "origin", "feat/x"]);

      // The mutation: nothing but the push happened. The exact same sha, on
      // the exact same worktree, now reads as pushed.
      expect(isShaPushedToRemote(headSha, wtDir)).toBe(true);

      expect(
        classifyWorktree({
          path: wtDir,
          branch: "feat/x",
          isMainWorktree: false,
          isLocked: false,
          isPrunable: false,
          statusUnknown: false,
          isDirty: isWorktreeDirty(wtDir),
          isPushed: isShaPushedToRemote(headSha, wtDir),
          prState: "MERGED",
        }),
      ).toEqual({ action: "remove", reason: "branch's PR merged" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses a worktree whose directory was deleted by hand as prunable, and classifies it 'prune' without crashing on git status", () => {
    const { root, repoDir } = makeFixtureRepo("prunable-worktree-");
    const wtDir = path.join(root, "wt");
    try {
      fixtureGit(repoDir, ["worktree", "add", "-q", wtDir, "-b", "feat/y"]);
      fs.rmSync(wtDir, { recursive: true, force: true }); // simulate a hand-deleted worktree directory, not `git worktree remove`

      const listing = parseWorktreeList(fixtureGit(repoDir, ["worktree", "list", "--porcelain"]));
      const deleted = listing.find((w) => w.branch === "feat/y");
      expect(deleted.prunable).toBe(true); // reproduces the exact porcelain line this bug depended on

      // The real isWorktreeDirty call on a gone directory still throws (exit
      // 128). A caller must never call it for a prunable entry; main() now
      // skips it via this same parsed flag.
      expect(() => isWorktreeDirty(deleted.path)).toThrow();

      expect(
        classifyWorktree({
          path: deleted.path,
          branch: deleted.branch,
          isMainWorktree: false,
          isLocked: deleted.locked,
          isPrunable: deleted.prunable,
          statusUnknown: false,
          isDirty: false,
          isPushed: true,
          prState: "MERGED",
        }),
      ).toEqual({ action: "prune", reason: "worktree directory is gone -- git worktree prune will clear it" });
    } finally {
      try {
        fixtureGit(repoDir, ["worktree", "prune"], { stdio: "ignore" });
      } catch {
        // best-effort cleanup -- the assertions above are what the test is for
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pruneRemoteTrackingRefs refreshes a tracking ref left stale by a branch deletion this clone never fetched", () => {
    const { root, repoDir } = makeFixtureRepo("stale-remote-branch-");
    const remoteDir = path.join(root, "remote.git");
    try {
      fs.mkdirSync(remoteDir);
      fixtureGit(remoteDir, ["init", "-q", "--bare"]);
      fixtureGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fixtureGit(repoDir, ["checkout", "-q", "-b", "feat/s"]);
      fixtureGit(repoDir, ["commit", "--allow-empty", "-q", "-m", "only reachable via feat/s"]);
      const headSha = fixtureGit(repoDir, ["rev-parse", "HEAD"]).trim();
      fixtureGit(repoDir, ["push", "-q", "origin", "feat/s"]);

      expect(isShaPushedToRemote(headSha, repoDir)).toBe(true);

      // An external deletion this clone doesn't know about yet: removed
      // directly on the bare remote, not via `git push origin --delete`
      // from repoDir, so repoDir's own tracking ref is left stale.
      fixtureGit(remoteDir, ["branch", "-D", "feat/s"]);

      // Stale and wrong: the remote branch is gone, but the cached
      // tracking ref has not caught up.
      expect(isShaPushedToRemote(headSha, repoDir)).toBe(true);

      pruneRemoteTrackingRefs(repoDir);

      // Fixture-mutation check: nothing but the prune ran. The same sha,
      // on the same repo, now correctly reads as not pushed.
      expect(isShaPushedToRemote(headSha, repoDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deleteRemoteBranch prunes its own tracking ref immediately, so a same-run re-check sees the deletion", () => {
    const { root, repoDir } = makeFixtureRepo("same-run-delete-");
    const wtDir = path.join(root, "wt");
    const remoteDir = path.join(root, "remote.git");
    try {
      fs.mkdirSync(remoteDir);
      fixtureGit(remoteDir, ["init", "-q", "--bare"]);
      fixtureGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fixtureGit(repoDir, ["worktree", "add", "-q", wtDir, "-b", "feat/z"]);
      fixtureGit(wtDir, ["push", "-q", "-u", "origin", "feat/z"]);
      fixtureGit(wtDir, ["commit", "--allow-empty", "-q", "-m", "a pushed follow-up"]);
      fixtureGit(wtDir, ["push", "-q", "origin", "feat/z"]);
      const headSha = fixtureGit(wtDir, ["rev-parse", "HEAD"]).trim();

      // Before any deletion: correctly reachable via origin/feat/z.
      expect(isShaPushedToRemote(headSha, wtDir)).toBe(true);

      // main()'s remote-branch loop runs before its worktree loop --
      // reproduce that ordering directly.
      deleteRemoteBranch("feat/z", repoDir);

      // Fixture-mutation check: nothing but that one deletion ran. The
      // exact same sha, on the exact same worktree, now correctly reads as
      // not pushed -- deleteRemoteBranch's own immediate ref-prune is what
      // makes a same-run re-check see this instead of the value computed
      // before the delete.
      expect(isShaPushedToRemote(headSha, wtDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recheckBeforeDeletingBranch keeps the local branch when the only containing ref was the remote branch this same run just deleted", () => {
    const { root, repoDir } = makeFixtureRepo("recheck-keeps-");
    const wtDir = path.join(root, "wt");
    const remoteDir = path.join(root, "remote.git");
    try {
      fs.mkdirSync(remoteDir);
      fixtureGit(remoteDir, ["init", "-q", "--bare"]);
      fixtureGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fixtureGit(repoDir, ["worktree", "add", "-q", wtDir, "-b", "feat/post"]);
      fixtureGit(wtDir, ["push", "-q", "-u", "origin", "feat/post"]);
      fixtureGit(wtDir, ["commit", "--allow-empty", "-q", "-m", "a pushed follow-up"]);
      fixtureGit(wtDir, ["push", "-q", "origin", "feat/post"]);
      const headSha = fixtureGit(wtDir, ["rev-parse", "HEAD"]).trim();

      deleteRemoteBranch("feat/post", repoDir);

      // Fixture-mutation check: removing this re-check (always returning
      // {action: "delete"}) makes this assertion fail, with nothing else in
      // the suite catching the regression -- the gap this test closes.
      expect(recheckBeforeDeletingBranch({ headSha, prHeadRefOid: "0".repeat(40), cwd: repoDir })).toEqual({
        action: "keep",
        reason: "only ref was the deleted remote branch",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the worktree removal breaks default-cwd git calls when run from inside the worktree being removed", () => {
    const { root, repoDir } = makeFixtureRepo("cwd-breaks-");
    const wtDir = path.join(root, "wt");
    const originalCwd = process.cwd();
    try {
      fixtureGit(repoDir, ["worktree", "add", "-q", wtDir, "-b", "feat/broken"]);
      process.chdir(wtDir);
      removeWorktree(wtDir); // deletes the directory that is now process.cwd()
      expect(() => deleteLocalBranch("feat/broken")).toThrow();
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("completes and removes the local branch when the pivot to the main checkout runs first", () => {
    const { root, repoDir } = makeFixtureRepo("cwd-is-doomed-");
    const wtDir = path.join(root, "wt");
    const originalCwd = process.cwd();
    try {
      fixtureGit(repoDir, ["worktree", "add", "-q", wtDir, "-b", "feat/self"]);

      // process.chdir resolves symlinks (e.g. macOS's /var -> /private/var),
      // same as the real process.cwd() main() reads -- compare against that
      // resolved form, not the pre-chdir path, so this matches production.
      process.chdir(wtDir);
      const worktrees = parseWorktreeList(fixtureGit(repoDir, ["worktree", "list", "--porcelain"]));
      const chdirTarget = resolveChdirTarget(worktrees, process.cwd());
      expect(chdirTarget).not.toBeNull();

      process.chdir(chdirTarget);
      removeWorktree(wtDir);
      deleteLocalBranch("feat/self");

      expect(fixtureGit(repoDir, ["branch", "--list", "feat/self"]).trim()).toBe("");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- End-to-end: real temp git repo + a stateful fake `gh` on PATH --------
//
// The real (non-pure) orchestration in main() -- the upfront batch snapshot,
// the live retarget-then-verify dance, and the final pre-delete recheck --
// is not exercised by the pure-fixture tests above, which feed each
// classifier its inputs directly. The gaps this bead (ugcportal-hvaf) found
// are specifically in that WIRING (a TOCTOU window between the batch
// snapshot and the delete call, a `--limit`-less `gh pr list`), so this
// section drives the actual script, as a child process, against a real
// temporary git remote, with a small stateful fake `gh` standing in for the
// real CLI -- proving the wiring, not just the classifiers it calls.

const SWEEP_SCRIPT_PATH = fileURLToPath(new URL("./sweep-merged-branches.mjs", import.meta.url));

/**
 * Writes a fake `gh` executable into `dir` (a plain `/bin/sh` wrapper around
 * an explicit `.cjs` implementation file, so there is no ambiguity about
 * which module system an extensionless, shebang-executed script should use)
 * that answers every `gh` subcommand `scripts/sweep-merged-branches.mjs`
 * makes, from `config`, and refuses (nonzero exit, a message naming the
 * unrecognized args) anything it doesn't recognize -- so a wiring mistake in
 * the real script surfaces as a loud, specific failure here rather than a
 * silent empty response. Also enforces `--limit` is present on every `gh pr
 * list` call, at or above `config.limitMin` (ugcportal-hvaf): drop
 * `--limit` from the real script and every test using this fake starts
 * failing, instead of a regression going unnoticed.
 *
 * Every invocation's argv is appended, one JSON array per line, to
 * `<dir>/gh-call-log.jsonl`, so a test can assert on what was actually
 * called, not just on the real script's visible side effects.
 *
 * Also answers `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/<branch>`
 * (ugcportal-ix0s, the primary path `deleteRemoteBranch` now tries before
 * falling back to `git push origin --delete`): unless `config.apiDeleteFailures[branch]`
 * says otherwise, it deletes `refs/heads/<branch>` directly on
 * `config.remoteDir` via `git update-ref -d` -- a direct ref write, not a
 * push, the same way the real GitHub API's effect on the ref never goes
 * through git's push/receive machinery either -- so the real `git
 * ls-remote` check `main()`'s own caller (`deleteRemoteBranch`) runs next
 * sees a result consistent with what the real API call would leave behind.
 * `config.apiDeleteFailures[branch]`, when set to one of `"422-reference-gone"`
 * (the only shape this endpoint is actually observed to return for an
 * already-gone ref, verified 2026-10-06 -- see `classifyGhApiDeleteFailure`'s
 * own doc), `"404"` (verified live to mean the REPOSITORY couldn't be
 * resolved, not that the branch is already gone -- ugcportal-ix0s: must fall
 * back to `git push origin --delete` like any other unrecognized failure,
 * not be treated as already-gone) or `"500"`,
 * fails the call with that real response shape instead, without touching
 * `remoteDir`.
 */
function writeFakeGh(dir, config) {
  const configPath = path.join(dir, "gh-config.json");
  const logPath = path.join(dir, "gh-call-log.jsonl");
  fs.writeFileSync(configPath, JSON.stringify(config));

  const implPath = path.join(dir, "gh-impl.cjs");
  const impl = `
const fs = require("fs");
const { execFileSync } = require("child_process");
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");

function flagValue(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
function fail(code, message) {
  process.stderr.write(message + "\\n");
  process.exit(code);
}

// Real response bodies this endpoint is actually observed (ugcportal-ix0s,
// 2026-10-06 against the real GitHub API) or documented to return.
const API_DELETE_RESPONSES = {
  "404": '{"message":"Not Found","status":"404"}\\ngh: Not Found (HTTP 404)',
  "422-reference-gone":
    '{"message":"Reference does not exist","documentation_url":"https://docs.github.com/rest/git/refs#delete-a-reference","status":"422"}\\ngh: Reference does not exist (HTTP 422)',
  "500": '{"message":"Internal Server Error","status":"500"}\\ngh: Internal Server Error (HTTP 500)',
};

if (args[0] === "api" && args[1] === "-X" && args[2] === "DELETE") {
  const m = /refs\\/heads\\/(.+)$/.exec(args[3] || "");
  const branch = m && m[1];
  if (!branch) fail(2, "fake-gh: could not parse branch from api call: " + JSON.stringify(args));

  const failureKey = config.apiDeleteFailures && config.apiDeleteFailures[branch];
  if (!failureKey) {
    if (!config.remoteDir) fail(2, "fake-gh: api delete call with no config.remoteDir to apply it to: " + JSON.stringify(args));
    execFileSync("git", ["-C", config.remoteDir, "update-ref", "-d", \`refs/heads/\${branch}\`]);
    process.exit(0);
  }
  const body = API_DELETE_RESPONSES[failureKey];
  if (!body) fail(2, "fake-gh: unrecognized apiDeleteFailures key: " + failureKey);
  fail(1, body);
}

if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write((config.defaultBranch || "main") + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  const limit = flagValue("--limit");
  if (!limit || Number(limit) < (config.limitMin || 0)) {
    fail(2, "fake-gh: missing or too-low --limit (ugcportal-hvaf regression): " + JSON.stringify(args));
  }
  const base = flagValue("--base");
  const json = flagValue("--json");
  let result;
  if (base) {
    result = (config.prListOpenByBase && config.prListOpenByBase[base]) || [];
  } else if (json === "headRefName,state,number,headRefOid,baseRefName") {
    result = config.prListAll || [];
  } else if (json === "number,baseRefName") {
    result = config.prListOpenBatch || [];
  } else {
    fail(2, "fake-gh: unrecognized pr list shape: " + JSON.stringify(args));
  }
  process.stdout.write(JSON.stringify(result) + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "edit") {
  const prNumber = args[2];
  const failure = config.editFailures && config.editFailures[prNumber];
  if (failure) fail(1, failure);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const prNumber = args[2];
  const resp = (config.viewResponses && config.viewResponses[prNumber]) || { baseRefName: "main", state: "OPEN" };
  process.stdout.write(JSON.stringify(resp) + "\\n");
  process.exit(0);
}

fail(2, "fake-gh: unhandled invocation: " + JSON.stringify(args));
`;
  fs.writeFileSync(implPath, impl);

  const ghPath = path.join(dir, "gh");
  fs.writeFileSync(ghPath, `#!/bin/sh\nexec node ${JSON.stringify(implPath)} "$@"\n`);
  fs.chmodSync(ghPath, 0o755);

  return { configPath, logPath };
}

/**
 * Installs a `pre-receive` hook on the bare repo at `remoteDir` that appends
 * every incoming ref-update line (`<old> <new> <ref>`, one per line, git's
 * own pre-receive protocol) to a plain log file, then allows the push
 * (ugcportal-ix0s). `git init --bare` already creates `hooks/`, so no mkdir
 * is needed. This is how "no git push runs" is asserted below: `git push`
 * cannot reach the remote without going through this hook, while the fake
 * `gh`'s api-delete handler (a direct `git update-ref -d` against the bare
 * repo, simulating the real GitHub API's effect on the ref) does not trigger
 * it -- so a log with no entry for a branch is direct evidence no push for
 * that branch happened, not an inference from the absence of some other
 * signal.
 *
 * @returns {string} path to the log file -- absent (not created at all)
 *   until the first push actually reaches this hook.
 */
function installPushLogger(remoteDir) {
  const logPath = path.join(remoteDir, "push-log.txt");
  const hookPath = path.join(remoteDir, "hooks", "pre-receive");
  fs.writeFileSync(hookPath, `#!/bin/sh\ncat >> ${JSON.stringify(logPath)}\nexit 0\n`);
  fs.chmodSync(hookPath, 0o755);
  return logPath;
}

/** @returns {string} the push log `installPushLogger` wrote, or "" if no push ever reached the hook. */
function readPushLog(logPath) {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
}

/** Runs the real script as a child process with the isolation `fixtureGitEnv` already applies to plain git calls, plus `dir` prepended to PATH so `gh` resolves to the fake. Never throws on a nonzero exit (the script sets one whenever it keeps a branch) -- callers need both the output AND the status. */
function runSweepScript({ cwd, fakeGhDir, args }) {
  const env = { ...fixtureGitEnv(), PATH: `${fakeGhDir}${path.delimiter}${process.env.PATH}` };
  try {
    const stdout = execFileSync(process.execPath, [SWEEP_SCRIPT_PATH, ...args], { cwd, env, encoding: "utf8" });
    return { status: 0, output: stdout };
  } catch (err) {
    return { status: err.status ?? 1, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("end-to-end against a real temp git remote and a stateful fake gh (ugcportal-hvaf)", () => {
  it("TOCTOU recheck keeps a branch the batch snapshot said was clear, once something appears live right before delete; partial-retarget failure is reported PR-by-PR and also keeps; a branch with nothing ever stacked on it still deletes cleanly -- and every gh pr list call carries --limit", () => {
    // Explicit, generous timeout (vitest's default is 5000ms): this test
    // spawns the real script as its own child process, which itself shells
    // out to git and the fake gh several times over -- real subprocess
    // overhead that the in-process pure-fixture tests above don't carry, and
    // which a busy machine can push past the default on its own, independent
    // of anything this test is actually checking.
    const { root, repoDir } = makeFixtureRepo("hvaf-round2-");
    const remoteDir = path.join(root, "remote.git");
    const ghBinDir = path.join(root, "bin");
    try {
      fixtureGit(repoDir, ["branch", "-m", "main"]); // name the clone's own branch deterministically, regardless of this git install's init.defaultBranch
      fs.mkdirSync(remoteDir);
      fixtureGit(remoteDir, ["init", "-q", "--bare"]);
      fixtureGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fixtureGit(repoDir, ["push", "-q", "-u", "origin", "main"]);

      // Three merged-PR branches, each pushed to origin, clone left checked
      // out on main throughout (git worktree list reports exactly one
      // worktree either way, so these never need their own checkout):
      //   feat/toctou  -- nothing stacked per the upfront batch, but a new
      //                   PR appears at the live, immediately-before-delete
      //                   recheck -- must be KEPT.
      //   feat/partial -- two PRs stacked per the batch; the first
      //                   retargets and verifies fine, the second's `gh pr
      //                   edit` fails -- must be KEPT, with the
      //                   successfully-retargeted PR named separately from
      //                   the failure.
      //   feat/clean   -- nothing stacked, ever -- must still be DELETED
      //                   (the baseline path has to keep working).
      for (const branch of ["feat/toctou", "feat/partial", "feat/clean"]) {
        fixtureGit(repoDir, ["branch", branch]);
        fixtureGit(repoDir, ["push", "-q", "origin", branch]);
      }

      // ugcportal-ix0s: a pre-receive hook on the real bare remote, logging
      // every incoming ref update -- direct evidence of whether `git push`
      // ever reached it, not an inference. The fake `gh`'s own api-delete
      // handler goes around this entirely (a direct `git update-ref -d`
      // against `remoteDir`, simulating the real API's effect on the ref
      // without using push at all), so an empty log after this run means no
      // push happened for any of these deletions.
      const pushLog = installPushLogger(remoteDir);

      fs.mkdirSync(ghBinDir);
      const { logPath } = writeFakeGh(ghBinDir, {
        defaultBranch: "main",
        limitMin: 500, // gh's own un-limited default is 30
        remoteDir, // ugcportal-ix0s: lets the fake's api-delete handler act on the real ref
        prListAll: [
          { headRefName: "feat/toctou", state: "MERGED", number: 201, headRefOid: "deadbeef", baseRefName: "main" },
          { headRefName: "feat/partial", state: "MERGED", number: 202, headRefOid: "deadbeef", baseRefName: "main" },
          { headRefName: "feat/clean", state: "MERGED", number: 203, headRefOid: "deadbeef", baseRefName: "main" },
        ],
        // The upfront batch snapshot: feat/toctou shows nothing stacked on
        // it here -- the whole point of the TOCTOU scenario below.
        prListOpenBatch: [
          { number: 501, baseRefName: "feat/partial" },
          { number: 502, baseRefName: "feat/partial" },
        ],
        // The LIVE, per-branch, immediately-before-delete recheck -- only
        // feat/toctou has something here, simulating a PR opened in the gap
        // between the batch snapshot above and the moment of deletion.
        prListOpenByBase: {
          "feat/toctou": [{ number: 999 }],
          "feat/clean": [],
        },
        editFailures: {
          "502": "fake-gh: simulated gh pr edit failure for PR #502",
        },
        viewResponses: {
          "501": { baseRefName: "main", state: "OPEN" },
        },
      });

      const result = runSweepScript({ cwd: repoDir, fakeGhDir: ghBinDir, args: ["--execute"] });

      // feat/toctou: batch said clear, live recheck found #999 -- kept.
      expect(result.output).toContain(
        "kept origin/feat/toctou: open PR(s) appeared based on this branch since the last check, immediately before delete: #999",
      );

      // feat/partial: PR #501 retargeted and verified fine; #502's edit
      // failed -- kept, and the reason names #502 while #501's success is
      // reported separately rather than silently folded into one message.
      expect(result.output).toContain("kept origin/feat/partial:");
      expect(result.output).toContain("#502");
      expect(result.output).toContain("already retargeted before the failure: #501");

      // feat/clean: nothing ever stacked on it -- the baseline path still
      // deletes normally.
      expect(result.output).toContain("removed origin/feat/clean");

      expect(result.status).not.toBe(0); // two branches kept -- main() sets a nonzero exit

      const remaining = fixtureGit(repoDir, ["ls-remote", "--heads", "origin"]);
      expect(remaining).toContain("refs/heads/feat/toctou");
      expect(remaining).toContain("refs/heads/feat/partial");
      expect(remaining).not.toContain("refs/heads/feat/clean");
      expect(remaining).toContain("refs/heads/main");

      // Directly: every `gh pr list` invocation this run made carried
      // --limit (the fake would otherwise have refused it, which would
      // already have failed the assertions above, but this checks the
      // actual call log rather than relying on that alone).
      const calls = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const listCalls = calls.filter((argv) => argv[0] === "pr" && argv[1] === "list");
      expect(listCalls.length).toBeGreaterThan(0);
      for (const argv of listCalls) {
        expect(argv).toContain("--limit");
      }

      // #501 really was retargeted (an actual `gh pr edit` call was made for
      // it), not just reported as if it had been.
      expect(calls).toContainEqual(["pr", "edit", "501", "--base", "main"]);

      // ugcportal-ix0s: feat/clean's deletion went through the GitHub API --
      // and it is the ONLY api-delete call this run made (feat/toctou and
      // feat/partial were both kept before ever reaching deleteRemoteBranch,
      // so neither could have made one) -- asserted as an exact array, not
      // `toContainEqual`, so this is the claim actually checked, not just a
      // presence check that would also pass if an unexpected extra call snuck in.
      const apiDeleteCalls = calls.filter((argv) => argv[0] === "api");
      expect(apiDeleteCalls).toEqual([["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/heads/feat/clean"]]);
      // And no git push ever reached the remote for it (or anything else --
      // feat/toctou and feat/partial were both kept, so neither was ever a
      // delete candidate at all): direct evidence from the remote's own
      // pre-receive hook, not an inference from the output above.
      expect(readPushLog(pushLog)).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

// --- End-to-end: deleteRemoteBranch's own API-vs-fallback branching --------
//
// The describe block above exercises the full `main()` orchestration with a
// stateful fake `gh` that answers `pr list`/`pr edit`/`pr view` (and, since
// ugcportal-ix0s, `api -X DELETE .../git/refs/heads/<branch>` too, via the
// same `writeFakeGh`). This block is narrower and newer (ugcportal-ix0s): it
// calls `deleteRemoteBranch` directly against a real temporary git remote,
// reusing that same fake `gh`, to prove three things the pure
// `classifyGhApiDeleteFailure` tests above cannot: that a successful API call
// never reaches `git push` at all, that an
// already-gone ref (verified above to come back as HTTP 422 "Reference does
// not exist" from the real API, not HTTP 404) is accepted the same way, and
// that a real `git push origin --delete` actually runs -- and still
// succeeds -- when the API fails for any other reason, including a 404
// (ugcportal-ix0s: verified live to mean the repository couldn't be
// resolved, not that the branch is already gone).
//
// "Never reaches git push" is proven with a real git mechanism, not an
// assertion about which function got called: a `pre-receive` hook installed
// on the bare remote appends one line per incoming ref update to a plain log
// file. `git push` cannot reach the remote without going through it; `gh api`
// (faked here to call `git update-ref -d` directly against the bare repo,
// simulating the real API's effect on the ref without involving push at all)
// does not trigger it. A log with no entry for a branch is therefore direct
// evidence no push for that branch happened, not an inference from the
// absence of some other signal.
//
// ugcportal-9faa: each case below spawns several real `git` subprocesses
// (init, remote add, checkout, push) plus a real `gh`-replacing child
// process per `deleteRemoteBranch` call, against its own fresh fixture repo
// -- the same shape as "end-to-end against real temporary git repositories"
// above, which carries this same explicit describe-level timeout for
// exactly this reason (there is nothing here to cache; each case needs its
// own isolated repository on disk).
describe("deleteRemoteBranch: GitHub API primary path, git push fallback (ugcportal-ix0s)", { timeout: 20_000 }, () => {
  // Same GIT_* isolation as "end-to-end against real temporary git
  // repositories" above, and for the same reason: deleteRemoteBranch's own
  // `execFileSync` calls (both the `gh` one and the `git` ones) carry no env
  // override of their own, by design, since in real use they run against the
  // actual target repo -- so this process's own GIT_* must not leak in.
  let savedGitEnv;
  beforeAll(() => {
    savedGitEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_")) {
        savedGitEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });
  afterAll(() => {
    Object.assign(process.env, savedGitEnv);
  });

  /** Runs `fn` with `fakeGhDir` prepended to this process's own PATH, restoring it afterward -- the real `deleteRemoteBranch`/`deleteRemoteBranchViaApi` under test here call `execFileSync("gh", ...)` with no env override of their own, so resolving to the fake has to happen through this process's actual PATH, the same way the GIT_* isolation above has to happen through this process's actual env. */
  function withFakeGhOnPath(fakeGhDir, fn) {
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeGhDir}${path.delimiter}${originalPath}`;
    try {
      return fn();
    } finally {
      process.env.PATH = originalPath;
    }
  }

  function setupFixture(prefix) {
    const { root, repoDir } = makeFixtureRepo(prefix);
    const remoteDir = path.join(root, "remote.git");
    const ghBinDir = path.join(root, "bin");
    fs.mkdirSync(remoteDir);
    fixtureGit(remoteDir, ["init", "-q", "--bare"]);
    fixtureGit(repoDir, ["remote", "add", "origin", remoteDir]);
    fixtureGit(repoDir, ["checkout", "-q", "-b", "feat/ix0s-delete"]);
    fixtureGit(repoDir, ["push", "-q", "-u", "origin", "feat/ix0s-delete"]);
    fs.mkdirSync(ghBinDir);
    return { root, repoDir, remoteDir, ghBinDir };
  }

  it("deletes through the GitHub API and never reaches git push", () => {
    const { root, repoDir, remoteDir, ghBinDir } = setupFixture("ix0s-api-success-");
    try {
      const pushLog = installPushLogger(remoteDir);
      const { logPath } = writeFakeGh(ghBinDir, { remoteDir, apiDeleteFailures: {} });

      withFakeGhOnPath(ghBinDir, () => {
        deleteRemoteBranch("feat/ix0s-delete", repoDir);
      });

      // The branch is actually gone on origin.
      expect(fixtureGit(repoDir, ["ls-remote", "--heads", "origin", "feat/ix0s-delete"]).trim()).toBe("");

      // The API call was really made, with the right path.
      const calls = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toContainEqual(["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/heads/feat/ix0s-delete"]);

      // Direct evidence, not an inference: no push for this branch -- or any
      // branch -- ever reached the remote's pre-receive hook.
      expect(readPushLog(pushLog)).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats an already-gone ref (HTTP 422 'Reference does not exist', verified as this endpoint's real shape above) as deleted, without falling back to git push", () => {
    const { root, repoDir, remoteDir, ghBinDir } = setupFixture("ix0s-already-gone-");
    try {
      const pushLog = installPushLogger(remoteDir);
      // Delete the branch out from under the fake -- some other process (an
      // earlier sweep, a human) already removed it before this call.
      fixtureGit(remoteDir, ["update-ref", "-d", "refs/heads/feat/ix0s-delete"]);
      const { logPath } = writeFakeGh(ghBinDir, {
        remoteDir,
        apiDeleteFailures: { "feat/ix0s-delete": "422-reference-gone" },
      });

      expect(() =>
        withFakeGhOnPath(ghBinDir, () => {
          deleteRemoteBranch("feat/ix0s-delete", repoDir);
        }),
      ).not.toThrow();

      const calls = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toContainEqual(["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/heads/feat/ix0s-delete"]);

      // Still no push, for the already-gone case either.
      expect(readPushLog(pushLog)).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to a real git push --delete when the API call returns a 404 (ugcportal-ix0s: verified live to mean the repo couldn't be resolved, not that the branch is already gone -- an unmatched 404 must fall back like any other unrecognized failure), and that still removes the branch", () => {
    const { root, repoDir, remoteDir, ghBinDir } = setupFixture("ix0s-fallback-");
    try {
      const pushLog = installPushLogger(remoteDir);
      const { logPath } = writeFakeGh(ghBinDir, {
        remoteDir,
        apiDeleteFailures: { "feat/ix0s-delete": "404" },
      });

      withFakeGhOnPath(ghBinDir, () => {
        deleteRemoteBranch("feat/ix0s-delete", repoDir);
      });

      // The branch is gone -- but this time only the fallback could have done it:
      // the fake gh never deletes the ref itself on a configured failure.
      expect(fixtureGit(repoDir, ["ls-remote", "--heads", "origin", "feat/ix0s-delete"]).trim()).toBe("");

      // The API call was attempted and failed, as configured.
      const calls = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toContainEqual(["api", "-X", "DELETE", "repos/{owner}/{repo}/git/refs/heads/feat/ix0s-delete"]);

      // Direct evidence a real git push reached the remote for this branch
      // this time -- the mirror image of the "never reaches git push" checks
      // in the two tests above.
      expect(readPushLog(pushLog)).toContain("refs/heads/feat/ix0s-delete");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("guard: the fixtures above must never reach this repository's own config", () => {
  // Real incident, not a hypothetical: an earlier version of the suite
  // above, lacking the isolation layers documented there, flipped THIS
  // repository's shared `core.bare` to true and overwrote its
  // `user.name`/`user.email` with the fixtures' own "Test"/"test@example.com"
  // identity -- found by inspecting the common `.git/config` every worktree
  // of this repository shares (this one included) and repaired by hand.
  // This guard reads that same shared config, through plain `git config
  // --get` with no `-C` or `cwd` override at all, so it resolves exactly the
  // way an accidentally-misdirected fixture command would have reached it.
  function readSharedConfig(key) {
    try {
      return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
    } catch {
      return null; // key not set -- a normal, non-bare repo with its identity set some other way
    }
  }

  it("leaves core.bare false (or unset) after every fixture test above has run", () => {
    expect(readSharedConfig("core.bare")).not.toBe("true");
  });

  it("leaves user.name and user.email as whatever they were, not the fixtures' Test/test@example.com", () => {
    expect(readSharedConfig("user.name")).not.toBe("Test");
    expect(readSharedConfig("user.email")).not.toBe("test@example.com");
  });
});
