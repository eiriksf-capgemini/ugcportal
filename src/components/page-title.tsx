import type { ReactNode } from "react";

/**
 * The page-level h1 (PR #90 round 2): one definition for the sign-in error
 * page, the upload page and the legal pages, which had each copied the same
 * class string. Renders straight on --background inside the app shell's
 * <main>, so the page-canvas token (text-foreground) is the right one — see
 * the pin in src/lib/design/dual-meaning-usage.test.ts.
 */
export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
      {children}
    </h1>
  );
}
