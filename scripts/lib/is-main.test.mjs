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
});
