import { signIn, signOut } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { SignInMenu } from "@/components/sign-in-menu";
import { resolveSessionOrAnonymous } from "@/lib/session-or-anonymous";
import { hasSignedInUser } from "@/lib/session";

/**
 * Renders the sign-in/sign-out affordance for the current request's
 * session.
 *
 * Reads `resolveSessionOrAnonymous()` (src/lib/session-or-anonymous.ts,
 * ugcportal-8df3), not `getSession()` directly (ugcportal-t0y round 1
 * medium finding, superseded): that helper awaits the same
 * `cache()`-memoized `getSession()` this and src/components/upload-
 * nav-link.tsx both need — so the two still cost one adapter round trip
 * between them rather than two — and ALSO degrades a rejected read to the
 * anonymous case instead of crashing this component and, with it, every
 * page `AppShell` renders it on (see that module's own comment for why a
 * decorative widget like this one must never fail closed the way
 * src/lib/admin.ts's `requireAdmin` does). A first attempt at avoiding the
 * round-trip duplication instead had AppShell resolve the session itself
 * and pass it down as a prop, which removed the duplicate but forced
 * AppShell to `await` before it could return `{children}` — serialising
 * the session lookup ahead of the page's own data fetching on every
 * render. `cache()` gets both: no duplicate query, and no component forced
 * to block its siblings on it.
 *
 * Gated on `hasSignedInUser` (src/lib/session.ts), not a hand-spelled
 * `!session?.user` (ugcportal-t0y round 3 finding 1): that used to disagree
 * with src/components/upload-nav-link.tsx's own `session?.user?.id` check
 * for a session with a user but no id, so a visitor could see "Sign out"
 * here while the header's own link to /upload silently vanished. Latent
 * today because the session callback always sets `user.id` under the
 * `"database"` strategy; live the moment that ever changes, for exactly one
 * of these two components and not the other, unless both read the same
 * predicate.
 */
export async function AuthStatus() {
  const session = await resolveSessionOrAnonymous();

  if (!hasSignedInUser(session)) {
    /*
     * One "Sign in" control, not two always-visible outline buttons
     * (ugcportal-qqnt.3; was ugcportal-axu's "outline rather than the
     * filled primary variant" reasoning for why these are outline at all —
     * two petrol slabs in the header was the loudest instance of the old
     * petrol-dominant treatment, and signing in is not the primary action
     * of a page whose job is to show photographs). Sign-in here is a closed
     * operator allowlist (src/config/users.ts) - a visitor saw two controls
     * they could never use, and the old visible label also rendered with a
     * double space ("Sign in with  Google") from a `&nbsp;` immediately
     * before an adjacent JSX text node on the next line (JSX collapses that
     * newline-plus-indentation into a second, plain space). `SignInMenu`
     * (src/components/sign-in-menu.tsx - see its own comment for the full
     * account) fixes both: ONE trigger, labelled "Sign in" alone, discloses
     * both provider choices without a second always-visible control, and
     * neither provider button's own label carries a "Sign in with" prefix
     * any more, so there is no longer a seam for the two spaces to meet at.
     *
     * Neither `signIn("google")` nor `signIn("facebook")` moved: both
     * Server Actions are still defined, and called, right here - only
     * handed to `SignInMenu` as props instead of placed directly inside a
     * `<form action={...}>` in this file (K3: relocated, not removed - see
     * auth-status.test.tsx's own source-scan assertion).
     */
    return (
      <SignInMenu
        googleAction={async () => {
          "use server";
          await signIn("google");
        }}
        facebookAction={async () => {
          "use server";
          await signIn("facebook");
        }}
      />
    );
  }

  return (
    <form
      action={async () => {
        "use server";
        await signOut();
      }}
      className="flex min-w-0 items-center gap-2"
    >
      {/*
        min-w-0 on this span, or the ellipsis is inert and a long name pushes
        the header wider instead of truncating. It is the only element in the
        header actions allowed to shrink, which is what keeps the Sign out
        button at full width while a long email gives way.
      */}
      <span className="min-w-0 truncate text-sm text-muted-foreground">
        {session.user.name ?? session.user.email}
      </span>
      <Button type="submit" variant="outline" size="header-sm">
        Sign out
      </Button>
    </form>
  );
}
