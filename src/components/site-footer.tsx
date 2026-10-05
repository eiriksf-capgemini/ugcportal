import Link from "next/link";

import { CookieSettingsLink } from "@/components/consent/cookie-settings-link";
import { FOOTER_LINK_CLASS } from "@/components/ui/footer-link";
import { LEGAL_PAGES } from "@/lib/legal/pages";
import {
  type LegalPage,
  legalReadiness,
  linkBlockedInProduction,
} from "@/lib/legal/publishable";
import {
  ABOUT_CONTACT_PATH,
  ABOUT_PATH,
  LICENCE_PATH,
  LLMS_TXT_PATH,
  PORTFOLIO_PATH,
  PRIVACY_PATH,
} from "@/lib/routes";
import { SITE_NAME } from "@/lib/site";

/**
 * The site footer (ugcportal-akv6), split out of src/components/app-shell.tsx
 * into its own file so PR #94 (concurrent, moves the header's markup into
 * site-header.tsx) stays a trivial merge against this one — neither PR
 * touches a line the other owns.
 *
 * Two variants, per the reference sketches: docs/design/forside.html's
 * three-column footer (`compact={false}`, the default) and docs/design/
 * tom-tilstand.html's one-line footer (`compact={true}`). Both variants
 * render the SAME link set — unlike the sketches, which show fewer links in
 * the compact footer — because K1 ("the footer is visible with all its
 * links, and every link target answers 200") is written as a property of
 * "the footer", not of a particular variant, and a footer that must always
 * carry every link is simpler to keep correct than one whose contents vary
 * by variant.
 *
 * `compact` is NOT wired up to the route in this bead: AppShell (the only
 * caller) is mounted once in the root layout, above every route, and has no
 * way to know which page it is currently rendering without new pathname
 * plumbing (a client `usePathname()` wrapper, or middleware setting a
 * request header) — infrastructure this bead's "keep the app-shell.tsx edit
 * to the minimum" instruction puts out of scope. AppShell therefore renders
 * the default (full) variant on every page for now; `compact` exists so a
 * future bead that DOES add route awareness has a tested variant to reach
 * for instead of inventing a second footer.
 *
 * CookieSettingsLink keeps rendering exactly as app-shell.tsx used it
 * (ugcportal-3wgp K4) — this bead only relocates it, per that component's
 * own doc comment ("The footer bead (ugcportal-akv6) owns where this
 * ultimately lives").
 *
 * No Instagram/Pinterest links: src/lib/site.ts defines no URLs for either
 * account today (the decisions table names both platforms, but the accounts
 * themselves do not exist yet), and inventing a handle would be worse than
 * omitting the links — see this component's own PR description for the same
 * point made to the reviewer.
 */

const FOOTER_HEADING_CLASS = "text-sm font-medium text-foreground";

/**
 * A STAND-IN for the footer's brand blurb (round-1 review follow-up, PR
 * #96) — deliberately NOT `SITE_DESCRIPTION` from src/lib/site.ts, whose
 * text ("Food, wine and drink, technology and books, photographed.")
 * names alcohol as a subject directly, which the Decisions table's "Wine
 * angle" row forbids (wine ACCESSORIES — glasses, coolers, apps — never
 * alcohol itself; see src/lib/site.ts's own `INTRO_PARAGRAPHS` for the
 * same rule applied to the About page's copy).
 *
 * TODO(ugcportal-ew7m): replace this with `SITE_TAGLINE` once PR #94
 * merges and introduces it in src/lib/site.ts — that is meant to be the
 * one shared, compliant tagline every surface reaches for; this is only a
 * placeholder so the footer does not ship non-compliant copy while #94 is
 * still in review.
 */
const FOOTER_ABOUT_LINE =
  "Original photography of food, books, home technology and wine accessories.";

/**
 * The registered LegalPage for a route this footer links to (round-1
 * review: previously went through each page's own `loadPrivacy`/
 * `loadLicence` loader instead, which builds the full rendered prose from
 * the live LEGAL_* contact once per request — on /privacy and /licence
 * themselves the footer's call would be a cache hit, but on every OTHER
 * page it would be a real, avoidable prose-build just to read one boolean
 * — see src/lib/legal/pages.ts's own comment for why LEGAL_PAGES is the
 * right thing to read instead). Throws rather than silently treating an
 * unregistered path as safe: a footer link to a legal page that isn't in
 * LEGAL_PAGES is a bug in this file, not a page that happens to be fine to
 * link.
 */
function legalPageFor(path: string): LegalPage {
  const page = LEGAL_PAGES.find((candidate) => candidate.path === path);
  if (!page) {
    throw new Error(
      `${path} is not registered in LEGAL_PAGES (src/lib/legal/pages.ts) — the footer cannot judge whether it is safe to link.`,
    );
  }
  return page;
}

/**
 * K3's real guard: whether a link to the given legal page may render at
 * all. Reads the SAME readiness the page itself guards rendering with
 * (`legalReadiness`/`assertPublishable`, src/lib/legal/publishable.ts) via
 * `LEGAL_PAGES` above, and applies `linkBlockedInProduction` — the same
 * helper `ugcportal-nf9l` reuses for the About page's own outbound link —
 * on top of it, so the footer and the pages cannot disagree about which
 * pages are safe to serve or to link to.
 */
function legalLinkBlocked(path: string): boolean {
  return linkBlockedInProduction(legalReadiness([legalPageFor(path)]));
}

/** The visible, assistive-tech-readable suffix on a blocked legal link — see FooterNavLink. */
const COMING_SOON_SUFFIX = " (coming soon)";

/**
 * Exported (round-1 review follow-up, PR #96) so its rendering rule — given
 * a `blocked` flag, which markup comes out — can be unit-tested directly,
 * independent of whatever the REAL `LEGAL_SIGN_OFF` (src/lib/legal/
 * contact.ts) happens to say today. That constant is a fact about this
 * repo's actual legal text, not a test fixture, and it changes over time
 * (ugcportal-alg signed off the real pages after this component was first
 * written) — testing the rendering rule here independently of it means
 * most of this file's K3 coverage does not need to assume a value for it.
 * One case still deliberately DOES render a live SiteFooter against the
 * real sign-off, on purpose — see src/components/site-footer.test.tsx's
 * own header comment for all four cases.
 */
export function FooterNavLink({
  label,
  href,
  blocked,
}: {
  label: string;
  href: string;
  blocked: boolean;
}) {
  if (blocked) {
    // K3: never an <a href> to a page carrying the draft marker once
    // NODE_ENV is production — rendered as inert, non-navigating text
    // instead of omitted outright, with a plain-text "(coming soon)"
    // suffix so a visitor (sighted or using assistive tech — this is
    // ordinary text content, not an aria-hidden decoration) learns the
    // page exists and is on its way, rather than wondering why "Privacy"
    // or "Licence and rights" is simply missing.
    return (
      <span
        className="text-muted-foreground italic"
        data-footer-draft-link={href}
      >
        {label}
        {COMING_SOON_SUFFIX}
      </span>
    );
  }
  return (
    <Link href={href} className={FOOTER_LINK_CLASS}>
      {label}
    </Link>
  );
}

export function SiteFooter({ compact = false }: { compact?: boolean }) {
  // Computed at render, on the server: SiteFooter carries no "use client"
  // directive, so this runs once per request on the server and never in the
  // browser — there is no hydration mismatch to worry about between a
  // server-computed year and a client-computed one, because the client
  // never computes it at all.
  const year = new Date().getFullYear();

  const privacyBlocked = legalLinkBlocked(PRIVACY_PATH);
  const licenceBlocked = legalLinkBlocked(LICENCE_PATH);

  const pageLinks: { label: string; href: string; blocked: boolean }[] = [
    { label: "About", href: ABOUT_PATH, blocked: false },
    { label: "Portfolio", href: PORTFOLIO_PATH, blocked: false },
    { label: "Licence and rights", href: LICENCE_PATH, blocked: licenceBlocked },
    { label: "Privacy", href: PRIVACY_PATH, blocked: privacyBlocked },
    { label: "Contact", href: ABOUT_CONTACT_PATH, blocked: false },
    { label: "llms.txt", href: LLMS_TXT_PATH, blocked: false },
  ];

  if (compact) {
    return (
      <footer data-site-footer="" className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <span>
            {SITE_NAME} · © {year}
          </span>
          <nav
            aria-label="Pages"
            className="flex flex-wrap items-center gap-x-4 gap-y-2"
          >
            {pageLinks.map((link) => (
              <FooterNavLink key={link.href} {...link} />
            ))}
          </nav>
          <CookieSettingsLink />
        </div>
      </footer>
    );
  }

  return (
    <footer data-site-footer="" className="border-t border-border">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-10 text-sm sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] sm:px-6">
        <div>
          <p className="font-medium text-foreground">{SITE_NAME}</p>
          <p className="mt-2 max-w-prose text-muted-foreground">
            {FOOTER_ABOUT_LINE}
          </p>
        </div>

        <nav aria-label="Pages">
          <h2 className={FOOTER_HEADING_CLASS}>Pages</h2>
          <ul className="mt-3 space-y-2">
            {pageLinks.map((link) => (
              <li key={link.href}>
                <FooterNavLink {...link} />
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <h2 className={FOOTER_HEADING_CLASS}>Legal</h2>
          <p className="mt-3">
            <CookieSettingsLink />
          </p>
          <p className="mt-6 text-xs text-muted-foreground">
            © {year} {SITE_NAME}
          </p>
        </div>
      </div>
    </footer>
  );
}
