import { signIn, signOut } from "@/lib/auth";
import { Button } from "@/components/ui/button";
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
    return (
      <div className="flex items-center gap-2">
        {/*
          Outline rather than the filled primary variant (ugcportal-axu): two
          petrol slabs in the header was the single loudest instance of the
          old petrol-dominant treatment, and signing in is not the primary
          action of a page whose job is to show photographs.

          "Sign in with" is visually hidden below 640px and the provider name
          carries the button on its own. Two full labels plus the wordmark
          came to roughly 330-340px of content that could not shrink - the
          labels must not truncate, and the buttons are shrink-0 - so at 320px
          the document grew a horizontal scrollbar.

          Hidden with sr-only rather than removed, so the accessible name
          stays "Sign in with Google" at every width. The visible text remains
          a substring of it, which is what WCAG 2.5.3 asks of a visible label.
        */}
        <form
          action={async () => {
            "use server";
            await signIn("google");
          }}
        >
          <Button type="submit" variant="outline" size="sm">
            <span className="sr-only sm:not-sr-only">Sign in with&nbsp;</span>
            Google
          </Button>
        </form>
        <form
          action={async () => {
            "use server";
            await signIn("facebook");
          }}
        >
          <Button type="submit" variant="outline" size="sm">
            <span className="sr-only sm:not-sr-only">Sign in with&nbsp;</span>
            Facebook
          </Button>
        </form>
      </div>
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
      <Button type="submit" variant="outline" size="sm">
        Sign out
      </Button>
    </form>
  );
}
