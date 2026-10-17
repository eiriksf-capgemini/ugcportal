#!/usr/bin/env node
/**
 * The pass budget (ugcportal-bc04): before the orchestrator spawns another
 * implementation pass on a bead, this script reads the bead's recorded pass
 * count and says PROCEED, STOP or UNKNOWN. It is the "B2" rule of
 * docs/process/release-cost-v0.4.0-vs-v0.5.0.md section 6.2, never enforced
 * until now (release-cost-v0.5.0-vs-v0.6.0.md section 9 item 4): three
 * implementation passes without a clean review round stop the bead, and the
 * remainder is filed as a bead instead of buying a fourth pass.
 *
 * Verdicts, and the exit status that is the gate (a sentence alone is what
 * gets skipped under load):
 *   PROCEED  exit 0  `metadata.tokens_impl_passes` is a whole number below 3,
 *                    or 3 or more and a counted round recorded a clean string;
 *                    in both cases only when the count is not below the
 *                    rounds recorded (next line)
 *   STOP     exit 1  3 or more passes and no counted round recorded clean
 *   UNKNOWN  exit 2  `tokens_impl_passes` is absent, empty or not a whole
 *                    number, or it is lower than the highest review round
 *                    recorded (a stale count). Refuses. An absent field is not
 *                    read as zero passes (check-pass-budget.test.mjs, "K3"
 *                    cases): an empty value silently becoming a pass-through
 *                    is this repo's recurring carrier bug (bead K3).
 *   (usage error, an unreadable bead file or an unresolvable id also exit 2,
 *    with a message on stderr: a gate that cannot read its input does not
 *    pass it.)
 *
 * "Clean round" means a counted `findings_r<N>` or `findings_pr<number>_r<N>`
 * key (pr-review-merge step 4a item 5) whose value is exactly CLEAN_FINDINGS,
 * all counts zero. A value that does not parse is not clean: the failure
 * direction is the stricter one. Which keys are counted is selectRounds: on a
 * bead with more than one PR, only the latest PR's. `findings_unstamped` is
 * never clean; it adds one to the rounds recorded.
 *
 * Every run prints how many metadata keys it examined and how many of them
 * were findings keys, so a zero cannot pass for a check (review-standards
 * section 6).
 *
 * Usage:
 *   node scripts/check-pass-budget.mjs <bead-id> [--beads <file>]
 *     --beads <file>  read a bead (or array of beads) from a JSON file
 *                     instead of running `bd show <id> --json`; for tests
 *
 * Read only: the one command it runs is `bd show`; nothing here writes a bead.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { isMainModule } from "./lib/is-main.mjs";

export const PASS_LIMIT = 3;
export const CLEAN_FINDINGS = "f1:0 f2:0 f3:0 f4:0 med:0 low:0";
export const FINDINGS_KEY = /^findings_(?:pr(\d+)_)?r(\d+)$/;

/** The PR numbers a `prs` value lists ("gh-261,gh-262" -> [261, 262]); entries that are not gh-<n> or <n> are skipped. */
export function listedPrs(prs) {
  if (prs === undefined || prs === null) return [];
  return String(prs)
    .split(",")
    .map((s) => /^(?:gh-|#)?(\d+)$/i.exec(s.trim()))
    .filter(Boolean)
    .map((m) => Number(m[1]));
}

/**
 * Which recorded rounds the budget counts (M1 of PR #296 round 1). The pass
 * count covers the whole bead, so a clean round only exempts it when it is a
 * round of the LATEST PR: with any `findings_pr<n>_r<N>` key, the latest PR is
 * the highest PR number found in `prs` or in those keys (GitHub numbers rise,
 * and a PR still in review may not be in `prs` yet), and only its keys count.
 * Bare `findings_r<N>` keys count only when there are no `findings_pr*` keys;
 * a bead with both is a recording error (pr-review-merge step 4a item 5 has the
 * bare keys renamed first), and no round of it counts as clean. Bare keys on a
 * bead whose `prs` lists more than one PR cannot be tied to a PR, so they count
 * toward the round total but never as clean, the same rule as
 * release-cost-report.mjs's withFindingsKeys (`multi-pr`).
 */
export function selectRounds(metadata) {
  const all = [];
  for (const key of Object.keys(metadata)) {
    const m = FINDINGS_KEY.exec(key);
    if (!m) continue;
    const value = String(metadata[key]).trim().replace(/\s+/g, " ");
    all.push({ key, pr: m[1] === undefined ? null : Number(m[1]), n: Number(m[2]), value, clean: value === CLEAN_FINDINGS });
  }
  const prKeys = all.filter((r) => r.pr !== null);
  const bare = all.filter((r) => r.pr === null);
  const listed = listedPrs(metadata.prs);
  const notes = [];
  let counted;
  let cleanAllowed = true;
  let latestPr = null;
  if (prKeys.length > 0) {
    latestPr = Math.max(...prKeys.map((r) => r.pr), ...listed);
    counted = prKeys.filter((r) => r.pr === latestPr);
    if (counted.length === 0) notes.push(`no findings_pr${latestPr}_r<N> key for the latest PR, #${latestPr}`);
    if (bare.length > 0) {
      cleanAllowed = false;
      notes.push(
        `recording error: both bare findings_r<N> (${bare.map((r) => r.key).join(", ")}) and findings_pr<n>_r<N> keys are set; no round counts as clean`,
      );
    }
  } else {
    counted = bare;
    if (listed.length > 1 && bare.length > 0) {
      cleanAllowed = false;
      notes.push(`prs lists ${listed.length} PRs and the findings keys are bare, so no round can be tied to the latest PR; none counts as clean`);
    }
  }
  const counts = new Set(counted.map((r) => r.key));
  const rounds = all.map((r) => ({ ...r, counted: counts.has(r.key) }));
  const unstamped = metadata.findings_unstamped !== undefined && metadata.findings_unstamped !== null && String(metadata.findings_unstamped).trim() !== "";
  const highest = counted.reduce((max, r) => Math.max(max, r.n), 0);
  return {
    rounds,
    latestPr,
    unstamped,
    roundsRecorded: highest + (unstamped ? 1 : 0),
    clean: cleanAllowed ? counted.filter((r) => r.clean).map((r) => r.key) : [],
    notes,
  };
}

/**
 * @param {{id?: string, metadata?: Record<string, unknown>}} bead
 * @returns {{verdict: "PROCEED"|"STOP"|"UNKNOWN", exit: 0|1|2, passes: number|null,
 *   rounds: {key: string, value: string, clean: boolean, counted: boolean}[], roundsRecorded: number,
 *   keysExamined: number, message: string}}
 */
export function checkPassBudget(bead) {
  const metadata = bead && typeof bead.metadata === "object" && bead.metadata ? bead.metadata : {};
  const keys = Object.keys(metadata);
  const sel = selectRounds(metadata);
  const raw = metadata.tokens_impl_passes;
  const base = { rounds: sel.rounds, roundsRecorded: sel.roundsRecorded, keysExamined: keys.length };
  const id = bead?.id ?? "<id>";
  const notes = sel.notes.length ? ` Note: ${sel.notes.join("; ")}.` : "";

  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!/^\d+$/.test(text)) {
    const seen = raw === undefined ? "absent" : `"${text}"`;
    return {
      ...base,
      verdict: "UNKNOWN",
      exit: 2,
      passes: null,
      message:
        `tokens_impl_passes is ${seen}, not a whole number. Refusing: an unknown count is not zero. ` +
        `Record the passes made so far first: bd update ${id} --set-metadata tokens_impl_passes=<n>, then re-run.${notes}`,
    };
  }
  const passes = Number(text);
  const counted = sel.rounds.filter((r) => r.counted);
  const seenRounds = counted.length ? counted.map((r) => `${r.key}=${r.value}`).join("; ") : "none recorded";
  // M2 of PR #296 round 1: every reviewed round reviewed a pushed pass, so a
  // count below the highest recorded round is stale bookkeeping, not a small
  // number of passes. Refuse rather than read it.
  if (passes < sel.roundsRecorded) {
    return {
      ...base,
      verdict: "UNKNOWN",
      exit: 2,
      passes,
      message:
        `tokens_impl_passes is ${passes} but ${sel.roundsRecorded} review round(s) are recorded ` +
        `(highest counted round ${sel.roundsRecorded - (sel.unstamped ? 1 : 0)}${sel.unstamped ? ", plus 1 for findings_unstamped" : ""}): ` +
        `the count lags the rounds. Refusing. Record the passes actually made: bd update ${id} --set-metadata tokens_impl_passes=<n>, then re-run.${notes}`,
    };
  }
  if (passes < PASS_LIMIT) {
    return { ...base, verdict: "PROCEED", exit: 0, passes, message: `${passes} pass(es), under the limit of ${PASS_LIMIT}.${notes}` };
  }
  if (sel.clean.length > 0) {
    return {
      ...base,
      verdict: "PROCEED",
      exit: 0,
      passes,
      message: `${passes} passes, at or over the limit of ${PASS_LIMIT}, but a clean round was recorded (${sel.clean.join(", ")}).${notes}`,
    };
  }
  return {
    ...base,
    verdict: "STOP",
    exit: 1,
    passes,
    message:
      `${passes} implementation passes and no clean review round (limit ${PASS_LIMIT}). Rounds counted: ${seenRounds}.${notes} ` +
      `Do not spawn another pass: post the stop on the PR and file the remainder as a bead with discovered-from ` +
      `${id} (dispatch-bead section 6).`,
  };
}

export function formatVerdict(bead, r) {
  const findingsKeys = r.rounds.length;
  const counted = r.rounds.filter((x) => x.counted).length;
  return [
    `${r.verdict} ${bead.id ?? "<id>"}: ${r.message}`,
    `Examined ${r.keysExamined} metadata key(s), ${findingsKeys} of them findings keys, ${counted} counted toward the budget.`,
  ].join("\n");
}

function loadBead(id, beadsFile) {
  if (beadsFile) {
    const parsed = JSON.parse(fs.readFileSync(beadsFile, "utf8"));
    const found = (Array.isArray(parsed) ? parsed : [parsed]).find((b) => b.id === id);
    if (!found) throw new Error(`bead not found in ${beadsFile}: ${id}`);
    return found;
  }
  // stderr is piped, not inherited, so bd's own message is printed once, in
  // the error below, rather than once by bd and again by main.
  const res = spawnSync("bd", ["show", id, "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`bd show ${id} exited ${res.status}: ${(res.stderr || res.stdout || "").trim()}`);
  const parsed = JSON.parse(res.stdout);
  const bead = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!bead || !bead.id) throw new Error(`bd show ${id} returned no bead`);
  return bead;
}

export function main(argv, out = console.log, err = console.error) {
  let id = null;
  let beadsFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--beads") beadsFile = argv[++i];
    else if (!id) id = argv[i];
    else {
      err("usage: check-pass-budget.mjs <bead-id> [--beads <file>]");
      return 2;
    }
  }
  if (!id || (argv.includes("--beads") && !beadsFile)) {
    err("usage: check-pass-budget.mjs <bead-id> [--beads <file>]");
    return 2;
  }
  let bead;
  try {
    bead = loadBead(id, beadsFile);
  } catch (e) {
    err(`check-pass-budget: cannot read bead ${id}: ${e.message}`);
    return 2;
  }
  const r = checkPassBudget(bead);
  out(formatVerdict(bead, r));
  return r.exit;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
