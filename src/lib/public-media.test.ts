import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MEDIA_PREVIEW_PATH,
  PUBLIC_MEDIA_PATH,
  mediaPreviewPath,
  publicMediaListingPath,
} from "@/lib/routes";

/**
 * The seams between the gallery and the two routes it depends on
 * (ugcportal-71y).
 *
 * `listPublicMedia` itself is exercised end to end against a real database in
 * src/app/page.test.tsx — that is where the scope and the cursor contract are
 * checked. What is left here is the part no runtime test reaches: that the
 * paths these constants name are the paths the App Router actually serves, and
 * that the query the browser writes is the query the server reads.
 */

const SRC = path.resolve(process.cwd(), "src");

describe("the named routes are the routes that exist", () => {
  /*
   * A string constant naming a URL is only as good as the file behind it, and
   * nothing else in the suite would notice the two parting company: moving or
   * renaming a route directory leaves every unit test green and every image in
   * the gallery a 404. The App Router maps path segments to directories
   * literally, so the check is a directory lookup.
   */
  it.each([
    { name: "the public feed", url: PUBLIC_MEDIA_PATH, file: "route.ts" },
    {
      name: "preview delivery",
      url: `${MEDIA_PREVIEW_PATH}/[previewId]`,
      file: "route.ts",
    },
  ])("$name is served from the directory its constant names", ({ url, file }) => {
    expect(existsSync(path.join(SRC, "app", url, file))).toBe(true);
  });

  it("points the gallery at the PUBLIC feed, not the owner-scoped one", () => {
    // GET /api/media deliberately returns the caller's own unpublished rows.
    // Reaching for it here would walk straight through everything the
    // anonymous scope in src/lib/media-listing.ts structurally enforces.
    expect(PUBLIC_MEDIA_PATH).toBe("/api/public/media");
    expect(publicMediaListingPath()).toBe("/api/public/media");

    const gallery = readFileSync(
      path.join(SRC, "components", "gallery", "gallery.tsx"),
      "utf8",
    );
    expect(gallery).not.toMatch(/["'`]\/api\/media(?:\?|["'`])/);
  });

  it("keeps the server's module graph out of the client bundle", () => {
    // The gallery is a "use client" component. Importing @/lib/public-media
    // from it pulls media-access, and through that @/lib/auth and
    // @/lib/prisma, across the client boundary — which is why the listing
    // path builder lives in @/lib/routes, a module that imports nothing.
    const gallery = readFileSync(
      path.join(SRC, "components", "gallery", "gallery.tsx"),
      "utf8",
    );
    expect(gallery).toContain('"use client"');
    for (const forbidden of [
      "@/lib/public-media",
      "@/lib/prisma",
      "@/lib/auth",
      "@/lib/media-access",
      "@/lib/media-listing",
    ]) {
      expect(gallery, `${forbidden} must not reach the client`).not.toContain(
        `from "${forbidden}"`,
      );
    }
  });
});

describe("publicMediaListingPath", () => {
  it("writes the parameters the listing reads", () => {
    const query = new URL(
      publicMediaListingPath({ limit: 24, cursor: "abc" }),
      "http://gallery.test",
    ).searchParams;
    expect(query.get("limit")).toBe("24");
    expect(query.get("cursor")).toBe("abc");
  });

  it("round-trips a cursor containing characters a URL would otherwise eat", () => {
    // encodeMediaCursor emits base64url, so `+` and `=` should not appear —
    // but the client does not get to assume that about an opaque value it was
    // handed. An unescaped `+` decodes as a space and the endpoint answers
    // 400, which looks like a server fault and is not one.
    const cursor = "a+b/c=d&e?f";
    const query = new URL(
      publicMediaListingPath({ cursor }),
      "http://gallery.test",
    ).searchParams;
    expect(query.get("cursor")).toBe(cursor);
  });

  it("omits parameters it was not given, rather than sending empty ones", () => {
    // `?cursor=` is treated as absent by the listing, but `?limit=` is not
    // worth relying on: an empty parameter is a claim the caller did not make.
    expect(publicMediaListingPath()).not.toContain("?");
    expect(publicMediaListingPath({ limit: 5 })).not.toContain("cursor");
    expect(publicMediaListingPath({ cursor: "c" })).not.toContain("limit");
  });
});

describe("mediaPreviewPath", () => {
  it("addresses the preview by its opaque handle", () => {
    expect(mediaPreviewPath("pv-1")).toBe(`${MEDIA_PREVIEW_PATH}/pv-1`);
  });

  it("cannot be talked into another route by the id it is given", () => {
    expect(mediaPreviewPath("../../../admin")).toBe(
      `${MEDIA_PREVIEW_PATH}/..%2F..%2F..%2Fadmin`,
    );
  });
});
