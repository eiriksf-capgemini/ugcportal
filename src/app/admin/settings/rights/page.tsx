import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { uploaderClearanceBlocker } from "@/lib/resale-rights";
import { RIGHTS_DECISION_PATH, RIGHTS_SETTINGS_PATH } from "@/lib/routes";

import { formatClearanceExpiry, formatReviewTimestamp } from "./dates";
import { ResaleRightsDecisionForm } from "./decision-form";
import { BLOCKER_MESSAGES, outcomeMessage } from "./outcomes";

export const metadata = {
  title: "Resale rights",
};

/**
 * Cap on one page of uploaders. Bounds the render; it is not a statement
 * about how many uploaders the instance may have.
 *
 * The query asks for one more row than it shows, so "there are more" is a
 * fact the database answered rather than a length compared against the cap.
 * Reading truncation off `rows.length === CAP` cannot tell "exactly CAP
 * uploaders" from "cut off", and it is how the notice on the old screen
 * managed to suppress itself (ugcportal-gkj).
 */
export const MAX_UPLOADERS = 100;

/**
 * Resale rights per uploader (ugcportal-0ss, re-anchored by ugcportal-vsm).
 *
 * Lists the people who have uploaded something — or who already carry a
 * review — with their standing clearance and the form to change it. Under
 * ugcportal-0ss this lived on the Instagram settings screen, because the
 * gate hung off connected accounts; it does not any more, and a connected
 * account confers no right to sell anything.
 *
 * What this screen does NOT do is per-upload triage. A clearance here says
 * "this person's own work may be resold"; whether a particular file may be
 * sold also needs its triage signed and each present rights layer cleared,
 * which is ugcportal-74w's curation UI. Until that ships nothing is sellable
 * no matter what is recorded here, which is the correct default.
 */
export default async function ResaleRightsSettingsPage({
  searchParams,
}: PageProps<"/admin/settings/rights">) {
  // `notFound` rather than an explicit 403 page: an ordinary user shouldn't
  // learn that an admin area exists here. The API routes answer 403 because
  // they have no such discoverability concern.
  const session = await requireAdmin();
  if (!session) {
    notFound();
  }

  const { error, rights, edit } = await searchParams;

  const rows = await prisma.user.findMany({
    // Everyone who could have something to sell, plus everyone already
    // judged. A user with no uploads and no review has nothing to decide
    // about yet, and listing every account would make this screen a user
    // directory rather than a rights screen.
    where: {
      OR: [{ media: { some: {} } }, { resaleRightsReview: { isNot: null } }],
    },
    orderBy: [{ email: "asc" }, { id: "asc" }],
    take: MAX_UPLOADERS + 1,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      _count: { select: { media: true } },
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
  const truncated = rows.length > MAX_UPLOADERS;
  const uploaders = truncated ? rows.slice(0, MAX_UPLOADERS) : rows;

  // One uploader's decision form at a time, chosen by `?edit=`. A page load
  // per form, which for a form that records a legal decision is not the
  // expensive part.
  const editingUserId = typeof edit === "string" ? edit : null;

  const errorMessage = outcomeMessage(error);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Resale rights</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Uploading grants no right to resell. Every uploader starts UNREVIEWED
        and stays unsellable until an admin works through the resale-rights
        checklist and records a clearance here. A clearance covers that
        person&apos;s own work only — what is <em>in</em> each file is triaged
        and cleared per upload.
      </p>

      {rights === "recorded" ? (
        <p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
          Resale-rights decision recorded.
        </p>
      ) : null}
      {errorMessage ? (
        <p className="mt-6 rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      {uploaders.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Nobody has uploaded anything yet, so there is nothing to review.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-border rounded-lg border border-border">
          {uploaders.map((uploader) => {
            const review = uploader.resaleRightsReview;
            const blocker = uploaderClearanceBlocker(review ?? null);
            const reviewer = review?.reviewedBy;
            // Separation of duties (checklist Part E.3): an admin clearing
            // their own uploads for sale. Recorded on the event row at write
            // time, surfaced here so it stays visible rather than sitting in
            // a table nobody reads.
            const selfReviewed =
              review?.reviewedByUserId != null &&
              review.reviewedByUserId === uploader.id;

            return (
              <li key={uploader.id} className="space-y-4 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {uploader.name ?? uploader.email ?? uploader.id}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {uploader.email ?? "no email on file"} · {uploader.role} ·{" "}
                    {uploader._count.media} upload
                    {uploader._count.media === 1 ? "" : "s"}
                  </p>
                </div>

                <div
                  className={
                    blocker
                      ? "rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm"
                      : "rounded-lg border border-border bg-muted p-3 text-sm"
                  }
                >
                  <p className="font-medium">
                    Resale rights: {review?.status ?? "UNREVIEWED"}
                    {blocker
                      ? " — not sellable"
                      : " — clear to sell, once each upload is triaged"}
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
                      Reviewed by the uploader themselves — no separation of
                      duties.
                    </p>
                  ) : null}
                </div>

                {editingUserId === uploader.id ? (
                  <div className="rounded-lg border border-border p-3 text-sm">
                    <p className="font-medium">
                      Record a resale-rights decision
                    </p>
                    <ResaleRightsDecisionForm
                      uploaderUserId={uploader.id}
                      review={review ?? null}
                      action={RIGHTS_DECISION_PATH}
                    />
                  </div>
                ) : (
                  <a
                    className="inline-block rounded-sm text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                    href={`${RIGHTS_SETTINGS_PATH}?edit=${uploader.id}`}
                  >
                    Record a resale-rights decision
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {truncated ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Showing the first {MAX_UPLOADERS} uploaders. There are more — this
          screen needs a search box before it can reach them.
        </p>
      ) : null}
    </div>
  );
}
