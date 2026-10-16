/**
 * Tests for scripts/check-human-merge-labels.mjs (ugcportal-ub7y, K3).
 * Pure classification over injected fixtures; no network.
 */
import { describe, expect, it } from "vitest";

import {
  COMMENT_WINDOW,
  FILE_WINDOW,
  LABEL,
  PR_LIST_LIMIT,
  VERDICT_MARKER,
  classifyPrs,
  exitCode,
  formatReport,
  isSensitivePath,
  run,
} from "./check-human-merge-labels.mjs";

const ROUND = "<!-- ugcportal-review-round: 1 -->";
const clean = { body: `${ROUND}\n${VERDICT_MARKER}\nReviewed clean; a human must merge` };
const blocked = { body: `${ROUND}\nBlocking: 2 findings` };
const chatter = { body: "LGTM" };
const sens = [{ path: ".claude/skills/x/SKILL.md" }];
const plain = [{ path: "src/a.ts" }];
const label = [{ name: LABEL }];

const pr = (number, labels, comments, files = plain) => ({ number, labels, comments, files });

describe("classifyPrs", () => {
  it("A: latest round has the verdict marker and no label", () => {
    const r = classifyPrs([pr(1, [], [clean]), pr(2, label, [clean])]);
    expect(r.unlabelledClean).toEqual([1]);
    expect(r.clean).toBe(2);
    expect(r.roundReviewed).toBe(2);
  });

  it("B: a sensitive round-reviewed PR with neither marker nor label is listed (the skipped-paragraph case)", () => {
    const r = classifyPrs([pr(3, [], [blocked], sens), pr(4, [], [blocked], plain)]);
    expect(r.sensitiveNoLabelNoVerdict).toEqual([3]);
    expect(r.sensitiveReviewed).toBe(1);
  });

  it("C: a label whose latest round comment has no verdict marker is stale", () => {
    const r = classifyPrs([pr(5, label, [clean, { body: "<!-- ugcportal-review-round: 2 -->\nBlocking" }])]);
    expect(r.staleLabel).toEqual([5]);
    expect(r.unlabelledClean).toEqual([]);
  });

  it("uses the LATEST round comment: an old verdict followed by a blocked round is not a verdict", () => {
    const r = classifyPrs([pr(6, [], [clean, { body: "<!-- ugcportal-review-round: 2 -->\nBlocking" }])]);
    expect(r.unlabelledClean).toEqual([]);
    expect(r.clean).toBe(0);
  });

  it("does not treat a comment that merely quotes the marker as a verdict (L1)", () => {
    const quoting = { body: `${ROUND}\nBlocking: put \`${VERDICT_MARKER}\` in the comment` };
    const r = classifyPrs([pr(7, [], [quoting])]);
    expect(r.clean).toBe(0);
    expect(r.unlabelledClean).toEqual([]);
    // and a round marker that is not the first line is not a round comment
    const notFirst = { body: `intro\n${ROUND}\n${VERDICT_MARKER}` };
    expect(classifyPrs([pr(8, [], [notFirst])]).roundReviewed).toBe(0);
  });

  it("matches the label by exact name, not by prefix (near-miss label does not count)", () => {
    const r = classifyPrs([pr(9, [{ name: "needs-review" }], [clean]), pr(10, [{ name: "needs-human-merge-2" }], [clean])]);
    expect(r.unlabelledClean).toEqual([9, 10]);
  });

  it("ignores PRs with no round comment and tolerates missing fields", () => {
    const r = classifyPrs([pr(11, [], [chatter], sens), { number: 12 }]);
    expect(r).toMatchObject({ examined: 2, roundReviewed: 0, clean: 0, unlabelledClean: [], sensitiveNoLabelNoVerdict: [], staleLabel: [] });
  });

  it("flags a PR at gh's comment window", () => {
    const many = Array.from({ length: COMMENT_WINDOW }, () => chatter);
    expect(classifyPrs([pr(13, [], many)]).truncatedComments).toEqual([13]);
  });
});

describe("round marker forms", () => {
  it("accepts the approx round marker", () => {
    const approx = { body: `<!-- ugcportal-review-round: 3 approx -->\n${VERDICT_MARKER}\nclean` };
    const r = classifyPrs([pr(20, [], [approx])]);
    expect(r.roundReviewed).toBe(1);
    expect(r.unlabelledClean).toEqual([20]);
  });

  it("accepts CRLF bodies (web-UI comments)", () => {
    const crlf = { body: `${ROUND}\r\n${VERDICT_MARKER}\r\nclean` };
    const r = classifyPrs([pr(21, [], [crlf])]);
    expect(r.roundReviewed).toBe(1);
    expect(r.unlabelledClean).toEqual([21]);
  });

  it("a non-round stop comment is not a round comment (step 2 labels only the sensitive-path stop)", () => {
    const stop = { body: `<!-- ugcportal-review-stop: chain-broken -->\n${VERDICT_MARKER}` };
    const r = classifyPrs([pr(22, label, [blocked, stop])]);
    // the latest ROUND comment is the blocked one, so the label is listed as C: the skill never labels this stop
    expect(r.staleLabel).toEqual([22]);
  });
});

describe("isSensitivePath", () => {
  it.each([
    [".claude/skills/a/b.md", true],
    [".claude/settings.json", true],
    ["CLAUDE.md", true],
    [".github/workflows/ci.yml", true],
    ["src/app/api/auth/x.ts", true],
    ["a/b/my-secret.txt", true],
    ["a/b/my-credentials.json", true],
    [".claude/settings.local.json", true],
    ["docker-compose.yml", true],
    ["deploy/docker-compose.yml", true],
    ["certs/server.pem", true],
    ["certs/server.key", true],
    ["src/lib/auth.ts", true],
    [".env", true],
    ["apps/web/.env.local", true],
    ["src/app/page.tsx", false],
    ["scripts/check-human-merge-labels.mjs", false],
    [".claude/agents/worker-reviewer.md", false],
  ])("%s -> %s", (p, expected) => expect(isSensitivePath(p)).toBe(expected));
});

describe("formatReport", () => {
  it("prints the exact counts line before any PR line", () => {
    const r = classifyPrs([pr(1, [], [clean]), pr(3, [], [blocked], sens), pr(5, label, [blocked]), pr(14, [], [chatter])]);
    const out = formatReport(r).split("\n");
    expect(out[0]).toBe(
      `PRs examined: 4; round-reviewed (latest round marker): 3; latest round carries ${VERDICT_MARKER}: 1; ` +
        "sensitive-path among round-reviewed: 1; A (verdict, no label): 1; B (sensitive, no label, no verdict): 1; C (label, no verdict): 1",
    );
    expect(out[1]).toContain("A #1");
    expect(out[2]).toContain("B #3");
    expect(out[3]).toContain("C #5");
  });
});

describe("exitCode / run", () => {
  const io = (prs) => {
    const logs = [];
    const warns = [];
    return { logs, warns, args: { listPrs: () => prs, log: (s) => logs.push(s), warn: (s) => warns.push(s) } };
  };

  it("exits 0 when nothing is listed, and still prints the counts", () => {
    const t = io([pr(1, label, [clean])]);
    expect(run(t.args)).toBe(0);
    expect(t.logs[0]).toContain("PRs examined: 1; round-reviewed (latest round marker): 1;");
  });

  it("exits 1 for each of A, B and C", () => {
    expect(run(io([pr(1, [], [clean])]).args)).toBe(1);
    expect(run(io([pr(2, [], [blocked], sens)]).args)).toBe(1);
    expect(run(io([pr(3, label, [blocked])]).args)).toBe(1);
  });

  it("exits 2 and warns when the PR list hits its limit, even with nothing listed", () => {
    const prs = Array.from({ length: PR_LIST_LIMIT }, (_, i) => pr(i + 1, [], [chatter]));
    const t = io(prs);
    expect(run(t.args)).toBe(2);
    expect(t.warns[0]).toContain("may be truncated");
  });

  it("exits 2 when a PR's comments hit the window", () => {
    const many = Array.from({ length: COMMENT_WINDOW }, () => chatter);
    const t = io([pr(1, [], many)]);
    expect(run(t.args)).toBe(2);
    expect(t.logs[0]).toContain("TRUNCATED #1");
  });

  it("exits 2 when a PR's files hit the window", () => {
    const many = Array.from({ length: FILE_WINDOW }, (_, i) => ({ path: `src/f${i}.ts` }));
    const t = io([pr(1, [], [chatter], many)]);
    expect(run(t.args)).toBe(2);
    expect(t.logs[0]).toContain("TRUNCATED #1: 100 files");
  });

  it("exitCode ranks truncation above a listed PR", () => {
    expect(exitCode(classifyPrs([pr(1, [], [clean])]), true)).toBe(2);
  });
});
