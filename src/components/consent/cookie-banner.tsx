"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import { Button } from "@/components/ui/button";

import { useConsent } from "./consent-context";

/**
 * The banner's copy (K5) — one short paragraph naming what is optional, what
 * it is for, and that nothing optional is set until the visitor chooses.
 * English, like the rest of the site. Exported so its own test can assert
 * the exact text, and so Eirik can review the exact wording from one place
 * (quoted verbatim in the PR body too).
 */
export const COOKIE_BANNER_COPY =
  "We use optional cookies for website analytics, to understand how visitors use this site. Nothing optional is set until you choose, and you can change your mind anytime via “Cookies” in the footer.";

export const COOKIE_BANNER_ACCEPT_LABEL = "Accept optional cookies";
export const COOKIE_BANNER_DECLINE_LABEL = "Only necessary";

// React warns about useLayoutEffect "doing nothing" when it runs during
// server rendering. It never actually DOES anything during SSR either way
// (Next does not execute effects server-side at all) — this just silences
// the warning the common way, by using the synchronous (layout) version
// only once `window` exists.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Bottom-anchored, small, one paragraph, two equally styled buttons
 * (ugcportal-3wgp K5). Both buttons share the exact same `variant`/`size` —
 * literally the same props, not just a visually similar pair — so there is
 * no dark pattern of one choice reading as more prominent than the other.
 *
 * Declining ("Only necessary") is listed first, not "Accept": the common
 * dark pattern this guards against is accept-first-and-highlighted, and
 * putting the less-data-hungry choice first costs nothing given both share
 * identical styling either way.
 *
 * Not a modal: no focus trap, no backdrop, nothing blocks interaction with
 * the rest of the page while it is open (no cookie wall). A visitor can
 * still use the site before choosing — the only thing gated is optional
 * storage/tracking itself, enforced by AnalyticsLoader, not by this banner
 * blocking anything.
 *
 * Review findings addressed here:
 *
 * - Round 1 finding 8 (the fixed banner can cover interactive content):
 *   nothing in that round added matching bottom padding anywhere, so the
 *   footer's "Cookies" control, the gallery's "Load more" button and
 *   `/upload`'s form bottom could sit behind this banner, unreachable by
 *   scroll, for the whole first-visit session. Fixed by measuring the
 *   banner's own rendered height and reserving exactly that much space
 *   while it's open — a `ResizeObserver` rather than a fixed guess, since
 *   the banner wraps to a second line (and a taller box) on narrow
 *   viewports.
 * - Round 2 finding 4: that fix wrote `document.body.style.paddingBottom`
 *   directly — a bare, unnamespaced global property any future
 *   fixed-position overlay (a toast, a mobile nav drawer, a second banner)
 *   reserving space the same way would silently clobber. Fixed by owning
 *   ONE namespaced CSS custom property instead (`--cookie-banner-reserved-
 *   height`, set via `style.setProperty`), consumed by a
 *   `padding-bottom: var(--cookie-banner-reserved-height, 0px)` rule on
 *   `body` in globals.css — composable with anything else that reserves
 *   its own differently-named variable, rather than two consumers racing
 *   to overwrite the same bare property.
 * - Finding 9 (reopening via "Cookies" neither moves focus nor announces):
 *   fixed by moving focus to a heading inside the banner whenever
 *   `reopenCount` increments (never on the very first, no-stored-choice
 *   open — see consent-context.tsx's own comment on why). This is the
 *   PRIMARY, reliable announcement mechanism — a focus move is always
 *   perceivable to assistive tech, in every browser/screen-reader
 *   combination, because it is the same signal any other reopened control
 *   relies on.
 * - Round 2 finding 8: `aria-live="polite"` was also added in round 1, on
 *   the theory that it would announce the region's reappearance even
 *   before focus lands. That's optimistic: this whole subtree unmounts
 *   (`if (!bannerOpen) return null;` below) and remounts from scratch on
 *   reopen, rather than staying present and toggling content — several
 *   screen-reader/browser combinations only reliably announce `aria-live`
 *   updates to content changing INSIDE an already-present live region, not
 *   a brand-new subtree appearing with the attribute already on it. Kept
 *   anyway as a harmless, best-effort secondary signal for the
 *   combinations that DO announce it — but the focus move above is what
 *   this component actually relies on; not a reason to go remove a
 *   worthwhile attribute that costs nothing when it doesn't help.
 */
export function CookieBanner() {
  const { bannerOpen, acceptOptional, onlyNecessary, reopenCount } = useConsent();
  const bannerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastHandledReopenCount = useRef(reopenCount);

  // Reserve space for the banner so it never covers interactive content
  // beneath it, for as long as it's open (round 1 finding 8, round 2
  // finding 4 — see this component's own doc comment above for both).
  useIsomorphicLayoutEffect(() => {
    if (!bannerOpen) return undefined;
    const el = bannerRef.current;
    if (!el) return undefined;

    const applyReservedHeight = () => {
      document.body.style.setProperty(
        "--cookie-banner-reserved-height",
        `${el.offsetHeight}px`,
      );
    };
    applyReservedHeight();

    const supportsResizeObserver = typeof ResizeObserver !== "undefined";
    const observer = supportsResizeObserver ? new ResizeObserver(applyReservedHeight) : null;
    observer?.observe(el);

    return () => {
      observer?.disconnect();
      document.body.style.removeProperty("--cookie-banner-reserved-height");
    };
  }, [bannerOpen]);

  // Finding 9: move focus into the banner when it was explicitly reopened
  // (reopenCount changed since last render) — but not on the initial
  // mount-time open a first-time visitor with no stored choice gets, which
  // is why this compares against a ref rather than firing on every open.
  useIsomorphicLayoutEffect(() => {
    if (reopenCount === lastHandledReopenCount.current) return;
    lastHandledReopenCount.current = reopenCount;
    if (bannerOpen) headingRef.current?.focus();
  }, [reopenCount, bannerOpen]);

  if (!bannerOpen) return null;

  return (
    <div
      ref={bannerRef}
      role="region"
      aria-label="Cookies"
      aria-live="polite"
      /*
       * bg-background, not bg-popover: button.tsx's `outline` variant (used
       * by both buttons below) renders its resting label in `text-primary`,
       * measured against `--background` (see button.tsx's own PETROL_
       * OUTLINE_STYLE comment and the header's identical bg-background
       * choice) — not against `--popover`, which is a different fill this
       * repo's contrast gate never paired it with. An axe run against this
       * banner (round 1, this bead) measured 1.81:1 on `--popover` in dark
       * mode before this was caught — bg-background is the one surface this
       * component is actually proven to work on.
       */
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-4 py-4 shadow-lg sm:px-6"
    >
      <h2 ref={headingRef} tabIndex={-1} className="sr-only">
        Cookies
      </h2>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-prose text-sm text-foreground">
          {COOKIE_BANNER_COPY}
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onlyNecessary}>
            {COOKIE_BANNER_DECLINE_LABEL}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={acceptOptional}>
            {COOKIE_BANNER_ACCEPT_LABEL}
          </Button>
        </div>
      </div>
    </div>
  );
}
