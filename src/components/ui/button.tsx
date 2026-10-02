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
 */
const PETROL_OUTLINE_STYLE =
  "border-primary bg-transparent text-primary hover:border-primary-hover hover:underline aria-expanded:border-primary-hover aria-expanded:underline"

const NEUTRAL_OUTLINE_STYLE =
  "border-input bg-transparent text-ink hover:border-input hover:bg-accent hover:text-accent-foreground hover:no-underline aria-expanded:border-input aria-expanded:bg-accent aria-expanded:no-underline"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/80 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive/75 aria-invalid:ring-3 aria-invalid:ring-destructive/80 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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
         * --color-petrol-400 (the pre-rw9j --ring/--sidebar-primary value,
         * already verified at 4.8-7.75:1 against every old surface by
         * focus-ring-on-old-surface) paired with --petrol-900 as the label
         * (the same fill-light/label-dark pairing dark mode's own --primary
         * already uses) measures 6.02:1. `hover:brightness-95` rather than a
         * second new token: this is a contrast fix for an untouched-surface
         * caller, not a second filled-button treatment to design and verify.
         */
        "default-neutral": "bg-petrol-400 text-petrol-900 hover:brightness-95",
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
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
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
