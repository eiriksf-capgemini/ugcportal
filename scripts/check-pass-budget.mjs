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
 *                    or 3 or more and some round recorded a clean string
 *   STOP     exit 1  3 or more passes and no round recorded clean
 *   UNKNOWN  exit 2  `tokens_impl_passes` is absent, empty or not a whole
 *                    number. Refuses. An absent field is not read as zero
 *                    passes (check-pass-budget.test.mjs, "K3" cases): an empty value silently becoming a pass-through
 *                    is this repo's recurring carrier bug (bead K3).
 *   (usage error, an unreadable bead file or an unresolvable id also exit 2,
 *    with a message on stderr: a gate that cannot read its input does not
 *    pass it.)
 *
 * "Clean round" means a `findings_r<N>` key (or `findings_pr<number>_r<N>` on
 * a bead with more than one reviewed PR, pr-review-merge step 4a item 5)
 * whose value is exactly CLEAN_FINDINGS, all counts zero. A value that does
 * not parse is not clean: the failure direction is the stricter one.
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
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { isMainModule } from "./lib/is-main.mjs";

export const PASS_LIMIT = 3;
export const CLEAN_FINDINGS = "f1:0 f2:0 f3:0 f4:0 med:0 low:0";
export const FINDINGS_KEY = /^findings_(?:pr\d+_)?r\d+$/;

/**
 * @param {{id?: string, metadata?: Record<string, unknown>}} bead
 * @returns {{verdict: "PROCEED"|"STOP"|"UNKNOWN", exit: 0|1|2, passes: number|null,
 *   rounds: {key: string, value: string, clean: boolean}[], keysExamined: number, message: string}}
 */
export function checkPassBudget(bead) {
  const metadata = bead && typeof bead.metadata === "object" && bead.metadata ? bead.metadata : {};
  const keys = Object.keys(metadata);
  const rounds = keys
    .filter((k) => FINDINGS_KEY.test(k))
    .map((key) => {
      const value = String(metadata[key]).trim().replace(/\s+/g, " ");
      return { key, value, clean: value === CLEAN_FINDINGS };
    });
  const raw = metadata.tokens_impl_passes;
  const base = { rounds, keysExamined: keys.length };

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
        `Record the passes made so far first: bd update ${bead.id ?? "<id>"} --set-metadata tokens_impl_passes=<n>, then re-run.`,
    };
  }
  const passes = Number(text);
  const clean = rounds.filter((r) => r.clean).map((r) => r.key);
  const seenRounds = rounds.length ? rounds.map((r) => `${r.key}=${r.value}`).join("; ") : "none recorded";
  if (passes < PASS_LIMIT) {
    return { ...base, verdict: "PROCEED", exit: 0, passes, message: `${passes} pass(es), under the limit of ${PASS_LIMIT}.` };
  }
  if (clean.length > 0) {
    return {
      ...base,
      verdict: "PROCEED",
      exit: 0,
      passes,
      message: `${passes} passes, at or over the limit of ${PASS_LIMIT}, but a clean round was recorded (${clean.join(", ")}).`,
    };
  }
  return {
    ...base,
    verdict: "STOP",
    exit: 1,
    passes,
    message:
      `${passes} implementation passes and no clean review round (limit ${PASS_LIMIT}). Rounds seen: ${seenRounds}. ` +
      `Do not spawn another pass: post the stop on the PR and file the remainder as a bead with discovered-from ` +
      `${bead.id ?? "<id>"} (dispatch-bead section 6).`,
  };
}

export function formatVerdict(bead, r) {
  const findingsKeys = r.rounds.length;
  return [
    `${r.verdict} ${bead.id ?? "<id>"}: ${r.message}`,
    `Examined ${r.keysExamined} metadata key(s), ${findingsKeys} of them findings keys.`,
  ].join("\n");
}

function loadBead(id, beadsFile) {
  let parsed;
  if (beadsFile) {
    parsed = JSON.parse(fs.readFileSync(beadsFile, "utf8"));
    const all = Array.isArray(parsed) ? parsed : [parsed];
    const found = id ? all.find((b) => b.id === id) : all.length === 1 ? all[0] : undefined;
    if (!found) throw new Error(`bead not found in ${beadsFile}: ${id}`);
    return found;
  }
  parsed = JSON.parse(execFileSync("bd", ["show", id, "--json"], { encoding: "utf8", maxBuffer: 1 << 26 }));
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
