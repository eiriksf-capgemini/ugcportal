import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCEPTED_MIME_TYPES as SERVER_ACCEPTED_MIME_TYPES,
  MAX_SIZE_BYTES as SERVER_MAX_SIZE_BYTES,
  validateUpload as serverValidateUpload,
} from "@/lib/media";
import * as clientRules from "@/lib/media-rules";

import { formatBytes } from "./outcomes";
import { UploadForm } from "./upload-form";

/**
 * ugcportal-n3c K4: the client's type list and size caps ARE the server's,
 * not a copy that agrees with them today.
 *
 * The failure this guards against is quiet by construction. A duplicated
 * `10 * 1024 * 1024` in the browser passes every test anyone would write for
 * it, right up until someone raises the server's cap and the upload page goes
 * on refusing files the API would now take — or lowers it, and the page cheers
 * files through to a 413.
 *
 * Two tests, because identity alone is not enough. The first proves the two
 * modules export the same objects. The second mutates the RULES MODULE and
 * proves the rendered form moves with it, which is the only way to show the
 * markup is reading those objects rather than a literal that happens to match.
 */

function accepted(markup: string): string {
  const match = /accept="([^"]*)"/.exec(markup);
  if (match === null) throw new Error("the form rendered no accept attribute");
  return match[1];
}

afterEach(() => {
  vi.doUnmock("@/lib/media-rules");
  vi.resetModules();
});

describe("the client runs the server's rules, not a copy of them", () => {
  it("shares the very objects @/lib/media exports", () => {
    // `toBe`, not `toEqual`: a separate array with the same members would pass
    // an equality check and be exactly the duplication K4 forbids.
    expect(clientRules.ACCEPTED_MIME_TYPES).toBe(SERVER_ACCEPTED_MIME_TYPES);
    expect(clientRules.MAX_SIZE_BYTES).toBe(SERVER_MAX_SIZE_BYTES);
  });

  it("shares the very function the upload route validates with", () => {
    // The strongest form of the guarantee: not the same numbers, the same
    // code. src/app/api/media/route.ts imports this from @/lib/media.
    expect(clientRules.validateUpload).toBe(serverValidateUpload);
  });

  it("derives the file input's accept list from that list", () => {
    const markup = renderToStaticMarkup(<UploadForm />);
    expect(accepted(markup)).toBe(SERVER_ACCEPTED_MIME_TYPES.join(","));
    // Sanity: the list is not empty, or the assertion above is vacuous.
    expect(SERVER_ACCEPTED_MIME_TYPES.length).toBeGreaterThan(0);
  });

  it("prints the real caps in the hint under the drop zone", () => {
    const markup = renderToStaticMarkup(<UploadForm />);
    expect(markup).toContain(formatBytes(SERVER_MAX_SIZE_BYTES.IMAGE));
    expect(markup).toContain(formatBytes(SERVER_MAX_SIZE_BYTES.VIDEO));
  });

  it("follows the rules module when the rules module changes", async () => {
    /*
      THE FIXTURE MUTATION. Everything above is consistent with the form
      holding its own hardcoded copy that happens to match. So: replace the
      rules module with different types and different caps, re-import the
      form, and require the markup to have moved. If any of it were typed in
      by hand, this fails.
    */
    const real =
      await vi.importActual<typeof import("@/lib/media-rules")>(
        "@/lib/media-rules",
      );

    vi.resetModules();
    vi.doMock("@/lib/media-rules", () => ({
      ...real,
      ACCEPTED_MIME_TYPES: Object.freeze(["image/avif"]),
      MAX_SIZE_BYTES: { IMAGE: 3 * 1024 * 1024, VIDEO: 7 * 1024 * 1024 },
      kindForDeclaredType: (mimeType: string) =>
        mimeType === "image/avif" ? "IMAGE" : undefined,
    }));

    const { UploadForm: MutatedForm } = await import("./upload-form");
    const markup = renderToStaticMarkup(<MutatedForm />);

    expect(accepted(markup)).toBe("image/avif");
    expect(markup).toContain("AVIF up to 3 MB");
    expect(markup).toContain("up to 7 MB");
    // And the real values are gone, which is what says nothing was hardcoded.
    expect(markup).not.toContain("image/jpeg");
    expect(markup).not.toContain(formatBytes(SERVER_MAX_SIZE_BYTES.VIDEO));
  });
});
