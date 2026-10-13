#!/usr/bin/env node
/**
 * Reads a bead back after a write and asserts the written value actually
 * landed (ugcportal-kssp, mitigation 3: "read the object back after a write
 * that matters").
 *
 * WHY THIS IS A SCRIPT AND NOT A SENTENCE IN A SKILL. The instances this
 * exists for are recorded in docs/process/development-process.md section 9,
 * weakness 6: `bd` writes whose stderr was redirected to the null device
 * were reported as applied when they had failed, and a `||` fallback ran its
 * second branch with the arguments reversed, SUCCEEDED, and recorded a graph
 * edge backwards. Both look identical to a write that worked, because `bd`
 * exiting 0 is the only evidence anyone was collecting. A sentence telling
 * an agent to check leaves no trace when it is skipped; a command leaves its
 * output, and this one prints the bead's whole metadata keyset, so a reader
 * can tell "I read it back and it matched" from "I never read it back".
 *
 * Usage:
 *   node scripts/bd-verify-metadata.mjs <bead-id> <expectation> [<expectation> ...]
 *
 * Expectations, each of which is checked and reported individually:
 *   key=value       metadata[key] must equal value exactly (string compare)
 *   notes~=text     the bead's notes field must CONTAIN text
 *
 * `notes~=` is here because of the specific accident this repo has had twice:
 * `bd update --notes` REPLACES the whole notes field (the append form is
 * `--append-notes`), so a note destroyed by the wrong flag reports success
 * and is only visible on a read-back. Pass a substring of what was there
 * before, plus one of what you just added, to catch both directions.
 *
 * Exit status -- deliberately three distinct non-zero codes, because "the
 * value is wrong" and "I could not find out" are different answers and
 * collapsing them is the defect this file is about:
 *   0  every expectation matched (and there was at least one)
 *   1  the bead exists and at least one expectation did NOT match
 *   2  usage error, including ZERO expectations -- a verifier handed nothing
 *      to verify must never print a success line
 *   3  could not read the bead back at all (bd failed, or returned no such
 *      bead). This is NOT folded into 1: an unreadable bead means the write
 *      is unverified, not that it failed.
 *
 * Self-test: scripts/bd-verify-metadata.test.mjs (vitest), which exercises
 * the pure functions below plus the real CLI against a stubbed `bd`.
 */

import { execFileSync } from "node:child_process";

import { isMainModule } from "./lib/is-main.mjs";

export const EXIT_OK = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNREADABLE = 3;

const NOTES_CONTAINS_PREFIX = "notes~=";

/**
 * Splits argv into the bead id and its expectations.
 *
 * Splits each `key=value` on the FIRST `=` only, so a value containing `=`
 * (a note sentence, a URL with a query string) survives intact rather than
 * being silently truncated to the part before the second one.
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{id: string, expectations: {kind: "metadata"|"notes-contains", key: string, value: string}[]}}
 * @throws {Error} on a missing id, a malformed expectation, or ZERO expectations
 */
export function parseArgs(argv) {
  const [id, ...rest] = argv;
  if (!id || id.startsWith("-")) {
    throw new Error("usage: bd-verify-metadata.mjs <bead-id> <key>=<value> [<key>=<value> ...] [notes~=<text>]");
  }

  const expectations = [];
  for (const arg of rest) {
    if (arg.startsWith(NOTES_CONTAINS_PREFIX)) {
      const value = arg.slice(NOTES_CONTAINS_PREFIX.length);
      if (value === "") throw new Error(`empty expectation: ${arg} -- a substring to look for is required`);
      expectations.push({ kind: "notes-contains", key: "notes", value });
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new Error(`malformed expectation: ${arg} -- expected <key>=<value> or notes~=<text>`);
    expectations.push({ kind: "metadata", key: arg.slice(0, eq), value: arg.slice(eq + 1) });
  }

  // The load-bearing branch. `bd-verify-metadata <id>` with no expectations
  // would otherwise iterate an empty list, find nothing wrong, and print a
  // success line -- the exact shape ("a check that matched nothing reports
  // success") this file was written to remove, reproduced inside the checker
  // itself.
  if (expectations.length === 0) {
    throw new Error(`no expectations given for ${id} -- nothing to verify is a usage error, not a pass`);
  }

  return { id, expectations };
}

/**
 * Picks the bead with `id` out of `bd show --json`'s output, which is an
 * ARRAY even for a single id.
 *
 * Both failure modes throw rather than returning null: an empty array (the
 * id does not exist, or `bd` answered a different question) and an array
 * whose entries are some OTHER bead are each "I could not read this bead
 * back", which must not be reportable as a pass.
 *
 * @param {string} stdout raw stdout of `bd show <id> --json`
 * @param {string} id
 * @returns {{id: string, metadata?: Record<string, unknown>, notes?: string}}
 */
export function selectBead(stdout, id) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`bd show ${id} --json did not return JSON: ${err.message}`);
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const match = rows.find((row) => row && row.id === id);
  if (!match) {
    const seen = rows.map((row) => (row && row.id) || "<no id>").join(", ") || "<empty array>";
    throw new Error(`bd show ${id} --json returned no bead with that id (got: ${seen})`);
  }
  return match;
}

/**
 * Checks each expectation against the bead actually read back.
 *
 * A missing metadata key and a key holding the wrong value are reported
 * DIFFERENTLY (`ABSENT` vs `MISMATCH`) because they point at different
 * mistakes -- a typo'd key name writes a new key and leaves the intended one
 * absent, which is the "dependency filter using the wrong field name"
 * instance one level down.
 *
 * @param {{metadata?: Record<string, unknown>, notes?: string}} bead
 * @param {{kind: string, key: string, value: string}[]} expectations
 * @returns {{verdict: "ok"|"MISMATCH"|"ABSENT", key: string, expected: string, actual: string}[]}
 */
export function checkExpectations(bead, expectations) {
  const metadata = bead.metadata ?? {};
  const notes = typeof bead.notes === "string" ? bead.notes : "";

  return expectations.map((exp) => {
    if (exp.kind === "notes-contains") {
      return {
        verdict: notes.includes(exp.value) ? "ok" : "MISMATCH",
        key: "notes",
        expected: `contains ${JSON.stringify(exp.value)}`,
        actual: notes === "" ? "<empty>" : `${notes.length} chars`,
      };
    }
    if (!Object.prototype.hasOwnProperty.call(metadata, exp.key)) {
      return { verdict: "ABSENT", key: exp.key, expected: exp.value, actual: "<key not present on the bead>" };
    }
    const actual = String(metadata[exp.key]);
    return { verdict: actual === exp.value ? "ok" : "MISMATCH", key: exp.key, expected: exp.value, actual };
  });
}

/**
 * The report. Prints the DENOMINATOR -- every metadata key the bead actually
 * holds -- not only the keys asked about, so the output of a run that
 * verified two keys is visibly different from the output of a run that
 * verified nothing, and a key written under a mistyped name is visible
 * beside the absent one it was meant to be.
 *
 * @param {string} id
 * @param {{metadata?: Record<string, unknown>}} bead
 * @param {{verdict: string, key: string, expected: string, actual: string}[]} results
 * @returns {string[]}
 */
export function formatReport(id, bead, results) {
  const keys = Object.keys(bead.metadata ?? {}).sort();
  const failed = results.filter((r) => r.verdict !== "ok");
  const lines = [
    `bd-verify-metadata ${id}: read back ${keys.length} metadata key(s) [${keys.join(", ") || "none"}];` +
      ` checked ${results.length} expectation(s).`,
  ];
  for (const r of results) {
    lines.push(
      r.verdict === "ok" ? `  ok       ${r.key} = ${r.expected}` : `  ${r.verdict} ${r.key}: expected ${r.expected}, bead holds ${r.actual}`,
    );
  }
  lines.push(
    failed.length === 0
      ? `VERIFIED: ${results.length}/${results.length} expectation(s) landed on ${id}.`
      : `FAILED: ${failed.length} of ${results.length} expectation(s) did not land on ${id}. The write did not do what was reported.`,
  );
  return lines;
}

/**
 * Runs `bd show <id> --json`. stderr is PIPED, never discarded, and is
 * re-printed on failure -- the whole point of this file is that a silenced
 * `bd` error is indistinguishable from a successful write (ugcportal-kssp
 * mitigation 2, applied to this file's own subprocess).
 *
 * @param {string} id
 * @returns {string}
 */
function readBead(id) {
  try {
    return execFileSync("bd", ["show", id, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err.stderr ?? "").toString().trim();
    throw new Error(`bd show ${id} --json failed${stderr ? `: ${stderr}` : ` (${err.message})`}`);
  }
}

export function main(argv = process.argv.slice(2), { read = readBead, log = console.log, err = console.error } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`bd-verify-metadata: ${e.message}`);
    return EXIT_USAGE;
  }

  let bead;
  try {
    bead = selectBead(read(parsed.id), parsed.id);
  } catch (e) {
    err(`bd-verify-metadata: ${e.message}`);
    err(`bd-verify-metadata: ${parsed.id} is UNVERIFIED -- this is not the same as "the write failed", and must not be reported as either a pass or a mismatch.`);
    return EXIT_UNREADABLE;
  }

  const results = checkExpectations(bead, parsed.expectations);
  for (const line of formatReport(parsed.id, bead, results)) log(line);
  return results.some((r) => r.verdict !== "ok") ? EXIT_MISMATCH : EXIT_OK;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
