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
 * Never prerendered — two independent reasons, the same shape
 * src/app/page.tsx and src/app/about/page.tsx give for their own `dynamic`
 * export:
 *
 *   - Correctness: `listPortfolioPieces` reads live, published Media rows.
 *     A statically generated portfolio page would keep showing an
 *     unpublished or deleted sample until something rebuilt it.
 *   - Buildability: ContactSection's `resolveContactEmail()` guard only
 *     works at request time (see src/lib/contact.ts), and prerendering
 *     would also mean running a Prisma query at `next build` time against a
 *     database the build environment has no reason to have — the exact
 *     failure src/app/page.tsx's own comment names.
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
      <ContactSection />
    </div>
  );
}
