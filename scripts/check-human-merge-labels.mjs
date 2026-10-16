#!/usr/bin/env node
/**
 * Audits the `needs-human-merge` label on open PRs (ugcportal-ub7y, K3).
 *
 * The question is NOT "which PRs carry the verdict marker but no label": the
 * same step-2 paragraph of pr-review-merge writes both, so a reviewer who
 * skips the paragraph leaves neither and that question prints 0 (round-1
 * finding M1). The check instead starts from what every review round writes,
 * the round marker, and reports three classes for a human to look at. A PR
 * is "round-reviewed" when some comment's FIRST LINE is exactly
 * `<!-- ugcportal-review-round: N -->` (or `N approx`); its LATEST such
 * comment is the PR's current verdict. A line is matched only when it is
 * exactly the marker, so a comment that quotes a marker inside prose is not
 * a verdict (L1). A round comment counts only when its author differs from
 * the PR's author (the same rule as step 4b's counter: the PR author cannot
 * stamp its own review), and both logins are known; a comment with no
 * readable author is not a round comment (R3-5).
 *
 * Reach: only ISSUE comments are read (`gh pr list --json comments`), not
 * review bodies. That matches where the skill writes the markers: step 5
 * stamps the round marker and step 2 the verdict marker in an issue comment
 * (`gh pr comment`), never in a review body. The label is applied only at the
 * sensitive-path reviewed-clean stop (step 2). The `approx`-at-cap and
 * broken-chain zero-finding stops stamp a non-round `ugcportal-review-stop`
 * comment, are not labelled by this check's PR, and so are not read here
 * (ugcportal-osth).
 *
 *   A  latest round comment carries the verdict marker line
 *      `<!-- ugcportal-needs-human-merge -->` but the PR has no label.
 *   B  PR is round-reviewed, touches a sensitive path (step 2's list), has no
 *      label and its latest round comment has no verdict marker. This is
 *      EITHER a blocked round (correct: no label) OR a reviewed-clean PR whose
 *      reviewer skipped the step-2 paragraph. The check cannot tell which from
 *      the data, so it lists them and a human reads the comment. Expect blocked
 *      PRs here; that is the price of not trusting the marker alone.
 *   C  PR carries the label but its latest round comment has no verdict
 *      marker, or it has no round comment by a reviewer at all: the label is
 *      stale or was applied before a clean review (a blocking round must
 *      remove it, step 2).
 *   D  PR carries the label and its latest round comment has the verdict
 *      marker, but the PR head is not the head that round reviewed: a push
 *      after the clean round left the label on unreviewed commits. The
 *      reviewed head is the `at=<sha>` of the round comment's
 *      `ugcportal-measured` line, else the `head <sha>` of its
 *      `Review round N (chain X, head <sha>)` line; a head that cannot be read counts as not reviewed. Step 2 says
 *      the next round removes or re-applies the label.
 *
 * Usage:  node scripts/check-human-merge-labels.mjs
 * Exit:   0 nothing listed; 1 any of A/B/C/D listed; 2 the data was truncated
 *         (PR list at its limit, or a PR whose comments or files hit gh's
 *         100-item window), so a zero could not be trusted.
 *
 * It prints its counts first (review-standards section 6): a bare "nothing"
 * from a filter that matched nothing reads as clean.
 */

import { execFileSync } from "node:child_process";

import { isMainModule } from "./lib/is-main.mjs";

export const LABEL = "needs-human-merge";
export const VERDICT_MARKER = "<!-- ugcportal-needs-human-merge -->";
export const ROUND_MARKER_RE = /^<!-- ugcportal-review-round: [0-9]+( approx)? -->$/;
export const PR_LIST_LIMIT = 200;
/** `gh pr list --json comments` fetches comments(first: 100). */
export const COMMENT_WINDOW = 100;
/** `gh pr list --json files` fetches files(first: 100). */
export const FILE_WINDOW = 100;

const SENSITIVE_PATH_RES = [
  /^\.claude\/settings(\.local)?\.json$/,
  /^\.claude\/skills\//,
  /^CLAUDE\.md$/,
  /^\.github\/workflows\//,
  /(^|\/)docker-compose\.yml$/,
  /(^|\/)[^/]*(secret|credential)[^/]*$/,
  /(^|\/)\.env[^/]*$/,
  /\.(pem|key)$/,
  /^src\/lib\/auth\.ts$/,
  /^src\/app\/api\/auth\//,
];

/** @param {string} path */
export function isSensitivePath(path) {
  return SENSITIVE_PATH_RES.some((re) => re.test(path));
}

const lines = (body) => body.split("\n").map((l) => l.replace(/\r$/, ""));

/**
 * The head a round comment says it reviewed, or null.
 * @param {string} body
 * @returns {string|null}
 */
export function reviewedHead(body) {
  for (const l of lines(body)) {
    const m = /^<!-- ugcportal-measured: .*\bat=([0-9a-f]{7,40})\b/.exec(l);
    if (m) return m[1];
  }
  for (const l of lines(body)) {
    const m = /^Review round [0-9]+ \(chain \w+, head ([0-9a-f]{7,40})\)/.exec(l);
    if (m) return m[1];
  }
  return null;
}

/** @param {string|undefined} head @param {string|null} reviewed */
function sameHead(head, reviewed) {
  return typeof head === "string" && head.length > 0 && reviewed !== null && head.startsWith(reviewed);
}

/**
 * @param {Array<{body?:string, author?:{login?:string}}>} comments chronological
 * @param {string|undefined} prAuthor
 * @returns {{body:string}|null} latest comment, by someone other than the PR author, whose first line is a round marker
 */
function latestRoundComment(comments, prAuthor) {
  let latest = null;
  for (const c of comments) {
    const who = c.author?.login;
    if (typeof who !== "string" || typeof prAuthor !== "string" || who === prAuthor) continue;
    if (typeof c.body === "string" && ROUND_MARKER_RE.test(lines(c.body)[0])) latest = c;
  }
  return latest;
}

/**
 * Pure classification over injected data.
 *
 * @param {Array<{number:number, author?:{login?:string}, headRefOid?:string, labels?:Array<{name:string}>, comments?:Array<{body?:string, author?:{login?:string}}>, files?:Array<{path:string}>}>} prs
 */
export function classifyPrs(prs) {
  let roundReviewed = 0;
  let clean = 0;
  let sensitiveReviewed = 0;
  const unlabelledClean = []; // A
  const sensitiveNoLabelNoVerdict = []; // B
  const staleLabel = []; // C
  const staleHead = []; // D
  const truncatedComments = [];
  const truncatedFiles = [];
  for (const pr of prs) {
    const comments = pr.comments ?? [];
    if (comments.length >= COMMENT_WINDOW) truncatedComments.push(pr.number);
    if ((pr.files ?? []).length >= FILE_WINDOW) truncatedFiles.push(pr.number);
    const latest = latestRoundComment(comments, pr.author?.login);
    const hasLabel = (pr.labels ?? []).some((l) => l.name === LABEL);
    if (!latest) {
      if (hasLabel) staleLabel.push(pr.number);
      continue;
    }
    roundReviewed++;
    const hasVerdict = lines(latest.body).includes(VERDICT_MARKER);
    const sensitive = (pr.files ?? []).some((f) => isSensitivePath(f.path));
    if (hasVerdict) clean++;
    if (sensitive) sensitiveReviewed++;
    if (hasVerdict && !hasLabel) unlabelledClean.push(pr.number);
    else if (hasVerdict && hasLabel && !sameHead(pr.headRefOid, reviewedHead(latest.body))) staleHead.push(pr.number);
    else if (!hasVerdict && hasLabel) staleLabel.push(pr.number);
    else if (!hasVerdict && !hasLabel && sensitive) sensitiveNoLabelNoVerdict.push(pr.number);
  }
  return {
    examined: prs.length,
    roundReviewed,
    clean,
    sensitiveReviewed,
    unlabelledClean,
    sensitiveNoLabelNoVerdict,
    staleLabel,
    staleHead,
    truncatedComments,
    truncatedFiles,
  };
}

/** @param {ReturnType<typeof classifyPrs>} r */
export function formatReport(r) {
  const out = [
    `PRs examined: ${r.examined}; round-reviewed (latest round marker): ${r.roundReviewed}; ` +
      `latest round carries ${VERDICT_MARKER}: ${r.clean}; sensitive-path among round-reviewed: ${r.sensitiveReviewed}; ` +
      `A (verdict, no label): ${r.unlabelledClean.length}; B (sensitive, no label, no verdict): ${r.sensitiveNoLabelNoVerdict.length}; ` +
      `C (label, no verdict): ${r.staleLabel.length}; D (label, head not reviewed): ${r.staleHead.length}`,
  ];
  for (const n of r.unlabelledClean) out.push(`  A #${n}: latest round has the verdict marker but no ${LABEL} label`);
  for (const n of r.sensitiveNoLabelNoVerdict)
    out.push(`  B #${n}: sensitive path, round-reviewed, no ${LABEL} label, no verdict marker (blocked, or marker skipped: read its latest round comment)`);
  for (const n of r.staleLabel)
    out.push(`  C #${n}: carries ${LABEL} but its latest round comment has no verdict marker, or no round comment by a reviewer exists (stale label?)`);
  for (const n of r.staleHead)
    out.push(`  D #${n}: carries ${LABEL} on a head its latest clean round did not review (pushed since?)`);
  for (const n of r.truncatedComments)
    out.push(`  TRUNCATED #${n}: ${COMMENT_WINDOW} comments hit gh's window, the latest round comment may be missing`);
  for (const n of r.truncatedFiles)
    out.push(`  TRUNCATED #${n}: ${FILE_WINDOW} files hit gh's window, a sensitive path past it would be missed`);
  return out.join("\n");
}

/** @param {ReturnType<typeof classifyPrs>} r @param {boolean} listTruncated */
export function exitCode(r, listTruncated) {
  if (listTruncated || r.truncatedComments.length > 0 || r.truncatedFiles.length > 0) return 2;
  const listed = r.unlabelledClean.length + r.sensitiveNoLabelNoVerdict.length + r.staleLabel.length + r.staleHead.length;
  return listed > 0 ? 1 : 0;
}

function listOpenPrs() {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--state", "open", "--json", "number,author,headRefOid,labels,comments,files", "--limit", String(PR_LIST_LIMIT)],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

/**
 * @param {{listPrs?:()=>any[], log?:(s:string)=>void, warn?:(s:string)=>void}} [io]
 * @returns {number} the exit code
 */
export function run({ listPrs = listOpenPrs, log = console.log, warn = console.warn } = {}) {
  const prs = listPrs();
  const listTruncated = prs.length >= PR_LIST_LIMIT;
  if (listTruncated) warn(`warning: ${prs.length} open PRs hit the --limit ${PR_LIST_LIMIT}; the list may be truncated`);
  const report = classifyPrs(prs);
  log(formatReport(report));
  return exitCode(report, listTruncated);
}

if (isMainModule(import.meta.url)) process.exit(run());
