/**
 * Tests for the local-CA resolver (ugcportal-drt1).
 *
 * These use real directories under a temp root rather than a mocked fs: the
 * behaviour under test IS filesystem behaviour (a missing directory, a
 * non-file entry that ends in .pem, several files needing concatenation), and
 * a mock would let the resolver pass while the real thing failed.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveLocalCa } from "./with-local-ca.mjs";

const WRAPPER = fileURLToPath(new URL("./with-local-ca.mjs", import.meta.url));

/** @type {string} */
let root;

const CERT_A = "-----BEGIN CERTIFICATE-----\nAAAA-first\n-----END CERTIFICATE-----";
const CERT_B = "-----BEGIN CERTIFICATE-----\nBBBB-second\n-----END CERTIFICATE-----";

function write(relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ugcportal-ca-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const resolve = (env = {}) => resolveLocalCa({ certsDir: "certs", env, cwd: root });

describe("no local CA configured", () => {
  it("is silent when the certs directory does not exist", () => {
    expect(resolve()).toEqual({ path: null, source: "none", warning: null });
  });

  it("warns rather than staying silent when certs/ exists but isn't readable", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      // chmod-based permission denial isn't reliable on Windows, and root
      // bypasses permission checks entirely -- skip rather than flake.
      return;
    }
    const dir = path.join(root, "certs");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "corp.pem"), CERT_A);
    fs.chmodSync(dir, 0o000);
    try {
      const result = resolve();
      expect(result.path).toBeNull();
      expect(result.warning).toContain("Could not read");
    } finally {
      fs.chmodSync(dir, 0o755); // afterEach's rmSync needs it readable again
    }
  });

  it("is silent when the certs directory exists but holds no PEM", () => {
    write("certs/README.md", "not a certificate");
    expect(resolve()).toEqual({ path: null, source: "none", warning: null });
  });

  it("ignores a directory that merely ends in .pem", () => {
    fs.mkdirSync(path.join(root, "certs", "nested.pem"), { recursive: true });
    expect(resolve().path).toBeNull();
  });
});

describe("certs directory", () => {
  it("uses a single PEM, as an absolute path", () => {
    const file = write("certs/corp.pem", CERT_A);
    const result = resolve();
    expect(result).toEqual({ path: file, source: "single", warning: null });
    expect(path.isAbsolute(result.path)).toBe(true);
  });

  it("concatenates every PEM when there is more than one", () => {
    write("certs/a-root.pem", CERT_A);
    write("certs/b-intermediate.pem", CERT_B);

    const result = resolve();
    expect(result.source).toBe("bundle");

    const bundle = fs.readFileSync(result.path, "utf8");
    // Both needles matter: a resolver that returned only the first PEM — the
    // obvious wrong implementation, since NODE_EXTRA_CA_CERTS takes one path
    // — passes the CERT_A assertion and fails this one.
    expect(bundle).toContain("AAAA-first");
    expect(bundle).toContain("BBBB-second");
    expect(bundle.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
  });

  it("warns, rather than silently building a partial bundle, when a PEM vanishes mid-run", () => {
    write("certs/a-root.pem", CERT_A);
    const bPath = write("certs/b-intermediate.pem", CERT_B);
    const realReadFileSync = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((file, ...rest) => {
      if (file === bPath) throw Object.assign(new Error("ENOENT (simulated)"), { code: "ENOENT" });
      return realReadFileSync(file, ...rest);
    });
    try {
      const result = resolve();
      expect(result.source).toBe("bundle");
      expect(result.warning).toContain("disappeared");
      expect(result.warning).toContain(bPath);
      const bundle = fs.readFileSync(result.path, "utf8");
      expect(bundle).toContain("AAAA-first");
      expect(bundle).not.toContain("BBBB-second");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to none, rather than writing an empty bundle, when every PEM vanishes mid-run", () => {
    const aPath = write("certs/a-root.pem", CERT_A);
    const bPath = write("certs/b-intermediate.pem", CERT_B);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT (simulated)"), { code: "ENOENT" });
    });
    try {
      const result = resolve();
      expect(result).toEqual({
        path: null,
        source: "none",
        warning: expect.stringContaining("disappeared"),
      });
      expect(result.warning).toContain(aPath);
      expect(result.warning).toContain(bPath);
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to none, rather than a false success, when the single PEM vanishes right before use", () => {
    const file = write("certs/corp.pem", CERT_A);
    const spy = vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT (simulated)"), { code: "ENOENT" });
    });
    try {
      const result = resolve();
      expect(result.path).toBeNull();
      expect(result.source).toBe("none");
      expect(result.warning).toContain(file);
    } finally {
      spy.mockRestore();
    }
  });

  it("removes a leftover bundle once certs/ is emptied, rather than leaving stale CA material behind", () => {
    write("certs/a-root.pem", CERT_A);
    write("certs/b-intermediate.pem", CERT_B);
    const bundlePath = resolve().path;
    expect(fs.existsSync(bundlePath)).toBe(true);

    fs.rmSync(path.join(root, "certs"), { recursive: true, force: true });
    expect(resolve()).toEqual({ path: null, source: "none", warning: null });
    expect(fs.existsSync(bundlePath)).toBe(false);
  });

  it("removes a leftover multi-PEM bundle once certs/ drops to exactly one PEM", () => {
    const bPath = write("certs/b-intermediate.pem", CERT_B);
    write("certs/a-root.pem", CERT_A);
    const bundlePath = resolve().path;
    expect(fs.existsSync(bundlePath)).toBe(true);

    // A cert rotation/removal down to a single remaining PEM -- the old
    // bundle (which still contains the removed cert's content) must not
    // be left behind at its predictable path once it's no longer what
    // gets used.
    fs.rmSync(bPath);
    const result = resolve();
    expect(result.source).toBe("single");
    expect(fs.existsSync(bundlePath)).toBe(false);
  });

  it("does not silently follow a pre-existing file at the bundle's predictable temp-write path", () => {
    write("certs/a-root.pem", CERT_A);
    write("certs/b-intermediate.pem", CERT_B);

    const dir = path.resolve(root, "certs");
    const bundlePath = path.join(
      os.tmpdir(),
      `ugcportal-local-ca-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}.pem`,
    );
    const tmpPath = path.join(os.tmpdir(), `.${path.basename(bundlePath)}.${process.pid}.tmp`);
    fs.writeFileSync(tmpPath, "pre-placed content, e.g. a symlink target in the real attack");
    try {
      // `wx` fails on an existing path rather than silently overwriting or
      // following it -- the correct fail-CLOSED response to a plausible
      // symlink-planting attempt at a predictable, PID-based name.
      expect(() => resolve()).toThrow();
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  });

  it("rewrites the bundle when the certs change between runs", () => {
    write("certs/a-root.pem", CERT_A);
    write("certs/b-intermediate.pem", CERT_B);
    const first = resolve().path;

    fs.writeFileSync(path.join(root, "certs", "b-intermediate.pem"), CERT_B.replace("BBBB-second", "CCCC-rotated"));
    const second = resolve().path;

    expect(second).toBe(first);
    expect(fs.readFileSync(second, "utf8")).toContain("CCCC-rotated");
    expect(fs.readFileSync(second, "utf8")).not.toContain("BBBB-second");
  });

  it("skips non-PEM files sitting alongside", () => {
    write("certs/notes.txt", "ignore me");
    const file = write("certs/corp.pem", CERT_A);
    expect(resolve().path).toBe(file);
  });

  it("replaces, rather than trusts, anything already at the bundle's well-known path", () => {
    write("certs/a-root.pem", CERT_A);
    write("certs/b-intermediate.pem", CERT_B);

    // Predict the deterministic bundle path the same way the resolver
    // computes it, and pre-place a wrong-content, wrong-mode file there --
    // simulating a stale or maliciously-planted file at a predictable
    // /tmp path (round-1 review finding: a non-atomic write trusted
    // whatever was already there).
    const dir = path.resolve(root, "certs");
    const bundlePath = path.join(
      os.tmpdir(),
      `ugcportal-local-ca-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}.pem`,
    );
    fs.writeFileSync(bundlePath, "PLANTED-GARBAGE", { mode: 0o644 });

    const result = resolve();
    expect(result.path).toBe(bundlePath);
    const content = fs.readFileSync(bundlePath, "utf8");
    expect(content).not.toContain("PLANTED-GARBAGE");
    expect(content).toContain("AAAA-first");
    expect(content).toContain("BBBB-second");
    expect(fs.statSync(bundlePath).mode & 0o777).toBe(0o600);
  });
});

describe("explicit NODE_EXTRA_CA_CERTS", () => {
  it("wins over the certs directory", () => {
    write("certs/corp.pem", CERT_A);
    const chosen = write("elsewhere/chosen.pem", CERT_B);

    const result = resolve({ NODE_EXTRA_CA_CERTS: chosen });
    expect(result).toEqual({ path: chosen, source: "env", warning: null });
  });

  it("resolves a relative value against cwd rather than passing it through", () => {
    const chosen = write("elsewhere/chosen.pem", CERT_B);
    const result = resolve({ NODE_EXTRA_CA_CERTS: "./elsewhere/chosen.pem" });
    expect(result.path).toBe(chosen);
    expect(result.warning).toBeNull();
  });

  it("warns when the named file does not exist, instead of failing silently", () => {
    const result = resolve({ NODE_EXTRA_CA_CERTS: "./missing/none.pem" });
    expect(result.source).toBe("env");
    expect(result.warning).toContain("not a readable file");
    // A known-bad path must not still be forwarded to the child -- that
    // would trade this warning for a second, differently-formatted
    // Node-level one instead of a clean fallback to the default trust store.
    expect(result.path).toBeNull();
  });

  it("warns when the named path is a directory, not a file", () => {
    const dir = path.join(root, "elsewhere", "not-a-file.pem");
    fs.mkdirSync(dir, { recursive: true });
    const result = resolve({ NODE_EXTRA_CA_CERTS: dir });
    expect(result.warning).toContain("not a readable file");
    expect(result.path).toBeNull();
  });

  it("falls back to the certs directory when the value is blank", () => {
    const file = write("certs/corp.pem", CERT_A);
    expect(resolve({ NODE_EXTRA_CA_CERTS: "   " }).path).toBe(file);
  });
});

describe("main() child process env (ugcportal-5g9t)", () => {
  // These spawn the real wrapper script, rather than calling resolveLocalCa()
  // directly with a parameter -- the bug this guards against was in main()'s
  // own env-forwarding logic, specifically with NODE_EXTRA_CA_CERTS already
  // present in the *ambient* shell environment before the wrapper runs (as
  // opposed to only ever passed as a function argument in a test). A unit
  // test that only exercises resolveLocalCa() would pass before this fix
  // existed, same as it did for ugcportal-drt1/PR gh-61.
  it("does not forward an explicit NODE_EXTRA_CA_CERTS that didn't resolve to a readable file", () => {
    const output = execFileSync(
      process.execPath,
      [WRAPPER, process.execPath, "-e", "process.stdout.write(String(process.env.NODE_EXTRA_CA_CERTS))"],
      {
        cwd: root,
        env: { ...process.env, NODE_EXTRA_CA_CERTS: "./certs/does-not-exist.pem" },
        encoding: "utf8",
      },
    );
    // String(undefined) -- the child's own NODE_EXTRA_CA_CERTS key must be
    // entirely absent, not merely falsy/empty, so this must read "undefined"
    // literally rather than e.g. "" (which `env.X = ""` would also produce).
    expect(output.trim()).toBe("undefined");
  });

  it("still forwards a resolved explicit NODE_EXTRA_CA_CERTS unchanged", () => {
    const chosen = write("elsewhere/chosen.pem", CERT_A);
    const output = execFileSync(
      process.execPath,
      [WRAPPER, process.execPath, "-e", "process.stdout.write(process.env.NODE_EXTRA_CA_CERTS ?? '')"],
      {
        cwd: root,
        env: { ...process.env, NODE_EXTRA_CA_CERTS: "./elsewhere/chosen.pem" },
        encoding: "utf8",
      },
    );
    // Compare via realpath: spawning a child with `cwd` set to a path under
    // macOS's /tmp (a symlink to /private/tmp) reports its own cwd pre-
    // resolved through that symlink, which a plain string comparison against
    // `root` would then spuriously fail on.
    expect(fs.realpathSync(output.trim())).toBe(fs.realpathSync(chosen));
  });
});
