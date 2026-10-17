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
 * Single-PR beads only (narrowed at PR #296 round 3). The count read is
 * `metadata.tokens_impl_passes`, which counts the whole bead, and the rounds
 * are its bare `findings_r<N>` keys. On a bead with more than one PR neither
 * can be tied to the PR in flight, so any sign of a second PR returns UNKNOWN
 * and names MULTI_PR_OWNER, the bead that owns the multi-PR case, instead of a
 * verdict. The signs (multiPrSignals): `prs` listing two or more PRs, a `prs`
 * entry that does not parse (named in the message, never dropped), any
 * `findings_pr<n>_` key, any `tokens_impl_passes_pr<n>` key.
 *
 * Verdicts, and the exit status that is the gate (a sentence alone is what
 * gets skipped under load):
 *   PROCEED  exit 0  a single-PR bead whose count is a whole number below 3,
 *                    or 3 or more and a round recorded a clean string; in
 *                    both cases only when the count is not below the rounds
 *                    recorded (next lines)
 *   STOP     exit 1  a single-PR bead, 3 or more passes and no round recorded
 *                    clean
 *   UNKNOWN  exit 2  the bead shows any multi-PR signal (above); or the count
 *                    is absent, empty or not a whole number; or it is lower
 *                    than the highest review round recorded (a stale count,
 *                    or a round with no pass behind it: the human decides).
 *                    Refuses. An absent field is not read as zero passes
 *                    (check-pass-budget.test.mjs, "K3" cases): an empty value
 *                    silently becoming a pass-through is this repo's
 *                    recurring carrier bug (bead K3).
 *   (usage error, an unreadable bead file or an unresolvable id also exit 2,
 *    with a message on stderr: a gate that cannot read its input does not
 *    pass it.)
 *
 * "Clean round" means a `findings_r<N>` key (pr-review-merge step 4a item 5)
 * whose value is exactly CLEAN_FINDINGS, all counts zero. A value that does
 * not parse is not clean: the failure direction is the stricter one.
 * `findings_unstamped` is never clean; it adds one to the rounds recorded.
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
/** Any findings key, bare or per-PR; only the bare form is counted. */
export const FINDINGS_KEY = /^findings_(?:pr(\d+)_)?r(\d+)$/;
const BARE_FINDINGS_KEY = /^findings_r(\d+)$/;
const PR_FINDINGS_KEY = /^findings_pr\d+_/;
const PR_PASSES_KEY = /^tokens_impl_passes_pr\d+/;
/** The bead that owns the multi-PR case this script refuses (PR #296 round 3). */
export const MULTI_PR_OWNER = "ugcportal-8zcj";

/**
 * A `prs` value split into the PR numbers it lists and the entries that do
 * not parse ("gh-261,#262,263" -> [261, 262, 263]; "gh-261;gh-262" -> one
 * unparsed entry). Entries are comma-separated gh-<n>, #<n> or <n>; empty
 * entries (a trailing comma) are ignored.
 */
export function parsePrs(prs) {
  const listed = [];
  const unparsed = [];
  if (prs === undefined || prs === null) return { listed, unparsed };
  for (const raw of String(prs).split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const m = /^(?:gh-|#)?(\d+)$/i.exec(entry);
    if (m) listed.push(Number(m[1]));
    else unparsed.push(entry);
  }
  return { listed, unparsed };
}

/** Every sign that the bead has, or had, more than one PR; empty on a single-PR bead. */
export function multiPrSignals(metadata) {
  const signals = [];
  const { listed, unparsed } = parsePrs(metadata.prs);
  const distinct = [...new Set(listed)];
  if (distinct.length > 1) signals.push(`prs lists ${distinct.length} PRs (${distinct.map((n) => `#${n}`).join(", ")})`);
  if (unparsed.length > 0) signals.push(`prs has ${unparsed.length} entr${unparsed.length === 1 ? "y" : "ies"} that do not parse (${unparsed.map((e) => `"${e}"`).join(", ")})`);
  const prFindings = Object.keys(metadata).filter((k) => PR_FINDINGS_KEY.test(k));
  if (prFindings.length > 0) signals.push(`per-PR findings key(s) ${prFindings.join(", ")}`);
  const prPasses = Object.keys(metadata).filter((k) => PR_PASSES_KEY.test(k));
  if (prPasses.length > 0) signals.push(`per-PR pass count key(s) ${prPasses.join(", ")}`);
  return signals;
}

/** The bare `findings_r<N>` rounds, the rounds recorded R (highest N, plus one for `findings_unstamped`) and the clean ones. */
export function selectRounds(metadata) {
  const rounds = [];
  for (const key of Object.keys(metadata)) {
    const any = FINDINGS_KEY.exec(key);
    if (!any) continue;
    const value = String(metadata[key]).trim().replace(/\s+/g, " ");
    const bare = BARE_FINDINGS_KEY.exec(key);
    rounds.push({ key, n: Number(any[2]), value, clean: value === CLEAN_FINDINGS, counted: Boolean(bare) });
  }
  const counted = rounds.filter((r) => r.counted);
  const unstamped = metadata.findings_unstamped !== undefined && metadata.findings_unstamped !== null && String(metadata.findings_unstamped).trim() !== "";
  const highest = counted.reduce((max, r) => Math.max(max, r.n), 0);
  return { rounds, unstamped, roundsRecorded: highest + (unstamped ? 1 : 0), clean: counted.filter((r) => r.clean).map((r) => r.key) };
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
  const passesKey = "tokens_impl_passes";
  const id = bead?.id ?? "<id>";
  const signals = multiPrSignals(metadata);
  if (signals.length > 0) {
    // Every findings key is reported, none counted: no verdict is read off a multi-PR bead.
    const rounds = selectRounds(metadata).rounds.map((r) => ({ ...r, counted: false }));
    return {
      rounds,
      roundsRecorded: 0,
      keysExamined: keys.length,
      passesKey,
      verdict: "UNKNOWN",
      exit: 2,
      passes: null,
      message:
        `The pass budget check applies to single-PR beads only, and this bead shows signs of more than one PR: ${signals.join("; ")}. ` +
        `Refusing: tokens_impl_passes and the findings keys cannot be tied to the PR in flight here. ` +
        `The orchestrator decides by hand (dispatch-bead section 6); the multi-PR case is owned by ${MULTI_PR_OWNER}.`,
    };
  }
  const sel = selectRounds(metadata);
  const base = { rounds: sel.rounds, roundsRecorded: sel.roundsRecorded, keysExamined: keys.length, passesKey };
  const unknown = (passes, message) => ({ ...base, verdict: "UNKNOWN", exit: 2, passes, message });

  const count = wholeNumber(metadata[passesKey]);
  if (!count.ok) {
    return unknown(
      null,
      `tokens_impl_passes is ${count.seen}, not a whole number. Refusing: an unknown count is not zero. ` +
        `Record the passes made so far first: bd update ${id} --set-metadata tokens_impl_passes=<n>, then re-run.`,
    );
  }
  const passes = Number(count.text);
  const counted = sel.rounds.filter((r) => r.counted);
  const seenRounds = counted.length ? counted.map((r) => `${r.key}=${r.value}`).join("; ") : "none recorded";
  // M2 of PR #296 round 1, L1 of round 2: a round that BLOCKED is normally
  // followed by a pushed fix pass before the next round, so a count below the
  // highest recorded round is usually stale bookkeeping. Not always: pr-review-merge step 5's
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
    return { ...base, verdict: "PROCEED", exit: 0, passes, message: `${passes} pass(es) (${passesKey}), under the limit of ${PASS_LIMIT}.` };
  }
  if (sel.clean.length > 0) {
    return {
      ...base,
      verdict: "PROCEED",
      exit: 0,
      passes,
      message: `${passes} passes (${passesKey}), at or over the limit of ${PASS_LIMIT}, but a clean round was recorded (${sel.clean.join(", ")}).`,
    };
  }
  return {
    ...base,
    verdict: "STOP",
    exit: 1,
    passes,
    message:
      `${passes} implementation passes (${passesKey}) and no clean review round (limit ${PASS_LIMIT}). Rounds counted: ${seenRounds}. ` +
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
