import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/**
 * Restyled onto the ugcportal-axu tokens, then onto the petrol palette
 * (ugcportal-rw9j).
 *
 * Four changes worth knowing about:
 *
 * 1. The `dark:` duplicates are gone. There is one theme per mode (see
 *    globals.css), so a `dark:` variant of a token-driven class would just be
 *    a second, hand-maintained copy of what the dark media-query override in
 *    globals.css already gives every token for free.
 * 2. Every alpha-modified colour utility here ships at an alpha the contrast
 *    gate has measured (RING_ALPHA_MODIFIER and
 *    DESTRUCTIVE_EDGE_ALPHA_MODIFIER in src/lib/design/contrast.ts), and a
 *    coverage test scans this file and fails on any alpha the gate has not
 *    seen. shadcn's stock ring and destructive-border alphas both measure
 *    below 3:1 on the lighter surfaces of this palette, so they are not an
 *    option here.
 * 3. The primary hover is an opaque step along the petrol ramp rather than an
 *    alpha fade, so the button's label sits on a background that does not
 *    depend on what happens to be behind the button.
 * 4. `outline` and `secondary` (ugcportal-rw9j) are the one petrol treatment
 *    docs/design/tokens.css's `.btn-outline` describes, not two different
 *    styles: a petrol border and label, transparent fill, hover moves to
 *    --primary-hover. They read `--primary`/`--primary-hover` directly rather
 *    than through `--border`/`--input`/`--accent` or `--secondary` (all
 *    untouched this phase, still the near-black surface scale - see
 *    globals.css's phase-1-mandate comment) precisely so this one petrol
 *    treatment works on the new canvas without waiting for fase 2. The hover
 *    state only moves the border/label colour, not the fill: `--primary-hover`
 *    (petrol-500 in light mode) measures 4.48:1 as TEXT on --paper, just under
 *    the 4.5:1 body text needs, so it is fine as a 3:1 non-text boundary but
 *    not as a second text colour on top of the resting one.
 * 5. `outline-neutral` (ugcportal-rw9j review round 4) exists for exactly one
 *    caller: src/app/upload/upload-queue-list.tsx's "Try again" button,
 *    which sits inside the untouched bg-destructive-surface well rather than
 *    on --background, where PETROL_OUTLINE_STYLE measures only 1.87:1.
 *    First fixed (rounds 2-3) as an inline className override that
 *    restated and inverted every PETROL_OUTLINE_STYLE utility at the call
 *    site - fragile by construction, confirmed the hard way when round 3
 *    found the first version of that override missed three of its six
 *    utilities. A real variant means "the pre-rw9j neutral outline" is a
 *    single word at the call site instead of a string a reviewer has to
 *    diff against PETROL_OUTLINE_STYLE by hand; border-input is
 *    --color-line-strong, already measured at 3:1+ against every near-black
 *    surface including this one (control-edge-on-destructive-surface in
 *    contrast.ts).
 * 6. THE RULE (ugcportal-qqnt.2): every button-like control on the public
 *    pages (header, hero, empty state) resolves to one of this file's own
 *    `buttonVariants` class sets - never a hand-written `inline-flex ...
 *    rounded-*` string at the call site (button-system.test.tsx's K3
 *    describe block enforces the second half of that; round-1 review,
 *    CONFIRMED low - an earlier version of this sentence pointed at
 *    src/components/type-scale.test.tsx instead, which exists but is
 *    entirely about heading type-scale sizing and asserts nothing about
 *    hand-written button classes).
 *    Which variant is primary depends on the SURFACE, not on taste:
 *      - on --background (the paper canvas): `default` is primary, `outline`
 *        is secondary - this is what src/components/auth-status.tsx's
 *        sign-in controls and the empty state's portfolio link both use.
 *      - on the hero's petrol-GRADIENT well (`.home-hero-surface`):
 *        `default-tint` is primary - see that variant's own comment for why
 *        it is not `default-neutral`.
 *      - on the untouched near-black surface scale (bg-surface-0..4 /
 *        bg-destructive-surface - fase 2's job, not this bead's):
 *        `default-neutral` is primary, `outline-neutral` is secondary.
 *    The shared `rounded-lg` radius (`--radius-lg`, 10px - the same figure
 *    docs/design/tokens.css's `--radius-card` names for a tile, which is why
 *    src/components/gallery/containment.ts's `GALLERY_TILE_BASE_CLASS` moved
 *    onto `rounded-lg` too) applies to every PUBLIC-PAGE button-like control
 *    this bead actually touches - hero's and empty state's `lg`-sized
 *    controls, and the header's sign-in/sign-out controls via the
 *    `header-sm` size below - not to every `size` key wholesale (round-1
 *    review, CONFIRMED medium: an earlier version of this change removed
 *    the smaller radius cap from `xs`/`sm`/`icon-xs`/`icon-sm` entirely,
 *    which silently changed the computed radius of every OTHER `size="sm"`
 *    caller this bead neither touches nor verifies - see the `size`
 *    variants' own comment below for the restored cap and the new
 *    `header-sm` size).
 */
const PETROL_OUTLINE_STYLE =
  "border-primary bg-transparent text-primary hover:border-primary-hover hover:underline aria-expanded:border-primary-hover aria-expanded:underline"

const NEUTRAL_OUTLINE_STYLE =
  "border-input bg-transparent text-ink hover:border-input hover:bg-accent hover:text-accent-foreground hover:no-underline aria-expanded:border-input aria-expanded:bg-accent aria-expanded:no-underline"

/**
 * `sm`'s box-model/typography/icon-sizing tokens, named once so `header-sm`
 * (ugcportal-qqnt.2 round 2, finding 5 - LOW, CONFIRMED) derives from the
 * SAME tokens `sm` uses rather than hand-copying them a second time. Before
 * this, `header-sm`'s definition retyped `sm`'s `h-7`/`gap-1`/`px-2.5`/
 * `text-[0.8rem]`/icon-size classes verbatim, so a future edit to `sm`'s box
 * model could silently drift the two apart with nothing to catch it (the
 * regression guard in button-system.test.tsx checks `sm` against a
 * historical snapshot of ITSELF, not against `header-sm`). `sm`'s own radius
 * cap and its `in-data-[slot=button-group]:rounded-lg` escape hatch stay OUT
 * of these three constants on purpose: that is the one thing `header-sm` is
 * supposed to differ on (see the `size` comment below) - sharing it too
 * would undo the whole point of `header-sm` existing.
 */
const SM_BOX_MODEL = "h-7 gap-1"
const SM_PADDING_AND_TEXT = "px-2.5 text-[0.8rem]"
const SM_ICON_SIZING =
  "has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5"

const buttonVariants = cva(
  /*
   * `aria-disabled:pointer-events-none aria-disabled:opacity-50` sits right
   * beside the `disabled:` pair (ugcportal-jx4 round-2 review finding), not
   * hand-rolled at a call site: a `focusableWhenDisabled` button (base-ui's
   * own escape hatch for staying focusable while busy — see
   * src/components/gallery/gallery.tsx's "Load more") renders
   * `aria-disabled="true"` instead of the native `disabled` attribute, so the
   * `disabled:` variant never matches it. Any such button gets the same
   * dimmed/non-interactive look for free, rather than every caller re-deriving
   * it. `aria-disabled:opacity-50` reuses the same alpha the `disabled:`
   * variant already applies, so it carries no new value for the contrast
   * gate's own alpha-coverage check (src/lib/design/usage.ts) to learn.
   *
   * `motion-safe:` on `active:not-aria-[haspopup]: translate-y-px` (space
   * inserted before the utility, here only - round-5 review: Tailwind's
   * source scanner reads raw file bytes, not AST-aware JS, so the bare,
   * un-prefixed combination written UNBROKEN in a comment is itself a
   * valid candidate and got compiled into the real production stylesheet,
   * reintroducing the exact ungated rule this fix removes; see
   * containment.ts's own `GALLERY_TILE_IMAGE_CLASS` comment, which hit the
   * identical problem, for the full account) (ugcportal-ig4g, closing
   * ugcportal-52ue): the 1px press offset is a `translate-*`
   * utility with no `motion-safe:`/`motion-reduce:` guard at all, the exact
   * "no-guard" shape src/lib/design/motion-reduce-pairing.test.ts's K2 scan
   * now flags for any `hover:`/`group-hover:`/`active:`/`focus:`-triggered
   * scale/translate/rotate/skew utility — under `prefers-reduced-motion:
   * reduce` it still animated on every press. `motion-safe:` on the
   * triggering utility itself (not a `motion-reduce:translate-none` override
   * on the result) is the same fix containment.ts's own hover scale uses,
   * for the same reason: it removes the rule from the stylesheet entirely
   * under `reduce`, rather than relying on it losing a specificity contest
   * it might not win.
   *
   * No bare `outline-none` here (ugcportal-oavb, fixing a gap `outline-none`
   * plus a box-shadow-only `focus-visible` ring left on EVERY caller of this
   * base, not only the two PR #122 patched locally): `forced-colors: active`
   * (Windows High Contrast and similar UA modes) ignores `box-shadow`
   * entirely, so `focus-visible:ring-3 focus-visible:ring-ring/80` alone paints
   * nothing there, and a bare `outline-none` does not merely fail to help —
   * Tailwind v4's `outline-none` compiles to `outline-style: none`, which
   * stays `none` under forced colors same as anywhere else, so focus became
   * fully invisible to a forced-colors user on every shared-system button.
   * Reaching instead for this repo's own `outline-hidden` idiom (the
   * transparent-but-forced-colors-visible outline most of this app's other
   * focusable elements use) is not an option UNCONDITIONALLY at the base:
   * `outline-hidden` is not gated to `:focus-visible`, so painting it on
   * every button at rest would show a permanent, always-on box under forced
   * colors, not only while focused. `focus-visible:outline-solid` +
   * `focus-visible:outline-2` + `focus-visible:outline-offset-2` +
   * `focus-visible:outline-transparent` is the combination that actually
   * works, confirmed by compiling this file with `@tailwindcss/node` and
   * rendering under Playwright's `forcedColors: "active"` emulation: a bare
   * `focus-visible:outline`/`outline-2` only READS the shared
   * `--tw-outline-style` custom property, it does not SET it, so stacked on
   * top of no outline-style at all it still resolves to nothing —
   * `outline-solid` is the utility that actually sets `outline-style: solid`
   * at `:focus-visible`'s specificity. `outline-transparent` keeps this
   * invisible outside forced-colors mode (verified: `outlineColor: "rgba(0,
   * 0, 0, 0)"` there, the existing box-shadow ring design unchanged), while
   * forced-colors mode substitutes its own system highlight colour for that
   * `transparent` the instant the control is actually focused (verified:
   * `outlineStyle: "solid"` only once focused, `"none"` before and after
   * blur). This was first proven out as a scoped override at exactly two
   * call sites (src/components/home/hero.tsx, src/components/home/
   * empty-state.tsx, PR #122 round 4) before landing here in the shared
   * base, which is why both of those files' own overrides and comments are
   * gone now — every caller gets this for free instead of two having it and
   * the rest (the header's sign-in controls among them) silently not.
   */
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/80 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent motion-safe:active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive/75 aria-invalid:ring-3 aria-invalid:ring-destructive/80 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // The only solid petrol fill in the system, for the one primary
        // action on a surface. Everything else is neutral or outlined, so
        // this reads as emphasis rather than as decoration.
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        /*
         * ugcportal-rw9j review round 5 (code-review): the filled-button
         * counterpart to outline-neutral, for the identical reason - a
         * `default`-variant caller inside a well still on the untouched
         * near-black surface scale (bg-surface-0..4 / bg-destructive-surface)
         * measures --primary at only 1.59-2.03:1 there in light mode, same
         * root cause as outline-neutral's own PETROL_OUTLINE_STYLE gap.
         * --color-petrol-400 (the pre-rw9j --ring/--sidebar-primary value)
         * paired with --petrol-900 as the label (the same fill-light/label-
         * dark pairing dark mode's own --primary already uses) measures
         * 4.8-7.75:1 against every old surface and (originally, with
         * `--petrol-900` as the label - see this variant's own comment
         * below for why that token changed to `--color-surface-0` under
         * ugcportal-ei5c) 6.02:1 for the label on its own fill - a NEW
         * measurement this round (contrast.ts's
         * petrol-400-fill-on-old-surface-* and, at the time,
         * petrol-900-on-petrol-400), not one focus-ring-on-old-surface
         * already covered: that pairing
         * only ever checked this same token at RING_ALPHA_MODIFIER alpha,
         * a different, weaker ratio than the full-opacity fill this variant
         * paints. `hover:brightness-95` rather than a second new token: this
         * is a contrast fix for an untouched-surface caller, not a second
         * filled-button treatment to design and verify.
         *
         * FIXED (ugcportal-ei5c): this used to read `text-petrol-900`, which
         * does not compile to any rule at all - `--color-petrol-900` (the
         * OKLCH near-black scale's version of this token) is declared in
         * :root, not @theme, specifically so Tailwind does NOT emit a
         * `text-`/`bg-` utility for it (see globals.css's own "stopping
         * Tailwind emitting bg-petrol-900 and friends" comment) - confirmed
         * empirically by compiling globals.css and checking the generated
         * utilities. The label therefore rendered in whatever colour the
         * caller happened to inherit, never petrol-900, while contrast.ts
         * documented a ratio (`petrol-900-on-petrol-400`) for a colour
         * nothing painted - a false claim of coverage for the one real
         * caller (the upload queue's "Try again" button). `text-surface-0`
         * is the fix: the same fill-light/label-dark shape, but with the
         * token `default-tint` below already uses for the identical reason
         * - genuinely declared in `@theme`, so the utility compiles, and a
         * real near-black, so nothing about the look changes. Its own
         * contrast.ts pairing (`surface-0-on-petrol-400`, replacing the
         * dead one) measures 7.75:1 in both colour schemes (neither token
         * is overridden per mode) - not reused from `default-tint`'s own
         * `surface-0-on-petrol-100` pairing, because that fill is
         * `--color-petrol-100` (L 0.95), lighter than this variant's
         * `--color-petrol-400` (L 0.72), so the ratio does not carry over.
         * The upload dropzone's "Choose files" label
         * (src/app/upload/upload-form.tsx) pastes the same
         * `bg-petrol-400`/`text-petrol-900` pair directly rather than
         * going through this variant, so it keeps the identical
         * never-compiles bug - disclosed, not fixed, in contrast.ts and in
         * that file's own comment, since it is not a call site of this
         * variant and is out of this bead's stated scope.
         */
        "default-neutral": "bg-petrol-400 text-surface-0 hover:brightness-95",
        /*
         * ugcportal-qqnt.2: the primary action on the front page's petrol-
         * GRADIENT well (`.home-hero-surface`, src/components/home/
         * hero.tsx) - a DIFFERENT surface from `default-neutral`'s untouched
         * near-black surface scale, so it needs its own fill rather than
         * reusing that one (a near-black-tuned fill is not verified against
         * this gradient, and vice versa). Light petrol-tint fill, dark
         * label - the same fill-light/label-dark shape `default-neutral`
         * uses, and (since ugcportal-ei5c) the same `text-surface-0` label
         * token too - but a different, lighter fill (`petrol-100` here vs
         * `petrol-400` there), so its own contrast.ts pairing rather than
         * assuming the ratio carries over. Colours and hover step are
         * exactly what the hero's own hand-styled CTA already used, moved
         * here unchanged: `surface-0-on-petrol-100` and
         * `surface-0-on-petrol-100-hover` in contrast.ts measure this exact
         * fill/label/hover-fill combination already, so adopting the shared
         * Button here needed no new contrast pairing.
         */
        "default-tint": "bg-petrol-100 text-surface-0 hover:bg-petrol-200",
        outline: PETROL_OUTLINE_STYLE,
        secondary: PETROL_OUTLINE_STYLE,
        "outline-neutral": NEUTRAL_OUTLINE_STYLE,
        /*
         * text-ink, not text-foreground (ugcportal-rw9j review round 2):
         * every current ghost-button usage (src/app/upload/upload-queue-
         * list.tsx - Cancel, Clear, Remove) renders inside a near-black well
         * (bg-surface-1, bg-destructive-surface), never on --background -
         * text-foreground now means "whatever pairs with --background" and
         * measured ~1.06-1.3:1 there. text-ink is the token those wells are
         * actually measured against (ink-on-surface-N, ink-on-destructive-
         * surface in contrast.ts). The hover state already swaps to
         * text-accent-foreground (also --color-ink), unaffected either way.
         */
        ghost:
          "text-ink hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent",
        destructive:
          "border-destructive/75 bg-destructive-surface text-destructive hover:bg-destructive-surface-hover focus-visible:border-destructive focus-visible:ring-destructive/80",
        link: "text-primary underline-offset-4 hover:underline",
      },
      /*
       * ugcportal-qqnt.2, round-1 review (CONFIRMED medium): `xs`/`sm`/
       * `icon-xs`/`icon-sm` cap their radius at a smaller
       * `rounded-[min(var(--radius-md),Npx)]` than the base class's own
       * `rounded-lg`, with an `in-data-[slot=button-group]:rounded-lg`
       * override standing by for the one context (a `ButtonGroup`) that
       * needs the base radius back. An earlier version of this bead removed
       * that cap from all four sizes entirely, on the theory that "one
       * radius token for all interactive elements" (this bead's own
       * description) meant no size should keep a smaller one. That silently
       * changed the COMPUTED radius of every `size="sm"`/`"xs"` caller this
       * bead neither touches nor verifies -
       * src/app/admin/settings/instagram/page.tsx,
       * src/app/admin/settings/rights/decision-form.tsx,
       * src/app/admin/settings/users/page.tsx,
       * src/app/upload/upload-queue-list.tsx, src/app/auth/error/page.tsx
       * and src/components/consent/cookie-banner.tsx all render a
       * `size="sm"` button today, none of them in this bead's stated scope
       * (admin and upload buttons are explicitly OUT of scope per the
       * bead's own description). The cap below is restored byte-for-byte
       * from before this bead - button-system.test.tsx's regression guard
       * renders CookieBanner and asserts its button's computed class list
       * is unchanged - so every one of those callers keeps the exact
       * radius it had before this bead, unexamined and unchanged.
       *
       * `header-sm`, not a change to `sm` itself, is how
       * src/components/auth-status.tsx's sign-in/sign-out controls get the
       * one radius K2 asks for: identical `h-7`/`gap-1`/`px-2.5`/
       * `text-[0.8rem]` dimensions to `sm` (so the header stays exactly as
       * compact at 320px - see auth-status.tsx's own comment on why that
       * width matters there), but WITHOUT the radius cap, so it falls
       * through to the base class's `rounded-lg` the same way hero's and
       * empty state's uncapped `lg` controls do. Whether the all-sizes-10px
       * radius is the right design for every OTHER `sm`/`xs` caller too is
       * an open question this bead does not decide here - noted in the
       * PR body as a follow-up for the parent epic (ugcportal-qqnt), not
       * settled by this change.
       */
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: `${SM_BOX_MODEL} rounded-[min(var(--radius-md),12px)] ${SM_PADDING_AND_TEXT} in-data-[slot=button-group]:rounded-lg ${SM_ICON_SIZING}`,
        // See the `size` comment above: derived from the SAME
        // SM_BOX_MODEL/SM_PADDING_AND_TEXT/SM_ICON_SIZING constants `sm`
        // itself uses, minus the radius cap, reserved for the header's
        // public-page controls so K2 holds without changing what every
        // other `size="sm"` caller renders.
        "header-sm": `${SM_BOX_MODEL} ${SM_PADDING_AND_TEXT} ${SM_ICON_SIZING}`,
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
