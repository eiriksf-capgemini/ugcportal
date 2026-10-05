import { UploadLink } from "@/components/upload-link";
import { resolveSessionOrAnonymous } from "@/lib/session-or-anonymous";
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
 *    and with AuthStatus, both of which call
 *    `resolveSessionOrAnonymous()` (src/lib/session-or-anonymous.ts,
 *    ugcportal-8df3), which in turn awaits the same cache()-memoized
 *    `getSession()` (src/lib/auth.ts) — so the two cost one adapter round
 *    trip between them rather than either duplicating it or serialising it —
 *    and degrades a rejected read to "signed out" instead of crashing this
 *    component (and, with it, every page it is rendered on) the way a bare
 *    `await getSession()` here used to (ugcportal-8df3's own premise: this
 *    file and AuthStatus were the gap `Home()`'s own fail-safe did not cover
 *    — see that module's doc comment).
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
 *
 * The auth gate lives here, server-side; whether the link is the CURRENT
 * page does not, and lives in the Client Component it renders
 * (src/components/upload-link.tsx) instead — see that file's comment for
 * why a round 3 attempt at answering that server-side (a request-scoped
 * proxy stamping the path onto a header) was wrong on two counts, one of
 * them a high-severity upload-body-truncation regression.
 */
export async function UploadNavLink() {
  const session = await resolveSessionOrAnonymous();

  if (!hasSignedInUser(session)) return null;

  return (
    <nav aria-label="Primary" className="shrink-0">
      <UploadLink />
    </nav>
  );
}
