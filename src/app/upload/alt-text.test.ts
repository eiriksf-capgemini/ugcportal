import { describe, expect, it } from "vitest";

import { MAX_ALT_TEXT_LENGTH, MAX_CAPTION_LENGTH } from "@/lib/media-rules";

import { altTextFieldError, captionFieldError } from "./alt-text";

/**
 * This page's own, stricter rule on top of the server's (ugcportal-gwr) —
 * see alt-text.ts's module docstring for why this page requires alt text to
 * add files at all, when POST /api/media itself does not.
 */
describe("altTextFieldError", () => {
  it("blocks on an empty field", () => {
    expect(altTextFieldError("")).toBe("Add alt text before choosing files.");
  });

  it("blocks on whitespace only", () => {
    expect(altTextFieldError("   ")).not.toBeNull();
  });

  it("passes ordinary text", () => {
    expect(altTextFieldError("A fox crossing a snowy field at dawn")).toBeNull();
  });

  it("accepts at exactly the shared length limit (125) and rejects one more (126)", () => {
    expect(altTextFieldError("a".repeat(MAX_ALT_TEXT_LENGTH))).toBeNull();
    expect(
      altTextFieldError("a".repeat(MAX_ALT_TEXT_LENGTH + 1)),
    ).not.toBeNull();
  });

  it("accepts one below the limit too (124)", () => {
    expect(altTextFieldError("a".repeat(MAX_ALT_TEXT_LENGTH - 1))).toBeNull();
  });

  it("blocks a bidi override, the same denylist every other user-typed field uses", () => {
    expect(altTextFieldError(`A fox‮ in a field`)).not.toBeNull();
  });

  it("gives the requiredness message precedence over a length/character message", () => {
    // An empty-after-trim field is "blank", not "too long" — there is no
    // length to complain about yet.
    expect(altTextFieldError("")).toBe("Add alt text before choosing files.");
  });
});

describe("captionFieldError", () => {
  it("has no requiredness rule — absence is fine", () => {
    expect(captionFieldError("")).toBeNull();
  });

  it("accepts at its own, longer limit and rejects one more", () => {
    expect(captionFieldError("c".repeat(MAX_CAPTION_LENGTH))).toBeNull();
    expect(
      captionFieldError("c".repeat(MAX_CAPTION_LENGTH + 1)),
    ).not.toBeNull();
  });

  it("blocks a bidi override", () => {
    expect(captionFieldError(`Caught‮ at dawn`)).not.toBeNull();
  });
});
