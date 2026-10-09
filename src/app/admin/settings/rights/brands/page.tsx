import { notFound } from "next/navigation";

import { PAGE_CONTAINER_CLASS } from "@/components/site/page-shell";
import { INLINE_LINK_CLASS } from "@/components/ui/inline-link";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { RIGHTS_BRAND_ALCOHOL_PATH, RIGHTS_SETTINGS_PATH } from "@/lib/routes";

import { formatReviewTimestamp } from "../dates";
import { brandOutcomeMessage } from "./outcomes";

export const metadata = {
  title: "Brands",
};

/** Cap on one page of brands, the same reasoning `MAX_UPLOADERS` states one
 * level up: the query asks for one more row than it shows, so "there are
 * more" is a fact the database answered rather than a length comparison. */
export const MAX_BRANDS = 200;

/** Cap on the "needs attention" list under one alcohol-linked brand. This is
 * a display limit on how many already-published items are NAMED, not on how
 * many are counted — `attentionCount` below is the true count regardless of
 * how many rows render. */
export const MAX_ATTENTION_ITEMS = 10;

export const BRAND_LIST_ID = "benefit-source-brands";

/**
 * Every brand anyone has named as a benefit source, and the one monotone
 * action that can record it as alcohol-linked (ugcportal-mqh8).
 *
 * WHY THIS SCREEN EXISTS. PUT /api/media/[id]/disclosure can only ever
 * record a brand's FIRST answer, and only as `null -> false` — a `yes` is a
 * refusal of the request that would have recorded it (see that route's own
 * long comment on `where: { alcoholLinked: null }`). Nothing, before this
 * bead, could later say "this brand turned out to be alcohol-linked" —
 * which left the K4 publish check with no way to ever start refusing a
 * brand it had already let through. This screen is that "later".
 *
 * K2'S "NEEDING ATTENTION" IS READ, NOT WRITTEN. An item already published
 * under a brand that is now alcohol-linked is NOT auto-unpublished here —
 * doing that from a GET-driven render would be a side effect of looking at a
 * page, and the bead is explicit that nothing may auto-unpublish. Instead
 * each alcohol-linked brand's own published, disclosed items are queried
 * fresh on every render (`disclosures` below), so the admin sees the true,
 * current set rather than a snapshot taken at the moment the brand was
 * flipped. Nothing is denormalised to get this: the publish gate
 * (`commercialPublishRefusal`, src/lib/alcohol-commerce.ts) already refuses
 * the NEXT publish attempt on any of these rows, which is K1; this is the
 * separate, read-only surface for what is already public, which is K2.
 */
export default async function BrandAlcoholSettingsPage({
  searchParams,
}: PageProps<"/admin/settings/rights/brands">) {
  // notFound(), not 401/403, for the same reason every other admin screen in
  // this product chooses it over requireAdminAccess's split: an ordinary
  // user should not learn this screen exists. The 401/403 split is specific
  // to the ROUTE this screen's form posts to — see that route's own
  // docstring — not to the page render.
  const session = await requireAdmin();
  if (!session) {
    notFound();
  }

  const { error, recorded } = await searchParams;

  const BRAND_SELECT = {
    id: true,
    slug: true,
    name: true,
    alcoholLinked: true,
    alcoholAnsweredAt: true,
    alcoholAnsweredBy: { select: { name: true, email: true } },
    // The already-published items this brand's answer now bears on (K2).
    // Named `disclosures` on the wire rather than selected through a
    // `benefitSourceId` filter: this is the BenefitSource's own reverse
    // relation, read from the brand side, which is a different write path
    // from the one src/lib/alcohol-commerce.write-paths.test.ts enumerates
    // (that one is about attaching a brand TO an item; this is a read of
    // what is already attached).
    disclosures: {
      where: { benefitReceived: true, media: { publishedAt: { not: null } } },
      orderBy: { createdAt: "asc" },
      take: MAX_ATTENTION_ITEMS + 1,
      select: {
        media: { select: { id: true, originalName: true, publishedAt: true } },
      },
    },
  } as const;

  const rows = await prisma.benefitSource.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_BRANDS + 1,
    select: BRAND_SELECT,
  });
  const truncated = rows.length > MAX_BRANDS;
  const brands = truncated ? rows.slice(0, MAX_BRANDS) : rows;

  const errorMessage = brandOutcomeMessage(error);

  return (
    <div className={PAGE_CONTAINER_CLASS}>
      <h1 className="text-2xl font-semibold tracking-tight">Brands</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Every company named as the source of a benefit, and what is recorded
        about whether it produces, imports or sells alcohol, or shares a
        brand or trademark with an alcoholic drink (alkoholloven § 9-2,
        docs/ugc-research.md §3.1a practical rule 1). Recording{" "}
        <strong>yes</strong> here is final: no action anywhere in this
        product can change it back. From that moment, no benefit, link or
        advertising label may be attached to anything from that brand, and
        publishing an item that already names it is refused the next time
        anyone tries.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        See also{" "}
        <a className={INLINE_LINK_CLASS} href={RIGHTS_SETTINGS_PATH}>
          resale rights
        </a>
        , which records who may resell their own uploads.
      </p>

      {recorded ? (
        <p className="mt-6 rounded-lg border border-border bg-muted p-3 text-sm">
          Brand recorded as alcohol-linked.
        </p>
      ) : null}
      {errorMessage ? (
        <p className="mt-6 rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      {brands.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Nobody has recorded a benefit from any brand yet, so there is
          nothing to answer.
        </p>
      ) : (
        <ul
          id={BRAND_LIST_ID}
          className="mt-8 divide-y divide-border rounded-lg border border-border"
        >
          {brands.map((brand) => {
            const attention = brand.disclosures;
            const attentionTruncated = attention.length > MAX_ATTENTION_ITEMS;
            const visibleAttention = attentionTruncated
              ? attention.slice(0, MAX_ATTENTION_ITEMS)
              : attention;

            return (
              <li key={brand.id} className="space-y-3 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{brand.name}</p>
                  <p className="text-xs text-muted-foreground">{brand.slug}</p>
                </div>

                <div
                  className={
                    brand.alcoholLinked === true
                      ? "rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm"
                      : "rounded-lg border border-border bg-muted p-3 text-sm"
                  }
                >
                  <p className="font-medium">
                    {brand.alcoholLinked === true
                      ? "Alcohol-linked — no benefit, link or label may be attached"
                      : brand.alcoholLinked === false
                        ? "Not alcohol-linked (first answer only — see below)"
                        : "Unchecked — treated the same as alcohol-linked until answered"}
                  </p>
                  {brand.alcoholLinked === true && brand.alcoholAnsweredAt ? (
                    <p className="mt-1 text-ink-muted">
                      Recorded{" "}
                      {formatReviewTimestamp(brand.alcoholAnsweredAt)} by{" "}
                      {brand.alcoholAnsweredBy
                        ? (brand.alcoholAnsweredBy.name ??
                          brand.alcoholAnsweredBy.email ??
                          "an admin no longer named")
                        : "an admin whose account no longer exists"}
                      .
                    </p>
                  ) : null}
                  {/*
                    text-muted-foreground, not text-ink-muted (ugcportal-
                    6uc2, phase 2): alcoholLinked === false can only render
                    this branch of the div above as bg-muted (the
                    alcoholLinked === true branch is bg-destructive-surface,
                    mutually exclusive with this condition), and bg-muted now
                    reads the paper scale.
                  */}
                  {brand.alcoholLinked === false ? (
                    <p className="mt-1 text-muted-foreground">
                      Recorded by the disclosure form the first time this
                      brand named a benefit. If this brand turns out to be
                      alcohol-linked after all, record it below — that answer
                      cannot be recorded through the disclosure form, only
                      here, and only in this direction.
                    </p>
                  ) : null}
                </div>

                {brand.alcoholLinked === true && attention.length > 0 ? (
                  <div className="rounded-lg border border-destructive/75 bg-destructive-surface p-3 text-sm">
                    <p className="font-medium text-destructive">
                      Needs attention: already published under this brand
                    </p>
                    <p className="mt-1 text-ink-muted">
                      These items were published before this brand was
                      recorded as alcohol-linked. Nothing here has
                      unpublished them — publishing again will now be
                      refused, but a row already public stays public until an
                      admin acts on it directly.
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-muted">
                      {visibleAttention.map(({ media }) => (
                        <li key={media.id}>{media.originalName}</li>
                      ))}
                    </ul>
                    {attentionTruncated ? (
                      <p className="mt-1 text-xs">
                        Showing the first {MAX_ATTENTION_ITEMS}. There are
                        more.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {brand.alcoholLinked !== true ? (
                  <form
                    action={RIGHTS_BRAND_ALCOHOL_PATH}
                    method="post"
                    className="flex items-center gap-2"
                  >
                    <input type="hidden" name="brandId" value={brand.id} />
                    <Button type="submit" size="sm" variant="destructive">
                      Record as alcohol-linked
                    </Button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {truncated ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Showing the first {MAX_BRANDS} brands. There are more — this screen
          needs a search box before it can list them.
        </p>
      ) : null}
    </div>
  );
}
