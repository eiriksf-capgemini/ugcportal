#!/usr/bin/env node
// Mint a short-lived GitHub App installation token for hal9000-agent-bot[bot],
// the separate identity subagents use so their PRs, reviews and commits are
// not attributed to a human account.
//
// Usage:
//   node scripts/gh-app-token.mjs            # prints the token
//   node scripts/gh-app-token.mjs --env      # prints `export` lines for eval
//   eval "$(node scripts/gh-app-token.mjs --env)"
//
// Env overrides (defaults are this repo's app):
//   GH_APP_CLIENT_ID          app client id (or numeric app id)
//   GH_APP_INSTALLATION_ID    installation id on eiriksf-capgemini
//   GH_APP_PRIVATE_KEY_PATH   PEM file, default ./hal9000.pem (gitignored)
//
// GitHub sets the token's expiry (see the `# expires` line under --env). Re-run to get a fresh one.
import { createSign } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CLIENT_ID = "Iv23liumVwHXyUQYitdf";
const DEFAULT_INSTALLATION_ID = "171866134";
const BOT_LOGIN = "hal9000-agent-bot[bot]";
const BOT_USER_ID = 343198806;

// Allowlist for the token spliced into `eval`-ed export lines. '.' is safe
// there: the shell does no expansion on it, it does not split words, and it is
// not a comment character. Real installation tokens need it: as observed on
// 2026-10-16 they are 383 characters, shaped ghs_<...>_<...>.<...>.<...> with
// exactly two '.' (a JWT-like suffix).
const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Only a non-empty string token is redacted: replaceAll("") would interleave
// the marker between every character.
const redact = (text, token) =>
  typeof token === "string" && token !== ""
    ? text.replaceAll(token, "[redacted]")
    : text;

export function mintJwt(pem, clientId, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(pem))}`;
}

export function buildEnvLines(token, expiresAt) {
  const email = `${BOT_USER_ID}+${BOT_LOGIN}@users.noreply.github.com`;
  return [
    `export GH_TOKEN=${token}`,
    `export GITHUB_TOKEN=${token}`,
    `export GIT_AUTHOR_NAME='${BOT_LOGIN}'`,
    `export GIT_AUTHOR_EMAIL='${email}'`,
    `export GIT_COMMITTER_NAME='${BOT_LOGIN}'`,
    `export GIT_COMMITTER_EMAIL='${email}'`,
    `# expires ${expiresAt}`,
  ];
}

// Returns { code, stdout, stderr }; does not write to process.stdout, process.stderr or call process.exit, so tests can
// drive it with a stubbed fetch.
export async function main({
  fetch: fetchFn = fetch,
  argv = [],
  env = process.env,
} = {}) {
  const clientId = env.GH_APP_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const installationId = env.GH_APP_INSTALLATION_ID ?? DEFAULT_INSTALLATION_ID;
  const keyPath = resolve(env.GH_APP_PRIVATE_KEY_PATH ?? "hal9000.pem");
  const fail = (msg) => ({
    code: 1,
    stdout: "",
    stderr: `gh-app-token: ${msg}\n`,
  });
  let pem;
  try {
    pem = readFileSync(keyPath, "utf8");
  } catch (err) {
    return fail(`cannot read private key at ${keyPath}: ${err.message}`);
  }
  try {
    const res = await fetchFn(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mintJwt(pem, clientId)}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    const body = await res.json();
    if (!res.ok || !body.token) {
      // Never print the raw body: a non-2xx body may still carry a token.
      const msg =
        typeof body.message === "string"
          ? `: ${redact(body.message.split("\n")[0], body.token)}`
          : "";
      return fail(`GitHub returned ${res.status}${msg}`);
    }
    // The token and expiry are spliced into lines meant for eval; accept only
    // shapes that cannot carry shell syntax, and never echo a rejected value.
    if (!TOKEN_PATTERN.test(body.token)) {
      return fail("GitHub returned a token with unexpected characters");
    }
    if (argv.includes("--env") && !EXPIRY_PATTERN.test(body.expires_at)) {
      return fail("GitHub returned an expires_at that is not ISO-8601");
    }
    const out = argv.includes("--env")
      ? buildEnvLines(body.token, body.expires_at).join("\n")
      : body.token;
    return { code: 0, stdout: out + "\n", stderr: "" };
  } catch (err) {
    return fail(String(err.message).split("\n")[0]);
  }
}

// Compare realpaths on both sides: import.meta.url is already symlink-resolved,
// process.argv[1] is not (/tmp -> /private/tmp on macOS).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const r = await main({ argv: process.argv.slice(2) });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
