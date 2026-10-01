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
 * Weight 500 only — the one weight globals.css's `--font-heading` rule and
 * every current heading's own `font-medium`/`font-semibold` utility actually
 * need; `display: "swap"` avoids an invisible-heading flash while it loads.
 */
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["500"],
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
