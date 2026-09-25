import { auth, signIn, signOut } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export async function AuthStatus() {
  const session = await auth();

  if (!session?.user) {
    return (
      <div className="flex items-center gap-2">
        {/*
          Outline rather than the filled primary variant (ugcportal-axu): two
          petrol slabs in the header was the single loudest instance of the
          old petrol-dominant treatment, and signing in is not the primary
          action of a page whose job is to show photographs.
        */}
        <form
          action={async () => {
            "use server";
            await signIn("google");
          }}
        >
          <Button type="submit" variant="outline" size="sm">
            Sign in with Google
          </Button>
        </form>
        <form
          action={async () => {
            "use server";
            await signIn("facebook");
          }}
        >
          <Button type="submit" variant="outline" size="sm">
            Sign in with Facebook
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
        min-w-0 on the flex child, or the ellipsis is inert and a long name
        pushes the header wider instead of truncating.
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
