import { notFound } from "next/navigation";

import type { RightsLayer } from "@/generated/prisma/enums";

import { PAGE_CONTAINER_CLASS } from "@/components/site/page-shell";
import { INLINE_LINK_CLASS } from "@/components/ui/inline-link";
import { requireAdmin } from "@/lib/admin";
import { TRIAGE_ANSWER_SELECT } from "@/lib/curation-triage";
import { prisma } from "@/lib/prisma";
import {
  CLEARABLE_LAYERS,
  TRIAGE_FACTS,
  unsettledLayers,
} from "@/lib/resale-rights";
import {
  ADMIN_USERS_PATH,
  CURATION_PATH,
  RIGHTS_SETTINGS_PATH,
  mediaPreviewPath,
} from "@/lib/routes";

import { recordClearance, recordTriage } from "./actions";
import { CurationClearanceForm } from "./clearance-form";
import { triageOutcomeMessage } from "./outcomes";
import { CurationTriageForm } from "./triage-form";

export const metadata = {
  title: "Curation triage",
};

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Cap on one page of uploads. Bounds the render; it is not a statement about
 * how many uploads the instance may hold.
 *
 * The query asks for one more row than it shows, so "there are more" is a
 * fact the database answered rather than a length compared against the cap —
 * the same construction, for the same reason, as MAX_UPLOADERS on the
 * resale-rights screen. Reading truncation off `rows.length === CAP` cannot
 * tell "exactly CAP uploads" from "cut off", which is how the notice on an
 * earlier screen managed to suppress itself (ugcportal-gkj).
 */
export const MAX_UPLOADS = 50;

/**
 * DOM id of the upload list. Exported because the page's tests read the rows
 * out of the rendered markup and have to name WHICH list they mean: an
 * opened triage form renders its own questions, and a helper that took "the
 * first list on the page" would silently start measuring something else
 * (the mistake ugcportal-qn3 recorded one screen over).
 */
export const UPLOAD_LIST_ID = "curation-uploads";

/**
 * DOM id of the `?error=` banner. Exported so page.test.tsx can assert that
 * an unknown or inherited code renders NO banner.
 *
 * Needed because this screen also renders the destructive well for an
 * untriaged upload, so "the markup contains no destructive styling" is false
 * on any page with an untriaged row — which the test's own fixtures all have.
 * The banner's `text-destructive` would distinguish it today, but that is a
 * styling choice either side could change; the id is there to be matched.
 */
export const ERROR_BANNER_ID = "curation-triage-error";

/**
 * What the page needs about one upload.
 *
 * `previewKey` is selected and never returned to the markup — see the
 * mapping below. It is read for exactly one yes/no question (is there a
 * watermarked object at all, ugcportal-vq3z K4), and it is `previews/
 * {userId}/{uuid}`, so rendering it would publish the uploader's account id
 * to the page. `previewId`, the opaque public handle, is what the image is
 * built from.
 */
const UPLOAD_SELECT = {
  id: true,
  kind: true,
  originalName: true,
  previewId: true,
  previewKey: true,
  createdAt: true,
  publishedAt: true,
  user: { select: { id: true, name: true, email: true } },
  listing: {
    select: {
      id: true,
      // Every registered triage fact, from the shared constant, so a column
      // cannot be omitted here and silently render as "Not answered" in the
      // form below.
      ...TRIAGE_ANSWER_SELECT,
      // Not a triage answer and not optional here: `modelReleaseKey` is
      // what PEOPLE's `alsoRequires` reads, so without it `unsettledLayers`
      // below would be answering a different question from the gate's.
      // GateListing requires it, so omitting it fails `tsc` at the call
      // rather than quietly under-reporting a blocked layer.
      modelReleaseKey: true,
      triagedAt: true,
      triagedByUserId: true,
      triagedBy: { select: { name: true, email: true, role: true } },
      // The per-layer justifications (ugcportal-qfy9). `clearedByUserId`
      // and the clearer's CURRENT role are both selected because that is
      // what `layerIsCleared` decides on — a clearance signed by someone
      // since demoted is not one the gate stands behind, and this screen
      // must not report it as settled when the gate does not.
      layerClearances: {
        select: {
          layer: true,
          reason: true,
          clearedAt: true,
          clearedByUserId: true,
          clearedBy: { select: { name: true, email: true, role: true } },
        },
      },
    },
  },
} as const;

/**
 * One upload as the markup sees it: the row, minus `previewKey`, plus the one
 * fact that column was read for.
 *
 * `previewKey` is DESTRUCTURED AWAY rather than "not rendered by convention".
 * The storage path never enters the object the JSX below can reach, so
 * leaking it would mean adding it back by hand rather than forgetting not to
 * use it — and "renders no preview storage path" in page.test.tsx scans the
 * markup for the prefix as well.
 *
 * Generic over the row rather than naming a Prisma payload type, so the one
 * `select` above stays the single description of what is loaded and this
 * helper cannot come to expect a different shape from the one the query
 * returns.
 */
function toCurationRow<Row extends { previewKey: string | null }>({
  previewKey,
  ...rest
}: Row) {
  return {
    ...rest,
    // Blank is absent, not a working preview — the same reading the publish
    // endpoint and recordTriageFacts both use, so the screen and the write
    // agree about which rows are curatable.
    hasPreview: previewKey !== null && previewKey.trim() !== "",
  };
}

/**
 * The registry's wording of the question each layer answers, so the
 * clearance forms below ask the same question the gate blocks on.
 *
 * Built from TRIAGE_FACTS rather than written out, for the reason the
 * triage form gives: a layer added to the registry is asked here without
 * anyone remembering.
 */
const LAYER_QUESTIONS: ReadonlyMap<RightsLayer, string> = new Map(
  TRIAGE_FACTS.map((fact) => [fact.layer, fact.question]),
);

/**
 * DOM id of one upload's rights-layer well. Exported so page.test.tsx can
 * read the layers of ONE row out of a page that renders several, rather
 * than matching "the first well on the page" — the mistake the upload list
 * id above records.
 */
export function rightsLayersSectionId(mediaId: string): string {
  return `rights-layers-${mediaId}`;
}

/** "Yes" / "No" / "Not answered" for one stored triage column. */
function answerLabel(stored: boolean | null): string {
  if (stored === true) return "Yes";
  if (stored === false) return "No";
  return "Not answered";
}

/**
 * Curation triage (ugcportal-vq3z).
 *
 * Lists owner-uploaded Media and records the per-upload Part C triage facts
 * the sellability gate reads — `depictsPeople`, `depictsMinors`,
 * `containsMusic`, `depictsAlcohol` and the rest of TRIAGE_FACTS — against
 * the acting admin's name and the time they recorded it. Before this screen
 * nothing in the application wrote those columns at all, so they were read by
 * the gate and written by nobody, and no upload could ever be sellable.
 *
 * WHAT THIS SCREEN DOES NOT DO, so that the absences are not mistaken for
 * gaps:
 *   - price and licence, and re-evaluating sellability at render
 *     (ugcportal-yzo7) — the price endpoint already exists at
 *     /api/admin/curation/[id]/price and is not driven from here yet;
 *   - showing the uploader's own attestation beside the admin's answer
 *     (ugcportal-vlnn, which also needs ugcportal-15r).
 *
 * THE SYNCED INSTAGRAM POST IS NOT SHOWN, and that is a statement about the
 * data rather than a design choice deferred. ugcportal-2eh Option A settles
 * that the artefact sold is always the owner-uploaded original from
 * ugcportal-8wa; a synced post would be discovery context only. There is no
 * synced-post table in the schema today — the Instagram integration is
 * deferred and `InstagramAccount` holds a connection, not posts — so there
 * is nothing to show as context, and every pointer on this screen is a
 * same-origin path to our own storage (ugcportal-vq3z K3).
 */
export default async function AdminCurationPage({
  searchParams,
}: PageProps<"/admin/curation">) {
  // `notFound` rather than an explicit 403 page, matching the three admin
  // settings screens: an ordinary user shouldn't learn that an admin area
  // exists here. The server action answers a refused caller with an error
  // instead, because it has no discoverability concern — see actions.ts.
  const session = await requireAdmin();
  if (!session) {
    notFound();
  }

  const { error, triage, clearance, edit } = await searchParams;

  const rows = await prisma.media.findMany({
    // Newest first, with `id` as the tiebreak so two uploads sharing a
    // timestamp have a stable order rather than whichever the planner
    // returned — otherwise the same page reads differently on consecutive
    // requests and every rendering assertion becomes flaky.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_UPLOADS + 1,
    select: UPLOAD_SELECT,
  });
  const truncated = rows.length > MAX_UPLOADS;
  const visible = (truncated ? rows.slice(0, MAX_UPLOADS) : rows).map(
    toCurationRow,
  );

  // One upload's triage form at a time, chosen by `?edit=`. A page load per
  // form, which for a form that records assertions about third parties'
  // rights is not the expensive part.
  const editingMediaId = typeof edit === "string" ? edit : null;

  /**
   * The upload named by `?edit=` is ALWAYS rendered, whether or not it falls
   * inside the capped slice.
   *
   * Not a convenience, and the same rule the resale-rights screen states for
   * its own cap: this screen is the only path in the codebase that can write
   * a triage fact, so an upload whose form cannot be opened is an upload that
   * can never be sold. Ranking past the cap by date would do exactly that,
   * silently — a hand-typed `?edit=<id>` would render nothing and say
   * nothing. The cap is a display limit; it must not become a limit on what
   * can be triaged.
   */
  const editedIsVisible = visible.some((row) => row.id === editingMediaId);
  const requestedRow =
    editingMediaId && !editedIsVisible
      ? await prisma.media.findUnique({
          where: { id: editingMediaId },
          select: UPLOAD_SELECT,
        })
      : null;
  const requestedUpload = requestedRow ? toCurationRow(requestedRow) : null;
  // Pinned to the top rather than sorted into place: the admin arrived here
  // to act on this upload, and an out-of-slice row sorted by date would be
  // below the fold of a list they were told is truncated.
  const uploads = requestedUpload ? [requestedUpload, ...visible] : visible;
  // `?edit=` naming nothing at all — a stale tab, a deleted upload, a typo —
  // used to render an ordinary page with no form and no explanation on the
  // sibling rights screen; it says so here instead.
  const editedUploadMissing = Boolean(
    editingMediaId && !editedIsVisible && !requestedRow,
  );

  const errorMessage = triageOutcomeMessage(error);

  return (
    <div className={PAGE_CONTAINER_CLASS}>
      <h1 className="text-2xl font-semibold tracking-tight">Curation triage</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        What is <em>in</em> each upload, answered per upload and recorded
        against your name. These answers are what the sellability gate reads;
        an unanswered question blocks the sale, and so does an answer nobody
        signed. A clearance for the person who uploaded the file is a separate
        decision, recorded on the{" "}
        <a className={INLINE_LINK_CLASS} href={RIGHTS_SETTINGS_PATH}>
          resale rights
        </a>{" "}
        screen; both have to hold before anything can be sold. Who may record
        either is decided on{" "}
        <a className={INLINE_LINK_CLASS} href={ADMIN_USERS_PATH}>
          users and roles
        </a>
        .
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        The file curated is always the uploaded original (ugcportal-2eh option
        A). A synced Instagram post would only ever be discovery context, and
        there is nothing synced to show yet.
      </p>
      {/*
        Price and licence are not on this screen yet; ugcportal-yzo7 adds
        them here rather than elsewhere. Said in the markup as well as in
        the docstring above, because an admin who finds no price field
        should know it is absent on purpose rather than broken.
      */}
      <p className="mt-2 text-sm text-muted-foreground">
        Recording the triage does not set a price or grant a licence. Those are
        separate decisions and are not on this screen yet. The rights layers a
        &ldquo;yes&rdquo; needs are cleared one at a time below, each with its
        own justification: clearing one settles that layer and no other.
      </p>

      {triage === "recorded" ? (
        <p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
          Triage recorded.
        </p>
      ) : null}
      {clearance === "recorded" ? (
        <p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
          Clearance recorded for that one layer. Every other layer still blocks
          until it has its own.
        </p>
      ) : null}
      {errorMessage ? (
        <p
          id={ERROR_BANNER_ID}
          className="mt-6 rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      ) : null}
      {editedUploadMissing ? (
        <p className="mt-6 rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm text-destructive">
          That upload no longer exists, so there is nothing to triage against
          it.
        </p>
      ) : null}
      {requestedUpload ? (
        <p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
          Showing {requestedUpload.originalName} at the top because you opened
          its triage form. It falls outside the {MAX_UPLOADS} most recent
          uploads listed below.
        </p>
      ) : null}

      {uploads.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Nobody has uploaded anything yet, so there is nothing to triage.
        </p>
      ) : (
        <ul
          id={UPLOAD_LIST_ID}
          className="mt-8 divide-y divide-border rounded-lg border border-border"
        >
          {uploads.map((upload) => {
            const listing = upload.listing;
            const triager = listing?.triagedBy;
            // A triage the gate will accept needs BOTH a named signer and
            // that signer being an admin right now — `triageBlocker` checks
            // `triagedBy?.role !== "ADMIN"`, re-read at evaluation time, so a
            // signature from someone since demoted is void. Surfaced here
            // since no render-time gate exists yet (ugcportal-yzo7, K4).
            const signedByCurrentAdmin =
              listing?.triagedByUserId != null && triager?.role === "ADMIN";

            /*
              THE LAYERS STILL IN THE WAY (ugcportal-qfy9), from the gate's
              own `unsettledLayers` rather than from a reading of the
              columns here. Two things follow, and both are the point:
              clearing one layer removes exactly that layer from this list,
              and a clearance signed by someone since demoted keeps its
              layer ON it, because `unsettledLayers` runs the same
              per-fact rule `triageBlocker` does.

              The `: []` branch covers an untriaged upload: there is no
              listing to ask about and nothing to clear. The well below is
              itself conditioned on `listing`, so for this case it renders
              nothing at all rather than an empty one.
            */
            const blockingLayers = listing ? unsettledLayers(listing) : [];
            // Only the layers a clearance can actually settle. ALCOHOL can
            // be on `blockingLayers` and must never get a form: nothing
            // settles it, so a box to type a justification into would be
            // an invitation to record a sentence the gate will not read.
            const clearableBlocking = blockingLayers.filter((layer) =>
              CLEARABLE_LAYERS.includes(layer),
            );
            const clearances = listing?.layerClearances ?? [];

            return (
              <li key={upload.id} className="space-y-4 p-4">
                <div className="flex items-start gap-4">
                  {upload.previewId ? (
                    /* eslint-disable-next-line @next/next/no-img-element --
                       a plain <img> for the same reason the item page gives:
                       the bytes come from our own route and nothing here
                       wants Next's optimiser in front of an admin thumbnail. */
                    <img
                      src={mediaPreviewPath(upload.previewId)}
                      alt=""
                      width={96}
                      height={96}
                      className="size-24 shrink-0 rounded-md border border-border object-cover"
                    />
                  ) : null}
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {upload.originalName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {upload.user.email ?? upload.user.id}{" "}
                      · {upload.kind} · uploaded{" "}
                      {dateTimeFormat.format(upload.createdAt)} ·{" "}
                      {upload.publishedAt ? "published" : "not published"}
                    </p>
                  </div>
                </div>

                <div
                  className={
                    signedByCurrentAdmin
                      ? "rounded-lg border border-border bg-muted p-3 text-sm"
                      : "rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm"
                  }
                >
                  <p className="font-medium">
                    {listing
                      ? signedByCurrentAdmin
                        ? "Triaged"
                        : "Triage not signed by a current admin"
                      : "Not triaged"}
                  </p>
                  {/*
                    text-ink-muted, not text-muted-foreground: this text sits
                    inside the well above, which is still the near-black
                    surface scale, and --muted-foreground is tuned for the
                    page canvas instead (see the same note on the
                    resale-rights screen and contrast.ts).
                  */}
                  <dl className="mt-2 space-y-1 text-xs text-ink-muted">
                    {TRIAGE_FACTS.map((fact) => (
                      <div key={fact.field}>
                        <dt className="inline font-medium">
                          {fact.question}{" "}
                        </dt>
                        <dd className="inline">
                          {answerLabel(listing?.[fact.field] ?? null)}
                        </dd>
                      </div>
                    ))}
                    <div>
                      <dt className="inline font-medium">Recorded by: </dt>
                      <dd className="inline">
                        {listing?.triagedByUserId
                          ? `${triager?.name ?? triager?.email ?? listing.triagedByUserId} (${triager?.role ?? "no account"})`
                          : "nobody"}
                        {listing?.triagedAt
                          ? ` · ${dateTimeFormat.format(listing.triagedAt)}`
                          : null}
                      </dd>
                    </div>
                  </dl>
                </div>

                {listing ? (
                  <div
                    id={rightsLayersSectionId(upload.id)}
                    className="rounded-lg border border-border bg-muted p-3 text-sm"
                  >
                    <p className="font-medium">Rights layers</p>
                    <p className="mt-1 text-xs text-ink-muted">
                      One justification per layer. Clearing a layer settles that
                      layer only — a music licence is not an answer about an
                      identifiable person, and the gate never reads one
                      layer&rsquo;s clearance for another.
                    </p>
                    {clearances.length > 0 ? (
                      <dl className="mt-2 space-y-1 text-xs text-ink-muted">
                        {clearances.map((recorded) => (
                          <div key={recorded.layer}>
                            <dt className="inline font-medium">
                              {recorded.layer} cleared:{" "}
                            </dt>
                            <dd className="inline">
                              {recorded.reason} —{" "}
                              {recorded.clearedBy?.name ??
                                recorded.clearedBy?.email ??
                                recorded.clearedByUserId ??
                                "nobody"}{" "}
                              ({recorded.clearedBy?.role ?? "no account"}) ·{" "}
                              {dateTimeFormat.format(recorded.clearedAt)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {clearableBlocking.length === 0 ? (
                      <p className="mt-2 text-xs text-ink-muted">
                        {blockingLayers.length === 0
                          ? "No layer is blocking this upload."
                          : "No layer here is one a clearance settles. What is still blocking cannot be cleared by recording a justification."}
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-3">
                        {clearableBlocking.map((layer) => (
                          <li key={layer}>
                            {editingMediaId === upload.id ? (
                              <CurationClearanceForm
                                mediaId={upload.id}
                                layer={layer}
                                question={LAYER_QUESTIONS.get(layer) ?? ""}
                                action={recordClearance}
                              />
                            ) : (
                              <p className="text-xs text-ink-muted">
                                {layer} is not settled yet.
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                {!upload.hasPreview ? (
                  /*
                    ugcportal-vq3z K4, the UI half. No form at all for an
                    upload with no watermarked preview, so this screen cannot
                    be the thing that puts an unprotected original into the
                    curation flow. The server refuses it too
                    (recordTriageFacts returns `no_preview`) — this only
                    explains why before the round trip, exactly as the users
                    screen's disabled last-admin button does.
                  */
                  <p className="text-sm text-muted-foreground">
                    No watermarked preview yet, so this upload cannot be
                    triaged. Today that means every video — poster frames are
                    not built yet.
                  </p>
                ) : editingMediaId === upload.id ? (
                  <div className="rounded-lg border border-border p-3 text-sm">
                    <p className="font-medium">Record the triage</p>
                    <CurationTriageForm
                      mediaId={upload.id}
                      answers={listing}
                      action={recordTriage}
                    />
                  </div>
                ) : (
                  <a
                    className="inline-block rounded-sm text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                    href={`${CURATION_PATH}?edit=${encodeURIComponent(upload.id)}`}
                  >
                    {listing ? "Revise the triage" : "Record the triage"}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {truncated ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Showing the {MAX_UPLOADS} most recent uploads. There are more — this
          screen needs a search box before it can list them. An upload outside
          this slice can still be triaged directly, via{" "}
          <code>{CURATION_PATH}?edit=&lt;media id&gt;</code>.
        </p>
      ) : null}
    </div>
  );
}
