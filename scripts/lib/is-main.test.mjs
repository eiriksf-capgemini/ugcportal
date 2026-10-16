import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isMainModule } from "./is-main.mjs";

describe("isMainModule", () => {
  it("is true when the module URL matches process.argv[1]", () => {
    const url = pathToFileURL(process.argv[1]).href;
    expect(isMainModule(url)).toBe(true);
  });

  it("is false for an unrelated module URL", () => {
    expect(isMainModule("file:///not/the/entry/point.mjs")).toBe(false);
  });

  it("is false when process.argv[1] is empty (no script path, e.g. a REPL)", () => {
    const original = process.argv[1];
    process.argv[1] = "";
    try {
      expect(isMainModule("file:///anything.mjs")).toBe(false);
    } finally {
      process.argv[1] = original;
    }
  });

  it("is false when both paths exist but are different files", () => {
    // Both realpathSync calls succeed, so only the comparison can answer false.
    const other = pathToFileURL(
      path.resolve(import.meta.dirname, "is-main.mjs"),
    ).href;
    expect(realpathSync(process.argv[1])).not.toBe(
      realpathSync(path.resolve(import.meta.dirname, "is-main.mjs")),
    );
    expect(isMainModule(other)).toBe(false);
  });

  it("is false for an existing sibling module URL while argv[1] is another existing file", () => {
    const original = process.argv[1];
    process.argv[1] = path.resolve(import.meta.dirname, "is-main.mjs");
    try {
      expect(isMainModule(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = original;
    }
  });

  it("is false, not a throw, when the module URL points at a missing file", () => {
    expect(isMainModule("file:///definitely/not/here.mjs")).toBe(false);
  });

  it("runs the entry point through a symlinked directory and through its realpath", () => {
    const root = mkdtempSync(path.join(tmpdir(), "is-main-"));
    try {
      const real = path.join(root, "real");
      const link = path.join(root, "link");
      mkdirSync(real);
      symlinkSync(real, link, "dir");
      const helper = pathToFileURL(
        path.resolve(import.meta.dirname, "is-main.mjs"),
      ).href;
      writeFileSync(
        path.join(real, "fixture.mjs"),
        `import { isMainModule } from ${JSON.stringify(helper)};\n` +
          `if (isMainModule(import.meta.url)) console.log("IS_MAIN_RAN");\n`,
      );
      for (const dir of [link, real, realpathSync(link)]) {
        const out = execFileSync(
          process.execPath,
          [path.join(dir, "fixture.mjs")],
          {
            encoding: "utf8",
          },
        );
        // K2 guardrail: exiting 0 with empty stdout is the failure being pinned.
        expect(out).not.toBe("");
        expect(out).toContain("IS_MAIN_RAN");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
