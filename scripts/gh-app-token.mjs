#!/usr/bin/env node
// Mint a short-lived GitHub App installation token for hal9000-agent[bot],
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
// Tokens expire after 1 hour. Re-run to get a fresh one.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CLIENT_ID = "Iv23liumVwHXyUQYitdf";
const DEFAULT_INSTALLATION_ID = "171866134";
const BOT_LOGIN = "hal9000-agent-bot[bot]";
const BOT_USER_ID = 343198806;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

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

// Returns { code, stdout, stderr }; never touches process state, so tests can
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
      return fail(
        `GitHub returned ${res.status}: ${body.message ?? JSON.stringify(body)}`,
      );
    }
    const out = argv.includes("--env")
      ? buildEnvLines(body.token, body.expires_at).join("\n")
      : body.token;
    return { code: 0, stdout: out + "\n", stderr: "" };
  } catch (err) {
    return fail(String(err.message).split("\n")[0]);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const r = await main({ argv: process.argv.slice(2) });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
