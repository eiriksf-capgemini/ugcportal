/**
 * Tests for the local-CA resolver (ugcportal-drt1).
 *
 * These use real directories under a temp root rather than a mocked fs: the
 * behaviour under test IS filesystem behaviour (a missing directory, a
 * non-file entry that ends in .pem, several files needing concatenation), and
 * a mock would let the resolver pass while the real thing failed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveLocalCa } from "./with-local-ca.mjs";

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
    expect(result.warning).toContain("does not exist");
  });

  it("falls back to the certs directory when the value is blank", () => {
    const file = write("certs/corp.pem", CERT_A);
    expect(resolve({ NODE_EXTRA_CA_CERTS: "   " }).path).toBe(file);
  });
});
