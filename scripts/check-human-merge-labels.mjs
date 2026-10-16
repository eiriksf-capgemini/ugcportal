#!/usr/bin/env node
/**
 * Lists open PRs that pr-review-merge reviewed clean and left for a human
 * (its comment carries the marker below) but that do not carry the GitHub
 * label `needs-human-merge` (ugcportal-ub7y, K3). Such a PR is waiting on a
 * person and discoverable only in chat.
 *
 * Usage:  node scripts/check-human-merge-labels.mjs     (exit 1 if any unlabelled)
 *
 * It prints its match counts first (PRs examined, PRs with a verdict
 * comment, unlabelled among those), per review-standards section 6: a bare
 * "no PRs" from a filter that matched nothing reads as clean.
 */

import { execFileSync } from "node:child_process";

import { isMainModule } from "./lib/is-main.mjs";

export const LABEL = "needs-human-merge";
export const VERDICT_MARKER = "<!-- ugcportal-needs-human-merge -->";
export const PR_LIST_LIMIT = 200;

/**
 * Pure classification over injected data.
 *
 * @param {Array<{number:number, labels?:Array<{name:string}>, comments?:Array<{body?:string}>}>} prs
 * @returns {{examined:number, withVerdict:number, unlabelled:number[]}}
 */
export function classifyPrs(prs) {
  const withVerdictPrs = prs.filter((pr) =>
    (pr.comments ?? []).some((c) => typeof c.body === "string" && c.body.includes(VERDICT_MARKER)),
  );
  const unlabelled = withVerdictPrs
    .filter((pr) => !(pr.labels ?? []).some((l) => l.name === LABEL))
    .map((pr) => pr.number);
  return { examined: prs.length, withVerdict: withVerdictPrs.length, unlabelled };
}

/** @param {{examined:number, withVerdict:number, unlabelled:number[]}} r */
export function formatReport(r) {
  const lines = [
    `PRs examined: ${r.examined}; PRs with a verdict comment (${VERDICT_MARKER}): ${r.withVerdict}; unlabelled among those: ${r.unlabelled.length}`,
  ];
  for (const n of r.unlabelled) lines.push(`  #${n} has a verdict comment but no ${LABEL} label`);
  return lines.join("\n");
}

function listOpenPrs() {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--state", "open", "--json", "number,labels,comments", "--limit", String(PR_LIST_LIMIT)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function main() {
  const prs = listOpenPrs();
  if (prs.length >= PR_LIST_LIMIT) {
    console.warn(`warning: ${prs.length} open PRs hit the --limit ${PR_LIST_LIMIT}; the list may be truncated`);
  }
  const report = classifyPrs(prs);
  console.log(formatReport(report));
  process.exit(report.unlabelled.length > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();
