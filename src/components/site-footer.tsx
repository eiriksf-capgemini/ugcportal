import Link from "next/link";

import { loadLicence } from "@/app/licence/content";
import { loadPrivacy } from "@/app/privacy/content";
import { CookieSettingsLink } from "@/components/consent/cookie-settings-link";
import {
  ABOUT_CONTACT_PATH,
  ABOUT_PATH,
  LICENCE_PATH,
  PORTFOLIO_PATH,
  PRIVACY_PATH,
} from "@/lib/routes";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

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

const LLMS_TXT_PATH = "/llms.txt";

/**
 * Renders on --background, the page canvas, same as the rest of this
 * footer and as CookieSettingsLink's identical class list (src/components/
 * consent/cookie-settings-link.tsx) — reused verbatim here for one visually
 * consistent footer link style, see src/lib/design/dual-meaning-usage.test.ts.
 */
const FOOTER_LINK_CLASS =
  "rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const FOOTER_HEADING_CLASS = "text-sm font-medium text-foreground";

/**
 * K3's real guard: whether a link to a page with the given draft status may
 * render at all. Reads the SAME readiness the legal pages themselves guard
 * rendering with (`legalReadiness`/`assertPublishable`,
 * src/lib/legal/publishable.ts) via each page's own `loadPrivacy`/
 * `loadLicence` loader below — this function only applies the "never link
 * a draft page in production" rule on top of that shared readiness, it does
 * not compute readiness itself, so the footer and the pages cannot disagree
 * about which pages are safe to serve.
 *
 * `env` is a parameter, same convention as `legalReadiness` and
 * `assertPublishable` themselves, so a test can exercise the production
 * branch without mutating the real `process.env`.
 */
export function blockedInProduction(
  draft: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return draft && env.NODE_ENV === "production";
}

function FooterNavLink({
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
    // NODE_ENV is production — annotated as inert text instead of omitted
    // outright, so a visitor still learns the page exists rather than
    // wondering why "Privacy" or "Licence and rights" is simply missing.
    return (
      <span
        className="text-muted-foreground italic"
        data-footer-draft-link={href}
      >
        {label}
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

  const privacyBlocked = blockedInProduction(loadPrivacy().readiness.draft);
  const licenceBlocked = blockedInProduction(loadLicence().readiness.draft);

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
            {SITE_DESCRIPTION}
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
