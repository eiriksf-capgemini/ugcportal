import type { ReactNode } from "react";

/**
 * The shared container and `<h1>` for /about and /portfolio (round-2
 * review): both pages used to open with the identical
 * `mx-auto w-full max-w-{3xl,6xl} px-4 py-12 sm:px-6` wrapper and the
 * identical `<h1>` styling, duplicated rather than shared. One component
 * now, parameterised on the two things that actually differ between the
 * pages — the title text, and whether the page needs the wider canvas
 * /portfolio's sample grid needs.
 *
 * `flex-1` is included here even though only /about's own copy of this
 * wrapper carried it before this change — the same class every other
 * top-level page content container in this app uses (the admin settings
 * pages, GALLERY_STATE_CONTAINER_CLASS) to fill the app shell's flex
 * column. /portfolio's pre-shared-component version was missing it; folding
 * both into one component is what surfaced that drift, and the fix is to
 * carry it on both now rather than on neither.
 */
export function PageShell({
  title,
  wide = false,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`mx-auto w-full ${wide ? "max-w-6xl" : "max-w-3xl"} flex-1 px-4 py-12 sm:px-6`}
    >
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>
      {children}
    </div>
  );
}
