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
 * Which count is read (M1 of PR #296 round 2). On a bead with one PR it is
 * `metadata.tokens_impl_passes`. That field counts the whole bead, across all
 * of its PRs, so on a bead that spans two or more PRs (the PR numbers in
 * `prs` and in its `findings_pr<n>_r<N>` keys together name two or more) it
 * cannot be set against the latest PR's rounds: the per-PR count
 * `tokens_impl_passes_pr<latest>` is read instead, and without it the verdict
 * is UNKNOWN. A multi-PR bead never gets PROCEED or STOP from the bead-wide
 * count.
 *
 * Verdicts, and the exit status that is the gate (a sentence alone is what
 * gets skipped under load):
 *   PROCEED  exit 0  the count read is a whole number below 3, or 3 or more
 *                    and a counted round recorded a clean string; in both
 *                    cases only when the count is not below the rounds
 *                    recorded (next lines)
 *   STOP     exit 1  3 or more passes and no counted round recorded clean
 *   UNKNOWN  exit 2  the count read is absent, empty or not a whole number;
 *                    or it is lower than the highest review round recorded
 *                    (a stale count, or a round with no pass behind it: the
 *                    human decides); or the bead spans more than one PR and
 *                    has no whole-number `tokens_impl_passes_pr<latest>`, or
 *                    still carries bare `findings_r<N>` keys that no PR can be
 *                    read off, or a per-PR count above the bead-wide one.
 *                    Refuses. An absent field is not read as zero passes
 *                    (check-pass-budget.test.mjs, "K3" cases): an empty value
 *                    silently becoming a pass-through is this repo's
 *                    recurring carrier bug (bead K3).
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

/** The PR numbers a `prs` value lists ("gh-261,#262,263" -> [261, 262, 263]); entries that are not gh-<n>, #<n> or <n> are skipped. */
export function listedPrs(prs) {
  if (prs === undefined || prs === null) return [];
  return String(prs)
    .split(",")
    .map((s) => /^(?:gh-|#)?(\d+)$/i.exec(s.trim()))
    .filter(Boolean)
    .map((m) => Number(m[1]));
}

/**
 * Which recorded rounds the budget counts (M1 of PR #296 rounds 1 and 2).
 * `spanned` is every PR number the bead names, in `prs` or in a
 * `findings_pr<n>_r<N>` key (a PR still in review may not be in `prs` yet);
 * `multiPr` is two or more of them. On a multi-PR bead the latest PR is the
 * highest of those numbers (GitHub numbers rise) and only its
 * `findings_pr<latest>_r<N>` keys count. Bare `findings_r<N>` keys cannot be
 * tied to a PR there (pr-review-merge step 4a item 5 has them renamed first),
 * so they are reported in `unattributed` and checkPassBudget refuses. On a
 * single-PR bead the bare keys count, or that one PR's `findings_pr` keys; a
 * bead with both forms is a recording error and no round of it counts as
 * clean.
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
  const spanned = [...new Set([...listedPrs(metadata.prs), ...prKeys.map((r) => r.pr)])].sort((a, b) => a - b);
  const multiPr = spanned.length > 1;
  const notes = [];
  let counted;
  let cleanAllowed = true;
  let latestPr = null;
  if (prKeys.length > 0 || multiPr) {
    latestPr = spanned[spanned.length - 1];
    counted = prKeys.filter((r) => r.pr === latestPr);
    if (counted.length === 0) notes.push(`no findings_pr${latestPr}_r<N> key for the latest PR, #${latestPr}`);
    if (bare.length > 0 && !multiPr) {
      cleanAllowed = false;
      notes.push(
        `recording error: both bare findings_r<N> (${bare.map((r) => r.key).join(", ")}) and findings_pr<n>_r<N> keys are set; no round counts as clean`,
      );
    }
  } else {
    counted = bare;
  }
  const counts = new Set(counted.map((r) => r.key));
  const rounds = all.map((r) => ({ ...r, counted: counts.has(r.key) }));
  const unstamped = metadata.findings_unstamped !== undefined && metadata.findings_unstamped !== null && String(metadata.findings_unstamped).trim() !== "";
  const highest = counted.reduce((max, r) => Math.max(max, r.n), 0);
  return {
    rounds,
    latestPr,
    spanned,
    multiPr,
    unattributed: multiPr ? bare.map((r) => r.key) : [],
    unstamped,
    roundsRecorded: highest + (unstamped ? 1 : 0),
    clean: cleanAllowed ? counted.filter((r) => r.clean).map((r) => r.key) : [],
    notes,
  };
}

const wholeNumber = (raw) => {
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  return { text, ok: /^\d+$/.test(text), seen: raw === undefined ? "absent" : `"${text}"` };
};

/**
 * @param {{id?: string, metadata?: Record<string, unknown>}} bead
 * @returns {{verdict: "PROCEED"|"STOP"|"UNKNOWN", exit: 0|1|2, passes: number|null, passesKey: string,
 *   rounds: {key: string, value: string, clean: boolean, counted: boolean}[], roundsRecorded: number,
 *   keysExamined: number, message: string}}
 */
export function checkPassBudget(bead) {
  const metadata = bead && typeof bead.metadata === "object" && bead.metadata ? bead.metadata : {};
  const keys = Object.keys(metadata);
  const sel = selectRounds(metadata);
  const passesKey = sel.multiPr ? `tokens_impl_passes_pr${sel.latestPr}` : "tokens_impl_passes";
  const base = { rounds: sel.rounds, roundsRecorded: sel.roundsRecorded, keysExamined: keys.length, passesKey };
  const id = bead?.id ?? "<id>";
  const notes = sel.notes.length ? ` Note: ${sel.notes.join("; ")}.` : "";
  const unknown = (passes, message) => ({ ...base, verdict: "UNKNOWN", exit: 2, passes, message: `${message}${notes}` });

  const count = wholeNumber(metadata[passesKey]);
  if (sel.multiPr) {
    const prList = sel.spanned.map((n) => `#${n}`).join(", ");
    const problems = [];
    if (!count.ok) {
      problems.push(
        `tokens_impl_passes counts the whole bead and cannot be attributed to the latest PR, #${sel.latestPr}, and ${passesKey} is ${count.seen}. ` +
          `Record the passes made on #${sel.latestPr} alone, counting its first: bd update ${id} --set-metadata ${passesKey}=<n>`,
      );
    }
    if (sel.unattributed.length > 0) {
      problems.push(
        `bare ${sel.unattributed.join(", ")} cannot be tied to a PR on a multi-PR bead. ` +
          `Rename them to findings_pr<their PR>_r<N> first (pr-review-merge step 4a item 5)`,
      );
    }
    const total = wholeNumber(metadata.tokens_impl_passes);
    if (count.ok && total.ok && Number(count.text) > Number(total.text)) {
      problems.push(`${passesKey} is ${count.text}, above the bead-wide tokens_impl_passes of ${total.text}, so one of them is wrong. Correct it`);
    }
    if (problems.length > 0) {
      return unknown(count.ok ? Number(count.text) : null, `The bead spans PRs ${prList}. Refusing: ${problems.join("; ")}. Then re-run.`);
    }
  } else if (!count.ok) {
    return unknown(
      null,
      `tokens_impl_passes is ${count.seen}, not a whole number. Refusing: an unknown count is not zero. ` +
        `Record the passes made so far first: bd update ${id} --set-metadata tokens_impl_passes=<n>, then re-run.`,
    );
  }
  const passes = Number(count.text);
  const counted = sel.rounds.filter((r) => r.counted);
  const seenRounds = counted.length ? counted.map((r) => `${r.key}=${r.value}`).join("; ") : "none recorded";
  // M2 of PR #296 round 1, L1 of round 2: every round that BLOCKED required a
  // pushed pass before the next round, so a count below the highest recorded
  // round is usually stale bookkeeping. Not always: pr-review-merge step 5's
  // BEHIND recovery stamps a round on an update-branch commit with no pass
  // behind it, and a round can re-review a fix a human pushed, so a count one
  // below the round number can be right. Refuse either way, and leave the
  // judgement to whoever reads the message, never a count raised to match.
  if (passes < sel.roundsRecorded) {
    return unknown(
      passes,
      `${passesKey} is ${passes} but ${sel.roundsRecorded} review round(s) are recorded ` +
        `(highest counted round ${sel.roundsRecorded - (sel.unstamped ? 1 : 0)}${sel.unstamped ? ", plus 1 for findings_unstamped" : ""}): ` +
        `the count lags the rounds. Refusing. Confirm the count or record the update round: if passes were made and not recorded, ` +
        `record them (bd update ${id} --set-metadata ${passesKey}=<n>) and re-run; if the count is right and a round had no pass behind it ` +
        `(a BEHIND update-branch round, a re-review of an unchanged head, a fix a human pushed), note that round on the bead and let a human ` +
        `decide. Never raise the count above the passes made.`,
    );
  }
  if (passes < PASS_LIMIT) {
    return { ...base, verdict: "PROCEED", exit: 0, passes, message: `${passes} pass(es) (${passesKey}), under the limit of ${PASS_LIMIT}.${notes}` };
  }
  if (sel.clean.length > 0) {
    return {
      ...base,
      verdict: "PROCEED",
      exit: 0,
      passes,
      message: `${passes} passes (${passesKey}), at or over the limit of ${PASS_LIMIT}, but a clean round was recorded (${sel.clean.join(", ")}).${notes}`,
    };
  }
  return {
    ...base,
    verdict: "STOP",
    exit: 1,
    passes,
    message:
      `${passes} implementation passes (${passesKey}) and no clean review round (limit ${PASS_LIMIT}). Rounds counted: ${seenRounds}.${notes} ` +
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
