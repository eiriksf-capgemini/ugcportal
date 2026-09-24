import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import {
  CURRENT_CHECKLIST_VERSION,
  RESALE_RIGHTS_ROUTES,
  RESALE_RIGHTS_STATUSES,
  accountClearanceBlocker,
} from "@/lib/resale-rights";
import { INSTAGRAM_CONNECT_PATH } from "@/lib/routes";

import { disconnectInstagramAccount, recordResaleRightsDecision } from "./actions";
import { BLOCKER_MESSAGES, outcomeMessage } from "./outcomes";

export const metadata = {
  title: "Instagram accounts",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
});

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
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
          conditions: true,
          evidenceKey: true,
          evidenceSha256: true,
          reviewedBy: { select: { name: true, email: true, role: true } },
        },
      },
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
                            ? ` · ${dateTimeFormat.format(review.reviewedAt)}`
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
                        <dt className="inline font-medium">Valid until: </dt>
                        <dd className="inline">
                          {review.validUntil
                            ? dateFormat.format(review.validUntil)
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
                  <form
                    action={recordResaleRightsDecision}
                    className="mt-3 space-y-3"
                  >
                    <input
                      type="hidden"
                      name="instagramAccountId"
                      value={account.id}
                    />
                    <p className="text-xs text-muted-foreground">
                      Worked through checklist version{" "}
                      {CURRENT_CHECKLIST_VERSION} (
                      docs/legal/instagram-resale-rights-checklist.md). The
                      decision is recorded against you by name.
                    </p>
                    <label className="block text-xs font-medium">
                      Status
                      <select
                        name="status"
                        defaultValue={review?.status ?? "UNREVIEWED"}
                        className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
                      >
                        {RESALE_RIGHTS_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs font-medium">
                      Route (how the rights were obtained)
                      <select
                        name="route"
                        defaultValue={review?.route ?? ""}
                        className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
                      >
                        <option value="">not recorded</option>
                        {RESALE_RIGHTS_ROUTES.map((route) => (
                          <option key={route} value={route}>
                            {route}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs font-medium">
                      Valid until (optional — the clearance stops counting at
                      the start of this day, UTC)
                      <input
                        type="date"
                        name="validUntil"
                        className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium">
                      Conditions from Part D (optional)
                      <textarea
                        name="conditions"
                        rows={2}
                        defaultValue={review?.conditions ?? ""}
                        className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium">
                      Reason (required, recorded in the audit trail)
                      <textarea
                        name="reason"
                        rows={2}
                        required
                        className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm"
                      />
                    </label>
                    <label className="block text-xs font-medium">
                      Evidence file (optional — stored privately, never with
                      sellable media)
                      <input
                        type="file"
                        name="evidence"
                        className="mt-1 block w-full text-sm"
                      />
                    </label>
                    <Button type="submit" size="sm">
                      Record decision
                    </Button>
                  </form>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
