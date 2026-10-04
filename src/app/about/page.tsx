import { ContactSection } from "@/components/site/contact-section";
import { IntroSection } from "@/components/site/intro-section";
import { PageShell } from "@/components/site/page-shell";
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
 * `force-dynamic` AGAIN (round-3 review), but for a DIFFERENT reason than
 * before. Round 1 had this for `ContactSection`'s old `resolveContactEmail`
 * throw, which moved to a boot-time warning (src/instrumentation.ts) and no
 * longer needs it; round 2 dropped the export on that basis, noting the
 * build still marks every route `ƒ (Dynamic)` anyway because the root
 * layout's `<AuthStatus />` (src/components/app-shell.tsx) reads the
 * session on every request. Round 3's point: relying on THAT is relying on
 * an implementation detail of a file this bead does not own and must not
 * touch — if AppShell ever stopped reading the session on every request
 * (caching it, say), `/about` would start silently serving a stale
 * prerendered snapshot, with nothing here to say that was never supposed to
 * happen. Declaring it explicitly makes this page's own correctness
 * independent of what AppShell does.
 */
export const dynamic = "force-dynamic";

export default function AboutPage() {
  return (
    <PageShell title="About us">
      <IntroSection />
      <WhatWeOfferSection />
      <ContactSection defaultSubject="Hello from your about page" />
    </PageShell>
  );
}
