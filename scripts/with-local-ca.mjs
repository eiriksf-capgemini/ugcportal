#!/usr/bin/env node
/**
 * Run a command with a locally-provided CA bundle trusted by Node
 * (ugcportal-drt1).
 *
 * WHY THIS EXISTS: behind a TLS-intercepting corporate proxy, the server-side
 * OAuth calls Auth.js makes — OIDC discovery against accounts.google.com, the
 * token exchange against graph.facebook.com — fail with
 * SELF_SIGNED_CERT_IN_CHAIN. The visitor sees the generic "Sign-in is
 * misconfigured" page (the `Configuration` branch in
 * src/app/auth/error/outcomes.ts), because @auth/core will not disclose why.
 * `next build` hits the same failure mode for an unrelated reason:
 * src/app/layout.tsx imports next/font/google, which fetches the font files
 * over HTTPS at build time — so `build`, not just `dev`/`start`, goes
 * through this wrapper too.
 *
 * The fix is Node's NODE_EXTRA_CA_CERTS. The trap is WHERE it has to be set.
 * Node reads that variable once, at process start, when it builds its TLS
 * trust store. Putting it in `.env.local` does not work and fails silently:
 * Next loads that file with dotenv from inside the already-running process,
 * long after the trust store exists. The variable then shows up in
 * `process.env` — so it looks set — while TLS never sees it. This wrapper
 * exists to set it in the real environment of the child process instead.
 *
 * It is deliberately a no-op for anyone not behind such a proxy: no certs
 * directory means spawn the command unchanged, with no warning. A developer
 * who has never heard of this should not be told about it.
 *
 * SCOPE: this only protects the three npm scripts (dev/build/start) that
 * explicitly invoke it. `npx next dev`, an IDE run-configuration that calls
 * `next` directly, or a future script that boots the server without going
 * through this wrapper all reproduce the original bug with no hint why --
 * there is no mechanism here that makes this apply repo-wide automatically.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";

/** Directory scanned for PEM files, relative to the repo root. */
export const DEFAULT_CERTS_DIR = "certs";

/** Shared between the two warning branches below so they can't drift apart. */
const DEFAULT_TRUST_STORE_WARNING = "TLS connections will use the default trust store only.";

/**
 * Decide which file, if any, should become NODE_EXTRA_CA_CERTS.
 *
 * @param {object} options
 * @param {string} options.certsDir Directory to scan for `*.pem`.
 * @param {Record<string, string | undefined>} options.env Environment to read.
 * @param {string} options.cwd Base for resolving relative paths.
 * @returns {{path: string | null, source: "env"|"single"|"bundle"|"none", warning: string | null}}
 */
export function resolveLocalCa({ certsDir, env, cwd }) {
  const explicit = (env.NODE_EXTRA_CA_CERTS ?? "").trim();
  if (explicit) {
    // An explicit setting wins over anything in certs/ — it is the operator
    // saying which bundle to use. It is still resolved to an absolute path:
    // Node would resolve a relative value against the process cwd anyway, so
    // this changes no semantics, but it stops the value silently pointing at
    // nothing if the command is ever started from another directory.
    const resolved = path.resolve(cwd, explicit);
    // Unlike a missing certs/ directory, an explicitly-named path that does
    // not resolve to a readable file is a misconfiguration, and staying
    // quiet about it would reproduce the exact silent failure this script
    // was written for. fs.existsSync alone accepts a directory too (Node
    // would then fail opening it as a cert bundle) -- require isFile().
    let isFile = false;
    try {
      isFile = fs.statSync(resolved).isFile();
    } catch {
      isFile = false;
    }
    return {
      path: resolved,
      source: "env",
      warning: isFile ? null : `NODE_EXTRA_CA_CERTS points at ${resolved}, which is not a readable file. ${DEFAULT_TRUST_STORE_WARNING}`,
    };
  }

  const dir = path.resolve(cwd, certsDir);
  // Computed unconditionally, before knowing whether certs/ even exists
  // right now, so it can be used to clean up a bundle left over from a
  // certs/ directory that has since been emptied OR removed entirely --
  // otherwise stale CA material sits at a predictable path indefinitely
  // with nothing pointing at it anymore.
  const bundlePath = path.join(
    os.tmpdir(),
    `ugcportal-local-ca-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}.pem`,
  );
  const cleanUpLeftoverBundle = () => {
    try {
      fs.unlinkSync(bundlePath);
    } catch {
      // Nothing to clean up, or already gone -- either way, fine.
    }
  };

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    // No certs directory at all: the ordinary case for anyone not behind a
    // proxy. Silent on purpose. Anything else (e.g. EACCES, a permissions
    // problem on a directory that DOES exist) is a real misconfiguration
    // and should not be indistinguishable from "no proxy".
    if (error.code === "ENOENT") {
      cleanUpLeftoverBundle();
      return { path: null, source: "none", warning: null };
    }
    return {
      path: null,
      source: "none",
      warning: `Could not read ${dir}: ${error.message}. ${DEFAULT_TRUST_STORE_WARNING}`,
    };
  }

  const pems = entries
    .filter((name) => name.toLowerCase().endsWith(".pem"))
    .sort()
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });

  if (pems.length === 0) {
    cleanUpLeftoverBundle();
    return { path: null, source: "none", warning: null };
  }
  if (pems.length === 1) return { path: pems[0], source: "single", warning: null };

  // NODE_EXTRA_CA_CERTS takes ONE path, so several PEMs have to be
  // concatenated. Handing it only the first would trust some of the
  // configured CAs while reporting success for all of them -- which is
  // exactly what silently dropping a vanished file's content would still
  // do, so a file that disappears between the statSync filter above and
  // here (another process editing certs/ mid-run) is skipped but ALSO
  // recorded, and surfaced as a warning rather than folded into a
  // silently-partial "success".
  const missing = [];
  const content = pems
    .map((file) => {
      try {
        return fs.readFileSync(file, "utf8").trimEnd() + "\n";
      } catch {
        missing.push(file);
        return "";
      }
    })
    .join("");

  // The bundle's NAME is deterministic (a hash of the certs dir path) so
  // repeated runs reuse one path instead of leaking a new temp file every
  // invocation. The WRITE is not: two concurrent `dev`/`start` regenerating
  // it at once (both reading the same certs/, so producing identical bytes
  // here) could otherwise interleave a partial write, and a well-known
  // path in a shared /tmp is exactly what a symlink-planting attack on a
  // multi-user host targets. Write to a fresh, process-unique temp file
  // with `wx` (fails if the path already exists, so it can't be a
  // pre-placed symlink either) and rename() over the target -- POSIX
  // rename is atomic and replaces whatever was at the destination, symlink
  // or not, rather than following/trusting it.
  const bundleTmp = path.join(os.tmpdir(), `.${path.basename(bundlePath)}.${process.pid}.tmp`);
  fs.writeFileSync(bundleTmp, content, { mode: 0o600, flag: "wx" });
  fs.renameSync(bundleTmp, bundlePath);
  return {
    path: bundlePath,
    source: "bundle",
    warning:
      missing.length > 0
        ? `${missing.length} PEM file(s) disappeared while building the CA bundle and were skipped: ${missing.join(", ")}.`
        : null,
  };
}

// Windows' child_process shell:true is documented by Node itself as unsafe
// for an argument containing shell metacharacters, because cmd.exe's own
// parsing can reinterpret them regardless of how spawn() quotes argv. This
// wrapper's only real call sites (package.json's dev/build/start scripts)
// never pass such an argument, but the wrapper itself is general-purpose
// (any command + args), so refuse rather than silently forward one through
// a shell on the one platform where that shell is unavoidable (a .cmd
// shim can't be exec'd without it).
const WINDOWS_SHELL_METACHARACTERS = /[&|<>^%!"]/;

/* c8 ignore start -- process wiring, exercised by `npm run dev` itself */
function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("usage: node scripts/with-local-ca.mjs <command> [args...]");
    process.exit(2);
  }

  if (process.platform === "win32") {
    const unsafe = args.find((a) => WINDOWS_SHELL_METACHARACTERS.test(a));
    if (unsafe) {
      console.error(
        `[local-ca] refusing to run: argument ${JSON.stringify(unsafe)} contains a shell metacharacter, ` +
          "unsafe to pass through Windows' shell:true (see Node's child_process shell-injection warning).",
      );
      process.exit(1);
    }
  }

  const { path: caPath, source, warning } = resolveLocalCa({
    certsDir: DEFAULT_CERTS_DIR,
    env: process.env,
    cwd: process.cwd(),
  });

  if (warning) console.warn(`[local-ca] ${warning}`);
  // Announced only when this script actually changed something, so the
  // no-proxy case stays silent (and so a failing sign-in has a visible
  // confirmation that the CA was in fact loaded).
  if (caPath && source !== "env") {
    console.log(`[local-ca] trusting ${path.relative(process.cwd(), caPath) || caPath}`);
  }

  const child = spawn(command, args, {
    stdio: "inherit",
    env: caPath ? { ...process.env, NODE_EXTRA_CA_CERTS: caPath } : process.env,
    // `next` and friends live in node_modules/.bin, which npm puts on PATH.
    // Windows needs a shell to resolve the .cmd shim; POSIX must not use one,
    // so that argv is passed through without another round of word splitting.
    shell: process.platform === "win32",
  });

  child.on("error", (error) => {
    console.error(`[local-ca] failed to start ${command}: ${error.message}`);
    process.exit(1);
  });
  // Mirror the child's fate rather than always exiting 0: `npm run dev`
  // reporting success after next crashed would hide the failure. This
  // process now has its OWN listener for SIGINT/SIGTERM (below), so
  // re-sending the same signal to ourselves would just re-enter that
  // listener instead of actually terminating -- unlike a process with no
  // listener, where self-sending applies the signal's default (fatal)
  // disposition. Compute the conventional 128+n exit code directly instead.
  child.on("exit", (code, signal) => {
    if (signal) process.exit(128 + (os.constants.signals[signal] ?? 0));
    else process.exit(code ?? 0);
  });

  // Forward the signals a supervisor or `kill <pid>` would send to THIS
  // process on to the real child -- without this, stopping the wrapper
  // (its PID is what `npm run dev` prints and what a supervisor tracks)
  // orphans `next` running underneath it, which keeps holding the port.
  // Known, accepted characteristic on POSIX: a terminal's Ctrl-C also
  // delivers SIGINT to the child directly (it shares the wrapper's
  // foreground process group), so an interactive Ctrl-C can reach the
  // child twice -- once from the terminal, once forwarded here. Next's own
  // SIGINT handling tolerates a repeat signal; this is not guaranteed of
  // every possible child and would need process-group-level control
  // (spawning detached and signalling the group) to close fully.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => child.kill(sig));
  }
}

if (isMainModule(import.meta.url)) main();
/* c8 ignore stop */
