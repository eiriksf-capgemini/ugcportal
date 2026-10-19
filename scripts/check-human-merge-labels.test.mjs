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
  classifyPrs as classifyRaw,
  exitCode,
  formatReport,
  isSensitivePath,
  normaliseLogin,
  reviewedHead,
  run,
} from "./check-human-merge-labels.mjs";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const REVIEWER = { login: "eiriksf-capgemini" };
// gh's real login shapes: the PR author of a bot PR is `app/<slug>`, the same bot's comment author is `<slug>`
const AUTHOR = { login: "app/hal9000-agent-bot" };
const BOT = { login: "hal9000-agent-bot" };
const classifyPrs = (prs, reviewer = REVIEWER.login) => classifyRaw(prs, reviewer);
const measured = (sha) => `<!-- ugcportal-measured: deltas=0 absences=0 at=${sha} baseline=n/a -->`;
const ROUND = "<!-- ugcportal-review-round: 1 -->";
const clean = { author: REVIEWER, body: `${ROUND}\n${measured(HEAD)}\n${VERDICT_MARKER}\nReviewed clean; a human must merge` };
const blocked = { author: REVIEWER, body: `${ROUND}\n${measured(HEAD)}\nBlocking: 2 findings` };
const chatter = { author: REVIEWER, body: "LGTM" };
const sens = [{ path: ".claude/skills/x/SKILL.md" }];
const plain = [{ path: "src/a.ts" }];
const label = [{ name: LABEL }];

const pr = (number, labels, comments, files = plain, headRefOid = HEAD) => ({
  number,
  author: AUTHOR,
  headRefOid,
  labels,
  comments,
  files,
});

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
    const r = classifyPrs([pr(5, label, [clean, { author: REVIEWER, body: "<!-- ugcportal-review-round: 2 -->\nBlocking" }])]);
    expect(r.staleLabel).toEqual([5]);
    expect(r.unlabelledClean).toEqual([]);
  });

  it("uses the LATEST round comment: an old verdict followed by a blocked round is not a verdict", () => {
    const r = classifyPrs([pr(6, [], [clean, { author: REVIEWER, body: "<!-- ugcportal-review-round: 2 -->\nBlocking" }])]);
    expect(r.unlabelledClean).toEqual([]);
    expect(r.clean).toBe(0);
  });

  it("does not treat a comment that merely quotes the marker as a verdict (L1)", () => {
    const quoting = { author: REVIEWER, body: `${ROUND}\nBlocking: put \`${VERDICT_MARKER}\` in the comment` };
    const r = classifyPrs([pr(7, [], [quoting])]);
    expect(r.clean).toBe(0);
    expect(r.unlabelledClean).toEqual([]);
    // and a round marker that is not the first line is not a round comment
    const notFirst = { author: REVIEWER, body: `intro\n${ROUND}\n${VERDICT_MARKER}` };
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
    const approx = { author: REVIEWER, body: `<!-- ugcportal-review-round: 3 approx -->\n${VERDICT_MARKER}\nclean` };
    const r = classifyPrs([pr(20, [], [approx])]);
    expect(r.roundReviewed).toBe(1);
    expect(r.unlabelledClean).toEqual([20]);
  });

  it("accepts CRLF bodies (web-UI comments)", () => {
    const crlf = { author: REVIEWER, body: `${ROUND}\r\n${VERDICT_MARKER}\r\nclean` };
    const r = classifyPrs([pr(21, [], [crlf])]);
    expect(r.roundReviewed).toBe(1);
    expect(r.unlabelledClean).toEqual([21]);
  });

  it("a non-round stop comment is not a round comment (step 2 labels only the sensitive-path stop)", () => {
    const stop = { author: REVIEWER, body: `<!-- ugcportal-review-stop: chain-broken -->\n${VERDICT_MARKER}` };
    const r = classifyPrs([pr(22, label, [blocked, stop])]);
    // the latest ROUND comment is the blocked one, so the label is listed as C: step 2 labels no non-counting stop for its chain state
    expect(r.staleLabel).toEqual([22]);
  });

  // ugcportal-0n6h / ugcportal-2ww3: the check reads the latest ROUND comment, never a stop comment
  const stopWithVerdict = { author: REVIEWER, body: `<!-- ugcportal-review-stop: approx-cap -->\n${VERDICT_MARKER}\nReviewed clean; a human must merge` };

  it("PR #274 shape: blocked round 6, then an approx-cap stop, then the label, lists as C", () => {
    const blocked6 = { author: REVIEWER, body: "<!-- ugcportal-review-round: 6 -->\nBlocking: 1 finding" };
    expect(classifyPrs([pr(23, label, [blocked6, stopWithVerdict], sens)]).staleLabel).toEqual([23]);
  });

  it("a labelled clean round 6 then a verdict-marked approx-cap stop lists nothing on the same head, D when the head moved", () => {
    const clean6 = { author: REVIEWER, body: clean.body.replace("review-round: 1", "review-round: 6") };
    const same = classifyPrs([pr(24, label, [clean6, stopWithVerdict], sens)]);
    expect([same.staleLabel, same.staleHead, same.unlabelledClean, same.sensitiveNoLabelNoVerdict]).toEqual([[], [], [], []]);
    const moved = classifyPrs([pr(25, label, [clean6, stopWithVerdict], sens, OTHER_HEAD)]);
    expect(moved.staleHead).toEqual([25]);
    expect(moved.staleLabel).toEqual([]);
  });
});

describe("round comment author (R3-5, M-R4-1)", () => {
  it("a round comment written by the bot that opened the PR is not a round comment: a labelled PR with only that comment is C", () => {
    const selfStamped = { author: BOT, body: clean.body };
    const r = classifyPrs([pr(30, label, [selfStamped])]);
    expect(r.roundReviewed).toBe(0);
    expect(r.staleLabel).toEqual([30]);
    expect(r.clean).toBe(0);
  });

  it("an unlabelled PR whose only verdict is self-stamped is not listed as A", () => {
    const r = classifyPrs([pr(31, [], [{ author: BOT, body: clean.body }])]);
    expect(r.unlabelledClean).toEqual([]);
  });

  it("a round comment with no readable author is not a round comment (fail closed)", () => {
    const r = classifyPrs([pr(32, label, [{ body: clean.body }])]);
    expect(r.staleLabel).toEqual([32]);
    // a PR with no author at all is still read: the PR author is not an input
    const noPrAuthor = { ...pr(33, label, [clean]), author: undefined };
    expect(classifyPrs([noPrAuthor]).staleLabel).toEqual([]);
  });

  it("the latest round comment by a reviewer wins over a later self-stamped one", () => {
    const r = classifyPrs([pr(34, label, [clean, { author: BOT, body: blocked.body }])]);
    expect(r.staleLabel).toEqual([]);
    expect(r.roundReviewed).toBe(1);
    expect(r.clean).toBe(1);
  });
});

describe("reviewer identity, not PR author (M-R4-1)", () => {
  const humanPr = (number, labels, comments, files = sens) => ({ ...pr(number, labels, comments, files), author: { login: REVIEWER.login } });

  it("a human-authored PR with a clean labelled round reads clean, not C", () => {
    const r = classifyPrs([humanPr(50, label, [clean])]);
    expect(r.roundReviewed).toBe(1);
    expect(r.clean).toBe(1);
    expect(r.staleLabel).toEqual([]);
    expect(r.unlabelledClean).toEqual([]);
    expect(r.staleHead).toEqual([]);
  });

  it("a human-authored sensitive PR whose reviewer skipped the step-2 paragraph reads B", () => {
    const r = classifyPrs([humanPr(51, [], [blocked])]);
    expect(r.roundReviewed).toBe(1);
    expect(r.sensitiveNoLabelNoVerdict).toEqual([51]);
  });

  it("a human-authored PR with a verdict and no label is A", () => {
    expect(classifyPrs([humanPr(52, [], [clean])]).unlabelledClean).toEqual([52]);
  });

  it("a bot-authored PR whose only round comment was written by the bot itself is not counted", () => {
    const r = classifyPrs([pr(53, [], [{ author: BOT, body: clean.body }], sens)]);
    expect(r.roundReviewed).toBe(0);
    expect(r.unlabelledClean).toEqual([]);
    expect(r.sensitiveNoLabelNoVerdict).toEqual([]);
  });

  it("the reviewer login is the injected one, not a constant", () => {
    const other = { author: { login: "someone-else" }, body: clean.body };
    expect(classifyPrs([pr(54, [], [other])], "someone-else").unlabelledClean).toEqual([54]);
    expect(classifyPrs([pr(55, [], [other])], REVIEWER.login).roundReviewed).toBe(0);
    expect(classifyPrs([pr(56, [], [clean])], "someone-else").roundReviewed).toBe(0);
  });

  it("an app/ prefix and letter case do not stop a login matching", () => {
    expect(normaliseLogin("app/dependabot")).toBe("dependabot");
    expect(classifyPrs([pr(57, [], [{ author: BOT, body: clean.body }])], "app/hal9000-agent-bot").unlabelledClean).toEqual([57]);
    expect(classifyPrs([pr(58, [], [clean])], "EiriksF-Capgemini").unlabelledClean).toEqual([58]);
  });

  it("no reviewer login reads nothing as round-reviewed (fail closed)", () => {
    expect(classifyRaw([pr(59, [], [clean])], undefined).roundReviewed).toBe(0);
  });

  it("no reviewer login AND a round comment with no author is not round-reviewed (\"\" must not equal \"\", ugcportal-9uf5)", () => {
    const authorless = { body: clean.body };
    const r = classifyRaw([pr(60, label, [authorless]), pr(61, [], [authorless])], undefined);
    expect(r.roundReviewed).toBe(0);
    expect(r.clean).toBe(0);
    expect(r.unlabelledClean).toEqual([]);
    expect(r.staleLabel).toEqual([60]);
  });
});

describe("D: the label on a head the clean round did not review (R3-5)", () => {
  it("lists a labelled clean PR whose head moved after the round", () => {
    const r = classifyPrs([pr(40, label, [clean], plain, OTHER_HEAD)]);
    expect(r.staleHead).toEqual([40]);
    expect(r.staleLabel).toEqual([]);
    expect(r.unlabelledClean).toEqual([]);
  });

  it("does not list a labelled clean PR whose head is the reviewed head (a short reviewed sha is a prefix)", () => {
    expect(classifyPrs([pr(41, label, [clean])]).staleHead).toEqual([]);
    const short = { author: REVIEWER, body: `${ROUND}\n${measured(HEAD.slice(0, 8))}\n${VERDICT_MARKER}` };
    expect(classifyPrs([pr(42, label, [short])]).staleHead).toEqual([]);
  });

  it("a head that cannot be read from the round comment, or from the PR, counts as not reviewed", () => {
    const noHead = { author: REVIEWER, body: `${ROUND}\n${VERDICT_MARKER}\nclean` };
    expect(classifyPrs([pr(43, label, [noHead])]).staleHead).toEqual([43]);
    expect(classifyPrs([pr(44, label, [clean], plain, null)]).staleHead).toEqual([44]);
  });

  it("D needs the label: an unlabelled clean PR is A, never D", () => {
    const r = classifyPrs([pr(45, [], [clean], plain, OTHER_HEAD)]);
    expect(r.unlabelledClean).toEqual([45]);
    expect(r.staleHead).toEqual([]);
  });

  it("D falls back to the `head <sha>` of the prose line when there is no measured marker", () => {
    const prose = { author: REVIEWER, body: `${ROUND}\n${VERDICT_MARKER}\nReview round 1 (chain exact, head ${HEAD}). Reviewed clean.` };
    expect(classifyPrs([pr(46, label, [prose])]).staleHead).toEqual([]);
    expect(classifyPrs([pr(47, label, [prose], plain, OTHER_HEAD)]).staleHead).toEqual([47]);
  });

  it("reviewedHead reads the measured marker first, else the prose head, else null", () => {
    expect(reviewedHead(clean.body)).toBe(HEAD);
    expect(reviewedHead(`${measured(OTHER_HEAD)}\nReview round 1 (chain exact, head ${HEAD})`)).toBe(OTHER_HEAD);
    expect(reviewedHead("nothing")).toBeNull();
  });

  it("kwxh: an `inline-fix head=<sha>` line is the reviewed head, ahead of the measured marker, so a label after an inline fix is not D", () => {
    const fixed = { author: REVIEWER, body: `${ROUND}\n${measured(HEAD)}\n${VERDICT_MARKER}\ninline-fix head=${OTHER_HEAD}\nReviewed clean; a human must merge` };
    expect(reviewedHead(fixed.body)).toBe(OTHER_HEAD);
    // the live head is the fix commit: the label is current
    expect(classifyPrs([pr(49, label, [fixed], plain, OTHER_HEAD)]).staleHead).toEqual([]);
    // the live head went back to (or stayed at) the pre-fix head: the label is not on the fixed head
    expect(classifyPrs([pr(50, label, [fixed], plain, HEAD)]).staleHead).toEqual([50]);
    // only a line that is exactly the field is read: a quote or a mid-sentence mention is not
    for (const text of [`> inline-fix head=${OTHER_HEAD}`, `see inline-fix head=${OTHER_HEAD}`, `inline-fix head=${OTHER_HEAD} and more`]) {
      expect(reviewedHead(`${ROUND}\n${measured(HEAD)}\n${text}`), text).toBe(HEAD);
    }
  });

  it("reads the sha on the ugcportal-measured line, not an earlier at=<sha> in prose (ugcportal-rix6)", () => {
    const quoted = `${ROUND}\nPrevious round reviewed at=${OTHER_HEAD}\n${measured(HEAD)}\n${VERDICT_MARKER}`;
    expect(reviewedHead(quoted)).toBe(HEAD);
    // through classifyPrs: the label sits on HEAD, which the measured line reviewed, so it is not D
    expect(classifyPrs([pr(48, label, [{ author: REVIEWER, body: quoted }])]).staleHead).toEqual([]);
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
    [".claude/agents/worker-reviewer.md", true],
    [".claude/agents/sub/x.md", true],
  ])("%s -> %s", (p, expected) => expect(isSensitivePath(p)).toBe(expected));
});

describe("formatReport", () => {
  it("prints the exact counts line before any PR line", () => {
    const r = classifyPrs([
      pr(1, [], [clean]),
      pr(3, [], [blocked], sens),
      pr(5, label, [blocked]),
      pr(14, [], [chatter]),
      pr(15, label, [clean], plain, OTHER_HEAD),
    ]);
    const out = formatReport(r).split("\n");
    expect(out[0]).toBe(
      `PRs examined: 5; round-reviewed (latest round marker): 4; latest round carries ${VERDICT_MARKER}: 2; ` +
        "sensitive-path among round-reviewed: 1; A (verdict, no label): 1; B (sensitive, no label, no verdict): 1; C (label, no verdict): 1; D (label, head not reviewed): 1",
    );
    expect(out[1]).toContain("A #1");
    expect(out[2]).toContain("B #3");
    expect(out[3]).toContain("C #5");
    expect(out[4]).toContain("D #15");
  });
});

describe("exitCode / run", () => {
  const io = (prs) => {
    const logs = [];
    const warns = [];
    return { logs, warns, args: { listPrs: () => prs, reviewer: () => REVIEWER.login, log: (s) => logs.push(s), warn: (s) => warns.push(s) } };
  };

  it("exits 0 when nothing is listed, and still prints the counts", () => {
    const t = io([pr(1, label, [clean])]);
    expect(run(t.args)).toBe(0);
    expect(t.logs[0]).toContain("PRs examined: 1; round-reviewed (latest round marker): 1;");
  });

  it("exits 1 for each of A, B, C and D", () => {
    expect(run(io([pr(4, label, [clean], plain, OTHER_HEAD)]).args)).toBe(1);
    expect(run(io([pr(1, [], [clean])]).args)).toBe(1);
    expect(run(io([pr(2, [], [blocked], sens)]).args)).toBe(1);
    expect(run(io([pr(3, label, [blocked])]).args)).toBe(1);
  });

  it("exits 2 when the reviewer login cannot be resolved", () => {
    const t = io([pr(1, [], [clean])]);
    expect(run({ ...t.args, reviewer: () => "" })).toBe(2);
    expect(run({ ...t.args, reviewer: () => { throw new Error("auth"); } })).toBe(2);
    expect(t.warns.join("\n")).toContain("no reviewer login");
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
