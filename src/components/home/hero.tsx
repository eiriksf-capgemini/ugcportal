import Link from "next/link";

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
 * tokens — never a stock photograph or any third-party asset. The three
 * decorative circles are plain `<span>`s coloured from the same token scale,
 * `aria-hidden` because they carry no information.
 */
export function Hero({ signedIn }: HeroProps) {
  const cta = signedIn
    ? { href: UPLOAD_PATH, label: "Upload" }
    : { href: signInPath(UPLOAD_PATH), label: "Sign in to upload" };

  return (
    <section data-home-hero className="home-hero-surface relative isolate overflow-hidden">
      {/*
        Purely decorative (K3's "fade-in on tiles"): three soft circles that
        fade in once, on mount, rather than the static flat gradient alone.
        `opacity-100` is the no-motion-preference-expressed baseline (so a
        browser with no media-feature support at all still shows them);
        `motion-safe:opacity-0` plus the keyframe animation below take over
        only under `prefers-reduced-motion: no-preference`, and
        `motion-reduce:animation-none` is the explicit, redundant-by-design
        belt-and-braces half — see src/app/globals.css's own comment on
        `@keyframes home-fade-in` for why both exist rather than only the
        `motion-safe:` gate.
      */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {/*
          Fully opaque, not alpha-blended — the same choice
          docs/design/forside.html's own `.hero-art span` reference sketch
          makes, and it sidesteps src/lib/design/contrast.ts's alpha-utility
          coverage gate entirely: an alpha-modified background utility (an
          "/NN" opacity suffix) needs its own documented pairing there, and
          these three carry no text, so there is nothing a contrast ratio
          would be checking.
        */}
        <span
          className="absolute -top-16 -right-12 h-40 w-40 rounded-full bg-petrol-400 opacity-100 motion-safe:opacity-0 motion-safe:animate-[home-fade-in_700ms_ease-out_both] motion-reduce:animate-none"
        />
        <span
          className="absolute -bottom-20 left-8 h-48 w-48 rounded-full bg-petrol-300 opacity-100 motion-safe:opacity-0 motion-safe:animate-[home-fade-in_700ms_ease-out_both] motion-safe:[animation-delay:150ms] motion-reduce:animate-none"
        />
        <span
          className="absolute top-1/3 right-1/4 h-20 w-20 rounded-full bg-petrol-100 opacity-100 motion-safe:opacity-0 motion-safe:animate-[home-fade-in_700ms_ease-out_both] motion-safe:[animation-delay:300ms] motion-reduce:animate-none"
        />
      </div>

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-16 sm:px-6 sm:py-20">
        {/*
          Deliberately NOT a heading element (confirmed the hard way, twice:
          an `<h1>` here broke src/app/page.tags.test.tsx's "emits one
          continuous item set however many distinct tags are present", which
          also asserts the full Home() markup carries exactly one h1-h6
          total; see also src/components/home/empty-state.tsx's own comment
          for the opposite failure an `<h2>` there caused once this was
          fixed). Whichever of <Gallery> (its own SITE_DESCRIPTION <h1>), the
          new EmptyState (also an `<h1>`) or GalleryUnavailable (its own
          <h1>) is rendered below this hero already supplies that one
          heading — see each component's own comment — and the two of those
          three this bead did not write are not this bead's to edit ("do not
          change grid logic" covers Gallery's empty/unavailable siblings
          too). Styled to read as the page's title regardless.
        */}
        <p className="max-w-2xl font-heading text-2xl leading-tight font-medium tracking-tight text-balance text-ink sm:text-4xl">
          Real photos of the things you actually use.
        </p>
        {/*
          text-ink, not text-ink-muted (src/lib/design/contrast.ts): measured
          at 4.15:1 against this well's lighter --petrol-700 stop, below the
          4.5:1 body-text threshold — --color-ink-muted is tuned for the
          darker near-black surface scale (surface-0..4, L 0.185-0.345),
          which this gradient's lighter stop (petrol-700, L ~0.42) is not.
          The title and lead read at the same weight of emphasis here rather
          than the usual primary/secondary split.
        */}
        <p className="max-w-prose text-sm text-ink sm:text-base">
          This is a small, growing gallery of food, books, home technology and
          wine accessories — think glasses, coolers and the apps that go with
          them — photographed by real people, not studios. Every picture here
          was taken by someone who actually owns the thing in frame. Browse
          what is already up, or sign in to add your own.
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
    </section>
  );
}
