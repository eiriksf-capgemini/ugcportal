/**
 * True when this module was invoked directly (`node <script>`), as
 * opposed to imported by another module (e.g. a test file importing its
 * exports). Shared by every script here that needs this check.
 *
 * Both sides are resolved with `fs.realpathSync` before comparing, so a script
 * reached through a symlinked directory (on macOS `/tmp` is a symlink to
 * `/private/tmp`) is recognised: `import.meta.url` carries the resolved path,
 * while `process.argv[1]` keeps the path as typed, and comparing the two raw
 * left the guard false so the script exited 0 without running. The comparison
 * is between two native OS paths (`fileURLToPath` on the URL side), not
 * `file://` URL text against an OS path, so path separators agree on Windows.
 *
 * Returns false when argv[1] is missing or either path cannot be resolved
 * (ENOENT, a non-`file:` module URL); the try/catch is what keeps it from
 * throwing, and is-main.test.mjs covers the missing-file case.
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
