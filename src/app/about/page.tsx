import { ContactSection } from "@/components/site/contact-section";
import { IntroSection } from "@/components/site/intro-section";
import { WhatWeOfferSection } from "@/components/site/what-we-offer-section";

/**
 * /about (ugcportal-qnq9.7): who runs this site, what is offered, and how to
 * get in touch. Linked from the header (ugcportal-14k9, concurrent with this
 * bead).
 *
 * §5.3 describes ONE "portfolio page" with five elements (intro, the six
 * captioned pieces, what-you-offer, contact, and — later — a rate card). This
 * bead splits that across two routes, per its own "in scope" description: an
 * about route and a portfolio/"work with us" route. /about carries
 * everything except the sample grid — intro, offer, contact — so the header
 * has somewhere substantive to send a visitor who is not specifically looking
 * for the sample work; /portfolio (src/app/portfolio/page.tsx) repeats the
 * same three sections AND adds the samples, so it independently satisfies
 * K1's literal wording ("the portfolio route shows all five elements").
 *
 * Shares IntroSection/WhatWeOfferSection/ContactSection with /portfolio
 * rather than duplicating their copy, so the two pages cannot drift apart
 * about who runs the site or how to reach it.
 */

export const metadata = {
  title: "About",
};

/**
 * Never prerendered. Two reasons, both load-bearing:
 *
 *   - ContactSection calls `resolveContactEmail()` (src/lib/contact.ts),
 *     which deliberately throws if this is a real production request with
 *     no CONTACT_EMAIL configured. That guard only works if it runs at
 *     REQUEST time; prerendering this page would run it during `next build`
 *     instead, in production mode, in every environment that builds this
 *     repo — including this repo's own CI and pre-push hook, neither of
 *     which sets CONTACT_EMAIL. See src/lib/contact.ts's own comment for the
 *     full reasoning, and src/app/page.tsx for the sibling case this mirrors
 *     (a build-time Prisma query there, a build-time env check here).
 *   - Buildability, for the same reason: a prerendered page is built with
 *     whatever module-scope code runs during that build, and this page's
 *     tree includes a function that is SUPPOSED to be able to throw.
 */
export const dynamic = "force-dynamic";

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        About us
      </h1>
      <IntroSection />
      <WhatWeOfferSection />
      <ContactSection />
    </div>
  );
}
