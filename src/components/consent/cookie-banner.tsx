"use client";

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
 */
export function CookieBanner() {
  const { bannerOpen, acceptOptional, onlyNecessary } = useConsent();

  if (!bannerOpen) return null;

  return (
    <div
      role="region"
      aria-label="Cookies"
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
