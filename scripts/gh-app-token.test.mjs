import {
  createPublicKey,
  createVerify,
  randomInt,
  generateKeyPairSync,
} from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildEnvLines, main, mintJwt } from "./gh-app-token.mjs";

let pem;
let keyPath;
let publicPem;
beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  pem = privateKey.export({ type: "pkcs8", format: "pem" });
  publicPem = publicKey.export({ type: "spki", format: "pem" });
  keyPath = join(mkdtempSync(join(tmpdir(), "gh-app-token-")), "throwaway.pem");
  writeFileSync(keyPath, pem);
});

const decode = (part) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const stubFetch =
  (status, body, calls = []) =>
  async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const rand = (n) =>
  Array.from({ length: n }, () => BASE62[randomInt(BASE62.length)]).join("");
// Real-shaped, random fixture (never a recorded token): 383 chars, ghs_ prefix,
// exactly two '.', several '_' and '-'. Shape observed 2026-10-16.
export function realShapedToken() {
  const head = `ghs_${rand(20)}_${rand(10)}-${rand(8)}_${rand(10)}`;
  const mid = `${rand(60)}-${rand(30)}_${rand(20)}`;
  const fixed = head.length + mid.length + 2;
  return `${head}.${mid}.${rand(383 - fixed)}`;
}
const REAL_TOKEN = realShapedToken();
const okBody = {
  token: REAL_TOKEN,
  expires_at: "2026-10-16T12:00:00Z",
};
const envOf = (extra = {}) => ({ GH_APP_PRIVATE_KEY_PATH: keyPath, ...extra });

describe("mintJwt", () => {
  it("has three parts, RS256 header, iss = client id, 600s lifetime, valid signature", () => {
    const jwt = mintJwt(pem, "client-xyz", 1_800_000_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    expect(decode(parts[0])).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = decode(parts[1]);
    expect(payload.iss).toBe("client-xyz");
    expect(payload.exp - payload.iat).toBe(600);
    expect(payload.iat).toBe(1_800_000_000 - 60);
    const v = createVerify("RSA-SHA256");
    v.update(`${parts[0]}.${parts[1]}`);
    expect(
      v.verify(createPublicKey(publicPem), Buffer.from(parts[2], "base64url")),
    ).toBe(true);
  });
});

describe("real-shaped fixture", () => {
  it("has the observed shape: 383 chars, ghs_ prefix, exactly two dots", () => {
    expect(REAL_TOKEN).toHaveLength(383);
    expect(REAL_TOKEN.startsWith("ghs_")).toBe(true);
    expect(REAL_TOKEN.split(".")).toHaveLength(3);
    expect(REAL_TOKEN.match(/_/g).length).toBeGreaterThan(2);
    expect(REAL_TOKEN).toContain("-");
  });
});

describe("main", () => {
  it("accepts a real-shaped token in plain mode and --env mode, unchanged", async () => {
    const plain = await main({
      fetch: stubFetch(201, okBody),
      argv: [],
      env: envOf(),
    });
    expect(plain).toEqual({ code: 0, stdout: `${REAL_TOKEN}\n`, stderr: "" });
    const env = await main({
      fetch: stubFetch(201, okBody),
      argv: ["--env"],
      env: envOf(),
    });
    expect(env.code).toBe(0);
    expect(env.stdout.split("\n")).toContain(`export GH_TOKEN=${REAL_TOKEN}`);
    expect(env.stdout.split("\n")).toContain(
      `export GITHUB_TOKEN=${REAL_TOKEN}`,
    );
  });

  it("--env prints exactly the export lines plus an expiry comment", async () => {
    const calls = [];
    const r = await main({
      fetch: stubFetch(201, okBody, calls),
      argv: ["--env"],
      env: envOf(),
    });
    const email = "343198806+hal9000-agent-bot[bot]@users.noreply.github.com";
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toEqual([
      `export GH_TOKEN=${REAL_TOKEN}`,
      `export GITHUB_TOKEN=${REAL_TOKEN}`,
      "export GIT_AUTHOR_NAME='hal9000-agent-bot[bot]'",
      `export GIT_AUTHOR_EMAIL='${email}'`,
      "export GIT_COMMITTER_NAME='hal9000-agent-bot[bot]'",
      `export GIT_COMMITTER_EMAIL='${email}'`,
      "# expires 2026-10-16T12:00:00Z",
      "",
    ]);
    expect(buildEnvLines("t", "e")).toHaveLength(7);
  });

  it("plain mode prints only the token and honours env overrides", async () => {
    const calls = [];
    const r = await main({
      fetch: stubFetch(201, okBody, calls),
      argv: [],
      env: envOf({ GH_APP_INSTALLATION_ID: "42", GH_APP_CLIENT_ID: "cid" }),
    });
    expect(r).toEqual({ code: 0, stdout: `${REAL_TOKEN}\n`, stderr: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(calls[0].init.method).toBe("POST");
    const jwt = calls[0].init.headers.Authorization.replace("Bearer ", "");
    expect(decode(jwt.split(".")[1]).iss).toBe("cid");
  });

  it("missing key: exit 1, empty stdout, gh-app-token: one-line stderr, no fetch", async () => {
    const calls = [];
    const r = await main({
      fetch: stubFetch(201, okBody, calls),
      argv: ["--env"],
      env: {
        GH_APP_PRIVATE_KEY_PATH: join(tmpdir(), "does-not-exist-3ssw.pem"),
      },
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.startsWith("gh-app-token:")).toBe(true);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("non-2xx (401): exit 1, empty stdout, gh-app-token: stderr naming the status", async () => {
    const r = await main({
      fetch: stubFetch(401, {
        message: "Bad credentials",
        token: "ghs_LEAKME401",
      }),
      argv: ["--env"],
      env: envOf(),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.startsWith("gh-app-token:")).toBe(true);
    expect(r.stderr).toContain("401");
    expect(r.stderr + r.stdout).not.toContain("ghs_LEAKME401");
  });

  it("a non-2xx response is a failure even if its body carries a token", async () => {
    const r = await main({
      fetch: stubFetch(403, okBody),
      argv: [],
      env: envOf(),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("403");
    expect(r.stderr + r.stdout).not.toContain(REAL_TOKEN);
  });

  it("a 403 with an empty-string token keeps its message intact", async () => {
    const r = await main({
      fetch: stubFetch(403, { message: "Nope", token: "" }),
      argv: [],
      env: envOf(),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("gh-app-token: GitHub returned 403: Nope\n");
  });

  it("a 403 whose message echoes the token never prints it", async () => {
    const r = await main({
      fetch: stubFetch(403, {
        message: `bad ${REAL_TOKEN} here`,
        token: REAL_TOKEN,
      }),
      argv: [],
      env: envOf(),
    });
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).not.toContain(REAL_TOKEN);
  });

  it.each([
    [
      "a token containing ;",
      { token: "ghs_x; rm -rf ~", expires_at: "2026-10-16T12:00:00Z" },
    ],
    [
      "a token containing a newline",
      { token: "ghs_x\nexport EVIL=1", expires_at: "2026-10-16T12:00:00Z" },
    ],
    [
      "a token containing $",
      { token: "ghs_x$HOME", expires_at: "2026-10-16T12:00:00Z" },
    ],
    [
      "a token containing a backtick",
      { token: "ghs_x`id`", expires_at: "2026-10-16T12:00:00Z" },
    ],
    [
      "a token containing a single quote",
      { token: "ghs_x'y", expires_at: "2026-10-16T12:00:00Z" },
    ],
    [
      "a token containing a double quote",
      { token: 'ghs_x"y', expires_at: "2026-10-16T12:00:00Z" },
    ],
    [
      "a token containing a space",
      { token: "ghs_x y", expires_at: "2026-10-16T12:00:00Z" },
    ],
    [
      "a token containing a backslash",
      { token: "ghs_x\\y", expires_at: "2026-10-16T12:00:00Z" },
    ],
    [
      "an expires_at containing a newline",
      { token: "ghs_ok", expires_at: "2026-10-16T12:00:00Z\nexport EVIL=1" },
    ],
    ["a non-ISO expires_at", { token: "ghs_ok", expires_at: "$(id)" }],
  ])("--env rejects %s and writes nothing to stdout", async (_name, body) => {
    const r = await main({
      fetch: stubFetch(201, body),
      argv: ["--env"],
      env: envOf(),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.startsWith("gh-app-token:")).toBe(true);
    expect(r.stderr).not.toContain("EVIL");
    expect(r.stderr).not.toContain("rm -rf");
  });

  it("2xx without a token still fails loudly", async () => {
    const r = await main({ fetch: stubFetch(200, {}), argv: [], env: envOf() });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
  });
});

const trackedFiles = (cwd) =>
  execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  })
    .split("\0")
    .filter(Boolean);
const pemFiles = (files) =>
  files.filter((f) => f.toLowerCase().endsWith(".pem"));

describe("entry guard", () => {
  it(
    "runs main when invoked through a symlinked directory",
    { timeout: 30_000 },
    () => {
      const real = mkdtempSync(join(tmpdir(), "gh-app-token-real-"));
      const link = join(
        mkdtempSync(join(tmpdir(), "gh-app-token-link-")),
        "scripts",
      );
      symlinkSync(dirname(fileURLToPath(import.meta.url)), link);
      const res = spawnSync(
        process.execPath,
        [join(link, "gh-app-token.mjs")],
        {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            GH_APP_PRIVATE_KEY_PATH: join(real, "absent.pem"),
          },
        },
      );
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr.startsWith("gh-app-token:")).toBe(true);
    },
  );
});

describe("K4: no private key is ever tracked", () => {
  // git ls-files reads the whole index; 30s is the inherent-cost ceiling.
  it("git ls-files contains no .pem file", { timeout: 30_000 }, () => {
    const files = trackedFiles(process.cwd());
    expect(files.length).toBeGreaterThan(100); // proves the listing was read
    expect(pemFiles(files)).toEqual([]);
  });

  it(
    "the listing sees a tracked non-ASCII .pem name",
    { timeout: 30_000 },
    () => {
      const repo = mkdtempSync(join(tmpdir(), "gh-app-token-repo-"));
      // Isolate from the machine: no global config or excludes (a global
      // gitignore listing *.pem would otherwise hide the file).
      const opts = {
        cwd: repo,
        timeout: 20_000,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      };
      execFileSync("git", ["init", "-q"], opts);
      writeFileSync(join(repo, "ø-key.pem"), "x");
      execFileSync("git", ["add", "-f", "."], opts);
      expect(pemFiles(trackedFiles(repo))).toEqual(["ø-key.pem"]);
    },
  );

  it("the pem filter itself flags a tracked key, at any depth and case", () => {
    expect(pemFiles(["a.txt", "hal9000.pem", "x/y/KEY.PEM"])).toEqual([
      "hal9000.pem",
      "x/y/KEY.PEM",
    ]);
  });
});
