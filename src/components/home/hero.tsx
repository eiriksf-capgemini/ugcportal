import Link from "next/link";

import { cn } from "cn";

import { GALLERY_RADIUS_CLASS } from "@/components/gallery/containment";
import { buttonVariants } from "@/components/ui/button";
import { DISPLAY_TITLE_CLASS } from "@/components/type-scale";
import { galleryItemAlt, type GalleryItem } from "@/lib/gallery-items";
import { PORTFOLIO_PATH, UPLOAD_PATH } from "@/lib/routes";

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
  /**
   * The hero's photographic visual (ugcportal-qqnt.4 K1), already resolved
   * by src/app/page.tsx the same way `signedIn` is — `listPortfolioPieces()`
   * (src/lib/portfolio.ts), fetched once there and handed down, never
   * re-queried here. The SAME reason as `signedIn` above applies doubly:
   * this is a Prisma read, and a plain, synchronous `Hero` can be driven with
   * a hand-built array in hero.test.tsx with no Prisma or request context at
   * all, for every count (three, one, zero) K1 needs covered.
   */
  portfolioPieces: GalleryItem[];
};

/**
 * Three overlapping offsets inside `HeroVisual`'s own box, in rendering
 * order — the same geometry docs/design/forside.html's `.hero-art
 * span:nth-child(n)` reference sketch draws (56% × 55% tiles at left
 * 0/26%/44%, top 15%/0/40%), as Tailwind percentage-of-container arbitrary
 * values rather than fixed pixels, so the one set of classes reads
 * correctly at both of the box's own breakpoints (h-28/w-28 below `sm`,
 * h-40/w-40 at and above it) without a second set of numbers for each.
 */
const HERO_VISUAL_TILE_POSITION_CLASS = [
  "left-0 top-[15%]",
  "left-[26%] top-0",
  "left-[44%] top-[40%]",
];

/** Every hero visual tile's size, real photograph or fallback alike. */
const HERO_VISUAL_TILE_SIZE_CLASS = "absolute h-[55%] w-[56%]";

/**
 * The fade-in every hero visual tile carries, real photograph or fallback
 * alike (K3) — unchanged in mechanism from the decorative circles this
 * replaces (see this file's own git history for `HERO_DECORATIVE_SHAPE_
 * CLASS`, the prior name of this same string): `opacity-100` is the
 * no-media-feature-support baseline (so a browser with neither value of
 * `prefers-reduced-motion` expressed still shows the tiles); `motion-safe:
 * opacity-0` plus the keyframe animation (src/app/globals.css) take over
 * only under `prefers-reduced-motion: no-preference`; `motion-reduce:
 * animate-none` is the explicit, redundant-by-design belt-and-braces half —
 * see that file's own comment on `@keyframes home-fade-in` for why both
 * exist rather than only the `motion-safe:` gate. Opaque, not
 * alpha-blended, for the same reason as before: these carry no text, so
 * there is nothing for src/lib/design/contrast.ts's alpha-utility coverage
 * gate to check.
 */
const HERO_VISUAL_TILE_MOTION_CLASS =
  "opacity-100 motion-safe:opacity-0 motion-safe:animate-[home-fade-in_700ms_ease-out_both] motion-reduce:animate-none";

/**
 * One neutral tone for every fallback tile (K1). The bead's own wording is
 * "a neutral petrol tile" — singular — one shade reused for whichever
 * slot(s) have no curated preview to show, not the three different shades
 * the decorative circles this replaces used to tell each other apart: there
 * is nothing to tell apart here, every fallback tile means the identical
 * thing ("no photograph in this slot yet").
 */
const HERO_VISUAL_FALLBACK_CLASS = "bg-petrol-200";

/**
 * The intrinsic `<img>` width/height HTML attributes every hero tile
 * carries (K3's "a hero image loads without width and height" guard) —
 * a fixed 1:1 figure, not a per-breakpoint one: the CSS classes above
 * already size and crop the rendered box at every breakpoint
 * (`object-cover` on a `h-full`-equivalent absolute box), so these
 * attributes exist only to give the browser an aspect ratio to reserve
 * layout space with BEFORE either the stylesheet or the image bytes have
 * arrived, not to describe the final on-screen size themselves.
 */
const HERO_VISUAL_TILE_INTRINSIC_PX = 160;

/**
 * The hero's photographic visual (ugcportal-qqnt.4 K1): up to three
 * overlapping radius-card tiles, each a real preview image of a curated
 * portfolio piece — `pieces` is `listPortfolioPieces()`'s own result
 * (src/lib/portfolio.ts), the SAME data and the SAME preview bytes
 * /portfolio itself renders, fetched once by src/app/page.tsx and handed
 * down rather than re-queried here. Replaces the three hand-rolled
 * decorative circles this bead's own premise found standing in for a real
 * photograph.
 *
 * FEWER THAN THREE PREVIEWS: the remaining slot(s) render as a plain
 * neutral petrol tile instead of a photograph (the bead's own words) —
 * never fewer than three TILES, so the three position classes above never
 * have to change shape depending on how much curated content exists; only
 * WHAT fills a given slot does. Zero pieces therefore renders three
 * fallback tiles and no `<img>` at all — a tested shape
 * (hero.test.tsx's own "zero pieces" case), not a missing one.
 *
 * Confined to its OWN box — a flex sibling of the text column in `Hero`
 * below, never an absolutely-positioned overlay behind it — for the exact
 * reason `HeroDecoration` (the component this one replaces) was: an earlier
 * version of THAT component positioned its three shapes `absolute` across
 * the whole hero, which put a near-white circle directly behind the
 * `text-ink` lead paragraph at several viewport widths (round-1 review,
 * CONFIRMED medium, on the original PR). This box's own `overflow-hidden`
 * still clips every tile to ITS bounds, and flexbox (`Hero`'s own
 * `sm:flex-row`) still keeps those bounds a sibling of the text column at
 * every width — so a tile cannot reach the text column's rectangle
 * regardless of its own size or offset, the same geometric guarantee
 * e2e/front-page.spec.ts's "no hero visual tile intersects hero text or
 * CTA" check still asserts, now against this component's own markup.
 *
 * `data-home-hero-decoration` IS GONE (K1's own "no element with
 * data-home-hero-decoration remains") — `data-home-hero-visual` below is a
 * new, differently-named marker, so a stale selector targeting the old
 * attribute fails loudly (matches nothing) rather than silently matching
 * whatever this element happens to be now.
 */
function HeroVisual({ pieces }: { pieces: GalleryItem[] }) {
  const shown = pieces.slice(0, 3);
  const fallbackCount = 3 - shown.length;

  return (
    <div
      data-home-hero-visual
      className="relative h-28 w-28 shrink-0 self-center overflow-hidden sm:h-40 sm:w-40"
    >
      {shown.map((piece, index) => (
        // Same reasoning as src/components/portfolio/portfolio-tile.tsx: the
        // preview is served by GET /api/media/preview/[previewId], which
        // next/image's optimizer cannot reach through (it proxies bytes
        // from object storage, not a static asset).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={piece.id}
          src={piece.previewSrc}
          alt={galleryItemAlt(piece, index)}
          width={HERO_VISUAL_TILE_INTRINSIC_PX}
          height={HERO_VISUAL_TILE_INTRINSIC_PX}
          loading="eager"
          decoding="async"
          draggable={false}
          className={cn(
            HERO_VISUAL_TILE_SIZE_CLASS,
            HERO_VISUAL_TILE_POSITION_CLASS[index],
            GALLERY_RADIUS_CLASS,
            "object-cover",
            HERO_VISUAL_TILE_MOTION_CLASS,
          )}
        />
      ))}
      {Array.from({ length: fallbackCount }, (_, fallbackIndex) => {
        const position = shown.length + fallbackIndex;
        return (
          <div
            key={`fallback-${position}`}
            aria-hidden="true"
            data-home-hero-visual-fallback
            className={cn(
              HERO_VISUAL_TILE_SIZE_CLASS,
              HERO_VISUAL_TILE_POSITION_CLASS[position],
              GALLERY_RADIUS_CLASS,
              HERO_VISUAL_FALLBACK_CLASS,
              HERO_VISUAL_TILE_MOTION_CLASS,
            )}
          />
        );
      })}
    </div>
  );
}

/**
 * The front page's hero (ugcportal-6dvg, copy and CTA revised by
 * ugcportal-qqnt.4): a title, a lead paragraph on what this site is, and one
 * primary call to action — signed out, "See the portfolio" (PORTFOLIO_PATH);
 * signed in, "Upload" (UPLOAD_PATH). The sign-in control itself lives in the
 * header only (ugcportal-qqnt.3) — a signed-out visitor is never offered a
 * second, duplicate sign-in affordance from this hero.
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
 * NO STOCK PHOTOGRAPH, NO THIRD-PARTY ASSET (K4, unchanged by
 * ugcportal-qqnt.4's own K1): the well itself is still `.home-hero-surface`
 * (src/app/globals.css), a `linear-gradient()` between two existing petrol
 * tokens. `HeroVisual` below DOES now render real `<img>`s — K4 was always
 * "no stock photo", never "no photo" — but every one is a genuine, already-
 * published portfolio piece's own preview, served from this app's own
 * origin (`GalleryItem.previewSrc`, the SAME `/api/media/preview/...` path
 * /portfolio itself uses), never an external URL.
 */
export function Hero({ signedIn, portfolioPieces }: HeroProps) {
  /*
   * ugcportal-qqnt.4 K2: a visitor's only hero action is "See the
   * portfolio" (PORTFOLIO_PATH) — never a sign-in prompt, which now lives in
   * the header only (ugcportal-qqnt.3) and would otherwise duplicate it, as
   * the bead's own premise notes found happening here before. A signed-in
   * user keeps the pre-existing "Upload" CTA straight to UPLOAD_PATH.
   */
  const cta = signedIn
    ? { href: UPLOAD_PATH, label: "Upload" }
    : { href: PORTFOLIO_PATH, label: "See the portfolio" };

  return (
    <section data-home-hero className="home-hero-surface relative isolate overflow-hidden">
      {/*
        ugcportal-qqnt.4's own in-scope item 4: vertical padding reduced
        from py-16/sm:py-20 to py-10/sm:py-16, so the section below starts
        inside a 900px-tall viewport (K3's "hero plus header stay at or
        under 620px at 1440x900" — e2e/front-page.spec.ts measures this for
        real rather than trusting the arithmetic alone).
      */}
      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10 sm:flex-row sm:items-center sm:px-6 sm:py-16">
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

            ugcportal-qqnt.4 K2: at most 25 words, no em-dash, one sentence
            naming what is photographed and by whom — this is 20 words. The
            longer, two-em-dash version this replaces (hero.tsx's own git
            history; also the bead's own premise notes) also tried to narrate
            the "browse, or sign in" choice inline; that is gone now that the
            hero offers exactly one action (see `cta` above), not two.
          */}
          <p className="max-w-prose text-sm text-ink sm:text-base">
            A small, growing gallery of food, books, home technology and wine
            accessories, photographed by the people who actually own them.
          </p>
          {/*
            buttonVariants, not a hand-rolled className (ugcportal-qqnt.2):
            `default-tint` is this well's one primary — see
            src/components/ui/button.tsx's own comment, point 6, for why
            that variant rather than `default-neutral`. The colours are
            unchanged from the className this replaces (bg-petrol-100 /
            text-surface-0 / hover:bg-petrol-200), so the contrast pairings
            already measuring them (surface-0-on-petrol-100 and its own
            -hover entry in src/lib/design/contrast.ts) still apply.

            Horizontal padding changes (round-2 review, LOW, CONFIRMED):
            `size="lg"` gives `px-2.5`, not the `px-4` the hand-rolled
            className this replaces used — the same value every other
            `size="lg"` caller gets, not a regression specific to this call
            site.

            Focus-visible outline under forced colors: no override needed
            here any more (ugcportal-oavb) — `buttonVariants`' own base now
            draws a real outline on `focus-visible` under `forced-colors:
            active`, for every caller, not only this one. A round-4,
            PR-#122-only version of this fix once lived here as a scoped
            `FORCED_COLORS_FOCUS_OUTLINE` override; see button.tsx's own
            comment on its base class for the current, systemic version and
            why a bare `outline-none` plus this app's `outline-hidden` idiom
            were both the wrong fix.
          */}
          <div className="mt-2">
            <Link
              href={cta.href}
              className={buttonVariants({ variant: "default-tint", size: "lg" })}
            >
              {cta.label}
            </Link>
          </div>
        </div>
        <HeroVisual pieces={portfolioPieces} />
      </div>
    </section>
  );
}
