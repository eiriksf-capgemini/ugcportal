import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { AnalyticsLoader } from "@/components/consent/analytics-loader";
import { ConsentProvider } from "@/components/consent/consent-context";
import { CookieBanner } from "@/components/consent/cookie-banner";
import { readConsentCookieOnServer } from "@/lib/consent.server";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Display face for h1-h3 (ugcportal-rw9j, product decision: approved).
 *
 * `weight: "variable"`, not a single static weight (review round 1): the
 * existing h1/h2 elements this now applies to mix `font-medium` (500) and
 * `font-semibold` (600) — src/app/admin/settings/rights/page.tsx,
 * users/page.tsx and instagram/page.tsx all use 600 — and Fraunces is a
 * genuine variable font (confirmed in next/font's own Google font-data:
 * weights 100-900, including "variable"), so loading only the 500 static
 * face would leave every 600 heading with no matching face to render at all.
 * The variable file covers every weight any heading asks for, present or
 * future, without re-deciding this per heading.
 *
 * `display: "swap"` avoids an invisible-heading flash while it loads.
 */
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  /*
   * Read once, server-side, so the first paint already matches whatever
   * choice the browser's cookie already carries (ugcportal-3wgp) — the
   * alternative, a client-only read, would mean every fresh page load shows
   * the banner for one frame regardless of an earlier choice.
   *
   * Round 4, LOW finding 10, ACCEPTED AND DOCUMENTED rather than
   * restructured: this `await` sits ahead of `{children}` in an `async`
   * layout, the exact shape `app-shell.tsx`'s own comment warns against —
   * "React only starts rendering `children` once [the function] itself has
   * returned... an `await` in THIS function's body... would serialise [it]
   * ahead of the page's own data fetching for every page". That warning is
   * about `getSession()`: a REAL async operation (JWT verification, a
   * session-store read) with actual I/O and actual latency to serialise
   * ahead of something else. `readConsentCookieOnServer()` is categorically
   * different — `next/headers`' `cookies()` reads already-parsed request
   * headers with no I/O at all, so there is nothing of consequence for it
   * to serialise ahead of; the delay is a microtask, not a network or
   * database round trip. Restructuring this into a nested async component
   * (so `children` could start resolving in parallel) would add real
   * complexity — a new component, a Suspense boundary, a fallback UI to
   * design for that boundary — to remove a cost this small. Not done; if a
   * FUTURE consent-adjacent read here ever gains real I/O, revisit this.
   */
  const initialConsent = await readConsentCookieOnServer();

  return (
    <html
      lang="en"
      /*
       * No `dark` class (ugcportal-rw9j): colour mode follows the OS/browser's
       * own `prefers-color-scheme`, via the `@media (prefers-color-scheme:
       * dark)` override in globals.css, not a class toggle - there is no
       * in-app switch yet. `color-scheme: light dark` in globals.css tells the
       * browser to match the active mode for its own chrome - scrollbars, form
       * controls, the canvas before paint.
       */
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <ConsentProvider initialConsent={initialConsent}>
          <AppShell>{children}</AppShell>
          {/*
            Mounted once, here, for every page a visitor can land on
            (ugcportal-3wgp) — including /auth/error and the admin routes
            (K1/K6). AnalyticsLoader is the ONLY place a tracking script may
            mount; CookieBanner is the only banner.
          */}
          <CookieBanner />
          <AnalyticsLoader />
        </ConsentProvider>
      </body>
    </html>
  );
}
