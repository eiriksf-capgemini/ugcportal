#!/usr/bin/env node
/**
 * CI gate on `npm audit` (ugcportal-1j4j).
 *
 * Fails when a high or critical advisory is in the dependency tree and its
 * GHSA id is not in scripts/npm-audit-allowlist.json. The allowlist is keyed
 * by GHSA id, so a new advisory in an already-allowlisted package still
 * fails. Also fails, loudly, when:
 *   - npm audit printed nothing, malformed JSON, or a registry error: a run
 *     that audited nothing must not read as "no advisories";
 *   - an allowlist entry has no owner bead, no valid recorded/re-check date
 *     or no reason, or its re-check date has passed;
 *   - an allowlisted id no longer appears (a stale entry nobody removed);
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
 * Usage:
 *   node scripts/check-npm-audit.mjs                   runs `npm audit --json` itself
 *   node scripts/check-npm-audit.mjs --json-file <p>   reads a saved report (tests)
 *   --allowlist <p>   alternative allowlist file
 * npm audit exits 1 whenever advisories exist, so its exit status is not the
 * verdict: the verdict is whether stdout parses as an audit report.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST = join(HERE, "npm-audit-allowlist.json");
const BLOCKING = new Set(["high", "critical"]);
const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const BEAD = /^ugcportal-[a-z0-9]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const canonicalId = (s) => `GHSA-${s.slice(5).toLowerCase()}`;
const validDate = (s) => typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

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
  return report;
}

/**
 * Map each high or critical GHSA id to { package, severity, affected[] }.
 * `unattributed` lists high/critical packages no such GHSA id reaches.
 */
export function collectAdvisories(report) {
  const vulns = report.vulnerabilities;
  const memo = new Map();
  const advisoriesOf = (name, seen = new Set()) => {
    if (memo.has(name)) return memo.get(name);
    if (seen.has(name)) return new Set();
    seen.add(name);
    const out = new Set();
    for (const via of vulns[name]?.via ?? []) {
      if (typeof via === "string") {
        for (const id of advisoriesOf(via, seen)) out.add(id);
      } else if (via && BLOCKING.has(via.severity)) {
        const id = GHSA.exec(String(via.url ?? ""))?.[0];
        if (id) out.add(canonicalId(id));
        else out.add(`NO-GHSA:${via.source ?? via.title ?? "unknown"}`);
      }
    }
    memo.set(name, out);
    return out;
  };
  const advisories = new Map();
  const unattributed = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (!BLOCKING.has(v?.severity)) continue;
    const ids = advisoriesOf(name);
    if (ids.size === 0) unattributed.push(name);
    for (const id of ids) {
      if (!advisories.has(id)) advisories.set(id, { id, package: null, severity: v.severity, affected: [] });
      const a = advisories.get(id);
      a.affected.push(name);
      if (v.severity === "critical") a.severity = "critical";
    }
  }
  // the owner package is the one carrying the advisory as a `via` object
  for (const [name, v] of Object.entries(vulns))
    for (const via of v?.via ?? []) {
      if (typeof via === "string" || !via) continue;
      const raw = GHSA.exec(String(via.url ?? ""))?.[0];
      const id = raw && canonicalId(raw);
      if (id && advisories.has(id)) advisories.get(id).package = via.name ?? name;
    }
  return { advisories, unattributed };
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
  const { advisories, unattributed } = collectAdvisories(report);
  for (const name of unattributed)
    errors.push(`${name}: high or critical but no high/critical GHSA id could be traced to it; it cannot be allowlisted`);
  for (const a of advisories.values()) {
    const entry = entries[a.id];
    const chain = a.affected.join(", ");
    if (!entry) {
      errors.push(`${a.id} (${a.package ?? "unknown package"}, ${a.severity}) is not in the allowlist; affects: ${chain}`);
    } else if (a.package && entry.package && entry.package !== a.package) {
      errors.push(`${a.id}: allowlist says package ${entry.package} but npm audit says ${a.package}; affects: ${chain}`);
    } else {
      lines.push(`allowlisted ${a.id} (${a.package}, ${a.severity}) owner ${entry.ownerBead} recheck ${entry.recheck}; affects: ${chain}`);
    }
  }
  for (const id of Object.keys(entries))
    if (!advisories.has(id)) errors.push(`allowlist entry ${id} (${entries[id]?.package ?? "?"}) no longer appears in npm audit; remove the stale entry`);
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
    out(`npm audit: ${JSON.stringify(v)}`);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
