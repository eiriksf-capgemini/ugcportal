import type { ReactNode } from "react";

import { cn } from "cn";

/**
 * The shared container for a top-level page's content, independent of any
 * particular `<h1>` styling (round-4 review).
 *
 * Reused directly — not through `PageShell` below — by four pages whose own
 * heading styling differs from `PageShell`'s: src/app/admin/settings/
 * rights/page.tsx, .../users/page.tsx and .../instagram/page.tsx (plain
 * `font-semibold`, no responsive `sm:text-3xl` step) and
 * src/app/upload/page.tsx (`font-medium`, not `font-semibold`). Forcing all
 * four through `PageShell`'s fixed title+children API would mean either
 * changing their visual heading style to match /about and /portfolio's (a
 * real, user-visible change this low-severity duplication finding does not
 * ask for) or adding heading-styling options to `PageShell` for four
 * callers that would each use a different one — more surface than the
 * problem needs. Sharing just this constant removes the actual duplication
 * (the wrapper `<div>`'s class list, copied by hand into five places) while
 * leaving every page's own heading exactly as it was.
 *
 * `flex-1` is included — the same class every other top-level page content
 * container in this app uses (the three admin settings pages,
 * `GALLERY_STATE_CONTAINER_CLASS`) to fill the app shell's flex column.
 * src/app/upload/page.tsx's own copy of this wrapper was missing it before
 * this change; surfaced by pulling all five copies together to compare, and
 * fixed the same way round 2 fixed the identical gap in /portfolio's.
 */
export const PAGE_CONTAINER_CLASS =
  "mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6";

/**
 * The centring/width/horizontal-padding shell every `max-w-6xl` surface in
 * this app shares - PAGE_CONTAINER_CLASS above uses `max-w-3xl` instead, so
 * it is not built from this. Exported (PR #94 review round 5, reuse finding
 * 6) so src/components/site-header.tsx can compose the header's own
 * container from the same string instead of re-spelling it a second time:
 * the header does NOT want this file's own `flex-1 py-12` (its height is a
 * precise, named-constant sum - see site-header.tsx's `HEADER_HEIGHT_PX` -
 * that `py-12` would silently break), so it is kept deliberately separate
 * from `WIDE_PAGE_CONTAINER_CLASS` below rather than folded into one
 * constant neither caller could use whole.
 */
export const SIX_XL_CONTAINER_CLASS = "mx-auto w-full max-w-6xl px-4 sm:px-6";

/** The same container, at the wider max-width /portfolio's sample grid needs. */
const WIDE_PAGE_CONTAINER_CLASS = cn(SIX_XL_CONTAINER_CLASS, "flex-1 py-12");

/**
 * The shared container AND `<h1>` for /about and /portfolio specifically
 * (round-2 review): those two pages' headings ARE identical in styling (and
 * their copy is deliberately kept in step — see src/app/about/page.tsx's own
 * comment), so they get the fuller component rather than only the constant
 * above.
 */
export function PageShell({
  title,
  wide = false,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? WIDE_PAGE_CONTAINER_CLASS : PAGE_CONTAINER_CLASS}>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>
      {children}
    </div>
  );
}
