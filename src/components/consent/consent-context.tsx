"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  type ConsentChoice,
  writeStoredConsent,
} from "@/lib/consent";

type ConsentContextValue = {
  /** `null` means no choice has ever been made — optional things stay OFF. */
  consent: ConsentChoice | null;
  /**
   * Whether the banner (or the reopened choice, via the "Cookies" control)
   * should be visible right now. Independent of `consent` so that reopening
   * to change a stored choice doesn't briefly make the app forget the
   * previous choice — the gated loader keeps reading `consent`, not this.
   */
  bannerOpen: boolean;
  acceptOptional: () => void;
  onlyNecessary: () => void;
  /**
   * Reopens the choice — what the "Cookies" control (K4) calls.
   *
   * `invoker` is the element that triggered the reopen, taken from the
   * click event's own `currentTarget` (ugcportal-ysub item 7). The banner
   * restores focus to it when the choice closes again; see
   * `takeReopenInvoker`. Optional, because the banner's very first,
   * mount-time open has no invoking control at all.
   */
  reopen: (invoker?: HTMLElement | null) => void;
  /**
   * Hands the element captured by the most recent `reopen()` to the one
   * consumer that needs it (CookieBanner's focus-restoration effect) and
   * clears it, so a later close cannot restore focus using a stale
   * invoker from an earlier reopen.
   *
   * Kept in a ref rather than in state deliberately: it is read exactly
   * once, inside a layout effect, and is never rendered — making it state
   * would re-render every consumer of this context on a value nothing
   * displays.
   */
  takeReopenInvoker: () => HTMLElement | null;
};

const ConsentContext = createContext<ConsentContextValue | null>(null);

/**
 * The single source of truth for the visitor's consent choice, for every
 * consumer: the banner, the gated analytics loader, and the "Cookies"
 * settings control (ugcportal-3wgp).
 *
 * `initialConsent` comes from the server (src/lib/consent.server.ts, read in
 * src/app/layout.tsx via next/headers' `cookies()`) rather than being read
 * again on the client: the server already saw the same cookie the browser
 * sent with this request, so re-reading it here would only risk a mismatch
 * between the server-rendered markup and the first client render, not add
 * any information. A real drift (a cookie cleared mid-session in another
 * tab, say) is corrected the next time this provider mounts from a fresh
 * server render, same as any other cookie-derived server state in this app.
 */
export function ConsentProvider({
  initialConsent,
  children,
}: {
  initialConsent: ConsentChoice | null;
  children: ReactNode;
}) {
  const [consent, setConsent] = useState<ConsentChoice | null>(initialConsent);
  const [bannerOpen, setBannerOpen] = useState(initialConsent === null);

  const acceptOptional = useCallback(() => {
    writeStoredConsent("granted");
    setConsent("granted");
    setBannerOpen(false);
  }, []);

  const onlyNecessary = useCallback(() => {
    writeStoredConsent("denied");
    setConsent("denied");
    setBannerOpen(false);
  }, []);

  const reopenInvokerRef = useRef<HTMLElement | null>(null);

  const reopen = useCallback((invoker?: HTMLElement | null) => {
    reopenInvokerRef.current = invoker ?? null;
    setBannerOpen(true);
  }, []);

  const takeReopenInvoker = useCallback(() => {
    const invoker = reopenInvokerRef.current;
    reopenInvokerRef.current = null;
    return invoker;
  }, []);

  const value = useMemo<ConsentContextValue>(
    () => ({
      consent,
      bannerOpen,
      acceptOptional,
      onlyNecessary,
      reopen,
      takeReopenInvoker,
    }),
    [consent, bannerOpen, acceptOptional, onlyNecessary, reopen, takeReopenInvoker],
  );

  return (
    <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>
  );
}

export function useConsent(): ConsentContextValue {
  const value = useContext(ConsentContext);
  if (value === null) {
    throw new Error("useConsent must be used within a ConsentProvider");
  }
  return value;
}

/**
 * The one non-throwing way to read consent context (review round 5, LOW
 * finding 7) — `null` outside a `ConsentProvider`, same as
 * `useContext(ConsentContext)` itself already returns, rather than
 * `useConsent()`'s own deliberate throw.
 *
 * `useConsent()` above throws BY DESIGN (see its own code and
 * consent-context.test.tsx's "throws rather than silently reporting no
 * choice") — that stays unchanged: every consumer that actually NEEDS a
 * consent choice to do its job (the banner, AnalyticsLoader) should keep
 * failing loudly if mounted without a provider, since silently reporting
 * "no choice" there would be indistinguishable from a real first-time
 * visitor and mask a real wiring bug.
 *
 * `CookieSettingsLink` is different: it is a single optional footer link
 * whose only job, absent a provider, is to not exist — not to report
 * anything about consent at all. This hook exists for exactly that one
 * tolerant consumer, not as a general-purpose replacement for
 * `useConsent()` elsewhere.
 */
export function useOptionalConsent(): ConsentContextValue | null {
  return useContext(ConsentContext);
}
