"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * The item page's share affordance (ugcportal-lju K2).
 *
 * LOADS NO THIRD-PARTY SCRIPT AND WRITES NO NON-ESSENTIAL STORAGE, by
 * construction rather than by review: the two branches below are
 * `navigator.share` (a browser-native API, not a script tag) and
 * `navigator.clipboard.writeText` (ditto) — nothing here reaches for a
 * share-widget SDK, an analytics beacon, or `localStorage`/cookies. That is
 * exactly why this bead's own notes treat a share button as NOT needing
 * ugcportal-3wgp's consent gate: a widget that phoned a third party would.
 *
 * ONE LABEL, "Share", in every render — not a server/client-conditional
 * label picked from `typeof navigator.share`. `navigator` does not exist
 * during server rendering, so branching the LABEL on its presence would
 * make the server-rendered markup and the first client render disagree
 * (React would either warn on hydration or — since this is a plain
 * attribute, not structural content — silently keep the server's string
 * until a later re-render re-decided it). The capability check instead
 * happens inside the click handler, which only ever runs in the browser:
 * `navigator.share` when present, falling back to copying the URL to the
 * clipboard when it is not. A visually-hidden live region announces which
 * branch ran, since a sighted mouse user sees the native share sheet (or
 * nothing, on a silent clipboard copy) but a screen-reader user hears
 * neither on its own.
 *
 * `window.location.href`, not a URL built from `siteOrigin()` and threaded
 * down as a prop: `siteOrigin()` (src/lib/origin.ts) returns `null` in
 * production when `AUTH_URL` is unset or malformed, by design — see that
 * module's own comment — and this control has no reason to go dark along
 * with the canonical link and the Open Graph tags when that happens. The
 * page the visitor is actually looking at always has a real location, with
 * or without `AUTH_URL` configured, so reading it client-side is both
 * simpler and strictly more available than propagating the server-side
 * origin decision into this component too.
 */
const STATUS_MESSAGE: Record<"copied" | "shared" | "failed", string> = {
  copied: "Link copied",
  shared: "Shared",
  failed: "Could not copy the link",
};

export function ShareControl({
  title,
  text,
}: {
  title: string;
  text: string;
}) {
  const [status, setStatus] = useState<"idle" | "shared" | "copied" | "failed">(
    "idle",
  );
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Revert the transient status back to the resting "Share" label after a
  // few seconds, and clear the timer on unmount so it never fires a state
  // update against an unmounted component (e.g. the visitor navigates away
  // right after copying).
  useEffect(() => {
    return () => {
      if (revertTimer.current !== null) clearTimeout(revertTimer.current);
    };
  }, []);

  function announce(next: "shared" | "copied" | "failed") {
    setStatus(next);
    if (revertTimer.current !== null) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => setStatus("idle"), 4000);
  }

  async function handleShare() {
    const url = window.location.href;

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text, url });
        announce("shared");
      } catch {
        // AbortError (the user dismissed the share sheet) and any other
        // failure both land here. Neither is an error this control reports:
        // the native share sheet already gave its own feedback (or the user
        // simply closed it), and falling back to a clipboard copy after a
        // deliberate cancel would surprise rather than help.
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      announce("copied");
    } catch {
      announce("failed");
    }
  }

  return (
    <div className="mt-6 flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        onClick={handleShare}
        data-share-control
      >
        Share
      </Button>
      {/*
        Visible AND an `aria-live` region, not `sr-only`: a sighted visitor
        who used the clipboard fallback (no native share sheet appears at
        all in that branch) gets no other signal that anything happened.
      */}
      <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {status === "idle" ? "" : STATUS_MESSAGE[status]}
      </span>
    </div>
  );
}
