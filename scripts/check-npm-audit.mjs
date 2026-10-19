#!/usr/bin/env node
/**
 * CI gate on `npm audit` (ugcportal-1j4j).
 *
 * Fails when a high or critical advisory is in the dependency tree and its
 * GHSA id is not in scripts/npm-audit-allowlist.json. The allowlist is keyed
 * by GHSA id, so a new advisory in an already-allowlisted package still
 * fails. Also fails, loudly, when:
 *   - npm audit printed nothing, malformed JSON, or a registry error, or a
 *     report whose `metadata.dependencies.total` is missing, not an integer
 *     or 0 (this repository has dependencies, so a report over none audited
 *     the wrong tree): a run that audited nothing must not read as "no
 *     advisories". Every run that parses prints the dependency count it
 *     examined beside the advisory counts, pass or fail;
 *   - an allowlist entry has no owner bead, no valid recorded/re-check date
 *     or no reason, or its re-check date has passed;
 *   - an allowlisted id is not collected: the gate collects high and critical
 *     advisories only, so an entry fails either because the id no longer
 *     appears in the report (a stale entry nobody removed) or because it still
 *     appears but below high (the message names the severity found; remove
 *     the entry, the gate fails until then);
 *   - a high or critical package cannot be traced to any high or critical
 *     GHSA id (an unattributable finding is never waved through).
 *
 * Attribution. `npm audit --json` reports only the package that carries an
 * advisory with the advisory itself (a `via` object with a `url` ending in a
 * GHSA id). Every package that depends on it is reported "via" the other
 * package's name, a string. The script follows those strings to the package
 * that owns the advisory, so one GHSA id covers a whole chain and the output
 * names every package the chain reaches (braces -> micromatch -> fast-glob
 * -> @next/eslint-plugin-next -> eslint-config-next).
 *
 * Cycles. A package is attributed every advisory carried by any package it
 * can reach through `via` strings, itself included. So a package in a `via`
 * cycle with an advisory-carrying package inherits that package's advisories,
 * and the result does not depend on the order of the `vulnerabilities` keys:
 * each package's reachable set is walked whole, never assembled from a
 * partial result cut short by a cycle (tested with both key orders in
 * check-npm-audit.test.mjs, "a cycle through an advisory-carrying package").
 *
 * Severity and order. One advisory id prints one severity: the worst any via
 * object in the whole report carries for it, beside every package whose via
 * object carries that severity; the affected packages and the advisories are
 * sorted, so the output is identical for any order of the `vulnerabilities`
 * keys (tested over all six orders of three packages).
 *
 * Usage:
 *   node scripts/check-npm-audit.mjs                   runs `npm audit --json` itself
 *   node scripts/check-npm-audit.mjs --json-file <p>   reads a saved report (tests)
 *   --allowlist <p>   alternative allowlist file
 * npm audit exits 1 whenever advisories exist, so its exit status is not the
 * verdict: the verdict is whether stdout parses as an audit report.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST = join(HERE, "npm-audit-allowlist.json");
const BLOCKING = new Set(["high", "critical"]);
const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const BEAD = /^ugcportal-[a-z0-9]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const canonicalId = (s) => `GHSA-${s.slice(5).toLowerCase()}`;
// round-trip, so a date Date.parse rolls over (2027-02-30 -> March 2) is rejected
const validDate = (s) => {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/** Parse npm audit stdout. Throws a message naming what was wrong. */
export function parseAudit(text) {
  if (typeof text !== "string" || text.trim() === "") throw new Error("npm audit printed no output, so nothing was audited");
  let report;
  try {
    report = JSON.parse(text);
  } catch (e) {
    throw new Error(`npm audit output is not valid JSON (${e.message}); first 200 chars: ${text.slice(0, 200)}`);
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) throw new Error("npm audit JSON is not an object");
  if (report.error) {
    const e = report.error;
    throw new Error(`npm audit reported an error: ${e.code ?? ""} ${e.summary ?? e.detail ?? JSON.stringify(e)}`.trim());
  }
  if (report.vulnerabilities === null || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities))
    throw new Error("npm audit JSON has no `vulnerabilities` object, so it is not an audit report");
  if (report.metadata === null || typeof report.metadata !== "object" || typeof report.metadata.vulnerabilities !== "object" || report.metadata.vulnerabilities === null)
    throw new Error("npm audit JSON has no `metadata.vulnerabilities` object, so it is not an audit report");
  const deps = report.metadata.dependencies?.total;
  if (!Number.isInteger(deps) || deps < 0)
    throw new Error(`npm audit JSON has no integer \`metadata.dependencies.total\` (got ${JSON.stringify(deps)}), so what it examined is unknown`);
  if (deps === 0) throw new Error("npm audit examined 0 dependencies; this repository has dependencies, so the wrong tree (or none) was audited");
  return report;
}

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const worst = (a, b) => (a === undefined || (RANK[b] ?? -1) > (RANK[a] ?? -1) ? b : a);

/**
 * Map each high or critical GHSA id to { package, packages[], severity,
 * affected[] }. severity is the worst severity any via object in the whole
 * report carries for that id (one value per id, whatever the key order);
 * packages are those whose via object carries it (package joins them).
 * `unattributed` lists high/critical packages no such GHSA id reaches. `present` maps every GHSA id in the report, at any
 * severity, to its own (worst) severity; it never changes what blocks.
 */
export function collectAdvisories(report) {
  const vulns = report.vulnerabilities;
  // the high/critical ids a package carries itself, as `via` objects
  const ownViaId = (via) => {
    const id = GHSA.exec(String(via.url ?? ""))?.[0];
    return id ? canonicalId(id) : `NO-GHSA:${via.source ?? via.title ?? "unknown"}`;
  };
  const ownIds = (name) => {
    const out = [];
    for (const via of vulns[name]?.via ?? [])
      if (typeof via !== "string" && via && BLOCKING.has(via.severity)) out.push({ id: ownViaId(via), severity: via.severity });
    return out;
  };
  // Union of ownIds over every package reachable from `name` through `via`
  // strings, itself included. Each call walks its whole reachable set (no
  // memo shared between start points), so a cycle cannot leave a partial
  // result behind for a later start point to reuse: see "Cycles" above.
  const advisoriesOf = (name) => {
    const out = new Map(); // id -> the advisory's own severity (from its via object)
    const seen = new Set([name]);
    const queue = [name];
    while (queue.length) {
      const cur = queue.shift();
      for (const { id, severity } of ownIds(cur)) out.set(id, worst(out.get(id), severity));
      for (const via of vulns[cur]?.via ?? [])
        if (typeof via === "string" && !seen.has(via)) {
          seen.add(via);
          queue.push(via);
        }
    }
    return out;
  };
  const advisories = new Map();
  const unattributed = [];
  // every GHSA id in the report at any severity, for telling "below the gate"
  // from "not in the report" when an allowlisted id is not collected
  const present = new Map();
  for (const v of Object.values(vulns))
    for (const via of v?.via ?? []) {
      const raw = typeof via === "string" || !via ? undefined : GHSA.exec(String(via.url ?? ""))?.[0];
      if (raw) present.set(canonicalId(raw), worst(present.get(canonicalId(raw)), via.severity));
    }
  // Report-wide, over every package's own `via` objects: the worst high/critical
  // severity each id carries, and the packages carrying a via object at exactly
  // that severity. Neither depends on the order of the `vulnerabilities` keys.
  const worstOf = new Map();
  for (const name of Object.keys(vulns))
    for (const { id, severity } of ownIds(name)) worstOf.set(id, worst(worstOf.get(id), severity));
  const carriers = new Map();
  for (const [name, v] of Object.entries(vulns))
    for (const via of v?.via ?? []) {
      if (typeof via === "string" || !via || !BLOCKING.has(via.severity)) continue;
      const id = ownViaId(via);
      if (via.severity === worstOf.get(id)) carriers.set(id, new Set([...(carriers.get(id) ?? []), via.name ?? name]));
    }
  const affectedBy = new Map();
  for (const [name, v] of Object.entries(vulns)) {
    if (!BLOCKING.has(v?.severity)) continue;
    const ids = advisoriesOf(name);
    if (ids.size === 0) unattributed.push(name);
    for (const id of ids.keys()) {
      if (!affectedBy.has(id)) affectedBy.set(id, []);
      affectedBy.get(id).push(name);
    }
  }
  // Printed severity: the worst over the whole report, never the first package
  // walked. Printed package: every package whose via object carries that
  // severity. Lists are sorted so the output is independent of key order.
  for (const id of [...affectedBy.keys()].sort()) {
    const severity = worstOf.get(id);
    const pkgs = [...(carriers.get(id) ?? [])].sort();
    advisories.set(id, { id, package: pkgs.length ? pkgs.join(", ") : null, packages: pkgs, severity, affected: affectedBy.get(id).sort() });
  }
  unattributed.sort();
  return { advisories, unattributed, present };
}

/** Returns an array of problems with the allowlist shape; empty when sound. */
export function validateAllowlist(allowlist, now = new Date()) {
  const errors = [];
  const entries = allowlist?.advisories;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return ["allowlist has no `advisories` object"];
  const today = now.toISOString().slice(0, 10);
  for (const [id, e] of Object.entries(entries)) {
    const where = `allowlist entry ${id}`;
    if (!GHSA.test(id) || id !== canonicalId(id))
      errors.push(`${where}: key is not a canonical GHSA id (GHSA-xxxx-xxxx-xxxx, lower-case groups)`);
    if (!e || typeof e !== "object") {
      errors.push(`${where}: not an object`);
      continue;
    }
    if (typeof e.package !== "string" || !e.package) errors.push(`${where}: missing package`);
    if (typeof e.ownerBead !== "string" || !BEAD.test(e.ownerBead)) errors.push(`${where}: missing or malformed ownerBead (want ugcportal-<id>)`);
    if (!validDate(e.recorded)) errors.push(`${where}: missing or malformed recorded date (want YYYY-MM-DD)`);
    if (!validDate(e.recheck)) errors.push(`${where}: missing or malformed recheck date (want YYYY-MM-DD)`);
    else if (e.recheck < today) errors.push(`${where}: re-check date ${e.recheck} has passed (today ${today}); re-check it and move the date or remove the entry`);
    if (typeof e.reason !== "string" || e.reason.trim() === "") errors.push(`${where}: missing reason`);
  }
  return errors;
}

/** Pure verdict over a parsed report and allowlist. */
export function evaluate(report, allowlist, now = new Date()) {
  const errors = validateAllowlist(allowlist, now);
  const lines = [];
  const entries = allowlist?.advisories && typeof allowlist.advisories === "object" ? allowlist.advisories : {};
  const { advisories, unattributed, present } = collectAdvisories(report);
  for (const name of unattributed)
    errors.push(`${name}: high or critical but no high/critical GHSA id could be traced to it; it cannot be allowlisted`);
  for (const a of advisories.values()) {
    const entry = entries[a.id];
    const chain = a.affected.join(", ");
    if (!entry) {
      errors.push(`${a.id} (${a.package ?? "unknown package"}, ${a.severity}) is not in the allowlist; affects: ${chain}`);
    } else if (a.packages.length && entry.package && !a.packages.includes(entry.package)) {
      errors.push(`${a.id}: allowlist says package ${entry.package} but npm audit says ${a.package}; affects: ${chain}`);
    } else {
      lines.push(`allowlisted ${a.id} (${a.package}, ${a.severity}) owner ${entry.ownerBead} recheck ${entry.recheck}; affects: ${chain}`);
    }
  }
  for (const id of Object.keys(entries))
    if (!advisories.has(id)) {
      const who = `allowlist entry ${id} (${entries[id]?.package ?? "?"})`;
      if (present.has(id))
        errors.push(`${who} is present in npm audit at ${present.get(id)}, below the high/critical gate; remove the entry (the gate collects high and critical only, so it fails until then)`);
      else errors.push(`${who} no longer appears in npm audit; remove the stale entry`);
    }
  return { ok: errors.length === 0, errors, lines };
}

/** Run `npm audit --json` itself; its exit status is not the verdict. */
export function runNpmAudit(spawn = spawnSync) {
  const r = spawn("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run npm audit: ${r.error.message}`);
  return r.stdout;
}

export function main(argv = process.argv.slice(2), { audit = runNpmAudit, now = new Date(), out = console.log, err = console.error } = {}) {
  const opt = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  try {
    const jsonFile = opt("--json-file");
    const text = jsonFile ? readFileSync(jsonFile, "utf8") : audit();
    const allowlist = JSON.parse(readFileSync(opt("--allowlist") ?? DEFAULT_ALLOWLIST, "utf8"));
    const report = parseAudit(text);
    const v = report.metadata.vulnerabilities;
    out(`npm audit: examined ${report.metadata.dependencies.total} dependencies; advisories ${JSON.stringify(v)}`);
    const verdict = evaluate(report, allowlist, now);
    for (const l of verdict.lines) out(l);
    for (const e of verdict.errors) err(`::error::${e}`);
    if (!verdict.ok) {
      err(`npm audit gate FAILED: ${verdict.errors.length} problem(s)`);
      return 1;
    }
    out(`npm audit gate passed: ${verdict.lines.length} allowlisted advisor${verdict.lines.length === 1 ? "y" : "ies"} matched, none unlisted`);
    return 0;
  } catch (e) {
    err(`::error::npm audit gate FAILED: ${e.message}`);
    return 1;
  }
}

// Compare realpaths on both sides: import.meta.url is already symlink-resolved,
// process.argv[1] is not (/tmp -> /private/tmp on macOS). The same shape as
// scripts/gh-app-token.mjs and scripts/check-compose-images.mjs.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main());
