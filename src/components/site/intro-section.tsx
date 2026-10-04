import { INTRO_PARAGRAPHS } from "@/lib/site-copy";

/**
 * §5.3's intro: "2-3 sentences on who you are, what you make and your
 * themes." Shared by /about and /portfolio (src/app/about/page.tsx,
 * src/app/portfolio/page.tsx) so the two pages cannot say something
 * different about who runs the site.
 *
 * NO HEADING OF ITS OWN, deliberately: each page supplies its own `<h1>`
 * ("About us" / "Portfolio") immediately above this, and a second heading
 * here would either duplicate it or fight it for the page's one `<h1>`.
 * `data-page-section="intro"` is the stable hook K1's render test looks for
 * instead.
 */
export function IntroSection() {
  return (
    <div data-page-section="intro">
      {INTRO_PARAGRAPHS.map((paragraph, index) => (
        <p
          key={index}
          className="mt-4 max-w-prose text-sm text-muted-foreground sm:text-base"
        >
          {paragraph}
        </p>
      ))}
    </div>
  );
}
