/**
 * True when this module was invoked directly (`node some-script.mjs`), as
 * opposed to imported by another module (e.g. a test file importing its
 * exports). Shared by every script here that needs this check.
 *
 * Both sides are resolved with `fs.realpathSync` before comparing, so a script
 * reached through a symlinked directory (on macOS `/tmp` is a symlink to
 * `/private/tmp`) is still recognised: `import.meta.url` is already the
 * resolved path, while `process.argv[1]` keeps the path as typed. Comparing
 * the two raw made the guard false and the script exit 0 without running.
 * Comparing the resolved paths as plain strings (rather than `file://` URL
 * text against an OS path, which never matches on Windows because of the
 * separators) keeps the check platform-neutral.
 *
 * Returns false, never throws, when argv[1] is missing or either path cannot
 * be resolved (e.g. ENOENT, or a non-`file:` module URL).
 *
 * @param {string} moduleUrl the caller's own `import.meta.url`
 * @returns {boolean}
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
