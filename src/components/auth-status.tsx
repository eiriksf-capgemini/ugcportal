import { auth, signIn, signOut } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export async function AuthStatus() {
  const session = await auth();

  if (!session?.user) {
    return (
      <form
        action={async () => {
          "use server";
          await signIn("facebook");
        }}
      >
        <Button type="submit">Sign in with Facebook</Button>
      </form>
    );
  }

  return (
    <form
      action={async () => {
        "use server";
        await signOut();
      }}
      className="flex items-center gap-2"
    >
      <span className="text-sm text-zinc-600 dark:text-zinc-400">
        {session.user.name ?? session.user.email}
      </span>
      <Button type="submit" variant="outline">
        Sign out
      </Button>
    </form>
  );
}
