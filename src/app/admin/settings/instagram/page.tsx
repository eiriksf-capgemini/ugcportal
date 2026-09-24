import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { INSTAGRAM_CONNECT_PATH } from "@/lib/routes";

import { disconnectInstagramAccount } from "./actions";
import { outcomeMessage } from "./outcomes";

export const metadata = {
  title: "Instagram accounts",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
});

export default async function InstagramSettingsPage({
  searchParams,
}: PageProps<"/admin/settings/instagram">) {
  // `notFound` rather than an explicit 403 page: an ordinary user shouldn't
  // learn that an admin area exists here. The API routes answer 403 because
  // they have no such discoverability concern.
  const session = await requireAdmin();
  if (!session) {
    notFound();
  }

  const { connected, error } = await searchParams;
  const accounts = await prisma.instagramAccount.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      instagramUserId: true,
      tokenExpiresAt: true,
      createdAt: true,
    },
  });

  const errorMessage = outcomeMessage(error);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Instagram accounts
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect the Instagram accounts whose posts should be synced into the
        portal. Media from a connected account is not offered for sale until
        its resale rights have been confirmed separately.
      </p>

      {connected ? (
        <p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
          Account connected.
        </p>
      ) : null}
      {errorMessage ? (
        <p className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <div className="mt-8">
        <Button render={<a href={INSTAGRAM_CONNECT_PATH} />}>
          Connect an Instagram account
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No accounts connected yet.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-border rounded-lg border border-border">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">@{account.username}</p>
                <p className="text-xs text-muted-foreground">
                  Connected {dateFormat.format(account.createdAt)} · token valid
                  until {dateFormat.format(account.tokenExpiresAt)}
                </p>
              </div>
              <form action={disconnectInstagramAccount}>
                <input type="hidden" name="id" value={account.id} />
                <Button type="submit" variant="destructive" size="sm">
                  Disconnect
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
