import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TOKEN_ENCRYPTION_KEY_ENV,
  decryptSecret,
  encryptSecret,
  safeEquals,
} from "@/lib/crypto";

const KEY = randomBytes(32).toString("base64");
const originalKey = process.env[TOKEN_ENCRYPTION_KEY_ENV];

beforeEach(() => {
  process.env[TOKEN_ENCRYPTION_KEY_ENV] = KEY;
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env[TOKEN_ENCRYPTION_KEY_ENV];
  } else {
    process.env[TOKEN_ENCRYPTION_KEY_ENV] = originalKey;
  }
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a token", () => {
    const token = "IGQVJYS0me-long-lived-token";
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it("never stores the plaintext in the envelope", () => {
    const token = "IGQVJYS0me-long-lived-token";
    const envelope = encryptSecret(token);

    expect(envelope).not.toContain(token);
    // Each base64url segment must also not decode back to the plaintext.
    for (const part of envelope.split(".").slice(1)) {
      expect(Buffer.from(part, "base64url").toString("utf8")).not.toContain(token);
    }
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same-token")).not.toBe(encryptSecret("same-token"));
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const envelope = encryptSecret("token");
    const [version, iv, tag, ciphertext] = envelope.split(".");
    const flipped = Buffer.from(ciphertext, "base64url");
    flipped[0] ^= 0xff;

    expect(() =>
      decryptSecret([version, iv, tag, flipped.toString("base64url")].join(".")),
    ).toThrow();
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptSecret("not-an-envelope")).toThrow(
      /Malformed encrypted secret envelope/,
    );
    expect(() => decryptSecret("v2.a.b.c")).toThrow(
      /Malformed encrypted secret envelope/,
    );
  });

  it("cannot be decrypted with a different key", () => {
    const envelope = encryptSecret("token");
    process.env[TOKEN_ENCRYPTION_KEY_ENV] = randomBytes(32).toString("base64");

    expect(() => decryptSecret(envelope)).toThrow();
  });

  it("fails loudly when the key is missing or the wrong length", () => {
    delete process.env[TOKEN_ENCRYPTION_KEY_ENV];
    expect(() => encryptSecret("token")).toThrow(
      new RegExp(`Missing required environment variable: ${TOKEN_ENCRYPTION_KEY_ENV}`),
    );

    process.env[TOKEN_ENCRYPTION_KEY_ENV] = randomBytes(16).toString("base64");
    expect(() => encryptSecret("token")).toThrow(/must decode to 32 bytes/);
  });
});

describe("safeEquals", () => {
  it("matches equal strings and rejects everything else", () => {
    expect(safeEquals("abc", "abc")).toBe(true);
    expect(safeEquals("abc", "abd")).toBe(false);
    expect(safeEquals("abc", "abcd")).toBe(false);
    expect(safeEquals("", "")).toBe(true);
  });
});
