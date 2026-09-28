import type { Session } from "next-auth";

import { signIn, signOut } from "@/lib/auth";
import { Button } from "@/components/ui/button";

/**
 * Renders the sign-in/sign-out affordance for a session the caller already
 * resolved.
 *
 * Takes `session` as a prop rather than calling `auth()` itself
 * (ugcportal-t0y): the app shell (src/components/app-shell.tsx) now needs the
 * same session to decide whether to show the upload nav link, and this app's
 * session strategy is `"database"` (src/lib/auth.ts), so every `auth()` call
 * is a real adapter round trip to the DB, not a free cookie read. A second
 * independent call here would pay that twice on every single page render for
 * no reason - the shell already has the answer by the time this renders.
 */
export function AuthStatus({ session }: { session: Session | null }) {
  if (!session?.user) {
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
