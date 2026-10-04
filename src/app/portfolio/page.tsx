import { GALLERY_GRID_CLASS } from "@/components/gallery/containment";
import { PortfolioTile } from "@/components/portfolio/portfolio-tile";
import { ContactSection } from "@/components/site/contact-section";
import { IntroSection } from "@/components/site/intro-section";
import { WhatWeOfferSection } from "@/components/site/what-we-offer-section";
import { listPortfolioPieces } from "@/lib/portfolio";

/**
 * /portfolio (ugcportal-qnq9.7, K1): the full §5.3 page — intro, the
 * captioned sample set, what-we-offer, and a working contact affordance —
 * reusing the SAME three shared sections /about renders (see that route's
 * own docstring for why the content is split, and why this route
 * independently repeats the non-sample sections rather than relying on the
 * split alone).
 *
 * v0.5.0 RELEASE SCOPE: photo pieces only. `listPortfolioPieces`
 * (src/lib/portfolio.ts) already filters to `kind: "IMAGE"` at the query —
 * this page does not additionally need to branch on kind, and nothing here
 * should start trying to render a video affordance before ugcportal-dzz/
 * -pmb and v0.6.0 land. See that module's own comment for Eirik's 2026-10-04
 * scoping note.
 */

export const metadata = {
  title: "Portfolio",
};

/**
 * Never prerendered — `listPortfolioPieces` reads live, published Media
 * rows. A statically generated portfolio page would keep showing an
 * unpublished or deleted sample until something rebuilt it, and would also
 * mean running a Prisma query at `next build` time against a database the
 * build environment has no reason to have — the same failure
 * src/app/page.tsx's own comment names.
 *
 * Unlike src/app/about/page.tsx (round-1 review: its own `force-dynamic`
 * export was dropped as redundant, even though the app as a whole still
 * renders every route dynamically — see that file's own comment), this
 * page's `dynamic` export is NOT redundant: `ContactSection`'s old
 * contact-email guard reason is gone (that check moved to a boot-time
 * warning, src/instrumentation.ts's `checkContactEmailConfiguration`, and
 * no longer throws at render time), but the live-data reason above is real
 * and specific to this page regardless of anything the root layout does.
 */
export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const pieces = await listPortfolioPieces();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        Portfolio
      </h1>
      <IntroSection />

      <section className="mt-10" data-page-section="samples">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Samples
        </h2>
        {pieces.length === 0 ? (
          // No sample has been curated yet (or none is a photo — v0.5.0's
          // scope) rather than an error: the gallery's own GalleryEmpty is
          // the precedent for an honest "genuinely nothing here yet" state
          // rather than a blank section.
          <p
            className="mt-4 max-w-prose text-sm text-muted-foreground"
            data-portfolio-samples-empty=""
          >
            New samples are on their way — check back soon.
          </p>
        ) : (
          <ul className={`mt-4 ${GALLERY_GRID_CLASS}`}>
            {pieces.map((piece, index) => (
              <PortfolioTile key={piece.id} piece={piece} position={index} />
            ))}
          </ul>
        )}
      </section>

      <WhatWeOfferSection />
      <ContactSection defaultSubject="Hello from your portfolio page" />
    </div>
  );
}
