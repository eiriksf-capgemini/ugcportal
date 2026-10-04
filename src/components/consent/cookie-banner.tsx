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
 * Round 5, LOW finding 3: where to send focus when the captured invoker is
 * still attached to the document but `.focus()` on it did not actually move
 * `document.activeElement` (e.g. it became `disabled`/`inert`/lost its own
 * focusability between capture and restore). Exported for its own direct
 * unit test, independent of the full banner mount/unmount cycle.
 *
 * First choice: the live "Cookies" trigger, looked up fresh by the stable
 * `data-cookie-settings-trigger` attribute (cookie-settings-link.tsx) —
 * NOT the stale captured ref, in case an equivalent, currently-focusable
 * control is right there even though the one originally captured is not.
 *
 * Second choice: the page's own `<h1>`. Every page in this repo renders
 * exactly one (app-shell.tsx's own documented convention, enforced by
 * gallery.test.tsx's "has exactly one <h1>"), so it is always present and
 * is already the visitor's own landmark for "where this page's content
 * starts" — a far more sensible landing spot than an unannounced, unfocused
 * <body>. Headings are not natively focusable; `tabIndex="-1"` is added if
 * missing (the same technique this component's own sr-only `<h2>` already
 * relies on above) and left in place afterwards — that only removes the
 * element from the SEQUENTIAL tab order's reach (Tab/Shift+Tab), not from
 * programmatic focus, same as that sr-only heading.
 */
export function focusFallbackTarget(): void {
  const trigger = document.querySelector<HTMLElement>("[data-cookie-settings-trigger]");
  if (trigger && document.contains(trigger)) {
    trigger.focus();
    if (document.activeElement === trigger) return;
  }

  const heading = document.querySelector<HTMLElement>("h1");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus();
}

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
 *   fixed by moving focus to a heading inside the banner on a genuine
 *   CLOSED -> OPEN transition. This is the PRIMARY, reliable announcement
 *   mechanism — a focus move is always perceivable to assistive tech, in
 *   every browser/screen-reader combination, because it is the same
 *   signal any other reopened control relies on.
 * - Round 3 finding 4: the first version of this fix tracked a `reopenCount`
 *   that incremented on every `reopen()` call, and moved focus whenever
 *   that count changed (while the banner was open). That is not the same
 *   thing as "the banner just transitioned from closed to open" — clicking
 *   the footer "Cookies" control WHILE the first-visit banner was still
 *   showing (never yet dismissed) also called `reopen()`, incrementing the
 *   count and yanking focus into a banner that was already visible and
 *   that the visitor may have been about to interact with elsewhere. Fixed
 *   by tracking whether the banner was ACTUALLY closed on the previous
 *   render instead (`wasOpenRef` below) — `reopenCount` is no longer
 *   needed anywhere (removed from ConsentContext entirely) since every
 *   post-mount `bannerOpen` closed -> open transition is, by construction,
 *   only ever caused by `reopen()` in the first place.
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
  const { bannerOpen, acceptOptional, onlyNecessary } = useConsent();
  const bannerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wasOpenRef = useRef(bannerOpen);
  const invokingElementRef = useRef<HTMLElement | null>(null);

  // Reserve space for the banner so it never covers interactive content
  // beneath it, for as long as it's open (round 1 finding 8, round 2
  // finding 4 — see this component's own doc comment above for both).
  //
  // Round 3, finding 9: a ResizeObserver plus a CSS variable is heavier
  // than two hardcoded heights (one for mobile, one for desktop) would be.
  // Kept anyway: the banner's real height isn't actually two discrete
  // values — it depends on viewport width continuously (the copy wraps at
  // whatever width it wraps at, not at one named breakpoint), on the
  // visitor's font-size/zoom settings, and on the copy's own length, which
  // a future edit could change. Two hardcoded numbers would be a pair of
  // magic constants silently wrong the next time any of those shift;
  // measuring the real rendered box is correct by construction regardless
  // of why it changed.
  //
  // Round 4, LOW finding 8, ACCEPTED AND DOCUMENTED rather than fixed: this
  // measurement only happens once this effect runs, client-side, after
  // hydration. globals.css's fallback (`padding-bottom: var(--cookie-
  // banner-reserved-height, 0px)`) means the server-rendered first paint —
  // which DOES already show the banner, since `bannerOpen` is decided
  // server-side from the cookie — has no reserved padding at all for one
  // frame, until this effect corrects it. Setting an initial server-
  // rendered value would need the same kind of guessed constant the
  // comment above just argued against (a real measurement isn't available
  // server-side at all — there is no layout pass to measure against), so
  // this is accepted as a brief, bounded pre-hydration window rather than
  // reintroducing a magic number to paper over it. The window is bounded
  // by hydration time, not by anything this component controls.
  useIsomorphicLayoutEffect(() => {
    if (!bannerOpen) return undefined;
    const el = bannerRef.current;
    if (!el) return undefined;

    const applyReservedHeight = (height: number) => {
      document.body.style.setProperty("--cookie-banner-reserved-height", `${height}px`);
    };
    applyReservedHeight(el.offsetHeight);

    const supportsResizeObserver = typeof ResizeObserver !== "undefined";
    const observer = supportsResizeObserver
      ? new ResizeObserver((entries) => {
          /*
           * Reads the SIZE THE OBSERVER ITSELF ALREADY MEASURED off the
           * entry (review round 3, finding 7), rather than re-reading
           * `el.offsetHeight` inside the callback — the observer has
           * already done that measurement; reading `offsetHeight` again
           * here would force a second, redundant synchronous layout.
           * `borderBoxSize` is the full box (border + padding + content),
           * matching what `offsetHeight` measures on the initial call
           * above; `contentRect` is content-box only and would
           * under-measure a banner with padding, so it is only the
           * fallback for an environment that provides neither (an older
           * engine with a partial ResizeObserver polyfill). `contentRect`
           * itself is optional-chained too (review round 4, finding 7) —
           * without it, an entry shape with neither `borderBoxSize` nor
           * `contentRect` at all (exactly the "provides neither" case this
           * fallback chain exists for) threw reading `.height` off
           * `undefined` instead of falling through to `el.offsetHeight`.
           */
          const entry = entries[0];
          const height =
            entry?.borderBoxSize?.[0]?.blockSize ?? entry?.contentRect?.height ?? el.offsetHeight;
          applyReservedHeight(height);
        })
      : null;
    observer?.observe(el);

    return () => {
      observer?.disconnect();
      document.body.style.removeProperty("--cookie-banner-reserved-height");
    };
  }, [bannerOpen]);

  // Finding 9: move focus into the banner on a genuine CLOSED -> OPEN
  // transition — never on the initial mount-time open a first-time
  // visitor with no stored choice gets (wasOpenRef's initial value equals
  // bannerOpen's own initial value, so there is no "transition" to detect
  // on the first render either way), and never when "Cookies" is clicked
  // while the banner is ALREADY showing (round 3 finding 4 — see this
  // component's own doc comment above).
  //
  // Round 4, LOW finding 5: closing the banner (accept/decline) left focus
  // wherever the browser defaults it once the clicked button unmounts
  // (typically <body>) — lost, rather than returned anywhere meaningful.
  // Fixed the way any accessible disclosure/dialog pattern does: capture
  // whatever had focus right before the banner opens on a REOPEN (the
  // footer "Cookies" control, in the one real path that reaches this),
  // and restore focus to it when the banner closes again. The very first,
  // mount-time open has no real "invoking control" at all (nothing was
  // clicked — the page simply loaded with the banner already showing), so
  // there is nothing captured for that case and closing it leaves the
  // browser's own default behaviour, same as before this fix for exactly
  // that one case.
  useIsomorphicLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = bannerOpen;

    if (bannerOpen && !wasOpen) {
      invokingElementRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      headingRef.current?.focus();
      return;
    }

    if (!bannerOpen && wasOpen) {
      const invoker = invokingElementRef.current;
      invokingElementRef.current = null;
      if (invoker && document.contains(invoker)) {
        invoker.focus();
        // Round 5, LOW finding 3: being attached (`document.contains`) is
        // necessary but not sufficient for `.focus()` to actually take —
        // the invoker could have gone `disabled`, `inert`, lost its
        // `tabIndex`, or otherwise become unfocusable between capture and
        // restore, in which case `.focus()` silently no-ops and focus is
        // left exactly where this whole effect exists to prevent: an
        // unannounced <body>. Detect that and fall back instead.
        if (document.activeElement !== invoker) focusFallbackTarget();
      }
    }
  }, [bannerOpen]);

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
