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
 * about who runs the site or how to reach it. `defaultSubject` is passed
 * explicitly (round-1 review) so this page's contact form does not say
 * "portfolio page" by way of a shared default.
 */

export const metadata = {
  title: "About",
};

/**
 * NO `export const dynamic` ANY MORE (round-1 review). This page used to
 * carry `force-dynamic` because `ContactSection` called
 * `resolveContactEmail()` (src/lib/contact.ts), which used to throw at
 * render time if production had nothing configured — and prerendering
 * would have run that check during `next build` instead of at a real
 * request. That guard now lives in src/instrumentation.ts as a boot-time
 * warning (`checkContactEmailConfiguration`), so nothing on this page's own
 * render path can throw any more, and there is no live data on this page to
 * go stale — nothing left here that NEEDS `force-dynamic`.
 *
 * WHAT THIS DOES NOT CLAIM: that `next build`'s own output marks `/about`
 * static (`○`). It does not — confirmed by running `npm run build`, which
 * still reports `ƒ (Dynamic)` for every route in this app, this one
 * included. That is inherited from the ROOT layout
 * (src/components/app-shell.tsx renders `<AuthStatus />`, an async Server
 * Component that reads the session via cookies on every request), which
 * forces every page under it to render dynamically regardless of any
 * individual page's own `dynamic` export — a site-wide fact, not one this
 * bead introduced or can fix from inside a single page file, and
 * app-shell.tsx is explicitly out of scope for this bead to touch. Removing
 * the now-redundant export here is still correct: it stops this file
 * claiming a reason for dynamism that no longer exists, even though a
 * different, pre-existing reason still applies at the site level.
 */

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        About us
      </h1>
      <IntroSection />
      <WhatWeOfferSection />
      <ContactSection defaultSubject="Hello from your about page" />
    </div>
  );
}
