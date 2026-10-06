"use client";

import { Popover } from "@base-ui/react/popover";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** A Server Action — `async () => { "use server"; ... }` — handed down as a prop; see this file's own comment. */
export type SignInFormAction = () => Promise<void>;

/**
 * The header's single sign-in control (ugcportal-qqnt.3), replacing the two
 * always-visible outline buttons ("Sign in with Google" / "Sign in with
 * Facebook") auth-status.tsx used to render side by side. Sign-in here is a
 * closed operator allowlist (src/config/users.ts) — a visitor who cannot use
 * either provider used to see two controls they could never use, and the
 * visible label also rendered with a double space ("Sign in with  Google")
 * from the `&nbsp;` before an adjacent JSX text node. One "Sign in" trigger
 * fixes both: there is exactly one control whose accessible name starts with
 * "Sign in" (K1), and each provider button's own label is now just its
 * provider name, with no "Sign in with" prefix left to double a space.
 *
 * Neither provider form is REMOVED (K3) — both `googleAction`/`facebookAction`
 * are still the same `signIn("google")`/`signIn("facebook")` Server Actions
 * auth-status.tsx always called, just handed down as props instead of used
 * directly in a `<form action={...}>` written in this file. Passing a Server
 * Action from a Server Component to a Client Component as a prop is a
 * supported Next.js pattern (the action itself, not this component, is what
 * crosses the server/client boundary) — this file never calls `signIn`
 * itself, it only renders the two forms whose `action` a parent hands it.
 *
 * Built on `@base-ui/react/popover`, the same primitive and the same reasons
 * src/components/mobile-nav-toggle.tsx already uses it for the mobile nav
 * disclosure — see that file's own comment for the fuller account (Escape
 * and outside-press dismissal, focus return to the trigger, both free from
 * the library rather than hand-rolled and inevitably incomplete). Unlike
 * that component, this one does NOT override `Popup`'s default `role`: a
 * small set of action buttons behind a disclosure trigger is a reasonable
 * fit for the library's own default `role="dialog"` (non-modal — nothing
 * here traps focus or blocks interaction with the rest of the page), so
 * `Trigger`'s matching default `aria-haspopup="dialog"` is left alone too,
 * rather than relabelled to a token ("menu") this still would not earn —
 * the two provider buttons are plain submit buttons, not real menuitems with
 * arrow-key roving focus.
 */
export function SignInMenu({
  googleAction,
  facebookAction,
}: {
  googleAction: SignInFormAction;
  facebookAction: SignInFormAction;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={(triggerProps) => (
          <Button {...triggerProps} type="button" variant="outline" size="header-sm">
            Sign in
          </Button>
        )}
      />

      <Popover.Portal>
        {/*
          z-30, the same tier mobile-nav-toggle.tsx's own panel uses, for the
          same reason (that file's own comment): above this header's sticky
          z-20 so the panel does not paint under it once the header is
          actually "stuck" to the top of a scrolled page.
        */}
        <Popover.Positioner align="end" sideOffset={8} className="z-30">
          <Popover.Popup
            aria-label="Choose a sign-in provider"
            className="flex min-w-36 flex-col gap-1 rounded-lg border border-border bg-background p-2 shadow-md"
          >
            <form action={googleAction}>
              <Button type="submit" variant="outline" size="header-sm" className="w-full">
                Google
              </Button>
            </form>
            <form action={facebookAction}>
              <Button type="submit" variant="outline" size="header-sm" className="w-full">
                Facebook
              </Button>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
