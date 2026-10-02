import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
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
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
