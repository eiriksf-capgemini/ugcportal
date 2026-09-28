import { headers } from "next/headers";
import Link from "next/link";

import { getSession } from "@/lib/auth";
import { CURRENT_PATH_HEADER, UPLOAD_PATH } from "@/lib/routes";
import { hasSignedInUser } from "@/lib/session";

/**
 * The header's nav landmark for /upload (ugcportal-t0y), shown only to
 * exactly the population src/app/upload/page.tsx:37 itself would let
 * through — gated on `hasSignedInUser` (src/lib/session.ts), the same
 * predicate src/components/auth-status.tsx uses (ugcportal-t0y round 3
 * finding 1: the two used to hand-spell their own, different expressions,
 * and disagreed for a session with a user but no id), so this link's
 * visibility can never disagree with what that page, or the rest of the
 * header, would do for the same visitor.
 *
 * A standalone async component, not inlined into app-shell.tsx, for two
 * reasons:
 *
 * 1. It lets AppShell stay a plain synchronous function. React can only
 *    start rendering a component's `children` once the component itself has
 *    returned, so an `await` in AppShell's own body — the shape this bead
 *    shipped with in round 1 — serialises the session lookup ahead of the
 *    page's own data fetching for every single page, including "/" for an
 *    anonymous gallery visitor who will never see this link at all. Kept as
 *    a sibling element instead, this renders concurrently with `{children}`
 *    and with AuthStatus, both of which call the same cache()-memoized
 *    `getSession()` (src/lib/auth.ts), so the two cost one adapter round
 *    trip between them rather than either duplicating it or serialising it.
 * 2. It lets this gating logic be unit tested in isolation — the same way
 *    src/app/upload/page.test.tsx tests its page directly — rather than
 *    needing a renderer that can resolve a nested async child while walking
 *    a parent tree. This repo's `renderToStaticMarkup` cannot: confirmed
 *    empirically, it throws "A component suspended while responding to
 *    synchronous input" the moment it meets one, so app-shell.tsx's own
 *    tests stub this component out rather than executing it.
 *
 * All-or-nothing rather than always rendering an empty <nav> and hiding only
 * the link inside it: a landmark with no content is a known screen-reader
 * anti-pattern, so a signed-out visitor gets no <nav> here at all rather than
 * one that resolves to empty.
 */
export async function UploadNavLink() {
  const session = await getSession();

  if (!hasSignedInUser(session)) return null;

  /*
    ugcportal-t0y round 3 finding 2: aria-current="page" when a signed-in
    user is already on /upload — the conventional expectation for a nav
    landmark's active item, and without it, clicking the link while already
    there is a no-op navigation with no indication why. Read from the
    request header src/proxy.ts stamps (see CURRENT_PATH_HEADER's own
    comment for why a header, not some other App Router mechanism, is what
    exists for a component this far up the tree to learn the current path
    at all). `undefined`, not `false`, when it isn't the current page:
    aria-current is only ever removed by omitting it, since the ARIA spec
    defines "false" as its own (falsy but present) token rather than a
    synonym for absent.
  */
  const pathname = (await headers()).get(CURRENT_PATH_HEADER);
  const isCurrentPage = pathname === UPLOAD_PATH;

  return (
    <nav aria-label="Primary" className="shrink-0">
      <Link
        href={UPLOAD_PATH}
        aria-current={isCurrentPage ? "page" : undefined}
        className="rounded-sm text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        Upload
      </Link>
    </nav>
  );
}
