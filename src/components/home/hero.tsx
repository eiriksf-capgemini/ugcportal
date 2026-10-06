import Link from "next/link";

import { cn } from "cn";

import { DISPLAY_TITLE_CLASS } from "@/components/type-scale";
import { signInPath, UPLOAD_PATH } from "@/lib/routes";

export type HeroProps = {
  /**
   * Whether the CURRENT visitor is signed in (ugcportal-6dvg K1), already
   * resolved by src/app/page.tsx before this renders.
   *
   * Deliberately a plain boolean prop rather than this component calling
   * `getSession()` itself: a React Server Component that `await`s inside its
   * own body cannot be resolved by `renderToStaticMarkup` when it is reached
   * as a CHILD of another component already being rendered that way —
   * confirmed empirically on this exact renderer (see
   * src/components/upload-nav-link.tsx's own comment, point 2) — and
   * src/app/page.test.tsx, src/app/page.tags.test.tsx and
   * src/app/page.error.test.tsx all drive the home page through exactly
   * `renderToStaticMarkup(await Home())`. Home() resolves the session itself
   * (the same `getSession()` every other independent reader in this app
   * uses) and hands this component the one bit it needs, which also makes
   * this component trivial to unit test with no session mocking at all.
   */
  signedIn: boolean;
};

/**
 * The decorative shapes' shared classes (round-1 review, low finding):
 * hoisted so the three `<span>`s below don't each spell out the same long
 * string with only position/size/colour/delay differing.
 *
 * Fully opaque, not alpha-blended — the same choice docs/design/forside.html's
 * own `.hero-art span` reference sketch makes for its shapes (this layout now
 * also matches that sketch's STRUCTURE, not only its opacity choice — see
 * the comment on `HeroDecoration` below for why that is now load-bearing,
 * not merely a style echo) — and it sidesteps src/lib/design/contrast.ts's
 * alpha-utility coverage gate entirely: an alpha-modified background utility
 * (an "/NN" opacity suffix) needs its own documented pairing there, and
 * these three carry no text, so there is nothing a contrast ratio would be
 * checking.
 *
 * `opacity-100` is the no-motion-preference-expressed baseline (so a browser
 * with no media-feature support at all still shows them); `motion-safe:
 * opacity-0` plus the keyframe animation (src/app/globals.css) take over only
 * under `prefers-reduced-motion: no-preference`, and `motion-reduce:
 * animate-none` is the explicit, redundant-by-design belt-and-braces half —
 * see that file's own comment on `@keyframes home-fade-in` for why both exist
 * rather than only the `motion-safe:` gate.
 */
const HERO_DECORATIVE_SHAPE_CLASS =
  "absolute rounded-full opacity-100 motion-safe:opacity-0 motion-safe:animate-[home-fade-in_700ms_ease-out_both] motion-reduce:animate-none";

/**
 * The hero's purely decorative shapes (K3's "fade-in on tiles"), confined to
 * their OWN box — a flex sibling of the text column in `Hero` below, never an
 * absolutely-positioned overlay behind it.
 *
 * NOT a style choice (round-1 review, CONFIRMED medium): an earlier version
 * positioned these three `absolute`, spanning the entire hero, which put the
 * near-white `bg-petrol-100` circle directly behind the `text-ink` lead
 * paragraph at 360/768/1024px viewport widths — contrast collapsing to
 * roughly 1:1 wherever the two actually overlapped, undetected by
 * src/lib/design/contrast.ts (which checks DECLARED token pairs, not what
 * two elements happen to composite to at a given breakpoint) and only found
 * by measuring real client rects in a browser. This box's own `overflow-
 * hidden` clips every shape to ITS bounds, and flexbox (see `Hero`'s own
 * `sm:flex-row`) keeps those bounds a sibling of the text column at every
 * width rather than a sibling of the whole hero — so a shape cannot reach
 * the text column's rectangle regardless of its own size or offset.
 * e2e/front-page.spec.ts's "no decorative shape intersects hero text" check
 * asserts this geometrically rather than trusting the structure to hold.
 */
function HeroDecoration() {
  return (
    <div
      aria-hidden="true"
      data-home-hero-decoration
      className="relative h-28 w-28 shrink-0 self-center overflow-hidden sm:h-40 sm:w-40"
    >
      <span
        className={`${HERO_DECORATIVE_SHAPE_CLASS} -top-4 -right-4 h-20 w-20 bg-petrol-400`}
      />
      <span
        className={`${HERO_DECORATIVE_SHAPE_CLASS} bottom-0 left-0 h-16 w-16 bg-petrol-300 motion-safe:[animation-delay:150ms]`}
      />
      <span
        className={`${HERO_DECORATIVE_SHAPE_CLASS} top-10 left-10 h-8 w-8 bg-petrol-100 motion-safe:[animation-delay:300ms]`}
      />
    </div>
  );
}

/**
 * The front page's hero (ugcportal-6dvg): a title, a lead paragraph on what
 * this site is, and one primary call to action — K1's "signed out leads to
 * sign-in; signed in, to upload."
 *
 * Rendered by src/app/page.tsx ABOVE whichever of <Gallery>, the new
 * EmptyState or <GalleryUnavailable> applies (K2) — never conditionally
 * itself; "is there anything to show" and "what is this site" are different
 * questions, and a visitor is owed an answer to the second one regardless of
 * the first.
 *
 * A WELL, not the page canvas (see src/lib/design/dual-meaning-usage.test.ts's
 * own header comment): the background below is a fixed petrol gradient that
 * does not follow light/dark mode, the same reasoning that keeps the
 * lightbox's scrim fixed (src/app/globals.css's `.pswp` block) — a hero
 * photograph surround that flipped to a pale canvas in light mode would fight
 * the brand treatment the petrol palette exists for. Text inside therefore
 * reads with `text-ink` (--color-ink) throughout, including the lead
 * paragraph — see that paragraph's own comment for why `text-ink-muted`
 * measures below threshold on this particular well — never
 * `text-foreground` / `text-muted-foreground`, which are audited per-file in
 * dual-meaning-usage.test.ts specifically because they change meaning
 * depending on `--background`, which this surface is not. See
 * src/lib/design/contrast.ts's `ink-on-hero-petrol` /
 * `surface-0-on-petrol-100` entries for the measured contrast this relies on.
 *
 * NO IMAGE (K4): the surface below is `.home-hero-surface`
 * (src/app/globals.css), a `linear-gradient()` between two existing petrol
 * tokens — never a stock photograph or any third-party asset. `HeroDecoration`
 * above is the only other visual element, and carries no information.
 */
export function Hero({ signedIn }: HeroProps) {
  const cta = signedIn
    ? { href: UPLOAD_PATH, label: "Upload" }
    : { href: signInPath(UPLOAD_PATH), label: "Sign in to upload" };

  /*
   * Session-aware (round-3 review, low finding): an earlier, static version
   * of this sentence always said "...or sign in to add your own" — true
   * beside the signed-out CTA above, but a visitor who is ALREADY signed in
   * (CTA: "Upload") was being told to sign in a second time, right next to
   * a button that does not ask them to. The rest of the lead paragraph is
   * identical either way; only this closing clause names the action that
   * matches the CTA actually on screen.
   */
  const closingSentence = signedIn
    ? "Browse what is already up, or add your own."
    : "Browse what is already up, or sign in to add your own.";

  return (
    <section data-home-hero className="home-hero-surface relative isolate overflow-hidden">
      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-16 sm:flex-row sm:items-center sm:px-6 sm:py-20">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/*
            The page's one real <h1> (ugcportal-qqnt.1). Earlier, this was
            deliberately NOT a heading element, because
            src/app/page.tags.test.tsx asserted exactly one heading in the
            whole page and whichever of <Gallery>, EmptyState or
            GalleryUnavailable rendered below already supplied it, at a size
            that competed with this title rather than reading as a smaller
            section — see src/components/gallery/gallery.tsx,
            src/components/home/empty-state.tsx and
            src/components/gallery/gallery-unavailable.tsx for the matching
            fix: each of their own headings is now an <h2> at
            SECTION_TITLE_CLASS. DISPLAY_TITLE_CLASS
            (src/components/type-scale.ts) is the one display size shared
            with /about and /portfolio's own page titles.
          */}
          <h1 className={cn("max-w-2xl text-ink", DISPLAY_TITLE_CLASS)}>
            Real photos of the things you actually use.
          </h1>
          {/*
            text-ink, not text-ink-muted (src/lib/design/contrast.ts):
            measured at 4.15:1 against this well's lighter --petrol-700
            stop, below the 4.5:1 body-text threshold — --color-ink-muted
            is tuned for the darker near-black surface scale (surface-0..4,
            L 0.185-0.345), which this gradient's lighter stop (petrol-700,
            L ~0.42) is not. The title and lead read at the same weight of
            emphasis here rather than the usual primary/secondary split.
          */}
          <p className="max-w-prose text-sm text-ink sm:text-base">
            This is a small, growing gallery of food, books, home technology
            and wine accessories — think glasses, coolers and the apps that
            go with them — photographed by real people, not studios. Every
            picture here was taken by someone who actually owns the thing in
            frame. {closingSentence}
          </p>
          <div className="mt-2">
            <Link
              href={cta.href}
              className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-petrol-100 px-4 py-2 text-sm font-medium text-surface-0 transition-colors hover:bg-petrol-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {cta.label}
            </Link>
          </div>
        </div>
        <HeroDecoration />
      </div>
    </section>
  );
}
