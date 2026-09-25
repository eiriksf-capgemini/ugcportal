import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { accountClearanceBlocker } from "@/lib/resale-rights";
import {
  INSTAGRAM_CONNECT_PATH,
  INSTAGRAM_RIGHTS_DECISION_PATH,
} from "@/lib/routes";

import { disconnectInstagramAccount } from "./actions";
import { formatClearanceExpiry, formatReviewTimestamp } from "./dates";
import { ResaleRightsDecisionForm } from "./decision-form";
import { BLOCKER_MESSAGES, outcomeMessage } from "./outcomes";

export const metadata = {
  title: "Instagram accounts",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
});

// The account's own OAuth dates stay in the server's zone, as ugcportal-5ce
// rendered them. Everything belonging to the *clearance* goes through
// ./dates instead, in UTC: those values are UTC by construction and are read
// alongside the edit form, which is where a mismatch misleads.

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

  const { connected, error, rights } = await searchParams;
  const accounts = await prisma.instagramAccount.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      instagramUserId: true,
      tokenExpiresAt: true,
      createdAt: true,
      connectedByUserId: true,
      resaleRightsReview: {
        select: {
          status: true,
          route: true,
          checklistVersion: true,
          reviewedByUserId: true,
          reviewedAt: true,
          validUntil: true,
          clearedOwnerUserId: true,
          clearedOwner: { select: { name: true, email: true } },
          conditions: true,
          evidenceKey: true,
          evidenceSha256: true,
          reviewedBy: { select: { name: true, email: true, role: true } },
        },
      },
    },
  });

  // Every user is a candidate rights holder: an upload's owner is whoever
  // uploaded it, and the clearance has to be able to name them.
  const rightsHolders = await prisma.user.findMany({
    orderBy: [{ name: "asc" }, { email: "asc" }],
    select: { id: true, name: true, email: true },
  });

  const errorMessage = outcomeMessage(error);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Instagram accounts
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect the Instagram accounts whose posts should be synced into the
        portal. Connecting an account grants no right to sell anything from it:
        every account starts UNREVIEWED, and stays unsellable until an admin
        works through the resale-rights checklist and records a clearance here.
      </p>

      {connected ? (
        <p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
          Account connected.
        </p>
      ) : null}
      {rights === "recorded" ? (
        <p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
          Resale-rights decision recorded.
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
          {accounts.map((account) => {
            const review = account.resaleRightsReview;
            const blocker = accountClearanceBlocker(review ?? null);
            const reviewer = review?.reviewedBy;
            // Separation of duties (checklist Part E.3): recorded on the
            // event row at write time, surfaced here so it stays visible
            // rather than sitting in a table nobody reads.
            const selfReviewed =
              review?.reviewedByUserId != null &&
              review.reviewedByUserId === account.connectedByUserId;

            return (
              <li key={account.id} className="space-y-4 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium">@{account.username}</p>
                    <p className="text-xs text-muted-foreground">
                      Connected {dateFormat.format(account.createdAt)} · token
                      valid until {dateFormat.format(account.tokenExpiresAt)}
                    </p>
                  </div>
                  <form action={disconnectInstagramAccount}>
                    <input type="hidden" name="id" value={account.id} />
                    <Button type="submit" variant="destructive" size="sm">
                      Disconnect
                    </Button>
                  </form>
                </div>

                <div
                  className={
                    blocker
                      ? "rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
                      : "rounded-lg border border-border bg-muted p-3 text-sm"
                  }
                >
                  <p className="font-medium">
                    Resale rights: {review?.status ?? "UNREVIEWED"}
                    {blocker ? " — not sellable" : " — clear to sell"}
                  </p>
                  {blocker ? (
                    <p className="mt-1 text-muted-foreground">
                      {BLOCKER_MESSAGES[blocker]}
                    </p>
                  ) : null}
                  {review ? (
                    <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                      <div>
                        <dt className="inline font-medium">Reviewer: </dt>
                        <dd className="inline">
                          {reviewer
                            ? `${reviewer.name ?? reviewer.email ?? review.reviewedByUserId} (${reviewer.role})`
                            : "none recorded"}
                          {review.reviewedAt
                            ? ` · ${formatReviewTimestamp(review.reviewedAt)}`
                            : null}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline font-medium">Checklist: </dt>
                        <dd className="inline">
                          {review.checklistVersion}
                          {review.route ? ` · route ${review.route}` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline font-medium">Rights holder: </dt>
                        <dd className="inline">
                          {review.clearedOwnerUserId
                            ? (review.clearedOwner?.name ??
                              review.clearedOwner?.email ??
                              review.clearedOwnerUserId)
                            : "none recorded — nothing is sellable"}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline font-medium">Expires: </dt>
                        <dd className="inline">
                          {/*
                            Stated as an instant plus the last day anything
                            can actually be sold. The gate refuses at
                            `validUntil <= now`, so a bare "valid until
                            31 Dec" reads as a day the admin does not have —
                            ambiguous in the direction that favours selling.
                          */}
                          {review.validUntil
                            ? formatClearanceExpiry(review.validUntil)
                            : "no end date"}
                        </dd>
                      </div>
                      {review.conditions ? (
                        <div>
                          <dt className="inline font-medium">Conditions: </dt>
                          <dd className="inline">{review.conditions}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="inline font-medium">Evidence: </dt>
                        <dd className="inline">
                          {review.evidenceKey
                            ? `stored · sha256 ${review.evidenceSha256?.slice(0, 16) ?? "unknown"}…`
                            : "none on file"}
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                  {selfReviewed ? (
                    <p className="mt-2 text-xs font-medium text-destructive">
                      Reviewed by the same admin who connected the account —
                      no separation of duties.
                    </p>
                  ) : null}
                </div>

                <details className="rounded-lg border border-border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">
                    Record a resale-rights decision
                  </summary>
                  <ResaleRightsDecisionForm
                    instagramAccountId={account.id}
                    review={review ?? null}
                    rightsHolders={rightsHolders}
                    action={INSTAGRAM_RIGHTS_DECISION_PATH}
                  />
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
