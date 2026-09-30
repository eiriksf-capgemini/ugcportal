/**
 * True when this module was invoked directly (`node some-script.mjs`), as
 * opposed to imported by another module (e.g. a test file importing its
 * exports). Shared by every script here that needs this check, after two
 * of them (scripts/with-local-ca.mjs, scripts/sweep-candidates.mjs)
 * independently wrote and independently fixed the same bug: comparing
 * `import.meta.url` (a `file://` URL) against a raw `process.argv[1]` OS
 * path with string `===` never matches on Windows (different separators,
 * no triple-slash form). `pathToFileURL` normalizes argv[1] into the same
 * form `import.meta.url` is already in.
 *
 * @param {string} moduleUrl the caller's own `import.meta.url`
 * @returns {boolean}
 */
import { pathToFileURL } from "node:url";

export function isMainModule(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(process.argv[1]).href;
}
