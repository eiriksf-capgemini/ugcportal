// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_PATH } from "@/lib/routes";

/**
 * ugcportal-t0y round 4. This needs a real DOM and a real client root, not
 * `renderToStaticMarkup` in the suite's default node environment: the
 * property under test — that `aria-current` updates on a CLIENT-SIDE
 * navigation, without a remount — cannot be observed from a single static
 * render at all. jsdom is pinned at ^26 deliberately (breaks on CI's Node 20
 * at 30, per src/components/gallery/gallery.unmount.test.tsx's own note);
 * this is this repo's third file needing the pragma, not its first.
 *
 * Mocks `next/navigation`'s `usePathname` directly, rather than reaching
 * into Next's internal `PathnameContext` (unexported from any public entry
 * point) to drive it via a Provider — this is the same approach
 * src/app/upload/page.test.tsx and others take for `next/navigation`'s
 * `redirect`.
 */
const pathnameMock = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

const { UploadLink } = await import("./upload-link");

let container: HTMLDivElement;
let root: Root;

function currentMarkup(): string {
  return container.innerHTML;
}

beforeEach(() => {
  // Same as src/components/gallery/gallery.unmount.test.tsx: React 19's
  // `act` from "react" (rather than a testing-library wrapper) needs this
  // flag set, or every `act()` call below warns instead of flushing.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("UploadLink (ugcportal-t0y round 4)", () => {
  it('marks the link aria-current="page" when usePathname() reports /upload', () => {
    pathnameMock.mockReturnValue(UPLOAD_PATH);

    act(() => {
      root.render(<UploadLink />);
    });

    expect(currentMarkup()).toContain('aria-current="page"');
  });

  it("omits aria-current on every other page", () => {
    pathnameMock.mockReturnValue("/");

    act(() => {
      root.render(<UploadLink />);
    });

    // Not `aria-current="false"`: the ARIA spec treats "false" as its own
    // present-but-falsy token, not a synonym for the attribute's absence.
    // Confirmed, not assumed — see the next test, which mutates the
    // production code to the naive bare-boolean form and shows React
    // renders exactly that string.
    expect(currentMarkup()).not.toContain("aria-current");
  });

  it("proves the naive bare-boolean form would leak a literal \"false\"", async () => {
    // A fixture mutation of the PRODUCTION file, not of this test: dynamic
    // import of a second copy of the module's source with the one
    // documented anti-pattern reinstated, so this is checking real React
    // rendering behaviour rather than restating the comment above as an
    // assumption. Isolated in its own dynamically-imported module (vitest's
    // `vi.mock` factories are file-scoped) so the other tests in this file
    // keep exercising the real, fixed component.
    vi.doMock("./upload-link", async () => {
      const Link = (await import("next/link")).default;
      const { usePathname } = await import("next/navigation");
      return {
        UploadLink: () => {
          const pathname = usePathname();
          return (
            <Link
              href={UPLOAD_PATH}
              aria-current={pathname === UPLOAD_PATH}
              className=""
            >
              Upload
            </Link>
          );
        },
      };
    });
    const { UploadLink: NaiveUploadLink } = await import("./upload-link");
    // NOT the current page, so `pathname === UPLOAD_PATH` is `false` -
    // exactly the bare boolean this test proves React renders literally.
    pathnameMock.mockReturnValue("/");

    act(() => {
      root.render(<NaiveUploadLink />);
    });

    expect(currentMarkup()).toContain('aria-current="false"');
    vi.doUnmock("./upload-link");
  });

  it("updates on a CLIENT-SIDE navigation, without a remount (round 3's regression)", () => {
    /*
      THE CASE ROUND 3'S HEADER-BASED VERSION GOT WRONG. That version read
      the path once, during the root layout's server render, which the App
      Router never re-runs on a client-side navigation - so a signed-in
      visitor who navigated from "/" to "/upload" without a full reload
      would see aria-current stuck at whatever the FIRST page load showed,
      and vice versa navigating away. Re-rendering the SAME mounted root
      with a new usePathname() return value (never unmounting in between)
      is exactly a soft navigation: no full reload, no remount - only a
      Client Component that actually subscribes to the router's current
      path can react to it, which is the whole reason this now lives in one.
    */
    pathnameMock.mockReturnValue("/");
    act(() => {
      root.render(<UploadLink />);
    });
    expect(currentMarkup()).not.toContain("aria-current");

    pathnameMock.mockReturnValue(UPLOAD_PATH);
    act(() => {
      root.render(<UploadLink />);
    });
    expect(currentMarkup()).toContain('aria-current="page"');

    pathnameMock.mockReturnValue("/");
    act(() => {
      root.render(<UploadLink />);
    });
    expect(currentMarkup()).not.toContain("aria-current");
  });
});
